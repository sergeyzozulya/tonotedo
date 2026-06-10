/// RRULE occurrence expansion (v1 subset).
///
/// The algorithm iterates over "candidate anchor dates" determined by the
/// frequency and interval, then filters/expands each anchor through the
/// BYDAY / BYMONTHDAY / BYMONTH constraints.  COUNT is evaluated against
/// the full rule expansion from the start date, not the window, per RFC 5545.
use jiff::civil::{Date, Weekday as JiffWeekday};
use jiff::ToSpan;

use super::types::{ByDay, Frequency, RRule, StartDate, Until, Weekday};

/// Map our `Weekday` enum to jiff's `Weekday`.
fn to_jiff_weekday(wd: Weekday) -> JiffWeekday {
    match wd {
        Weekday::Mo => JiffWeekday::Monday,
        Weekday::Tu => JiffWeekday::Tuesday,
        Weekday::We => JiffWeekday::Wednesday,
        Weekday::Th => JiffWeekday::Thursday,
        Weekday::Fr => JiffWeekday::Friday,
        Weekday::Sa => JiffWeekday::Saturday,
        Weekday::Su => JiffWeekday::Sunday,
    }
}

/// Return the number of days in a given year+month.
fn days_in_month(year: i16, month: i8) -> i8 {
    // jiff can tell us directly: try to construct the last valid day.
    // We probe from 31 downward.
    for d in (1i8..=31).rev() {
        if Date::new(year, month, d).is_ok() {
            return d;
        }
    }
    28 // fallback (should never reach here)
}

/// Resolve a possibly-negative BYMONTHDAY value to an absolute day-of-month,
/// returning `None` if the resolved day does not exist in the given month.
fn resolve_month_day(year: i16, month: i8, raw: i8) -> Option<i8> {
    if raw == 0 {
        return None; // 0 is invalid per RFC 5545
    }
    let day = if raw > 0 {
        raw
    } else {
        let dim = days_in_month(year, month);
        dim + raw + 1 // e.g. -1 → last day
    };
    if day < 1 {
        return None;
    }
    // Verify the date actually exists.
    if Date::new(year, month, day).is_ok() {
        Some(day)
    } else {
        None
    }
}

/// Return all dates in `year`/`month` that match a positional BYDAY entry.
/// `position > 0` → nth occurrence from start; `position < 0` → from end.
fn positional_byday_dates(year: i16, month: i8, entry: ByDay) -> Vec<Date> {
    let pos = match entry.position {
        Some(p) => p,
        None => return Vec::new(), // handled separately
    };
    let jwd = to_jiff_weekday(entry.weekday);
    let dim = days_in_month(year, month);
    // Collect all matching weekdays in the month.
    let matches: Vec<Date> = (1..=dim)
        .filter_map(|d| {
            let date = Date::new(year, month, d).ok()?;
            if date.weekday() == jwd {
                Some(date)
            } else {
                None
            }
        })
        .collect();
    if pos > 0 {
        let idx = (pos as usize).saturating_sub(1);
        matches.get(idx).copied().into_iter().collect()
    } else {
        // negative: count from end
        let idx = matches.len().saturating_sub((-pos) as usize);
        matches.get(idx).copied().into_iter().collect()
    }
}

/// Check whether a date matches a plain (non-positional) BYDAY weekday list.
fn matches_plain_byday(date: Date, by_day: &[ByDay]) -> bool {
    if by_day.is_empty() {
        return true;
    }
    let plain: Vec<_> = by_day.iter().filter(|bd| bd.position.is_none()).collect();
    if plain.is_empty() {
        return false; // only positional entries in list
    }
    let jwd = date.weekday();
    plain.iter().any(|bd| to_jiff_weekday(bd.weekday) == jwd)
}

/// Return all candidate dates for a given monthly/yearly anchor that satisfy
/// the BYDAY and BYMONTHDAY constraints in the rule.
///
/// RFC 5545 §3.3.10: when both BYDAY and BYMONTHDAY are present, the
/// intersection is taken.
fn expand_anchor_date(year: i16, month: i8, rule: &RRule) -> Vec<Date> {
    let has_positional = rule.by_day.iter().any(|bd| bd.position.is_some());
    let has_plain_byday = rule.by_day.iter().any(|bd| bd.position.is_none());
    let has_bymonthday = !rule.by_month_day.is_empty();

    if has_positional && !has_bymonthday {
        // Positional BYDAY only.
        let mut dates: Vec<Date> = rule
            .by_day
            .iter()
            .filter(|bd| bd.position.is_some())
            .flat_map(|bd| positional_byday_dates(year, month, *bd))
            .collect();
        dates.sort();
        dates.dedup();
        return dates;
    }

    if has_bymonthday {
        let bymonthday_dates: Vec<Date> = rule
            .by_month_day
            .iter()
            .filter_map(|&raw| {
                let day = resolve_month_day(year, month, raw)?;
                Date::new(year, month, day).ok()
            })
            .collect();

        if has_plain_byday {
            // Intersection of BYMONTHDAY and plain BYDAY.
            let mut dates: Vec<Date> = bymonthday_dates
                .into_iter()
                .filter(|&d| matches_plain_byday(d, &rule.by_day))
                .collect();
            dates.sort();
            dates.dedup();
            return dates;
        }
        let mut dates = bymonthday_dates;
        dates.sort();
        dates.dedup();
        return dates;
    }

    if has_plain_byday {
        // Plain BYDAY: enumerate all weekdays matching in the month/week.
        // For MONTHLY/YEARLY, this enumerates all matching days in the month.
        // For WEEKLY this is handled separately by the caller.
        let dim = days_in_month(year, month);
        let mut dates: Vec<Date> = (1..=dim)
            .filter_map(|d| {
                let date = Date::new(year, month, d).ok()?;
                if matches_plain_byday(date, &rule.by_day) {
                    Some(date)
                } else {
                    None
                }
            })
            .collect();
        dates.sort();
        dates.dedup();
        return dates;
    }

    // No filters: return no specific dates; caller uses the anchor itself.
    Vec::new()
}

/// Maximum number of occurrences we will generate (safety cap).
const MAX_OCCURRENCES: usize = 10_000;

/// Expand a rule into all occurrences, stopping at COUNT/UNTIL.
///
/// `start` is the anchor date of the rule (the entry's primary date property).
/// All occurrences with `effective_date >= start_date_of_rule` are generated,
/// up to COUNT.  The caller then filters to the desired window.
///
/// Returns occurrences as a sorted, deduplicated `Vec<Date>`.
pub fn expand_all(rule: &RRule, start: StartDate) -> Vec<Date> {
    let start_date = start.date();
    let mut results: Vec<Date> = Vec::new();

    match rule.freq {
        Frequency::Daily => expand_daily(rule, start_date, &mut results),
        Frequency::Weekly => expand_weekly(rule, start_date, &mut results),
        Frequency::Monthly => expand_monthly(rule, start_date, &mut results),
        Frequency::Yearly => expand_yearly(rule, start_date, &mut results),
    }

    results.sort();
    results.dedup();
    results
}

fn should_stop(date: Date, rule: &RRule, count_so_far: usize) -> bool {
    if count_so_far >= MAX_OCCURRENCES {
        return true;
    }
    match &rule.until {
        Some(Until::Count(n)) => count_so_far >= *n as usize,
        Some(Until::Date(d)) => date > *d,
        None => false,
    }
}

fn expand_daily(rule: &RRule, start: Date, results: &mut Vec<Date>) {
    // BYDAY, BYMONTHDAY, BYMONTH can filter daily occurrences.
    let mut current = start;
    loop {
        if should_stop(current, rule, results.len()) {
            break;
        }
        let ok = check_bymonth(current, rule)
            && check_bymonthday(current, rule)
            && check_plain_byday(current, rule);
        if ok {
            results.push(current);
        }
        current = match current.checked_add((rule.interval as i64).days()) {
            Ok(d) => d,
            Err(_) => break,
        };
    }
}

fn expand_weekly(rule: &RRule, start: Date, results: &mut Vec<Date>) {
    // Anchor week starts on `start`.  Each interval step advances by N weeks.
    // Within each week, BYDAY selects which days; default = only `start`'s day.
    let has_byday = !rule.by_day.is_empty();

    let mut week_start = start;
    // When BYDAY is present, the "week" is the 7-day block starting from the
    // rule start's ISO Monday (anchor week).  We anchor on `start` and visit
    // the matching days in each interval-week.
    loop {
        if should_stop(week_start, rule, results.len()) {
            break;
        }

        if has_byday {
            // Visit every day of this week and pick matching BYDAY entries.
            for day_offset in 0i64..7 {
                let candidate = match week_start.checked_add(day_offset.days()) {
                    Ok(d) => d,
                    Err(_) => break,
                };
                if should_stop(candidate, rule, results.len()) {
                    break;
                }
                if candidate < start {
                    continue;
                }
                if check_bymonth(candidate, rule) && matches_plain_byday(candidate, &rule.by_day) {
                    results.push(candidate);
                }
            }
        } else {
            // No BYDAY: the recurrence is the anchor day every N weeks.
            if check_bymonth(week_start, rule) {
                results.push(week_start);
            }
        }

        week_start = match week_start.checked_add((7 * rule.interval as i64).days()) {
            Ok(d) => d,
            Err(_) => break,
        };
    }
}

fn expand_monthly(rule: &RRule, start: Date, results: &mut Vec<Date>) {
    // Anchor month is start's year/month.  Advance by interval months.
    // Within each month, BYDAY / BYMONTHDAY expand the occurrences.
    let mut year = start.year();
    let mut month = start.month();

    loop {
        // Safety: stop if we've wandered too far.
        if results.len() >= MAX_OCCURRENCES {
            break;
        }

        let has_filter = !rule.by_day.is_empty() || !rule.by_month_day.is_empty();

        let candidates: Vec<Date> = if has_filter {
            let mut dates = expand_anchor_date(year, month, rule);
            dates.retain(|&d| d >= start); // first iteration: skip pre-start
            dates
        } else {
            // No filter: use the same day-of-month as the start.
            let day = start.day();
            // Month-end clamping: skip months where the day doesn't exist.
            if let Ok(d) = Date::new(year, month, day) {
                if d >= start {
                    vec![d]
                } else {
                    vec![]
                }
            } else {
                // Day doesn't exist in this month (e.g. Jan 31 → Feb has no
                // Feb 31): skip the month, per the spec.
                vec![]
            }
        };

        let until_date = until_date(rule);
        for c in candidates {
            if should_stop(c, rule, results.len()) {
                break;
            }
            if let Some(ud) = until_date {
                if c > ud {
                    return;
                }
            }
            if !check_bymonth(c, rule) {
                continue;
            }
            results.push(c);
        }

        // Advance by interval months.
        let (ny, nm) = add_months(year, month, rule.interval);
        year = ny;
        month = nm;

        // Stop if we've gone past the UNTIL date.
        if let Some(Until::Date(ud)) = &rule.until {
            if Date::new(year, month, 1).map(|d| d > *ud).unwrap_or(false) {
                break;
            }
        }
        // Safety guard for infinite rules.
        if results.len() >= MAX_OCCURRENCES {
            break;
        }
    }
}

fn expand_yearly(rule: &RRule, start: Date, results: &mut Vec<Date>) {
    let mut year = start.year();

    loop {
        if results.len() >= MAX_OCCURRENCES {
            break;
        }

        let until_date = until_date(rule);

        let has_filter =
            !rule.by_day.is_empty() || !rule.by_month_day.is_empty() || !rule.by_month.is_empty();

        if has_filter {
            // Determine which months to visit.
            let months: Vec<i8> = if !rule.by_month.is_empty() {
                rule.by_month.iter().map(|&m| m as i8).collect()
            } else {
                vec![start.month()]
            };

            for &month in &months {
                let candidates = expand_anchor_date(year, month, rule);
                for c in candidates {
                    if c < start {
                        continue;
                    }
                    if should_stop(c, rule, results.len()) {
                        return;
                    }
                    if let Some(ud) = until_date {
                        if c > ud {
                            return;
                        }
                    }
                    results.push(c);
                }
            }
        } else {
            // No filter: same month+day as start, once per interval years.
            if let Ok(d) = Date::new(year, start.month(), start.day()) {
                if d >= start {
                    if should_stop(d, rule, results.len()) {
                        break;
                    }
                    if let Some(ud) = until_date {
                        if d > ud {
                            break;
                        }
                    }
                    results.push(d);
                }
            }
            // Leap-year skip: if start is Feb 29 and this year has no Feb 29,
            // we simply skip the year (same as monthly clamping).
        }

        year = match year.checked_add(rule.interval as i16) {
            Some(y) => y,
            None => break,
        };

        if year > 9999 {
            break;
        }
    }
}

// ── helpers ──────────────────────────────────────────────────────────────────

fn until_date(rule: &RRule) -> Option<Date> {
    if let Some(Until::Date(d)) = &rule.until {
        Some(*d)
    } else {
        None
    }
}

fn check_bymonth(date: Date, rule: &RRule) -> bool {
    if rule.by_month.is_empty() {
        return true;
    }
    rule.by_month.contains(&(date.month() as u8))
}

fn check_bymonthday(date: Date, rule: &RRule) -> bool {
    if rule.by_month_day.is_empty() {
        return true;
    }
    let dim = days_in_month(date.year(), date.month());
    rule.by_month_day.iter().any(|&raw| {
        let resolved = if raw > 0 { raw } else { dim + raw + 1 };
        resolved == date.day()
    })
}

fn check_plain_byday(date: Date, rule: &RRule) -> bool {
    let plain: Vec<_> = rule
        .by_day
        .iter()
        .filter(|bd| bd.position.is_none())
        .collect();
    if plain.is_empty() {
        return true;
    }
    plain
        .iter()
        .any(|bd| to_jiff_weekday(bd.weekday) == date.weekday())
}

/// Advance (year, month) by `interval` months, clamping to valid range.
fn add_months(year: i16, month: i8, interval: u32) -> (i16, i8) {
    let total_months = (year as i32) * 12 + (month as i32 - 1) + interval as i32;
    let new_year = (total_months / 12) as i16;
    let new_month = (total_months % 12 + 1) as i8;
    (new_year, new_month)
}
