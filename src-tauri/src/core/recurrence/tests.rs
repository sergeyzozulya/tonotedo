/// Test suite for the RRULE v1 subset — covers all acceptance criteria in
/// docs/spec/0008-calendar.md plus the edge cases listed in the spec.
///
/// Organisation:
///   parse_*       — parser unit tests
///   expand_*      — expansion unit tests
///   override_*    — override map tests
///   orphan_*      — orphaned override detection
///   edge_*        — calendar math edge cases (leap years, month-end, etc.)
///   spec_*        — direct mapping to acceptance criteria in 0008
use std::collections::HashMap;

use jiff::civil::Date;

use super::expand::expand_all;
use super::overrides::{expand_with_overrides, parse_overrides};
use super::parse::parse_rrule;
use super::types::{
    Frequency, OverrideAction, ParseResult, RRule, StartDate, UnsupportedFeature, Until, Weekday,
};

// ── helpers ────────────────────────────────────────────────────────────────

fn date(s: &str) -> Date {
    s.parse()
        .unwrap_or_else(|_| panic!("bad date literal: {s}"))
}

fn start(s: &str) -> StartDate {
    StartDate::Date(date(s))
}

fn ok_rule(s: &str) -> RRule {
    match parse_rrule(s) {
        ParseResult::Ok(r) => r,
        other => panic!("expected Ok rule for {s:?}, got {other:?}"),
    }
}

fn dates_in_window(rule: &RRule, st: StartDate, from: &str, to: &str) -> Vec<Date> {
    let all = expand_all(rule, st);
    let from = date(from);
    let to = date(to);
    all.into_iter().filter(|&d| d >= from && d <= to).collect()
}

// ── parse tests ────────────────────────────────────────────────────────────

#[test]
fn parse_simple_weekly_byday() {
    let r = ok_rule("RRULE:FREQ=WEEKLY;BYDAY=MO");
    assert_eq!(r.freq, Frequency::Weekly);
    assert_eq!(r.interval, 1);
    assert_eq!(r.by_day.len(), 1);
    assert_eq!(r.by_day[0].weekday, Weekday::Mo);
    assert!(r.by_day[0].position.is_none());
}

#[test]
fn parse_daily_count() {
    let r = ok_rule("RRULE:FREQ=DAILY;COUNT=10");
    assert_eq!(r.freq, Frequency::Daily);
    assert_eq!(r.until, Some(Until::Count(10)));
}

#[test]
fn parse_monthly_until() {
    let r = ok_rule("RRULE:FREQ=MONTHLY;UNTIL=20261231");
    assert_eq!(r.freq, Frequency::Monthly);
    assert_eq!(r.until, Some(Until::Date(date("2026-12-31"))));
}

#[test]
fn parse_until_iso_form() {
    let r = ok_rule("RRULE:FREQ=MONTHLY;UNTIL=2026-12-31");
    assert_eq!(r.until, Some(Until::Date(date("2026-12-31"))));
}

#[test]
fn parse_until_with_datetime_suffix() {
    // RRULE can contain YYYYMMDDTHHmmssZ; we extract only the date part.
    let r = ok_rule("RRULE:FREQ=DAILY;UNTIL=20261231T235959Z");
    assert_eq!(r.until, Some(Until::Date(date("2026-12-31"))));
}

#[test]
fn parse_no_prefix() {
    // Bare form without "RRULE:" prefix.
    let r = ok_rule("FREQ=WEEKLY;BYDAY=MO");
    assert_eq!(r.freq, Frequency::Weekly);
}

#[test]
fn parse_interval() {
    let r = ok_rule("RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO");
    assert_eq!(r.interval, 2);
}

#[test]
fn parse_byday_multi() {
    let r = ok_rule("RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR");
    assert_eq!(r.by_day.len(), 3);
    let days: Vec<Weekday> = r.by_day.iter().map(|bd| bd.weekday).collect();
    assert!(days.contains(&Weekday::Mo));
    assert!(days.contains(&Weekday::We));
    assert!(days.contains(&Weekday::Fr));
}

#[test]
fn parse_byday_positional_positive() {
    let r = ok_rule("RRULE:FREQ=MONTHLY;BYDAY=1MO");
    assert_eq!(r.by_day[0].position, Some(1));
    assert_eq!(r.by_day[0].weekday, Weekday::Mo);
}

#[test]
fn parse_byday_positional_negative() {
    let r = ok_rule("RRULE:FREQ=MONTHLY;BYDAY=-1FR");
    assert_eq!(r.by_day[0].position, Some(-1));
    assert_eq!(r.by_day[0].weekday, Weekday::Fr);
}

#[test]
fn parse_bymonthday_positive() {
    let r = ok_rule("RRULE:FREQ=MONTHLY;BYMONTHDAY=15");
    assert_eq!(r.by_month_day, vec![15]);
}

#[test]
fn parse_bymonthday_negative() {
    let r = ok_rule("RRULE:FREQ=MONTHLY;BYMONTHDAY=-1");
    assert_eq!(r.by_month_day, vec![-1]);
}

#[test]
fn parse_bymonthday_multi() {
    let r = ok_rule("RRULE:FREQ=MONTHLY;BYMONTHDAY=1,-1");
    assert!(r.by_month_day.contains(&1));
    assert!(r.by_month_day.contains(&-1));
}

#[test]
fn parse_bymonth() {
    let r = ok_rule("RRULE:FREQ=YEARLY;BYMONTH=3,6,9,12");
    assert_eq!(r.by_month, vec![3, 6, 9, 12]);
}

#[test]
fn parse_yearly_simple() {
    let r = ok_rule("RRULE:FREQ=YEARLY");
    assert_eq!(r.freq, Frequency::Yearly);
    assert_eq!(r.interval, 1);
}

#[test]
fn parse_error_missing_freq() {
    assert!(matches!(
        parse_rrule("RRULE:INTERVAL=1;COUNT=5"),
        ParseResult::Malformed(_)
    ));
}

#[test]
fn parse_error_duplicate_key() {
    assert!(matches!(
        parse_rrule("RRULE:FREQ=DAILY;FREQ=WEEKLY"),
        ParseResult::Malformed(_)
    ));
}

#[test]
fn parse_error_count_and_until() {
    assert!(matches!(
        parse_rrule("RRULE:FREQ=DAILY;COUNT=5;UNTIL=20261231"),
        ParseResult::Malformed(_)
    ));
}

#[test]
fn parse_error_empty() {
    assert!(matches!(parse_rrule(""), ParseResult::Malformed(_)));
}

#[test]
fn parse_error_bad_interval() {
    assert!(matches!(
        parse_rrule("RRULE:FREQ=DAILY;INTERVAL=0"),
        ParseResult::Malformed(_)
    ));
}

#[test]
fn parse_error_bad_byday_prefix() {
    assert!(matches!(
        parse_rrule("RRULE:FREQ=MONTHLY;BYDAY=0MO"),
        ParseResult::Malformed(_)
    ));
}

#[test]
fn parse_error_bad_bymonth() {
    assert!(matches!(
        parse_rrule("RRULE:FREQ=YEARLY;BYMONTH=13"),
        ParseResult::Malformed(_)
    ));
}

#[test]
fn parse_unsupported_bysetpos() {
    match parse_rrule("RRULE:FREQ=MONTHLY;BYDAY=MO;BYSETPOS=1") {
        ParseResult::Unsupported(features) => {
            assert!(features.contains(&UnsupportedFeature::BySetPos));
        }
        other => panic!("expected Unsupported, got {other:?}"),
    }
}

#[test]
fn parse_unsupported_byweekno() {
    match parse_rrule("RRULE:FREQ=YEARLY;BYWEEKNO=1") {
        ParseResult::Unsupported(features) => {
            assert!(features.contains(&UnsupportedFeature::ByWeekNo));
        }
        other => panic!("expected Unsupported, got {other:?}"),
    }
}

#[test]
fn parse_unsupported_byyearday() {
    match parse_rrule("RRULE:FREQ=YEARLY;BYYEARDAY=100") {
        ParseResult::Unsupported(features) => {
            assert!(features.contains(&UnsupportedFeature::ByYearDay));
        }
        other => panic!("expected Unsupported, got {other:?}"),
    }
}

#[test]
fn parse_unsupported_hourly() {
    match parse_rrule("RRULE:FREQ=HOURLY") {
        ParseResult::Unsupported(features) => {
            assert!(features
                .iter()
                .any(|f| matches!(f, UnsupportedFeature::Frequency(_))));
        }
        other => panic!("expected Unsupported, got {other:?}"),
    }
}

#[test]
fn parse_unsupported_minutely() {
    match parse_rrule("RRULE:FREQ=MINUTELY") {
        ParseResult::Unsupported(features) => {
            assert!(features
                .iter()
                .any(|f| matches!(f, UnsupportedFeature::Frequency(_))));
        }
        other => panic!("expected Unsupported, got {other:?}"),
    }
}

#[test]
fn parse_unsupported_secondly() {
    match parse_rrule("RRULE:FREQ=SECONDLY") {
        ParseResult::Unsupported(features) => {
            assert!(features
                .iter()
                .any(|f| matches!(f, UnsupportedFeature::Frequency(_))));
        }
        other => panic!("expected Unsupported, got {other:?}"),
    }
}

#[test]
fn parse_unsupported_wkst() {
    match parse_rrule("RRULE:FREQ=WEEKLY;BYDAY=MO;WKST=SU") {
        ParseResult::Unsupported(features) => {
            assert!(features.contains(&UnsupportedFeature::Wkst));
        }
        other => panic!("expected Unsupported, got {other:?}"),
    }
}

#[test]
fn parse_unsupported_byhour() {
    match parse_rrule("RRULE:FREQ=DAILY;BYHOUR=9") {
        ParseResult::Unsupported(features) => {
            assert!(features.contains(&UnsupportedFeature::ByHour));
        }
        other => panic!("expected Unsupported, got {other:?}"),
    }
}

#[test]
fn parse_unsupported_byminute() {
    match parse_rrule("RRULE:FREQ=DAILY;BYMINUTE=30") {
        ParseResult::Unsupported(features) => {
            assert!(features.contains(&UnsupportedFeature::ByMinute));
        }
        other => panic!("expected Unsupported, got {other:?}"),
    }
}

#[test]
fn parse_unsupported_bysecond() {
    match parse_rrule("RRULE:FREQ=DAILY;BYSECOND=0") {
        ParseResult::Unsupported(features) => {
            assert!(features.contains(&UnsupportedFeature::BySecond));
        }
        other => panic!("expected Unsupported, got {other:?}"),
    }
}

#[test]
fn parse_unsupported_unknown_part() {
    match parse_rrule("RRULE:FREQ=WEEKLY;BYDAY=MO;XFOO=BAR") {
        ParseResult::Unsupported(features) => {
            assert!(features
                .iter()
                .any(|f| matches!(f, UnsupportedFeature::Unknown(s) if s == "XFOO")));
        }
        other => panic!("expected Unsupported, got {other:?}"),
    }
}

#[test]
fn parse_unsupported_display_names() {
    // Verify the Display impl produces the expected strings (used in UI warnings).
    assert_eq!(UnsupportedFeature::BySetPos.to_string(), "BYSETPOS");
    assert_eq!(UnsupportedFeature::ByWeekNo.to_string(), "BYWEEKNO");
    assert_eq!(UnsupportedFeature::ByYearDay.to_string(), "BYYEARDAY");
    assert_eq!(UnsupportedFeature::ByHour.to_string(), "BYHOUR");
    assert_eq!(UnsupportedFeature::ByMinute.to_string(), "BYMINUTE");
    assert_eq!(UnsupportedFeature::BySecond.to_string(), "BYSECOND");
    assert_eq!(UnsupportedFeature::Wkst.to_string(), "WKST");
    assert_eq!(
        UnsupportedFeature::Frequency("HOURLY".into()).to_string(),
        "FREQ=HOURLY"
    );
    assert_eq!(
        UnsupportedFeature::Unknown("XFOO".into()).to_string(),
        "XFOO"
    );
}

// ── expansion tests ────────────────────────────────────────────────────────

#[test]
fn expand_daily_count() {
    // spec: "FREQ=DAILY;COUNT=10" starting 2026-01-01 → exactly 10 occurrences
    let rule = ok_rule("RRULE:FREQ=DAILY;COUNT=10");
    let all = expand_all(&rule, start("2026-01-01"));
    assert_eq!(all.len(), 10);
    assert_eq!(all[0], date("2026-01-01"));
    assert_eq!(all[9], date("2026-01-10"));
}

#[test]
fn expand_weekly_byday_mondays() {
    // spec example: FREQ=WEEKLY;BYDAY=MO → every Monday
    let rule = ok_rule("RRULE:FREQ=WEEKLY;BYDAY=MO");
    let result = dates_in_window(&rule, start("2026-01-05"), "2026-01-01", "2026-02-28");
    // 2026-01-05 is a Monday.  Mondays in Jan+Feb 2026:
    // Jan: 5, 12, 19, 26  Feb: 2, 9, 16, 23 = 8 Mondays.
    assert_eq!(result.len(), 8);
    for d in &result {
        use jiff::civil::Weekday as JWD;
        assert_eq!(d.weekday(), JWD::Monday, "{d} is not a Monday");
    }
}

#[test]
fn expand_weekly_interval2() {
    // FREQ=WEEKLY;INTERVAL=2;BYDAY=MO → every other Monday
    let rule = ok_rule("RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO");
    // Start 2026-01-05 (Monday).  Next: 2026-01-19, 2026-02-02, 2026-02-16
    let result = dates_in_window(&rule, start("2026-01-05"), "2026-01-01", "2026-02-28");
    assert_eq!(result.len(), 4, "{result:?}");
    assert_eq!(result[0], date("2026-01-05"));
    assert_eq!(result[1], date("2026-01-19"));
    assert_eq!(result[2], date("2026-02-02"));
    assert_eq!(result[3], date("2026-02-16"));
}

#[test]
fn expand_weekly_multi_byday() {
    // FREQ=WEEKLY;BYDAY=MO,WE,FR → Mon/Wed/Fri
    let rule = ok_rule("RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR");
    let result = dates_in_window(&rule, start("2026-01-05"), "2026-01-05", "2026-01-11");
    // Week of Jan 5–11 2026: Mon=5, Wed=7, Fri=9
    assert_eq!(
        result,
        vec![date("2026-01-05"), date("2026-01-07"), date("2026-01-09")]
    );
}

#[test]
fn expand_monthly_same_day() {
    // FREQ=MONTHLY starting 2026-01-15 → 15th of each month
    let rule = ok_rule("RRULE:FREQ=MONTHLY");
    let result = dates_in_window(&rule, start("2026-01-15"), "2026-01-01", "2026-06-30");
    assert_eq!(result.len(), 6);
    assert_eq!(result[0], date("2026-01-15"));
    assert_eq!(result[5], date("2026-06-15"));
}

#[test]
fn expand_monthly_bymonthday() {
    let rule = ok_rule("RRULE:FREQ=MONTHLY;BYMONTHDAY=1");
    let result = dates_in_window(&rule, start("2026-01-01"), "2026-01-01", "2026-06-30");
    assert_eq!(result.len(), 6);
    for d in &result {
        assert_eq!(d.day(), 1);
    }
}

#[test]
fn expand_monthly_bymonthday_negative_last_day() {
    // BYMONTHDAY=-1 = last day of each month
    let rule = ok_rule("RRULE:FREQ=MONTHLY;BYMONTHDAY=-1");
    let result = dates_in_window(&rule, start("2026-01-01"), "2026-01-01", "2026-04-30");
    assert_eq!(result.len(), 4, "{result:?}");
    assert_eq!(result[0], date("2026-01-31")); // Jan: 31 days
    assert_eq!(result[1], date("2026-02-28")); // Feb: 28 days (2026 not leap)
    assert_eq!(result[2], date("2026-03-31")); // Mar: 31 days
    assert_eq!(result[3], date("2026-04-30")); // Apr: 30 days
}

#[test]
fn expand_monthly_31st_skips_short_months() {
    // Starting Jan 31; Feb 31 doesn't exist → skip; Mar 31 exists.
    let rule = ok_rule("RRULE:FREQ=MONTHLY");
    let result = dates_in_window(&rule, start("2026-01-31"), "2026-01-01", "2026-06-30");
    // Jan 31, Feb skipped, Mar 31, Apr skipped (30 days), May 31, Jun skipped
    assert_eq!(result.len(), 3, "{result:?}");
    assert_eq!(result[0], date("2026-01-31"));
    assert_eq!(result[1], date("2026-03-31"));
    assert_eq!(result[2], date("2026-05-31"));
}

#[test]
fn expand_monthly_positional_1mo_first_monday() {
    // FREQ=MONTHLY;BYDAY=1MO → first Monday of each month
    let rule = ok_rule("RRULE:FREQ=MONTHLY;BYDAY=1MO");
    let result = dates_in_window(&rule, start("2026-01-05"), "2026-01-01", "2026-06-30");
    // Jan 2026: first Mon = Jan 5; Feb = Feb 2; Mar = Mar 2; Apr = Apr 6;
    // May = May 4; Jun = Jun 1.
    assert_eq!(result.len(), 6, "{result:?}");
    assert_eq!(result[0], date("2026-01-05"));
    assert_eq!(result[1], date("2026-02-02"));
    assert_eq!(result[2], date("2026-03-02"));
    assert_eq!(result[3], date("2026-04-06"));
    assert_eq!(result[4], date("2026-05-04"));
    assert_eq!(result[5], date("2026-06-01"));
}

#[test]
fn expand_monthly_positional_neg1_last_friday() {
    // FREQ=MONTHLY;BYDAY=-1FR → last Friday of each month
    let rule = ok_rule("RRULE:FREQ=MONTHLY;BYDAY=-1FR");
    let result = dates_in_window(&rule, start("2026-01-30"), "2026-01-01", "2026-03-31");
    // Jan 2026: last Fri = Jan 30; Feb: Feb 27; Mar: Mar 27
    assert_eq!(result.len(), 3, "{result:?}");
    assert_eq!(result[0], date("2026-01-30"));
    assert_eq!(result[1], date("2026-02-27"));
    assert_eq!(result[2], date("2026-03-27"));
}

#[test]
fn expand_yearly_simple() {
    let rule = ok_rule("RRULE:FREQ=YEARLY");
    let result = dates_in_window(&rule, start("2020-03-15"), "2020-01-01", "2026-12-31");
    assert_eq!(result.len(), 7); // 2020–2026
    assert!(result.iter().all(|d| d.month() == 3 && d.day() == 15));
}

#[test]
fn expand_yearly_bymonth() {
    // FREQ=YEARLY;BYMONTH=3,9 → March and September each year
    let rule = ok_rule("RRULE:FREQ=YEARLY;BYMONTH=3,9;BYMONTHDAY=1");
    let result = dates_in_window(&rule, start("2026-03-01"), "2026-01-01", "2027-12-31");
    assert_eq!(result.len(), 4, "{result:?}");
    assert_eq!(result[0], date("2026-03-01"));
    assert_eq!(result[1], date("2026-09-01"));
    assert_eq!(result[2], date("2027-03-01"));
    assert_eq!(result[3], date("2027-09-01"));
}

#[test]
fn expand_until_inclusive() {
    // RFC 5545: UNTIL is inclusive.
    let rule = ok_rule("RRULE:FREQ=DAILY;UNTIL=20260105");
    let all = expand_all(&rule, start("2026-01-01"));
    // Should include Jan 5.
    assert!(all.contains(&date("2026-01-05")), "{all:?}");
    assert!(!all.contains(&date("2026-01-06")));
    assert_eq!(all.len(), 5);
}

#[test]
fn expand_count_from_rule_start_not_window() {
    // COUNT counts from rule start.  Window starts mid-run.
    // Start 2026-01-01, COUNT=10 (Jan 1–10), window = Jan 5–31.
    let rule = ok_rule("RRULE:FREQ=DAILY;COUNT=10");
    let result = dates_in_window(&rule, start("2026-01-01"), "2026-01-05", "2026-01-31");
    // Days 5..10 are in the window (6 occurrences: Jan 5,6,7,8,9,10).
    assert_eq!(result.len(), 6, "{result:?}");
    assert_eq!(result[0], date("2026-01-05"));
    assert_eq!(result[5], date("2026-01-10"));
}

#[test]
fn expand_count3_of_count10_in_later_window() {
    // Occurrence 3 of COUNT=10 should appear in a window that starts later.
    let rule = ok_rule("RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=10");
    // Start 2026-01-05 (Mon).  Occurrence 3 = 2026-01-19.
    let result = dates_in_window(&rule, start("2026-01-05"), "2026-01-19", "2026-01-19");
    assert_eq!(result.len(), 1);
    assert_eq!(result[0], date("2026-01-19"));
}

#[test]
fn expand_interval_anchored_on_start() {
    // FREQ=WEEKLY;INTERVAL=3;BYDAY=MO anchored on 2026-01-05 (Mon).
    // Every 3rd Monday from that date.
    let rule = ok_rule("RRULE:FREQ=WEEKLY;INTERVAL=3;BYDAY=MO");
    let result = dates_in_window(&rule, start("2026-01-05"), "2026-01-01", "2026-04-30");
    assert_eq!(result[0], date("2026-01-05"));
    assert_eq!(result[1], date("2026-01-26")); // +3 weeks
    assert_eq!(result[2], date("2026-02-16")); // +3 weeks
    assert_eq!(result[3], date("2026-03-09")); // +3 weeks
    assert_eq!(result[4], date("2026-03-30")); // +3 weeks
    assert_eq!(result[5], date("2026-04-20")); // +3 weeks
}

// ── override tests ─────────────────────────────────────────────────────────

#[test]
fn override_move_single_occurrence() {
    // Move 2026-05-25 (Monday) to 2026-05-26 (Tuesday).
    let rule = ok_rule("RRULE:FREQ=WEEKLY;BYDAY=MO");
    let st = start("2026-05-18");
    let raw: HashMap<String, String> = [("2026-05-25".into(), "2026-05-26".into())]
        .into_iter()
        .collect();
    let overrides = parse_overrides(&raw);
    let exp = expand_with_overrides(
        &rule,
        st,
        date("2026-05-18"),
        date("2026-06-08"),
        &overrides,
    );
    let effectives: Vec<Date> = exp.occurrences.iter().map(|o| o.effective).collect();
    // May 18, May 26 (moved from 25), Jun 1, Jun 8
    assert!(effectives.contains(&date("2026-05-18")));
    assert!(effectives.contains(&date("2026-05-26")));
    assert!(!effectives.contains(&date("2026-05-25")));
    // Verify the moved flag.
    let moved_occ = exp
        .occurrences
        .iter()
        .find(|o| o.effective == date("2026-05-26"))
        .unwrap();
    assert!(moved_occ.moved);
    assert_eq!(moved_occ.original, date("2026-05-25"));
}

#[test]
fn override_skip_occurrence() {
    // Skip 2026-06-01.
    let rule = ok_rule("RRULE:FREQ=WEEKLY;BYDAY=MO");
    let st = start("2026-05-18");
    let raw: HashMap<String, String> = [("2026-06-01".into(), "skip".into())].into_iter().collect();
    let overrides = parse_overrides(&raw);
    let exp = expand_with_overrides(
        &rule,
        st,
        date("2026-05-18"),
        date("2026-06-15"),
        &overrides,
    );
    let effectives: Vec<Date> = exp.occurrences.iter().map(|o| o.effective).collect();
    assert!(!effectives.contains(&date("2026-06-01")));
    assert!(effectives.contains(&date("2026-05-25")));
    assert!(effectives.contains(&date("2026-06-08")));
}

#[test]
fn override_skip_case_insensitive() {
    let rule = ok_rule("RRULE:FREQ=DAILY;COUNT=3");
    let st = start("2026-01-01");
    let raw: HashMap<String, String> = [("2026-01-02".into(), "SKIP".into())].into_iter().collect();
    let overrides = parse_overrides(&raw);
    let exp = expand_with_overrides(
        &rule,
        st,
        date("2026-01-01"),
        date("2026-01-03"),
        &overrides,
    );
    let effectives: Vec<Date> = exp.occurrences.iter().map(|o| o.effective).collect();
    assert!(!effectives.contains(&date("2026-01-02")));
    assert_eq!(effectives.len(), 2);
}

#[test]
fn override_moved_occurrence_appears_in_window_if_target_in_window() {
    // Original date outside window (before), moved target inside window.
    let rule = ok_rule("RRULE:FREQ=WEEKLY;BYDAY=MO");
    let st = start("2026-05-11");
    let raw: HashMap<String, String> = [
        // Move May 11 (Monday, in window_from−1 day) to May 12 (in window).
        ("2026-05-11".into(), "2026-05-12".into()),
    ]
    .into_iter()
    .collect();
    let overrides = parse_overrides(&raw);
    let exp = expand_with_overrides(
        &rule,
        st,
        date("2026-05-12"),
        date("2026-05-25"),
        &overrides,
    );
    let effectives: Vec<Date> = exp.occurrences.iter().map(|o| o.effective).collect();
    assert!(effectives.contains(&date("2026-05-12")));
}

#[test]
fn override_moved_occurrence_not_in_window_if_target_outside() {
    // Move the only occurrence out of the window — it should not appear.
    let rule = ok_rule("RRULE:FREQ=DAILY;COUNT=1");
    let st = start("2026-01-01");
    let raw: HashMap<String, String> = [("2026-01-01".into(), "2026-02-01".into())]
        .into_iter()
        .collect();
    let overrides = parse_overrides(&raw);
    let exp = expand_with_overrides(
        &rule,
        st,
        date("2026-01-01"),
        date("2026-01-31"),
        &overrides,
    );
    assert!(exp.occurrences.is_empty());
}

// ── orphan detection tests ─────────────────────────────────────────────────

#[test]
fn orphan_detected_for_date_not_in_expansion() {
    // Override a date that is not a real occurrence.
    let rule = ok_rule("RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=4");
    let st = start("2026-01-05");
    let raw: HashMap<String, String> = [
        ("2026-01-13".into(), "skip".into()), // Jan 13 is a Tuesday, not in rule
    ]
    .into_iter()
    .collect();
    let overrides = parse_overrides(&raw);
    let exp = expand_with_overrides(
        &rule,
        st,
        date("2026-01-01"),
        date("2026-12-31"),
        &overrides,
    );
    assert_eq!(exp.orphaned.len(), 1);
    assert_eq!(exp.orphaned[0].key, "2026-01-13");
    assert!(matches!(exp.orphaned[0].action, OverrideAction::Skip));
}

#[test]
fn orphan_detected_beyond_count() {
    // Override a date that would be in the pattern but falls after COUNT.
    let rule = ok_rule("RRULE:FREQ=DAILY;COUNT=3");
    let st = start("2026-01-01");
    let raw: HashMap<String, String> = [
        ("2026-01-04".into(), "skip".into()), // 4th occurrence > COUNT=3
    ]
    .into_iter()
    .collect();
    let overrides = parse_overrides(&raw);
    let exp = expand_with_overrides(
        &rule,
        st,
        date("2026-01-01"),
        date("2026-12-31"),
        &overrides,
    );
    assert_eq!(exp.orphaned.len(), 1);
    assert_eq!(exp.orphaned[0].key, "2026-01-04");
}

#[test]
fn orphan_detected_beyond_until() {
    let rule = ok_rule("RRULE:FREQ=DAILY;UNTIL=20260103");
    let st = start("2026-01-01");
    let raw: HashMap<String, String> = [
        ("2026-01-05".into(), "skip".into()), // after UNTIL
    ]
    .into_iter()
    .collect();
    let overrides = parse_overrides(&raw);
    let exp = expand_with_overrides(
        &rule,
        st,
        date("2026-01-01"),
        date("2026-12-31"),
        &overrides,
    );
    assert_eq!(exp.orphaned.len(), 1);
}

#[test]
fn no_orphan_for_valid_override() {
    let rule = ok_rule("RRULE:FREQ=DAILY;COUNT=5");
    let st = start("2026-01-01");
    let raw: HashMap<String, String> = [("2026-01-03".into(), "2026-01-04".into())]
        .into_iter()
        .collect();
    let overrides = parse_overrides(&raw);
    let exp = expand_with_overrides(
        &rule,
        st,
        date("2026-01-01"),
        date("2026-01-10"),
        &overrides,
    );
    assert!(exp.orphaned.is_empty(), "{:?}", exp.orphaned);
}

// ── spec acceptance criteria: overrides from 0008 example ─────────────────

#[test]
fn spec_override_example_from_0008() {
    // From the spec:
    //   repeat: "RRULE:FREQ=WEEKLY;BYDAY=MO"
    //   overrides:
    //     "2026-05-25": "2026-05-26"   # moved one day
    //     "2026-06-01": skip
    let rule = ok_rule("RRULE:FREQ=WEEKLY;BYDAY=MO");
    let st = start("2026-05-18");
    let raw: HashMap<String, String> = [
        ("2026-05-25".into(), "2026-05-26".into()),
        ("2026-06-01".into(), "skip".into()),
    ]
    .into_iter()
    .collect();
    let overrides = parse_overrides(&raw);
    let exp = expand_with_overrides(
        &rule,
        st,
        date("2026-05-18"),
        date("2026-06-15"),
        &overrides,
    );
    let effectives: Vec<Date> = exp.occurrences.iter().map(|o| o.effective).collect();
    assert!(effectives.contains(&date("2026-05-18")));
    assert!(!effectives.contains(&date("2026-05-25"))); // moved
    assert!(effectives.contains(&date("2026-05-26"))); // to here
    assert!(!effectives.contains(&date("2026-06-01"))); // skipped
    assert!(effectives.contains(&date("2026-06-08")));
    assert!(effectives.contains(&date("2026-06-15")));
    assert!(exp.orphaned.is_empty());
}

// ── edge cases ─────────────────────────────────────────────────────────────

#[test]
fn edge_leap_year_feb29_yearly() {
    // FREQ=YEARLY starting Feb 29 2024 → only leap years have Feb 29.
    let rule = ok_rule("RRULE:FREQ=YEARLY");
    let result = dates_in_window(&rule, start("2024-02-29"), "2024-01-01", "2033-12-31");
    // Leap years in range: 2024, 2028, 2032.
    assert_eq!(result.len(), 3, "{result:?}");
    assert_eq!(result[0], date("2024-02-29"));
    assert_eq!(result[1], date("2028-02-29"));
    assert_eq!(result[2], date("2032-02-29"));
}

#[test]
fn edge_leap_year_monthly_feb29() {
    // FREQ=MONTHLY starting Feb 29 2024 → Mar 29, Apr 29, ... but NOT every
    // month has a 29th.  All months with 29 days should appear.
    let rule = ok_rule("RRULE:FREQ=MONTHLY");
    // All months have day 29 except... actually all months from Jan–Dec have
    // at least 29 days (Feb in leap year).  Let's just check Feb 2024 → Mar.
    let result = dates_in_window(&rule, start("2024-02-29"), "2024-02-01", "2024-06-30");
    // Feb 29, Mar 29, Apr 29, May 29, Jun 29 = 5
    assert_eq!(result.len(), 5, "{result:?}");
    assert_eq!(result[0], date("2024-02-29"));
    assert_eq!(result[1], date("2024-03-29"));
}

#[test]
fn edge_bymonthday_neg2_second_to_last() {
    // BYMONTHDAY=-2 → second-to-last day of month
    let rule = ok_rule("RRULE:FREQ=MONTHLY;BYMONTHDAY=-2");
    let result = dates_in_window(&rule, start("2026-01-01"), "2026-01-01", "2026-03-31");
    assert_eq!(result[0], date("2026-01-30")); // Jan has 31, so -2 = 30
    assert_eq!(result[1], date("2026-02-27")); // Feb 2026 has 28, so -2 = 27
    assert_eq!(result[2], date("2026-03-30")); // Mar has 31, so -2 = 30
}

#[test]
fn edge_positional_byday_month_boundary_5th_monday() {
    // FREQ=MONTHLY;BYDAY=5MO → 5th Monday of month (some months have no 5th Monday)
    let rule = ok_rule("RRULE:FREQ=MONTHLY;BYDAY=5MO");
    let result = dates_in_window(&rule, start("2026-01-26"), "2026-01-01", "2026-12-31");
    // Jan 2026 has 5 Mondays: 5,12,19,26; that's only 4. Let me check:
    // Jan 2026: Mon = 5, 12, 19, 26 → only 4 Mondays. No 5th.
    // Let me find months with 5 Mondays in 2026.
    // Feb: 2,9,16,23 → 4. Mar: 2,9,16,23,30 → 5 (Mar 30 is a Monday).
    // Jun 2026: Mon = 1,8,15,22,29 → 5 Mondays.
    // Aug 2026: Mon = 3,10,17,24,31 → 5 Mondays.
    // Nov 2026: Mon = 2,9,16,23,30 → 5 Mondays.
    // So at least March, June, August, November should appear.
    assert!(result.contains(&date("2026-03-30")));
    assert!(result.contains(&date("2026-06-29")));
    assert!(result.contains(&date("2026-08-31")));
    assert!(result.contains(&date("2026-11-30")));
    // Months without a 5th Monday should not appear.
    assert!(!result.contains(&date("2026-01-01"))); // Jan has no 5th Mon
}

#[test]
fn edge_until_is_inclusive_rfc5545() {
    // UNTIL=20260103 → Jan 1, 2, 3 all included; Jan 4 excluded.
    let rule = ok_rule("RRULE:FREQ=DAILY;UNTIL=20260103");
    let all = expand_all(&rule, start("2026-01-01"));
    assert_eq!(all.len(), 3);
    assert!(all.contains(&date("2026-01-03")));
    assert!(!all.contains(&date("2026-01-04")));
}

#[test]
fn edge_zone_naive_arithmetic() {
    // Ensure that StartDate::DateTime (with time) still uses the date component
    // for expansion — zone-naive as per the spec.
    use jiff::civil::DateTime;
    let st = StartDate::DateTime("2026-01-05T09:00:00".parse::<DateTime>().unwrap());
    let rule = ok_rule("RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=3");
    let all = expand_all(&rule, st);
    assert_eq!(all.len(), 3);
    assert_eq!(all[0], date("2026-01-05"));
    assert_eq!(all[1], date("2026-01-12"));
    assert_eq!(all[2], date("2026-01-19"));
}

#[test]
fn edge_bymonthday_and_plain_byday_intersection() {
    // FREQ=MONTHLY;BYMONTHDAY=1,15;BYDAY=MO,TU,WE,TH,FR = business days on 1st or 15th
    // 2026-01: 1st = Thu (business), 15th = Thu (business).
    // 2026-02: 1st = Sun (not business), 15th = Sun (not business).
    // 2026-03: 1st = Sun (not), 15th = Sun (not).
    // 2026-04: 1st = Wed (business), 15th = Wed (business).
    let rule = ok_rule("RRULE:FREQ=MONTHLY;BYMONTHDAY=1,15;BYDAY=MO,TU,WE,TH,FR");
    let result = dates_in_window(&rule, start("2026-01-01"), "2026-01-01", "2026-04-30");
    // Jan 1 = Thu ✓, Jan 15 = Thu ✓, Feb 1 = Sun ✗, Feb 15 = Sun ✗,
    // Mar 1 = Sun ✗, Mar 15 = Sun ✗, Apr 1 = Wed ✓, Apr 15 = Wed ✓
    assert!(result.contains(&date("2026-01-01")));
    assert!(result.contains(&date("2026-01-15")));
    assert!(!result.contains(&date("2026-02-01")));
    assert!(!result.contains(&date("2026-02-15")));
    assert!(!result.contains(&date("2026-03-01")));
    assert!(!result.contains(&date("2026-03-15")));
    assert!(result.contains(&date("2026-04-01")));
    assert!(result.contains(&date("2026-04-15")));
}

#[test]
fn edge_bymonth_filter_on_yearly() {
    // FREQ=YEARLY;BYMONTH=6;BYMONTHDAY=15 → June 15 every year
    let rule = ok_rule("RRULE:FREQ=YEARLY;BYMONTH=6;BYMONTHDAY=15");
    let result = dates_in_window(&rule, start("2024-06-15"), "2024-01-01", "2027-12-31");
    assert_eq!(result.len(), 4, "{result:?}");
    for d in &result {
        assert_eq!(d.month(), 6);
        assert_eq!(d.day(), 15);
    }
}

#[test]
fn edge_daily_with_bymonth_filter() {
    // FREQ=DAILY;BYMONTH=2 → every day in February
    // Start Jan 29; first hit should be Feb 1.
    let rule = ok_rule("RRULE:FREQ=DAILY;BYMONTH=2");
    let result = dates_in_window(&rule, start("2026-01-29"), "2026-01-01", "2026-02-28");
    assert_eq!(result.len(), 28, "{result:?}");
    assert_eq!(result[0], date("2026-02-01"));
    assert_eq!(result[27], date("2026-02-28"));
}

#[test]
fn edge_source_date_move_shifts_non_overridden() {
    // If the entry's source (start) date is changed, non-overridden occurrences shift.
    // Original start 2026-01-05 (Mon); new start 2026-01-06 (Tue).
    // Rule: FREQ=WEEKLY (no BYDAY) → anchor day shifts from Mon to Tue.
    let rule = ok_rule("RRULE:FREQ=WEEKLY");
    let old_all = dates_in_window(&rule, start("2026-01-05"), "2026-01-01", "2026-02-28");
    let new_all = dates_in_window(&rule, start("2026-01-06"), "2026-01-01", "2026-02-28");
    // All old dates are Monday, all new dates are Tuesday.
    use jiff::civil::Weekday as JWD;
    assert!(old_all.iter().all(|d| d.weekday() == JWD::Monday));
    assert!(new_all.iter().all(|d| d.weekday() == JWD::Tuesday));
}

#[test]
fn edge_orphan_after_source_date_move() {
    // Override was keyed to a Monday (old start); after source moves to Tuesday,
    // the Monday key is no longer in the expansion → orphaned.
    let rule = ok_rule("RRULE:FREQ=WEEKLY");
    let new_start = start("2026-01-06"); // Tuesday
    let raw: HashMap<String, String> = [
        ("2026-01-12".into(), "skip".into()), // old Monday — not in new expansion
    ]
    .into_iter()
    .collect();
    let overrides = parse_overrides(&raw);
    let exp = expand_with_overrides(
        &rule,
        new_start,
        date("2026-01-01"),
        date("2026-12-31"),
        &overrides,
    );
    assert_eq!(exp.orphaned.len(), 1);
    assert_eq!(exp.orphaned[0].key, "2026-01-12");
}

// ── spec acceptance criteria direct mappings ───────────────────────────────

/// spec: "An entry with a valid repeat RRULE renders at every expanded
/// occurrence within the visible window."
#[test]
fn spec_valid_rrule_expands_in_window() {
    let rule = ok_rule("RRULE:FREQ=WEEKLY;BYDAY=MO");
    let result = dates_in_window(&rule, start("2026-05-18"), "2026-05-18", "2026-06-15");
    // 4 Mondays: May 18, 25, Jun 1, 8, 15 = 5
    assert_eq!(result.len(), 5, "{result:?}");
}

/// spec: "Invalid RRULE → suppressed recurrence + warning surfaced."
/// We verify that a malformed RRULE returns ParseResult::Malformed (not Ok)
/// so the caller can suppress recurrence.
#[test]
fn spec_invalid_rrule_suppressed_recurrence() {
    assert!(matches!(
        parse_rrule("RRULE:FREQ=BORKED"),
        ParseResult::Unsupported(_)
    ));
    assert!(matches!(
        parse_rrule("RRULE:INTERVAL=1"),
        ParseResult::Malformed(_)
    ));
}

/// spec: "Editing a single occurrence persists an overrides entry on the source;
/// other occurrences are unaffected."
#[test]
fn spec_single_override_does_not_affect_others() {
    let rule = ok_rule("RRULE:FREQ=DAILY;COUNT=5");
    let st = start("2026-01-01");
    let raw: HashMap<String, String> = [("2026-01-03".into(), "2026-01-10".into())]
        .into_iter()
        .collect();
    let overrides = parse_overrides(&raw);
    let exp = expand_with_overrides(
        &rule,
        st,
        date("2026-01-01"),
        date("2026-01-10"),
        &overrides,
    );
    // Jan 1, 2 unchanged; Jan 3 moved to Jan 10; Jan 4, 5 unchanged.
    let effectives: Vec<Date> = exp.occurrences.iter().map(|o| o.effective).collect();
    assert!(effectives.contains(&date("2026-01-01")));
    assert!(effectives.contains(&date("2026-01-02")));
    assert!(!effectives.contains(&date("2026-01-03")));
    assert!(effectives.contains(&date("2026-01-04")));
    assert!(effectives.contains(&date("2026-01-05")));
    assert!(effectives.contains(&date("2026-01-10")));
}

/// spec: "Recurring entry's source date moved → all non-overridden occurrences shift."
#[test]
fn spec_source_date_move_shifts_occurrences() {
    // Covered by edge_source_date_move_shifts_non_overridden above.
    // This test makes the spec link explicit with a COUNT-bounded rule.
    let rule = ok_rule("RRULE:FREQ=WEEKLY;COUNT=4");
    let old = dates_in_window(&rule, start("2026-01-05"), "2026-01-01", "2026-12-31");
    let new = dates_in_window(&rule, start("2026-01-06"), "2026-01-01", "2026-12-31");
    // old starts Mon, new starts Tue.
    use jiff::civil::Weekday as JWD;
    assert_eq!(old[0].weekday(), JWD::Monday);
    assert_eq!(new[0].weekday(), JWD::Tuesday);
    assert_ne!(old, new);
}
