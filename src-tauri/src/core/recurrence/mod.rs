/// RRULE v1 subset parser and occurrence expander (docs/spec/0008-calendar.md).
///
/// # Usage
///
/// ```rust,ignore
/// use tonotedo_lib::core::recurrence::{parse_rrule, ParseResult, StartDate};
/// use tonotedo_lib::core::recurrence::overrides::{expand_with_overrides, parse_overrides};
///
/// let result = parse_rrule("RRULE:FREQ=WEEKLY;BYDAY=MO");
/// if let ParseResult::Ok(rule) = result {
///     let start = StartDate::Date("2026-01-05".parse().unwrap());
///     let from  = "2026-01-01".parse().unwrap();
///     let to    = "2026-03-31".parse().unwrap();
///     let exp   = expand_with_overrides(&rule, start, from, to, &Default::default());
///     // exp.occurrences: every Monday in Q1 2026
/// }
/// ```
pub mod expand;
pub mod overrides;
pub mod parse;
pub mod types;

// Re-export the most-used surface for convenience.
pub use parse::parse_rrule;
pub use types::{
    ByDay, ExpansionResult, Frequency, Occurrence, OrphanedOverride, OverrideAction, OverridesMap,
    ParseError, ParseResult, RRule, StartDate, UnsupportedFeature, Until, Weekday,
};

#[cfg(test)]
mod tests;
