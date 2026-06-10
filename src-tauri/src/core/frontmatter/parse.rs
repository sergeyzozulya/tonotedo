// Parsing: raw bytes → split frontmatter + body, then YAML → typed Values.
//
// Non-error contract (spec 0002 §"Edge cases / Malformed frontmatter"):
//   Malformed YAML → entry with zero properties + a warning string; never a hard error.
//
// YAML crate: saphyr 0.0.6 (maintained fork of yaml-rust, YAML 1.2).
// We use YamlOwned (owned, no input lifetimes) so the parsed tree is freely storable.
// The raw API is preferred over serde-saphyr because we need verbatim round-trip for
// opaque/unknown values, and serde coercions would lose structural fidelity.

use std::collections::BTreeMap;

use jiff::civil::{Date, DateTime};
use saphyr::{LoadableYamlNode, ScalarOwned, YamlOwned};

use super::value::{DatetimeValue, RangeEndpoint, RangeValue, Value};

// ── Raw split ────────────────────────────────────────────────────────────────

/// Result of splitting the file bytes into frontmatter and body.
pub struct RawSplit {
    /// YAML text between the `---` fences (empty string if no frontmatter).
    pub yaml_text: String,
    /// Everything after the closing `---\n` (or the entire file if no frontmatter).
    pub body: String,
    /// True when a `---` opening fence was present (even if YAML was empty/malformed).
    pub had_fence: bool,
}

/// Split `.md` file bytes into optional frontmatter + body.
///
/// Rules:
/// - File must start with exactly `---\n` (or `---\r\n`) for frontmatter to be detected.
/// - Closing fence is the next line that is exactly `---` (with optional CR before LF).
/// - Everything after the closing fence's newline is the body, **byte-exact** (no modifications).
/// - If no opening fence, the whole file is the body.
/// - BOM (`\xEF\xBB\xBF`) is tolerated: strip before fence check; body returned byte-exact.
pub fn split_frontmatter(source: &[u8]) -> RawSplit {
    let text = String::from_utf8_lossy(source);

    // Strip optional UTF-8 BOM from the logical view only.
    let stripped = text.strip_prefix('\u{FEFF}').unwrap_or(&text);

    // Must start with `---` followed immediately by a newline.
    let after_open = if let Some(rest) = stripped.strip_prefix("---\r\n") {
        rest
    } else if let Some(rest) = stripped.strip_prefix("---\n") {
        rest
    } else {
        return RawSplit {
            yaml_text: String::new(),
            body: stripped.to_string(),
            had_fence: false,
        };
    };

    // Find the closing `---` fence.
    match find_close_fence(after_open) {
        None => {
            // No closing fence → treat whole content as body (malformed).
            RawSplit {
                yaml_text: String::new(),
                body: stripped.to_string(),
                had_fence: false,
            }
        }
        Some((yaml_end, body_start)) => {
            let yaml_text = after_open[..yaml_end].to_string();
            let body = after_open[body_start..].to_string();
            RawSplit {
                yaml_text,
                body,
                had_fence: true,
            }
        }
    }
}

/// Find the closing `---` fence in the text that follows the opening fence.
///
/// Returns `(yaml_end_byte, body_start_byte)` within `text`, or `None` if not found.
fn find_close_fence(text: &str) -> Option<(usize, usize)> {
    let mut pos = 0;
    while pos < text.len() {
        let line_end = text[pos..]
            .find('\n')
            .map(|i| pos + i + 1)
            .unwrap_or(text.len());
        let raw_line = &text[pos..line_end];
        let line = raw_line.trim_end_matches('\n').trim_end_matches('\r');
        if line == "---" {
            return Some((pos, line_end));
        }
        let next = if line_end > pos { line_end } else { pos + 1 };
        pos = next;
    }
    None
}

// ── YAML → typed properties ───────────────────────────────────────────────────

/// Parse YAML text into an ordered map of property name → Value.
///
/// On YAML parse error, returns `(empty map, Some(warning))`.
/// Unknown / unrecognised value shapes are preserved as `Value::Opaque(yaml_text)`.
pub fn parse_yaml_properties(yaml_text: &str) -> (BTreeMap<String, Value>, Option<String>) {
    if yaml_text.trim().is_empty() {
        return (BTreeMap::new(), None);
    }

    let docs = match YamlOwned::load_from_str(yaml_text) {
        Ok(d) => d,
        Err(e) => {
            return (BTreeMap::new(), Some(format!("malformed frontmatter: {e}")));
        }
    };

    let doc = match docs.into_iter().next() {
        None => return (BTreeMap::new(), None),
        Some(d) => d,
    };

    let mapping = match doc.as_mapping() {
        Some(m) => m,
        None => {
            if doc.is_null() {
                return (BTreeMap::new(), None);
            }
            return (
                BTreeMap::new(),
                Some("malformed frontmatter: top-level YAML value is not a mapping".to_string()),
            );
        }
    };

    let mut map = BTreeMap::new();
    // Iterate by cloning to avoid lifetime issues (YamlOwned is cheap to clone for typical
    // frontmatter sizes: tens of properties, short strings).
    let pairs: Vec<(YamlOwned, YamlOwned)> = mapping
        .iter()
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();

    for (k, v) in pairs {
        let key = yaml_owned_to_key_string(&k);
        let value = infer_value(&v, None);
        map.insert(key, value);
    }

    (map, None)
}

/// Extract a string key from a `YamlOwned` key node.
fn yaml_owned_to_key_string(yaml: &YamlOwned) -> String {
    if let Some(s) = yaml.as_str() {
        return s.to_string();
    }
    if let Some(i) = yaml.as_integer() {
        return i.to_string();
    }
    yaml_owned_to_string(yaml)
}

// ── Type inference ────────────────────────────────────────────────────────────

/// Convert a raw `YamlOwned` node to a typed `Value`.
///
/// `declared_type` is an optional schema hint that wins over inference (spec 0002
/// §"Type inference").  This is the hook for Phase 3 schema integration.
pub fn infer_value(yaml: &YamlOwned, declared_type: Option<&str>) -> Value {
    match declared_type {
        Some("string") | Some("text") => return Value::String(yaml_owned_to_string(yaml)),
        Some("number") => {
            if let Some(n) = yaml_as_number(yaml) {
                return Value::Number(n);
            }
        }
        Some("boolean") => {
            if let Some(b) = yaml.as_bool() {
                return Value::Boolean(b);
            }
        }
        Some("date") => {
            if let Some(s) = yaml.as_str() {
                if let Some(d) = parse_date(s) {
                    return Value::Date(d);
                }
            }
        }
        Some("datetime") => {
            if let Some(s) = yaml.as_str() {
                if let Some(dt) = parse_datetime(s) {
                    return Value::Datetime(dt);
                }
            }
        }
        Some("range") => {
            if let Some(s) = yaml.as_str() {
                if let Some(r) = parse_range(s) {
                    return Value::Range(r);
                }
            }
        }
        Some("tag") | Some("tag[]") | Some("tags") => {
            return Value::Tags(yaml_owned_to_string_vec(yaml));
        }
        Some("enum") => return Value::Enum(yaml_owned_to_string(yaml)),
        Some("ref") | Some("ref[]") => return Value::Refs(yaml_owned_to_string_vec(yaml)),
        _ => {}
    }

    infer_from_yaml_owned(yaml)
}

fn infer_from_yaml_owned(yaml: &YamlOwned) -> Value {
    if let Some(b) = yaml.as_bool() {
        return Value::Boolean(b);
    }
    if let Some(i) = yaml.as_integer() {
        return Value::Number(i as f64);
    }
    if let Some(f) = yaml.as_floating_point() {
        return Value::Number(f);
    }
    if yaml.is_null() {
        return Value::String(String::new());
    }
    if let Some(s) = yaml.as_str() {
        return infer_string(s);
    }
    if let Some(arr) = yaml.as_vec() {
        // Array of strings → Tags (default inference for string arrays)
        let items: Vec<String> = arr.iter().map(yaml_owned_to_string).collect();
        return Value::Tags(items);
    }
    // Mapping or other complex shape → Opaque (emitted verbatim for round-trip).
    Value::Opaque(yaml_owned_to_string(yaml))
}

/// Infer type from a scalar string.
fn infer_string(s: &str) -> Value {
    // Range check must come before date/datetime because `2026-06-01..2026-06-05`
    // contains date-like substrings.
    if s.contains("..") {
        if let Some(r) = parse_range(s) {
            return Value::Range(r);
        }
    }
    // ISO date: YYYY-MM-DD (exactly)
    if let Some(d) = parse_date(s) {
        return Value::Date(d);
    }
    // ISO datetime
    if let Some(dt) = parse_datetime(s) {
        return Value::Datetime(dt);
    }
    Value::String(s.to_string())
}

// ── Date / datetime parsing ───────────────────────────────────────────────────

/// Parse an ISO date string `YYYY-MM-DD` (strict: no extra characters allowed).
///
/// Returns `None` for invalid input or strings that contain more than a date
/// (e.g. datetime strings that start with a valid date prefix are rejected).
pub fn parse_date(s: &str) -> Option<Date> {
    let s = s.trim();
    // Must be exactly YYYY-MM-DD (10 chars) — reject datetime strings that start with a valid date.
    if s.len() != 10 {
        return None;
    }
    s.parse::<Date>().ok()
}

/// Parse an ISO datetime string, returning a `DatetimeValue`.
///
/// Accepted forms:
/// - `2026-05-20T14:00:00+02:00`  → explicit offset
/// - `2026-05-20T14:00+02:00`     → explicit offset, no seconds
/// - `2026-05-20T14:00:00Z`       → UTC
/// - `2026-05-20T14:00:00`        → zone-naive
/// - `2026-05-20T14:00`           → zone-naive, no seconds
pub fn parse_datetime(s: &str) -> Option<DatetimeValue> {
    let s = s.trim();

    // Must contain a T separator (case-insensitive).
    if !s.contains('T') && !s.contains('t') {
        return None;
    }

    let (dt_part, offset_secs) = split_offset(s)?;
    let civil = dt_part.parse::<DateTime>().ok()?;

    Some(match offset_secs {
        Some(off) => DatetimeValue::with_offset(civil, off),
        None => DatetimeValue::naive(civil),
    })
}

/// Split a datetime string into `(civil_part, Option<offset_seconds>)`.
fn split_offset(s: &str) -> Option<(&str, Option<i32>)> {
    // Handle Z suffix (UTC, offset = 0).
    if let Some(dt) = s.strip_suffix('Z').or_else(|| s.strip_suffix('z')) {
        return Some((dt, Some(0)));
    }

    // Locate T separator.
    let t_pos = s.find('T').or_else(|| s.find('t'))?;
    let time_part = &s[t_pos + 1..];

    // Find +/- in the time part (offset sign, not the date's leading minus which is before T).
    if let Some(plus_pos) = time_part.rfind('+') {
        let offset_str = &time_part[plus_pos + 1..];
        if let Some(secs) = parse_offset_str(offset_str) {
            return Some((&s[..t_pos + 1 + plus_pos], Some(secs)));
        }
    }
    if let Some(minus_pos) = time_part.rfind('-') {
        let offset_str = &time_part[minus_pos + 1..];
        if let Some(secs) = parse_offset_str(offset_str) {
            return Some((&s[..t_pos + 1 + minus_pos], Some(-secs)));
        }
    }

    // No offset — zone-naive; validate that there's at least HH:MM in time part.
    if time_part.len() >= 5 {
        Some((s, None))
    } else {
        None
    }
}

/// Parse `HH:MM` or `HH:MM:SS` offset into total seconds.
fn parse_offset_str(s: &str) -> Option<i32> {
    let parts: Vec<&str> = s.split(':').collect();
    if parts.len() < 2 {
        return None;
    }
    let h: i32 = parts[0].parse().ok()?;
    let m: i32 = parts[1].parse().ok()?;
    if h > 18 || m > 59 {
        return None;
    }
    Some(h * 3600 + m * 60)
}

// ── Range parsing ─────────────────────────────────────────────────────────────

/// Parse a range string `<start>..<end>`.
pub fn parse_range(s: &str) -> Option<RangeValue> {
    let (left, right) = s.split_once("..")?;
    let start = parse_range_endpoint(left.trim())?;
    let end = parse_range_endpoint(right.trim())?;
    let mixed = start.is_date() != end.is_date();
    Some(RangeValue { start, end, mixed })
}

fn parse_range_endpoint(s: &str) -> Option<RangeEndpoint> {
    if let Some(dt) = parse_datetime(s) {
        return Some(RangeEndpoint::Datetime(dt));
    }
    if let Some(d) = parse_date(s) {
        return Some(RangeEndpoint::Date(d));
    }
    None
}

// ── YamlOwned helpers ─────────────────────────────────────────────────────────

/// Serialize a `YamlOwned` value to a string.
///
/// For complex values (mappings, sequences) this round-trips through the saphyr emitter
/// to produce a stable text representation for `Opaque` storage.
pub fn yaml_owned_to_string(yaml: &YamlOwned) -> String {
    if let Some(s) = yaml.as_str() {
        return s.to_string();
    }
    if let Some(i) = yaml.as_integer() {
        return i.to_string();
    }
    if let Some(f) = yaml.as_floating_point() {
        return f.to_string();
    }
    if let Some(b) = yaml.as_bool() {
        return b.to_string();
    }
    if yaml.is_null() {
        return String::new();
    }
    // For complex shapes, emit to YAML text via saphyr's emitter.
    // The emitter operates on borrowed `Yaml<'input>` so we serialize manually.
    emit_yaml_owned_to_string(yaml)
}

/// Emit a `YamlOwned` value to its YAML text representation (without the `---` document marker).
fn emit_yaml_owned_to_string(yaml: &YamlOwned) -> String {
    match yaml {
        YamlOwned::Value(ScalarOwned::Null) => "~".to_string(),
        YamlOwned::Value(ScalarOwned::Boolean(b)) => b.to_string(),
        YamlOwned::Value(ScalarOwned::Integer(i)) => i.to_string(),
        YamlOwned::Value(ScalarOwned::FloatingPoint(f)) => f.to_string(),
        YamlOwned::Value(ScalarOwned::String(s)) => s.clone(),
        YamlOwned::Sequence(seq) => {
            let items: Vec<String> = seq.iter().map(emit_yaml_owned_to_string).collect();
            format!("[{}]", items.join(", "))
        }
        YamlOwned::Mapping(map) => {
            let items: Vec<String> = map
                .iter()
                .map(|(k, v)| {
                    format!(
                        "{}: {}",
                        emit_yaml_owned_to_string(k),
                        emit_yaml_owned_to_string(v)
                    )
                })
                .collect();
            format!("{{{}}}", items.join(", "))
        }
        YamlOwned::Tagged(_, inner) => emit_yaml_owned_to_string(inner),
        _ => String::new(),
    }
}

fn yaml_as_number(yaml: &YamlOwned) -> Option<f64> {
    if let Some(i) = yaml.as_integer() {
        return Some(i as f64);
    }
    if let Some(f) = yaml.as_floating_point() {
        return Some(f);
    }
    if let Some(s) = yaml.as_str() {
        return s.parse().ok();
    }
    None
}

fn yaml_owned_to_string_vec(yaml: &YamlOwned) -> Vec<String> {
    if let Some(arr) = yaml.as_vec() {
        return arr.iter().map(yaml_owned_to_string).collect();
    }
    if let Some(s) = yaml.as_str() {
        if !s.is_empty() {
            return vec![s.to_string()];
        }
    }
    vec![]
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── split_frontmatter ────────────────────────────────────────────────────

    #[test]
    fn split_basic_frontmatter() {
        let src = b"---\nid: abc\n---\n# Hello\n";
        let r = split_frontmatter(src);
        assert!(r.had_fence);
        assert_eq!(r.yaml_text, "id: abc\n");
        assert_eq!(r.body, "# Hello\n");
    }

    #[test]
    fn split_no_frontmatter() {
        let src = b"# Just a body\n";
        let r = split_frontmatter(src);
        assert!(!r.had_fence);
        assert_eq!(r.body, "# Just a body\n");
        assert!(r.yaml_text.is_empty());
    }

    #[test]
    fn split_empty_frontmatter() {
        let src = b"---\n---\n# Body\n";
        let r = split_frontmatter(src);
        assert!(r.had_fence);
        assert!(r.yaml_text.is_empty());
        assert_eq!(r.body, "# Body\n");
    }

    #[test]
    fn split_crlf_fences() {
        let src = b"---\r\nfoo: bar\r\n---\r\nbody\r\n";
        let r = split_frontmatter(src);
        assert!(r.had_fence);
        assert_eq!(r.yaml_text, "foo: bar\r\n");
        assert_eq!(r.body, "body\r\n");
    }

    #[test]
    fn split_bom_prefix() {
        let src = b"\xEF\xBB\xBF---\nid: x\n---\nbody\n";
        let r = split_frontmatter(src);
        assert!(r.had_fence);
        assert_eq!(r.yaml_text, "id: x\n");
        assert_eq!(r.body, "body\n");
    }

    #[test]
    fn split_body_contains_triple_dash_in_code_fence() {
        // A `---` inside the body (after frontmatter closed) must NOT affect frontmatter parsing.
        let src = b"---\nid: abc\n---\n```\n---\n```\n";
        let r = split_frontmatter(src);
        assert!(r.had_fence);
        assert_eq!(r.body, "```\n---\n```\n");
    }

    #[test]
    fn split_no_closing_fence_treated_as_malformed() {
        // Opening fence but no closing → had_fence false.
        let src = b"---\nid: abc\n# oops no closing\n";
        let r = split_frontmatter(src);
        assert!(!r.had_fence);
    }

    // ── parse_date ───────────────────────────────────────────────────────────

    #[test]
    fn parse_date_valid() {
        let d = parse_date("2026-05-20").unwrap();
        assert_eq!(d.year(), 2026);
        assert_eq!(d.month(), 5);
        assert_eq!(d.day(), 20);
    }

    #[test]
    fn parse_date_invalid() {
        assert!(parse_date("not-a-date").is_none());
        assert!(parse_date("2026-13-01").is_none());
    }

    // ── parse_datetime ───────────────────────────────────────────────────────

    #[test]
    fn parse_datetime_with_offset() {
        let dt = parse_datetime("2026-05-20T14:00:00+02:00").unwrap();
        assert!(dt.has_offset());
        assert_eq!(dt.offset_seconds, Some(7200));
        assert_eq!(dt.civil.hour(), 14);
    }

    #[test]
    fn parse_datetime_utc_z() {
        let dt = parse_datetime("2026-05-20T14:00:00Z").unwrap();
        assert!(dt.has_offset());
        assert_eq!(dt.offset_seconds, Some(0));
    }

    #[test]
    fn parse_datetime_negative_offset() {
        let dt = parse_datetime("2026-05-20T09:00:00-05:00").unwrap();
        assert!(dt.has_offset());
        assert_eq!(dt.offset_seconds, Some(-18000));
    }

    #[test]
    fn parse_datetime_no_offset() {
        let dt = parse_datetime("2026-05-20T14:00").unwrap();
        assert!(!dt.has_offset());
        assert_eq!(dt.civil.hour(), 14);
    }

    #[test]
    fn parse_datetime_no_seconds() {
        let dt = parse_datetime("2026-05-20T14:30+01:00").unwrap();
        assert!(dt.has_offset());
        assert_eq!(dt.offset_seconds, Some(3600));
        assert_eq!(dt.civil.minute(), 30);
    }

    #[test]
    fn parse_datetime_rejects_plain_date() {
        assert!(parse_datetime("2026-05-20").is_none());
    }

    // ── parse_range ──────────────────────────────────────────────────────────

    #[test]
    fn parse_range_date_date() {
        let r = parse_range("2026-06-01..2026-06-05").unwrap();
        assert!(!r.mixed);
        assert!(r.start.is_date());
        assert!(r.end.is_date());
    }

    #[test]
    fn parse_range_datetime_datetime() {
        let r = parse_range("2026-06-01T09:00..2026-06-01T10:30").unwrap();
        assert!(!r.mixed);
        assert!(r.start.is_datetime());
        assert!(r.end.is_datetime());
    }

    #[test]
    fn parse_range_mixed_endpoints_flagged() {
        let r = parse_range("2026-06-01..2026-06-01T10:30").unwrap();
        assert!(r.mixed, "mixed endpoints must be flagged");
    }

    #[test]
    fn parse_range_invalid() {
        assert!(parse_range("not..valid").is_none());
    }

    // ── infer_value ──────────────────────────────────────────────────────────

    #[test]
    fn infer_bool_true() {
        let docs = YamlOwned::load_from_str("v: true").unwrap();
        let v = docs[0]
            .as_mapping()
            .unwrap()
            .values()
            .next()
            .unwrap()
            .clone();
        assert_eq!(infer_value(&v, None), Value::Boolean(true));
    }

    #[test]
    fn infer_integer() {
        let docs = YamlOwned::load_from_str("v: 42").unwrap();
        let v = docs[0]
            .as_mapping()
            .unwrap()
            .values()
            .next()
            .unwrap()
            .clone();
        assert_eq!(infer_value(&v, None), Value::Number(42.0));
    }

    #[test]
    fn infer_string_plain() {
        let docs = YamlOwned::load_from_str("v: hello").unwrap();
        let v = docs[0]
            .as_mapping()
            .unwrap()
            .values()
            .next()
            .unwrap()
            .clone();
        assert_eq!(infer_value(&v, None), Value::String("hello".to_string()));
    }

    #[test]
    fn infer_string_as_date() {
        let docs = YamlOwned::load_from_str("v: '2026-05-20'").unwrap();
        let v = docs[0]
            .as_mapping()
            .unwrap()
            .values()
            .next()
            .unwrap()
            .clone();
        assert!(matches!(infer_value(&v, None), Value::Date(_)));
    }

    #[test]
    fn infer_string_as_datetime() {
        let docs = YamlOwned::load_from_str("v: '2026-05-20T14:00+02:00'").unwrap();
        let v = docs[0]
            .as_mapping()
            .unwrap()
            .values()
            .next()
            .unwrap()
            .clone();
        assert!(matches!(infer_value(&v, None), Value::Datetime(_)));
    }

    #[test]
    fn infer_string_as_range() {
        let docs = YamlOwned::load_from_str("v: '2026-06-01..2026-06-05'").unwrap();
        let v = docs[0]
            .as_mapping()
            .unwrap()
            .values()
            .next()
            .unwrap()
            .clone();
        assert!(matches!(infer_value(&v, None), Value::Range(_)));
    }

    #[test]
    fn declared_type_wins_over_inference() {
        // A string that looks like a date, but declared as string → stays string.
        let docs = YamlOwned::load_from_str("v: '2026-05-20'").unwrap();
        let v = docs[0]
            .as_mapping()
            .unwrap()
            .values()
            .next()
            .unwrap()
            .clone();
        assert_eq!(
            infer_value(&v, Some("string")),
            Value::String("2026-05-20".to_string())
        );
    }

    #[test]
    fn opaque_for_unknown_nested_mapping() {
        let docs = YamlOwned::load_from_str("v:\n  nested: true").unwrap();
        let v = docs[0]
            .as_mapping()
            .unwrap()
            .values()
            .next()
            .unwrap()
            .clone();
        assert!(matches!(infer_value(&v, None), Value::Opaque(_)));
    }

    // ── parse_yaml_properties ────────────────────────────────────────────────

    #[test]
    fn parse_malformed_yaml_returns_warning() {
        let (map, warn) = parse_yaml_properties("{ bad yaml: [unclosed");
        assert!(warn.is_some(), "malformed YAML must produce a warning");
        assert!(map.is_empty());
    }

    #[test]
    fn parse_empty_yaml_no_warning() {
        let (map, warn) = parse_yaml_properties("   ");
        assert!(warn.is_none());
        assert!(map.is_empty());
    }

    #[test]
    fn parse_yaml_non_mapping_top_level() {
        // Top-level list is not a mapping → warning, empty map.
        let (map, warn) = parse_yaml_properties("- item1\n- item2\n");
        assert!(warn.is_some());
        assert!(map.is_empty());
    }

    #[test]
    fn parse_properties_basic() {
        let yaml = "id: abc123\ntags:\n  - rust\n  - code\n";
        let (map, warn) = parse_yaml_properties(yaml);
        assert!(warn.is_none());
        assert_eq!(map.get("id"), Some(&Value::String("abc123".to_string())));
        assert_eq!(
            map.get("tags"),
            Some(&Value::Tags(vec!["rust".to_string(), "code".to_string()]))
        );
    }
}
