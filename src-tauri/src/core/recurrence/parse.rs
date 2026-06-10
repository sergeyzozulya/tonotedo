/// Parse an RRULE string into a typed struct (v1 subset).
///
/// Accepts both the bare form (`FREQ=WEEKLY;BYDAY=MO`) and the prefixed form
/// (`RRULE:FREQ=WEEKLY;BYDAY=MO`).  The prefix is stripped before parsing.
use std::collections::HashSet;

use super::types::{
    ByDay, Frequency, ParseError, ParseResult, RRule, UnsupportedFeature, Until, Weekday,
};

/// Parse an RRULE string.  Returns [`ParseResult`].
pub fn parse_rrule(input: &str) -> ParseResult {
    let body = input.trim();
    // Strip optional "RRULE:" prefix (case-insensitive per RFC 5545).
    let body = body
        .strip_prefix("RRULE:")
        .or_else(|| body.strip_prefix("rrule:"))
        .unwrap_or(body);

    if body.is_empty() {
        return ParseResult::Malformed(ParseError {
            message: "empty RRULE".into(),
        });
    }

    let mut freq: Option<Frequency> = None;
    let mut interval: Option<u32> = None;
    let mut count: Option<u32> = None;
    let mut until: Option<jiff::civil::Date> = None;
    let mut by_day: Vec<ByDay> = Vec::new();
    let mut by_month_day: Vec<i8> = Vec::new();
    let mut by_month: Vec<u8> = Vec::new();

    let mut unsupported: Vec<UnsupportedFeature> = Vec::new();
    let mut seen_keys: HashSet<String> = HashSet::new();

    for part in body.split(';') {
        let part = part.trim();
        if part.is_empty() {
            continue;
        }
        let (key, val) = match part.split_once('=') {
            Some(pair) => pair,
            None => {
                return ParseResult::Malformed(ParseError {
                    message: format!("expected KEY=VALUE, got {part:?}"),
                });
            }
        };
        let key_upper = key.to_uppercase();

        if !seen_keys.insert(key_upper.clone()) {
            return ParseResult::Malformed(ParseError {
                message: format!("duplicate key: {key_upper}"),
            });
        }

        match key_upper.as_str() {
            "FREQ" => match parse_freq(val) {
                Ok(f) => freq = Some(f),
                Err(uf) => unsupported.push(uf),
            },
            "INTERVAL" => match val.parse::<u32>() {
                Ok(n) if n >= 1 => interval = Some(n),
                _ => {
                    return ParseResult::Malformed(ParseError {
                        message: format!("INTERVAL must be a positive integer, got {val:?}"),
                    });
                }
            },
            "COUNT" => match val.parse::<u32>() {
                Ok(n) => count = Some(n),
                _ => {
                    return ParseResult::Malformed(ParseError {
                        message: format!("COUNT must be a non-negative integer, got {val:?}"),
                    });
                }
            },
            "UNTIL" => match parse_until_date(val) {
                Ok(d) => until = Some(d),
                Err(e) => return ParseResult::Malformed(e),
            },
            "BYDAY" => match parse_by_day(val) {
                Ok(days) => by_day = days,
                Err(e) => return ParseResult::Malformed(e),
            },
            "BYMONTHDAY" => match parse_by_month_day(val) {
                Ok(days) => by_month_day = days,
                Err(e) => return ParseResult::Malformed(e),
            },
            "BYMONTH" => match parse_by_month(val) {
                Ok(months) => by_month = months,
                Err(e) => return ParseResult::Malformed(e),
            },
            // Explicitly unsupported features — named in the spec.
            "BYSETPOS" => unsupported.push(UnsupportedFeature::BySetPos),
            "BYWEEKNO" => unsupported.push(UnsupportedFeature::ByWeekNo),
            "BYYEARDAY" => unsupported.push(UnsupportedFeature::ByYearDay),
            "BYHOUR" => unsupported.push(UnsupportedFeature::ByHour),
            "BYMINUTE" => unsupported.push(UnsupportedFeature::ByMinute),
            "BYSECOND" => unsupported.push(UnsupportedFeature::BySecond),
            "WKST" => unsupported.push(UnsupportedFeature::Wkst),
            other => unsupported.push(UnsupportedFeature::Unknown(other.to_string())),
        }
    }

    // If any unsupported features were found, return early regardless of
    // whether the supported parts would parse cleanly.
    if !unsupported.is_empty() {
        return ParseResult::Unsupported(unsupported);
    }

    // FREQ is mandatory.
    let freq = match freq {
        Some(f) => f,
        None => {
            return ParseResult::Malformed(ParseError {
                message: "FREQ is required".into(),
            });
        }
    };

    // COUNT and UNTIL are mutually exclusive (RFC 5545 §3.3.10).
    let until_term = match (count, until) {
        (Some(_), Some(_)) => {
            return ParseResult::Malformed(ParseError {
                message: "COUNT and UNTIL are mutually exclusive".into(),
            });
        }
        (Some(n), None) => Some(Until::Count(n)),
        (None, Some(d)) => Some(Until::Date(d)),
        (None, None) => None,
    };

    ParseResult::Ok(RRule {
        freq,
        interval: interval.unwrap_or(1),
        until: until_term,
        by_day,
        by_month_day,
        by_month,
    })
}

fn parse_freq(val: &str) -> Result<Frequency, UnsupportedFeature> {
    match val.to_uppercase().as_str() {
        "DAILY" => Ok(Frequency::Daily),
        "WEEKLY" => Ok(Frequency::Weekly),
        "MONTHLY" => Ok(Frequency::Monthly),
        "YEARLY" => Ok(Frequency::Yearly),
        other => Err(UnsupportedFeature::Frequency(other.to_string())),
    }
}

/// Parse an UNTIL date value.  RFC 5545 allows DATE or DATE-TIME; we accept:
///   - `YYYYMMDD`          → date
///   - `YYYYMMDDTHHmmssZ`  → we extract just the date (zone-naive expansion)
///   - ISO `YYYY-MM-DD`    → also accepted for convenience
fn parse_until_date(val: &str) -> Result<jiff::civil::Date, ParseError> {
    // ISO form YYYY-MM-DD
    if val.len() == 10 && val.chars().nth(4) == Some('-') {
        return val.parse::<jiff::civil::Date>().map_err(|e| ParseError {
            message: e.to_string(),
        });
    }
    // iCalendar compact form YYYYMMDD or YYYYMMDDTHHmmssZ
    let date_part = if val.len() >= 8 { &val[..8] } else { val };
    if date_part.len() == 8 && date_part.chars().all(|c| c.is_ascii_digit()) {
        let y: i16 = date_part[0..4].parse().map_err(|_| ParseError {
            message: format!("bad UNTIL year in {val:?}"),
        })?;
        let m: i8 = date_part[4..6].parse().map_err(|_| ParseError {
            message: format!("bad UNTIL month in {val:?}"),
        })?;
        let d: i8 = date_part[6..8].parse().map_err(|_| ParseError {
            message: format!("bad UNTIL day in {val:?}"),
        })?;
        return jiff::civil::Date::new(y, m, d).map_err(|e| ParseError {
            message: e.to_string(),
        });
    }
    Err(ParseError {
        message: format!("unrecognized UNTIL format: {val:?}"),
    })
}

/// Parse a BYDAY value such as `MO`, `MO,WE,FR`, `1MO`, `-1FR`, `1MO,-1FR`.
fn parse_by_day(val: &str) -> Result<Vec<ByDay>, ParseError> {
    val.split(',')
        .map(|s| parse_single_byday(s.trim()))
        .collect()
}

fn parse_single_byday(s: &str) -> Result<ByDay, ParseError> {
    if s.len() < 2 {
        return Err(ParseError {
            message: format!("invalid BYDAY entry: {s:?}"),
        });
    }
    // The last two characters are the weekday abbreviation.
    let (prefix, wd_str) = s.split_at(s.len() - 2);
    let weekday = parse_weekday(wd_str)?;
    let position = if prefix.is_empty() {
        None
    } else {
        let n: i8 = prefix.parse().map_err(|_| ParseError {
            message: format!("invalid positional prefix {prefix:?} in BYDAY entry {s:?}"),
        })?;
        if n == 0 {
            return Err(ParseError {
                message: "BYDAY positional prefix must not be zero".into(),
            });
        }
        Some(n)
    };
    Ok(ByDay { position, weekday })
}

fn parse_weekday(s: &str) -> Result<Weekday, ParseError> {
    match s.to_uppercase().as_str() {
        "MO" => Ok(Weekday::Mo),
        "TU" => Ok(Weekday::Tu),
        "WE" => Ok(Weekday::We),
        "TH" => Ok(Weekday::Th),
        "FR" => Ok(Weekday::Fr),
        "SA" => Ok(Weekday::Sa),
        "SU" => Ok(Weekday::Su),
        other => Err(ParseError {
            message: format!("unknown weekday: {other:?}"),
        }),
    }
}

fn parse_by_month_day(val: &str) -> Result<Vec<i8>, ParseError> {
    val.split(',')
        .map(|s| {
            let s = s.trim();
            s.parse::<i8>().map_err(|_| ParseError {
                message: format!("invalid BYMONTHDAY value: {s:?}"),
            })
        })
        .collect()
}

fn parse_by_month(val: &str) -> Result<Vec<u8>, ParseError> {
    val.split(',')
        .map(|s| {
            let s = s.trim();
            let n: u8 = s.parse().map_err(|_| ParseError {
                message: format!("invalid BYMONTH value: {s:?}"),
            })?;
            if !(1..=12).contains(&n) {
                return Err(ParseError {
                    message: format!("BYMONTH value {n} out of range 1–12"),
                });
            }
            Ok(n)
        })
        .collect()
}
