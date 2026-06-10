// Projection file parsers: _tags.md and _people.md.
//
// Design reference: design-0001 §"Model":
//   "`people(slug PK, full_name, color, avatar_path)` / `tag_meta(tag PK, ...)`
//   — projections of `_people.md` / `_tags.md`"
//
// Spec 0002 §"Reserved names":
//   "library-root `_tags.md` → parse its frontmatter `tags:` list →
//    index.set_tag_meta; `_people.md` → `people:` list → index.set_people."
//
// Their schemas are lists-of-maps.  We parse with saphyr directly (same YAML
// library used by frontmatter/) rather than through Entry::from_bytes, because
// Entry normalises and strips properties in ways incompatible with these
// projection schemas.
//
// INV (projection resilience): a MALFORMED projection (YAML that fails to parse)
// is NOT fatal and does NOT clobber the existing projection.  The parser returns
// `Err(ProjectionError::Parse)`, the caller logs and SKIPS `set_*`, so the last
// good projection survives.  A genuinely-empty projection (valid YAML, no
// `tags:`/`people:` key, or an empty list) DOES replace the table.  This
// distinction prevents a transient bad save from wiping tag/person metadata.
//
// INV (root-only): only `_tags.md` and `_people.md` at the library root are
// projection files.  Identically-named files in subdirectories are silently
// skipped (the reconciler checks group_path == "" before calling these).

use saphyr::{LoadableYamlNode, MappingOwned, YamlOwned};

use crate::core::index::{Index, IndexError, PeopleRow, TagMetaRow};

/// Failure while applying a projection.
#[derive(Debug)]
pub enum ProjectionError {
    /// The projection file's frontmatter YAML failed to parse.  The caller must
    /// keep the previous projection (do NOT clear the table).
    Parse,
    /// An index write failed.
    Index(IndexError),
}

impl From<IndexError> for ProjectionError {
    fn from(e: IndexError) -> Self {
        ProjectionError::Index(e)
    }
}

/// Parse `_tags.md` bytes and replace `tag_meta` in the index.
///
/// Expected frontmatter shape:
/// ```yaml
/// tags:
///   - tag: followup
///     description: "..."
///     color: amber
///     icon: "⏳"
///   - tag: work
/// ```
///
/// Unknown fields are silently ignored.  Missing optional fields (description,
/// color, icon) → stored as NULL.
pub fn apply_tags_projection(index: &mut Index, bytes: &[u8]) -> Result<(), ProjectionError> {
    let rows = parse_tags_md(bytes)?;
    index.set_tag_meta(&rows)?;
    Ok(())
}

/// Parse `_people.md` bytes and replace `people` in the index.
///
/// Expected frontmatter shape:
/// ```yaml
/// people:
///   - slug: sergey
///     full_name: "Sergey K."
///     color: blue
///     avatar_path: "_people/sergey.jpg"
///   - slug: anna
/// ```
pub fn apply_people_projection(index: &mut Index, bytes: &[u8]) -> Result<(), ProjectionError> {
    let rows = parse_people_md(bytes)?;
    index.set_people(&rows)?;
    Ok(())
}

// ── Internal parsers ──────────────────────────────────────────────────────────

/// Extract frontmatter YAML from a `.md` file's bytes, then parse the `tags:`
/// list-of-maps into `TagMetaRow`s.
///
/// Returns `Err(Parse)` if the frontmatter YAML is malformed (caller keeps the
/// previous projection).  Returns `Ok(empty)` when there is genuinely nothing to
/// project (no frontmatter, no `tags:` key, or an empty list).
fn parse_tags_md(bytes: &[u8]) -> Result<Vec<TagMetaRow>, ProjectionError> {
    let yaml_text = match extract_frontmatter_text(bytes) {
        Some(t) => t,
        None => return Ok(Vec::new()),
    };
    // A YAML parse failure is a MALFORMED file: keep the previous projection.
    let docs = YamlOwned::load_from_str(&yaml_text).map_err(|_| ProjectionError::Parse)?;
    let doc = match docs.into_iter().next() {
        Some(d) => d,
        None => return Ok(Vec::new()),
    };
    let mapping = match doc.as_mapping() {
        Some(m) => m.clone(),
        None => return Ok(Vec::new()),
    };

    // Find the "tags" key in the mapping.
    let tags_list = mapping
        .iter()
        .find(|(k, _)| k.as_str() == Some("tags"))
        .and_then(|(_, v)| v.as_vec().cloned());

    let list = match tags_list {
        Some(l) => l,
        None => return Ok(Vec::new()),
    };

    let mut rows = Vec::with_capacity(list.len());
    for item in &list {
        if let Some(m) = item.as_mapping() {
            let tag = str_field_owned(m, "tag");
            let tag = match tag {
                Some(t) if !t.is_empty() => t,
                _ => continue, // skip entries without a valid tag key
            };
            rows.push(TagMetaRow {
                tag,
                description: str_field_owned(m, "description"),
                color: str_field_owned(m, "color"),
                icon: str_field_owned(m, "icon"),
            });
        }
    }
    Ok(rows)
}

/// Extract frontmatter YAML from a `.md` file's bytes, then parse the `people:`
/// list-of-maps into `PeopleRow`s.
fn parse_people_md(bytes: &[u8]) -> Result<Vec<PeopleRow>, ProjectionError> {
    let yaml_text = match extract_frontmatter_text(bytes) {
        Some(t) => t,
        None => return Ok(Vec::new()),
    };
    let docs = YamlOwned::load_from_str(&yaml_text).map_err(|_| ProjectionError::Parse)?;
    let doc = match docs.into_iter().next() {
        Some(d) => d,
        None => return Ok(Vec::new()),
    };
    let mapping = match doc.as_mapping() {
        Some(m) => m.clone(),
        None => return Ok(Vec::new()),
    };

    // Find the "people" key in the mapping.
    let people_list = mapping
        .iter()
        .find(|(k, _)| k.as_str() == Some("people"))
        .and_then(|(_, v)| v.as_vec().cloned());

    let list = match people_list {
        Some(l) => l,
        None => return Ok(Vec::new()),
    };

    let mut rows = Vec::with_capacity(list.len());
    for item in &list {
        if let Some(m) = item.as_mapping() {
            let slug = str_field_owned(m, "slug");
            let slug = match slug {
                Some(s) if !s.is_empty() => s,
                _ => continue, // skip entries without a valid slug
            };
            rows.push(PeopleRow {
                slug,
                full_name: str_field_owned(m, "full_name"),
                color: str_field_owned(m, "color"),
                avatar_path: str_field_owned(m, "avatar_path"),
            });
        }
    }
    Ok(rows)
}

/// Extract the YAML text between the first `---` fence pair in a `.md` file.
///
/// Returns `None` if the file does not start with a frontmatter fence.
fn extract_frontmatter_text(bytes: &[u8]) -> Option<String> {
    let text = std::str::from_utf8(bytes).ok()?;
    // Must start with `---\n` or `---\r\n`.
    let after_open = text
        .strip_prefix("---\n")
        .or_else(|| text.strip_prefix("---\r\n"))?;

    // Find the closing `---`.
    let mut cur = 0;
    for line in after_open.lines() {
        if line.trim_end_matches('\r') == "---" {
            return Some(after_open[..cur].to_string());
        }
        // +1 for the newline that `lines()` strips.
        cur += line.len() + 1;
    }
    None
}

/// Extract a String-typed field from a YamlOwned mapping.
fn str_field_owned(map: &MappingOwned, key: &str) -> Option<String> {
    map.iter()
        .find(|(k, _)| k.as_str() == Some(key))
        .and_then(|(_, v)| v.as_str().map(|s| s.to_string()))
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_tags_md_basic() {
        let src = b"---\ntags:\n  - tag: followup\n    description: Revisit later\n    color: amber\n  - tag: work\n---\n";
        let rows = parse_tags_md(src).unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].tag, "followup");
        assert_eq!(rows[0].description.as_deref(), Some("Revisit later"));
        assert_eq!(rows[0].color.as_deref(), Some("amber"));
        assert_eq!(rows[1].tag, "work");
        assert!(rows[1].description.is_none());
    }

    #[test]
    fn parse_people_md_basic() {
        let src = b"---\npeople:\n  - slug: sergey\n    full_name: Sergey K.\n    color: blue\n  - slug: anna\n---\n";
        let rows = parse_people_md(src).unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].slug, "sergey");
        assert_eq!(rows[0].full_name.as_deref(), Some("Sergey K."));
        assert_eq!(rows[1].slug, "anna");
        assert!(rows[1].full_name.is_none());
    }

    #[test]
    fn parse_tags_md_no_frontmatter() {
        // No frontmatter is a genuinely-empty projection, not a parse failure.
        let rows = parse_tags_md(b"# Just body\nno frontmatter\n").unwrap();
        assert!(rows.is_empty());
    }

    #[test]
    fn parse_people_no_frontmatter() {
        let rows = parse_people_md(b"just body").unwrap();
        assert!(rows.is_empty());
    }

    #[test]
    fn parse_tags_md_malformed_yaml_is_error() {
        // Unbalanced/invalid YAML inside the fence → Parse error (keep prior).
        let src = b"---\ntags:\n  - tag: followup\n   bad: \"unterminated\n---\n";
        assert!(matches!(parse_tags_md(src), Err(ProjectionError::Parse)));
    }

    #[test]
    fn parse_people_md_malformed_yaml_is_error() {
        let src = b"---\npeople:\n  - slug: sergey\n   bad: \"unterminated\n---\n";
        assert!(matches!(parse_people_md(src), Err(ProjectionError::Parse)));
    }

    #[test]
    fn extract_frontmatter_text_basic() {
        let src = b"---\nfoo: bar\n---\nbody\n";
        assert_eq!(
            extract_frontmatter_text(src),
            Some("foo: bar\n".to_string())
        );
    }

    #[test]
    fn extract_frontmatter_text_no_fence() {
        assert_eq!(extract_frontmatter_text(b"body only\n"), None);
    }
}
