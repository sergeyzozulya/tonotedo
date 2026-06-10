// Entry file model: parse a .md file's bytes into a structured Entry, and serialize back.
//
// This is the primary public API of the frontmatter module.

use std::collections::BTreeMap;

use super::id::generate_id;
use super::parse::{parse_datetime, parse_yaml_properties, split_frontmatter};
use super::serialize::serialize_frontmatter;
use super::value::{DatetimeValue, Value};

/// A parsed entry file (spec 0002).
///
/// `title` is derived from the body (first H1) and never stored in frontmatter.
/// `body` is byte-preserved exactly as read.
/// `properties` holds all frontmatter properties except `title`.
/// `parse_warning` is set when frontmatter was malformed (non-fatal).
#[derive(Debug, Clone)]
pub struct Entry {
    /// All parsed frontmatter properties (excludes `title` — that's derived).
    pub properties: BTreeMap<String, Value>,
    /// Raw body text after the frontmatter, byte-preserved.
    pub body: String,
    /// Non-fatal warning when frontmatter was malformed (spec 0002 edge case).
    pub parse_warning: Option<String>,
}

impl Entry {
    /// Parse `.md` file bytes into an `Entry`.
    ///
    /// Never returns an error — malformed frontmatter yields an entry with zero properties
    /// and a warning (spec 0002 §"Edge cases / Malformed frontmatter").
    pub fn from_bytes(bytes: &[u8]) -> Self {
        let split = split_frontmatter(bytes);

        if !split.had_fence {
            return Entry {
                properties: BTreeMap::new(),
                body: split.body,
                parse_warning: None,
            };
        }

        let (mut properties, parse_warning) = parse_yaml_properties(&split.yaml_text);
        // Remove 'title' if it somehow made it in — it must never be stored.
        properties.remove("title");

        Entry {
            properties,
            body: split.body,
            parse_warning,
        }
    }

    /// Serialize the entry back to `.md` file bytes.
    ///
    /// - Properties are written in canonical order (spec 0002 §"Frontmatter write order").
    /// - The body is appended byte-exact.
    /// - `title` is never serialized.
    pub fn to_bytes(&self, schema_order: &[&str]) -> Vec<u8> {
        let mut out = String::new();

        if !self.properties.is_empty() {
            out.push_str(&serialize_frontmatter(&self.properties, schema_order));
        }

        out.push_str(&self.body);
        out.into_bytes()
    }

    // ── Built-in property accessors ──────────────────────────────────────────

    /// `id` — stable opaque string; present on every persisted entry.
    pub fn id(&self) -> Option<&str> {
        match self.properties.get("id") {
            Some(Value::String(s)) => Some(s.as_str()),
            _ => None,
        }
    }

    /// `created` datetime.
    pub fn created(&self) -> Option<&DatetimeValue> {
        match self.properties.get("created") {
            Some(Value::Datetime(dt)) => Some(dt),
            _ => None,
        }
    }

    /// `updated` datetime.
    pub fn updated(&self) -> Option<&DatetimeValue> {
        match self.properties.get("updated") {
            Some(Value::Datetime(dt)) => Some(dt),
            _ => None,
        }
    }

    /// `tags` array.
    pub fn tags(&self) -> &[String] {
        match self.properties.get("tags") {
            Some(Value::Tags(t)) => t.as_slice(),
            _ => &[],
        }
    }

    /// `mentions` array.
    pub fn mentions(&self) -> &[String] {
        match self.properties.get("mentions") {
            Some(Value::Tags(m)) => m.as_slice(),
            _ => &[],
        }
    }

    /// `archived` optional boolean.
    pub fn archived(&self) -> Option<bool> {
        match self.properties.get("archived") {
            Some(Value::Boolean(b)) => Some(*b),
            _ => None,
        }
    }

    /// `view` optional string.
    pub fn view(&self) -> Option<&str> {
        match self.properties.get("view") {
            Some(Value::String(s)) => Some(s.as_str()),
            _ => None,
        }
    }

    /// Derive `title` from the first H1 heading in the body.
    ///
    /// Returns `None` if no H1 is found (the UI will show the slug or a placeholder).
    pub fn title(&self) -> Option<String> {
        extract_h1(&self.body)
    }

    // ── Mutation helpers ─────────────────────────────────────────────────────

    /// Set a property.  Passing `title` is silently ignored (spec: title is derived only).
    pub fn set_property(&mut self, key: impl Into<String>, value: Value) {
        let key = key.into();
        if key == "title" {
            return;
        }
        self.properties.insert(key, value);
    }

    /// Remove a property.
    pub fn remove_property(&mut self, key: &str) {
        self.properties.remove(key);
    }

    /// Generate and set a fresh `id` (ULID).  Call once at creation time; noop if id exists.
    pub fn ensure_id(&mut self) {
        if self.id().is_none() {
            self.properties
                .insert("id".to_string(), Value::String(generate_id()));
        }
    }

    /// Set `created` and `updated` to now (UTC).
    pub fn set_timestamps_now(&mut self) {
        let dt = datetime_now_utc();
        self.properties
            .insert("created".to_string(), Value::Datetime(dt.clone()));
        self.properties
            .insert("updated".to_string(), Value::Datetime(dt));
    }

    /// Update `updated` to now (UTC).
    pub fn touch_updated(&mut self) {
        self.properties
            .insert("updated".to_string(), Value::Datetime(datetime_now_utc()));
    }
}

/// Build a `DatetimeValue` for the current UTC time.
fn datetime_now_utc() -> DatetimeValue {
    let ts = jiff::Timestamp::now();
    let zdt = ts.to_zoned(jiff::tz::TimeZone::UTC);
    let civil = zdt.datetime();
    let s = format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        civil.year(),
        civil.month(),
        civil.day(),
        civil.hour(),
        civil.minute(),
        civil.second()
    );
    parse_datetime(&s).unwrap_or_else(|| DatetimeValue::naive(civil))
}

/// Extract the text of the first H1 heading from markdown body.
///
/// Handles ATX headings (`# Title`) and ignores headings inside code fences.
fn extract_h1(body: &str) -> Option<String> {
    let mut in_code_fence = false;
    for line in body.lines() {
        let trimmed = line.trim_start();
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            in_code_fence = !in_code_fence;
            continue;
        }
        if in_code_fence {
            continue;
        }
        if let Some(rest) = trimmed.strip_prefix("# ") {
            let title = rest.trim().to_string();
            if !title.is_empty() {
                return Some(title);
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── from_bytes ───────────────────────────────────────────────────────────

    #[test]
    fn parse_well_formed_entry() {
        let src = b"---\nid: abc123\ntags:\n  - rust\n---\n# Hello\n\nBody text.\n";
        let e = Entry::from_bytes(src);
        assert!(e.parse_warning.is_none());
        assert_eq!(e.id(), Some("abc123"));
        assert_eq!(e.tags(), &["rust"]);
        assert_eq!(e.body, "# Hello\n\nBody text.\n");
    }

    #[test]
    fn parse_no_frontmatter() {
        let src = b"# Just body\n";
        let e = Entry::from_bytes(src);
        assert!(e.parse_warning.is_none());
        assert!(e.properties.is_empty());
        assert_eq!(e.body, "# Just body\n");
    }

    #[test]
    fn parse_malformed_frontmatter_non_fatal() {
        // Malformed YAML → properties empty, warning set, file not rejected.
        let src = b"---\n{unclosed: [bad\n---\nbody\n";
        let e = Entry::from_bytes(src);
        assert!(
            e.parse_warning.is_some(),
            "must have a warning for malformed YAML"
        );
        assert!(e.properties.is_empty());
        assert_eq!(e.body, "body\n");
    }

    #[test]
    fn title_not_in_properties() {
        // Even if someone writes `title` in frontmatter, it must be stripped.
        let src = b"---\nid: x\ntitle: Should be stripped\n---\nbody\n";
        let e = Entry::from_bytes(src);
        assert!(!e.properties.contains_key("title"));
    }

    #[test]
    fn title_derived_from_h1() {
        let src = b"---\nid: x\n---\n# My Title\n\nsome text\n";
        let e = Entry::from_bytes(src);
        assert_eq!(e.title(), Some("My Title".to_string()));
    }

    #[test]
    fn title_none_when_no_h1() {
        let src = b"---\nid: x\n---\nno heading here\n";
        let e = Entry::from_bytes(src);
        assert_eq!(e.title(), None);
    }

    #[test]
    fn title_ignored_inside_code_fence() {
        let src = b"---\nid: x\n---\n```\n# Not a title\n```\n";
        let e = Entry::from_bytes(src);
        assert_eq!(e.title(), None);
    }

    #[test]
    fn title_empty_allowed() {
        // Empty title: no H1 → None; spec says "empty title allowed, UI shows slug".
        let src = b"---\nid: x\n---\n## Only h2\n";
        let e = Entry::from_bytes(src);
        assert_eq!(e.title(), None);
    }

    // ── round-trip ───────────────────────────────────────────────────────────

    #[test]
    fn round_trip_body_byte_exact() {
        // Body with trailing whitespace, no trailing newline, unusual spacing.
        let src =
            b"---\nid: abc\n---\n# Title  \n\nLine with trailing spaces.  \nNo newline at end";
        let e = Entry::from_bytes(src);
        let out = e.to_bytes(&[]);
        let body_bytes = extract_body_from_output(&out);
        assert_eq!(
            body_bytes,
            b"# Title  \n\nLine with trailing spaces.  \nNo newline at end"
        );
    }

    #[test]
    fn round_trip_canonical_order_idempotent() {
        // Parse a file with out-of-order properties, serialize, parse again, serialize again.
        // The two serializations must be byte-identical.
        let src = b"---\nupdated: '2026-01-01T00:00Z'\nid: xyz\ncreated: '2026-01-01T00:00Z'\ntags:\n  - a\n---\nbody\n";
        let e = Entry::from_bytes(src);
        let out1 = e.to_bytes(&[]);
        let e2 = Entry::from_bytes(&out1);
        let out2 = e2.to_bytes(&[]);
        assert_eq!(
            out1, out2,
            "parse→serialize must be idempotent (canonical order stable)"
        );
    }

    #[test]
    fn unknown_property_round_trips_verbatim() {
        // An opaque map-shaped property must survive unmodified.
        let src = b"---\nid: abc\ncustom_map:\n  nested: true\n---\nbody\n";
        let e = Entry::from_bytes(src);
        let val = e.properties.get("custom_map");
        assert!(val.is_some(), "unknown property must be preserved");
        assert!(matches!(val.unwrap(), Value::Opaque(_)));

        let out = e.to_bytes(&[]);
        let out_str = String::from_utf8(out).unwrap();
        assert!(
            out_str.contains("custom_map:"),
            "unknown property must round-trip"
        );
    }

    #[test]
    fn entry_with_all_builtins() {
        let src = b"---\nid: abc\ncreated: '2026-01-01T10:00+02:00'\nupdated: '2026-01-02T10:00+02:00'\ntags:\n  - foo\nmentions:\n  - alice\narchived: true\nview: task-list\n---\nbody\n";
        let e = Entry::from_bytes(src);
        assert_eq!(e.id(), Some("abc"));
        assert!(e.created().is_some());
        assert!(e.updated().is_some());
        assert_eq!(e.tags(), &["foo"]);
        assert_eq!(e.mentions(), &["alice"]);
        assert_eq!(e.archived(), Some(true));
        assert_eq!(e.view(), Some("task-list"));
    }

    #[test]
    fn body_with_triple_dash_in_code_fence_preserved() {
        let src = b"---\nid: x\n---\n```yaml\n---\nfoo: bar\n```\n";
        let e = Entry::from_bytes(src);
        assert_eq!(e.body, "```yaml\n---\nfoo: bar\n```\n");
    }

    // ── ensure_id / timestamps ───────────────────────────────────────────────

    #[test]
    fn ensure_id_generates_nonempty() {
        let mut e = Entry {
            properties: BTreeMap::new(),
            body: String::new(),
            parse_warning: None,
        };
        e.ensure_id();
        let id = e.id().unwrap();
        assert!(!id.is_empty());
        // ULID is 26 chars, Crockford base32.
        assert_eq!(id.len(), 26, "ULID must be 26 chars");
    }

    #[test]
    fn ensure_id_does_not_overwrite_existing() {
        let mut e = Entry {
            properties: BTreeMap::new(),
            body: String::new(),
            parse_warning: None,
        };
        e.properties
            .insert("id".to_string(), Value::String("keep-me".to_string()));
        e.ensure_id();
        assert_eq!(e.id(), Some("keep-me"));
    }

    #[test]
    fn set_property_ignores_title() {
        let mut e = Entry {
            properties: BTreeMap::new(),
            body: String::new(),
            parse_warning: None,
        };
        e.set_property("title", Value::String("ignored".to_string()));
        assert!(!e.properties.contains_key("title"));
    }

    #[test]
    fn set_timestamps_now_creates_both() {
        let mut e = Entry {
            properties: BTreeMap::new(),
            body: String::new(),
            parse_warning: None,
        };
        e.set_timestamps_now();
        assert!(e.created().is_some());
        assert!(e.updated().is_some());
        // Timestamps should carry UTC offset (0).
        assert_eq!(e.created().unwrap().offset_seconds, Some(0));
    }

    // ── extract_h1 ───────────────────────────────────────────────────────────

    #[test]
    fn h1_first_heading_wins() {
        let body = "# First\n## Second\n# Third\n";
        assert_eq!(extract_h1(body), Some("First".to_string()));
    }

    #[test]
    fn h1_empty_body() {
        assert_eq!(extract_h1(""), None);
    }

    #[test]
    fn h1_hash_no_space_not_heading() {
        // `#Title` without space is not a valid ATX heading per CommonMark.
        let body = "#NotAHeading\n# Actual\n";
        assert_eq!(extract_h1(body), Some("Actual".to_string()));
    }

    // ── Helper ───────────────────────────────────────────────────────────────

    fn extract_body_from_output(bytes: &[u8]) -> &[u8] {
        let text = std::str::from_utf8(bytes).unwrap();
        // Find the closing `---` fence in the output.
        let after_open = match text.strip_prefix("---\n") {
            Some(s) => s,
            None => return bytes,
        };
        let mut cur = 0;
        loop {
            let line_end = after_open[cur..]
                .find('\n')
                .map(|i| cur + i + 1)
                .unwrap_or(after_open.len());
            let line = after_open[cur..line_end]
                .trim_end_matches('\n')
                .trim_end_matches('\r');
            if line == "---" {
                let body_offset = 4 /* opening "---\n" */ + line_end;
                return &bytes[body_offset..];
            }
            let next = if line_end > cur { line_end } else { cur + 1 };
            cur = next;
            if cur >= after_open.len() {
                break;
            }
        }
        bytes
    }
}
