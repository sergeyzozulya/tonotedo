// Property value model per docs/spec/0002-entries.md §"Properties" and §"Type inference".
//
// Design notes:
// - `Opaque` preserves YAML text verbatim for unknown shapes; it is the round-trip escape hatch
//   required by 0002 ("plugin escape hatch — never silently drop properties").
// - `DatetimeValue` carries an optional explicit UTC offset in seconds.  `Some(0)` = UTC/Z;
//   `None` = zone-naive (allowed per spec 0002 "offset-less allowed = zone-naive").
//   The civil datetime is stored alongside; the two together are sufficient for formatting and
//   for the reconciler to compute a sort key when an offset is present.
// - Range allows mixed endpoints (date vs datetime) — parsed but flagged with `mixed: true`.

use jiff::civil::{Date, DateTime};

/// A typed property value as defined in spec 0002.
#[derive(Debug, Clone, PartialEq)]
pub enum Value {
    /// Plain string (or multi-line `text`).
    String(String),
    /// Numeric value.
    Number(f64),
    /// Boolean.
    Boolean(bool),
    /// Calendar date with no time component.
    Date(Date),
    /// Datetime.
    ///
    /// `offset_seconds`: if `Some`, the value was written with an explicit UTC offset
    /// (e.g. `2026-05-20T14:00+02:00`) — positive = east of UTC.
    /// If `None`, the value was written without an offset (`2026-05-20T14:00`) and is
    /// zone-naive.
    Datetime(DatetimeValue),
    /// Date or datetime range (`<start>..<end>`).
    Range(RangeValue),
    /// Tag or tag array (rendered as chips — spec 0004).
    Tags(Vec<String>),
    /// Enum value (one of a fixed list; list is schema-level, not stored here).
    Enum(String),
    /// Reference to another entry by slug, or array of such refs.
    Refs(Vec<String>),
    /// Unknown YAML shape preserved verbatim (round-trip guarantee).
    Opaque(String),
}

/// A datetime that may or may not carry an explicit UTC offset.
#[derive(Debug, Clone, PartialEq)]
pub struct DatetimeValue {
    /// Civil (wall-clock) datetime.  When `offset_seconds` is `Some`, this is the
    /// local wall-clock time at the stored offset.
    pub civil: DateTime,
    /// UTC offset in seconds (positive = east of UTC).
    /// `None` when the value was written without an offset (zone-naive).
    pub offset_seconds: Option<i32>,
}

impl DatetimeValue {
    /// Create an offset-less (zone-naive) datetime.
    pub fn naive(civil: DateTime) -> Self {
        Self {
            civil,
            offset_seconds: None,
        }
    }

    /// Create a datetime with an explicit offset.
    pub fn with_offset(civil: DateTime, offset_seconds: i32) -> Self {
        Self {
            civil,
            offset_seconds: Some(offset_seconds),
        }
    }

    /// Whether an explicit offset is present.
    pub fn has_offset(&self) -> bool {
        self.offset_seconds.is_some()
    }
}

/// A range with two endpoints of possibly different kinds.
#[derive(Debug, Clone, PartialEq)]
pub struct RangeValue {
    pub start: RangeEndpoint,
    pub end: RangeEndpoint,
    /// True when start and end are of different kinds (one date, one datetime).
    /// The spec says mixed endpoints "parse but flag".
    pub mixed: bool,
}

/// One endpoint of a range.
#[derive(Debug, Clone, PartialEq)]
pub enum RangeEndpoint {
    Date(Date),
    Datetime(DatetimeValue),
}

impl RangeEndpoint {
    pub fn is_date(&self) -> bool {
        matches!(self, RangeEndpoint::Date(_))
    }

    pub fn is_datetime(&self) -> bool {
        matches!(self, RangeEndpoint::Datetime(_))
    }
}
