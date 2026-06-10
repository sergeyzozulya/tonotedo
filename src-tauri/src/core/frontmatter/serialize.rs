// Canonical YAML serialization per spec 0002 §"Frontmatter write order".
//
// Order: built-ins first (id, created, updated, tags, mentions), then schema-ordered
// user properties (via optional hint), then remaining alphabetically.  Unknown/opaque
// values go in the alphabetical bucket unchanged.
//
// Design goals:
// - Deterministic: same input → byte-identical output.
// - Opaque values are emitted verbatim (round-trip guarantee).
// - `title` is NEVER written (derived from body H1).

use std::collections::{BTreeMap, HashSet};

use super::value::{DatetimeValue, RangeEndpoint, RangeValue, Value};

/// Built-in property names in canonical write order (`title` excluded — never serialized).
pub const BUILTIN_ORDER: &[&str] = &["id", "created", "updated", "tags", "mentions"];

/// Serialize a property map to YAML frontmatter text (including the `---` fences).
///
/// `schema_order` is an optional slice of property names that should appear after
/// built-ins but before the alphabetical remainder.  Pass `&[]` when no schema is
/// available.
///
/// The returned string ends with `\n` so it can be directly concatenated with the body.
pub fn serialize_frontmatter(props: &BTreeMap<String, Value>, schema_order: &[&str]) -> String {
    let mut out = String::from("---\n");

    let builtin_set: HashSet<&str> = BUILTIN_ORDER.iter().copied().collect();
    let schema_set: HashSet<&str> = schema_order.iter().copied().collect();

    // 1. Built-ins in fixed order.
    for &name in BUILTIN_ORDER {
        if let Some(v) = props.get(name) {
            write_property(&mut out, name, v);
        }
    }

    // 2. Schema-ordered user properties (skip built-ins).
    for &name in schema_order {
        if builtin_set.contains(name) {
            continue;
        }
        if let Some(v) = props.get(name) {
            write_property(&mut out, name, v);
        }
    }

    // 3. Remaining properties in alphabetical order (covers unknowns too).
    let mut remaining: Vec<&str> = props
        .keys()
        .map(String::as_str)
        .filter(|&k| !builtin_set.contains(k) && !schema_set.contains(k) && k != "title")
        .collect();
    remaining.sort_unstable();

    for name in remaining {
        if let Some(v) = props.get(name) {
            write_property(&mut out, name, v);
        }
    }

    out.push_str("---\n");
    out
}

/// Write a single `key: value\n` line (or multi-line block) into `out`.
fn write_property(out: &mut String, key: &str, value: &Value) {
    match value {
        Value::String(s) => {
            if needs_quoting(s) {
                out.push_str(&format!("{key}: {}\n", quote_yaml_string(s)));
            } else {
                out.push_str(&format!("{key}: {s}\n"));
            }
        }
        Value::Number(n) => {
            if n.fract() == 0.0 && n.abs() < 1e15 {
                out.push_str(&format!("{key}: {}\n", *n as i64));
            } else {
                out.push_str(&format!("{key}: {n}\n"));
            }
        }
        Value::Boolean(b) => {
            out.push_str(&format!("{key}: {b}\n"));
        }
        Value::Date(d) => {
            // Singlequote to prevent YAML from re-parsing the date as a scalar.
            out.push_str(&format!("{key}: '{}'\n", format_date(*d)));
        }
        Value::Datetime(dt) => {
            out.push_str(&format!("{key}: '{}'\n", format_datetime(dt)));
        }
        Value::Range(r) => {
            out.push_str(&format!("{key}: '{}'\n", format_range(r)));
        }
        Value::Tags(tags) => {
            if tags.is_empty() {
                out.push_str(&format!("{key}: []\n"));
            } else {
                out.push_str(&format!("{key}:\n"));
                for tag in tags {
                    if needs_quoting(tag) {
                        out.push_str(&format!("  - {}\n", quote_yaml_string(tag)));
                    } else {
                        out.push_str(&format!("  - {tag}\n"));
                    }
                }
            }
        }
        Value::Enum(s) => {
            if needs_quoting(s) {
                out.push_str(&format!("{key}: {}\n", quote_yaml_string(s)));
            } else {
                out.push_str(&format!("{key}: {s}\n"));
            }
        }
        Value::Refs(refs) => {
            if refs.is_empty() {
                out.push_str(&format!("{key}: []\n"));
            } else if refs.len() == 1 {
                out.push_str(&format!("{key}: {}\n", refs[0]));
            } else {
                out.push_str(&format!("{key}:\n"));
                for r in refs {
                    out.push_str(&format!("  - {r}\n"));
                }
            }
        }
        Value::Opaque(raw) => {
            // Emit verbatim; raw already contains the value text for round-trip.
            out.push_str(&format!("{key}: {raw}\n"));
        }
    }
}

// ── Formatters ────────────────────────────────────────────────────────────────

/// Format a `jiff::civil::Date` as `YYYY-MM-DD`.
pub fn format_date(d: jiff::civil::Date) -> String {
    format!("{:04}-{:02}-{:02}", d.year(), d.month(), d.day())
}

/// Format a `DatetimeValue` as an ISO 8601 string.
pub fn format_datetime(dt: &DatetimeValue) -> String {
    let c = &dt.civil;
    let base = if c.second() != 0 {
        format!(
            "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}",
            c.year(),
            c.month(),
            c.day(),
            c.hour(),
            c.minute(),
            c.second()
        )
    } else {
        format!(
            "{:04}-{:02}-{:02}T{:02}:{:02}",
            c.year(),
            c.month(),
            c.day(),
            c.hour(),
            c.minute()
        )
    };

    match dt.offset_seconds {
        None => base,
        Some(0) => format!("{base}Z"),
        Some(secs) => {
            let sign = if secs >= 0 { '+' } else { '-' };
            let abs = secs.unsigned_abs();
            let hh = abs / 3600;
            let mm = (abs % 3600) / 60;
            format!("{base}{sign}{hh:02}:{mm:02}")
        }
    }
}

fn format_range_endpoint(ep: &RangeEndpoint) -> String {
    match ep {
        RangeEndpoint::Date(d) => format_date(*d),
        RangeEndpoint::Datetime(dt) => format_datetime(dt),
    }
}

/// Format a `RangeValue` as `<start>..<end>`.
pub fn format_range(r: &RangeValue) -> String {
    format!(
        "{}..{}",
        format_range_endpoint(&r.start),
        format_range_endpoint(&r.end)
    )
}

// ── YAML string quoting ───────────────────────────────────────────────────────

/// Returns true when a string needs quoting to round-trip through YAML safely.
fn needs_quoting(s: &str) -> bool {
    if s.is_empty() {
        return true;
    }
    matches!(
        s.to_lowercase().as_str(),
        "true" | "false" | "yes" | "no" | "on" | "off" | "null" | "~"
    ) || s.starts_with([
        ':', '#', '&', '*', '?', '|', '-', '<', '>', '=', '!', '%', '@', '`',
    ]) || s.contains('\n')
        || s.contains(": ")
        || s.starts_with(' ')
        || s.ends_with(' ')
}

/// Wrap a string in double quotes, escaping internal double quotes and backslashes.
fn quote_yaml_string(s: &str) -> String {
    let escaped = s
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('\n', "\\n");
    format!("\"{escaped}\"")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::frontmatter::value::DatetimeValue;
    use jiff::civil::{Date, DateTime};
    use std::collections::BTreeMap;

    fn make_date(y: i16, m: i8, d: i8) -> Date {
        Date::new(y, m, d).unwrap()
    }

    fn make_dt_offset(y: i16, mo: i8, d: i8, h: i8, mi: i8, s: i8, off: i32) -> DatetimeValue {
        let civil = DateTime::new(y, mo, d, h, mi, s, 0).unwrap();
        DatetimeValue::with_offset(civil, off)
    }

    fn make_dt_naive(y: i16, mo: i8, d: i8, h: i8, mi: i8) -> DatetimeValue {
        let civil = DateTime::new(y, mo, d, h, mi, 0, 0).unwrap();
        DatetimeValue::naive(civil)
    }

    // ── format_date ──────────────────────────────────────────────────────────

    #[test]
    fn format_date_basic() {
        assert_eq!(format_date(make_date(2026, 5, 20)), "2026-05-20");
    }

    #[test]
    fn format_date_zero_padding() {
        assert_eq!(format_date(make_date(2026, 1, 5)), "2026-01-05");
    }

    // ── format_datetime ──────────────────────────────────────────────────────

    #[test]
    fn format_datetime_with_positive_offset() {
        let dt = make_dt_offset(2026, 5, 20, 14, 0, 0, 7200);
        assert_eq!(format_datetime(&dt), "2026-05-20T14:00+02:00");
    }

    #[test]
    fn format_datetime_utc() {
        let dt = make_dt_offset(2026, 5, 20, 14, 0, 0, 0);
        assert_eq!(format_datetime(&dt), "2026-05-20T14:00Z");
    }

    #[test]
    fn format_datetime_negative_offset() {
        let dt = make_dt_offset(2026, 5, 20, 9, 0, 0, -18000);
        assert_eq!(format_datetime(&dt), "2026-05-20T09:00-05:00");
    }

    #[test]
    fn format_datetime_naive() {
        let dt = make_dt_naive(2026, 5, 20, 14, 30);
        assert_eq!(format_datetime(&dt), "2026-05-20T14:30");
    }

    #[test]
    fn format_datetime_with_seconds() {
        let dt = make_dt_offset(2026, 5, 20, 14, 30, 45, 3600);
        assert_eq!(format_datetime(&dt), "2026-05-20T14:30:45+01:00");
    }

    // ── canonical write order ────────────────────────────────────────────────

    #[test]
    fn canonical_order_builtins_first() {
        let mut props = BTreeMap::new();
        props.insert("zebra".to_string(), Value::String("last".to_string()));
        props.insert("id".to_string(), Value::String("abc123".to_string()));
        props.insert("alpha".to_string(), Value::String("also-last".to_string()));
        props.insert(
            "updated".to_string(),
            Value::Datetime(make_dt_offset(2026, 1, 1, 0, 0, 0, 0)),
        );

        let out = serialize_frontmatter(&props, &[]);
        let lines: Vec<&str> = out.lines().collect();
        assert_eq!(lines[1], "id: abc123");
        assert!(lines[2].starts_with("updated:"));
        let alpha_pos = lines.iter().position(|l| l.starts_with("alpha:")).unwrap();
        let zebra_pos = lines.iter().position(|l| l.starts_with("zebra:")).unwrap();
        assert!(alpha_pos < zebra_pos);
    }

    #[test]
    fn title_never_serialized() {
        let mut props = BTreeMap::new();
        props.insert("id".to_string(), Value::String("x".to_string()));
        props.insert("title".to_string(), Value::String("My Title".to_string()));
        let out = serialize_frontmatter(&props, &[]);
        assert!(
            !out.contains("title:"),
            "title must never appear in serialized frontmatter"
        );
    }

    #[test]
    fn schema_order_between_builtins_and_alpha() {
        let mut props = BTreeMap::new();
        props.insert("id".to_string(), Value::String("x".to_string()));
        props.insert("status".to_string(), Value::String("open".to_string()));
        props.insert("alpha_extra".to_string(), Value::String("z".to_string()));

        let out = serialize_frontmatter(&props, &["status"]);
        let lines: Vec<&str> = out.lines().collect();
        let id_pos = lines.iter().position(|l| l.starts_with("id:")).unwrap();
        let status_pos = lines.iter().position(|l| l.starts_with("status:")).unwrap();
        let alpha_pos = lines
            .iter()
            .position(|l| l.starts_with("alpha_extra:"))
            .unwrap();
        assert!(id_pos < status_pos, "id (builtin) before schema prop");
        assert!(
            status_pos < alpha_pos,
            "schema prop before alphabetical remainder"
        );
    }

    #[test]
    fn empty_tags_serialized_as_empty_list() {
        let mut props = BTreeMap::new();
        props.insert("tags".to_string(), Value::Tags(vec![]));
        let out = serialize_frontmatter(&props, &[]);
        assert!(out.contains("tags: []"));
    }

    #[test]
    fn tags_serialized_as_list() {
        let mut props = BTreeMap::new();
        props.insert(
            "tags".to_string(),
            Value::Tags(vec!["rust".to_string(), "code".to_string()]),
        );
        let out = serialize_frontmatter(&props, &[]);
        assert!(out.contains("tags:\n  - rust\n  - code"));
    }

    #[test]
    fn opaque_value_emitted_verbatim() {
        let mut props = BTreeMap::new();
        props.insert(
            "custom".to_string(),
            Value::Opaque("{nested: {deep: true}}".to_string()),
        );
        let out = serialize_frontmatter(&props, &[]);
        assert!(out.contains("custom: {nested: {deep: true}}"));
    }

    #[test]
    fn boolean_false_serialized() {
        let mut props = BTreeMap::new();
        props.insert("archived".to_string(), Value::Boolean(false));
        let out = serialize_frontmatter(&props, &[]);
        assert!(out.contains("archived: false"));
    }

    #[test]
    fn number_integer_no_decimal() {
        let mut props = BTreeMap::new();
        props.insert("rating".to_string(), Value::Number(5.0));
        let out = serialize_frontmatter(&props, &[]);
        assert!(out.contains("rating: 5\n"));
    }

    #[test]
    fn serialize_deterministic() {
        let mut props = BTreeMap::new();
        props.insert("id".to_string(), Value::String("abc".to_string()));
        props.insert("zebra".to_string(), Value::String("z".to_string()));
        props.insert("alpha".to_string(), Value::String("a".to_string()));

        let out1 = serialize_frontmatter(&props, &[]);
        let out2 = serialize_frontmatter(&props, &[]);
        assert_eq!(out1, out2, "serialization must be deterministic");
    }

    #[test]
    fn needs_quoting_special_values() {
        assert!(needs_quoting("true"));
        assert!(needs_quoting("false"));
        assert!(needs_quoting("null"));
        assert!(needs_quoting(""));
        assert!(!needs_quoting("hello"));
        assert!(!needs_quoting("my-note"));
    }

    #[test]
    fn range_serialized_with_quotes() {
        use crate::core::frontmatter::value::{RangeEndpoint, RangeValue};
        let mut props = BTreeMap::new();
        let start = RangeEndpoint::Date(make_date(2026, 6, 1));
        let end = RangeEndpoint::Date(make_date(2026, 6, 5));
        props.insert(
            "due".to_string(),
            Value::Range(RangeValue {
                start,
                end,
                mixed: false,
            }),
        );
        let out = serialize_frontmatter(&props, &[]);
        assert!(out.contains("due: '2026-06-01..2026-06-05'"));
    }
}
