/// Core types for the RRULE v1 subset (docs/spec/0008-calendar.md).
///
/// # Dependency decision: `rrule` crate vs direct implementation
///
/// We implement the subset directly rather than wrapping the `rrule` crate
/// (https://crates.io/crates/rrule) for three reasons:
///
/// 1. **Ownership of the rejection contract.** The spec requires a structured
///    "unsupported RRULE feature: X" warning for anything outside the v1 subset.
///    The `rrule` crate does not model rejection as a typed value — it either
///    parses successfully (full RFC 5545) or returns an opaque error.  Wrapping
///    it would require parsing the string ourselves anyway to detect forbidden
///    parts before handing the clean remainder to the library.
///
/// 2. **Small, enumerable subset.** FREQ ∈ {DAILY,WEEKLY,MONTHLY,YEARLY},
///    INTERVAL, COUNT, UNTIL, BYDAY (with positional prefix), BYMONTHDAY
///    (with negatives), BYMONTH — this is under 100 lines of grammar.  Writing
///    it directly is simpler than adding a full-RFC crate and fencing it.
///
/// 3. **Zero extra transitive deps.** The `rrule` crate pulls in `chrono` and
///    several others; we are converging on `jiff` across the codebase (the
///    sibling Phase 2 agent made the same choice).  Mixing two date libraries
///    for no gain is a maintenance hazard.
///
/// Dates: `jiff` 0.2.  All arithmetic is zone-naive (`jiff::civil::Date` /
/// `jiff::civil::DateTime`) because the spec stores offsets at the storage layer
/// and expands occurrences in the machine's local zone at render time.  The
/// caller handles zone conversion before and after calling these functions.
use std::collections::HashMap;

/// The frequency component of an RRULE.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Frequency {
    Daily,
    Weekly,
    Monthly,
    Yearly,
}

/// A weekday name, Monday-indexed to match iCalendar.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Weekday {
    Mo,
    Tu,
    We,
    Th,
    Fr,
    Sa,
    Su,
}

impl Weekday {
    /// Return the iCalendar two-letter abbreviation.
    pub fn as_str(self) -> &'static str {
        match self {
            Weekday::Mo => "MO",
            Weekday::Tu => "TU",
            Weekday::We => "WE",
            Weekday::Th => "TH",
            Weekday::Fr => "FR",
            Weekday::Sa => "SA",
            Weekday::Su => "SU",
        }
    }
}

/// A BYDAY entry: optionally positional (e.g. `1MO`, `-1FR`), otherwise plain.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ByDay {
    /// None = every matching weekday; Some(n) = nth occurrence in the month
    /// (positive from start, negative from end).
    pub position: Option<i8>,
    pub weekday: Weekday,
}

/// The termination condition.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Until {
    /// Terminate after exactly N occurrences (counted from rule start).
    Count(u32),
    /// Terminate at or before this date (RFC 5545: inclusive).
    Date(jiff::civil::Date),
}

/// A parsed, validated RRULE (v1 subset only).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RRule {
    pub freq: Frequency,
    /// Default 1.
    pub interval: u32,
    pub until: Option<Until>,
    /// BYDAY values (multiple allowed).
    pub by_day: Vec<ByDay>,
    /// BYMONTHDAY values (multiple allowed; negatives = from month end).
    pub by_month_day: Vec<i8>,
    /// BYMONTH values (1–12, multiple allowed).
    pub by_month: Vec<u8>,
}

/// Names of unsupported RRULE features for the structured warning.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UnsupportedFeature {
    Frequency(String),
    BySetPos,
    ByWeekNo,
    ByYearDay,
    ByHour,
    ByMinute,
    BySecond,
    Wkst,
    RDate,
    ExDate,
    Unknown(String),
}

impl std::fmt::Display for UnsupportedFeature {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            UnsupportedFeature::Frequency(s) => write!(f, "FREQ={s}"),
            UnsupportedFeature::BySetPos => write!(f, "BYSETPOS"),
            UnsupportedFeature::ByWeekNo => write!(f, "BYWEEKNO"),
            UnsupportedFeature::ByYearDay => write!(f, "BYYEARDAY"),
            UnsupportedFeature::ByHour => write!(f, "BYHOUR"),
            UnsupportedFeature::ByMinute => write!(f, "BYMINUTE"),
            UnsupportedFeature::BySecond => write!(f, "BYSECOND"),
            UnsupportedFeature::Wkst => write!(f, "WKST"),
            UnsupportedFeature::RDate => write!(f, "RDATE"),
            UnsupportedFeature::ExDate => write!(f, "EXDATE"),
            UnsupportedFeature::Unknown(s) => write!(f, "{s}"),
        }
    }
}

/// Parse error for malformed (as opposed to merely unsupported) RRULE strings.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParseError {
    pub message: String,
}

impl std::fmt::Display for ParseError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "invalid RRULE: {}", self.message)
    }
}

impl std::error::Error for ParseError {}

/// The result of attempting to parse an RRULE string.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ParseResult {
    /// Parsed successfully.
    Ok(RRule),
    /// The string is well-formed but uses features outside the v1 subset.
    /// The caller renders the source date as a single occurrence and surfaces
    /// the warning to the user.
    Unsupported(Vec<UnsupportedFeature>),
    /// The string is malformed (missing FREQ, duplicate keys, bad value, etc.).
    Malformed(ParseError),
}

/// A date value that a recurring entry's primary property can hold.
/// Zone-naive arithmetic; the caller resolves the offset before and after.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum StartDate {
    Date(jiff::civil::Date),
    DateTime(jiff::civil::DateTime),
}

impl StartDate {
    /// Return the civil date, discarding any time component.
    pub fn date(self) -> jiff::civil::Date {
        match self {
            StartDate::Date(d) => d,
            StartDate::DateTime(dt) => dt.date(),
        }
    }
}

/// An action from the `overrides` map on a source entry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OverrideAction {
    /// Move this occurrence to a different date.
    MoveTo(jiff::civil::Date),
    /// Skip (suppress) this occurrence.
    Skip,
}

/// The `overrides` map: original occurrence date → action.
/// The key is the ISO date string as stored in YAML (`"2026-05-25"`).
pub type OverridesMap = HashMap<String, OverrideAction>;

/// A single resolved occurrence after applying overrides.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Occurrence {
    /// The original date as produced by the rule (before override).
    pub original: jiff::civil::Date,
    /// The effective date after applying any override (same as `original` if
    /// no override applies).
    pub effective: jiff::civil::Date,
    /// Whether this occurrence was moved by an override.
    pub moved: bool,
}

/// An override key that no longer corresponds to any occurrence within the
/// generous expansion horizon (see `expand_with_overrides`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OrphanedOverride {
    /// The key as it appeared in the map.
    pub key: String,
    pub action: OverrideAction,
}

/// Output of `expand_with_overrides`.
#[derive(Debug, Clone)]
pub struct ExpansionResult {
    /// Occurrences whose effective date falls within [window_from, window_to].
    pub occurrences: Vec<Occurrence>,
    /// Override keys not found in the full expansion (orphaned).
    pub orphaned: Vec<OrphanedOverride>,
}
