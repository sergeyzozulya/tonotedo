// Transactional entry upsert and bulk metadata upserts.
//
// `upsert_entry` is the primary write path:
//   1. files row (reconciliation ledger)
//   2. entries row (with title derived from body)
//   3. properties rows
//   4. tags rows (frontmatter surface)
//   5. mentions rows (frontmatter surface)
//   6. body scan → tags + mentions + links (body surface)
//   7. FTS update (the FTS triggers handle INSERT/UPDATE on entries, but we
//      need to push the body text in separately because the virtual table's
//      content row only stores title, not body — so we write directly to fts).

use rusqlite::{params, Connection};
use serde_json;

use super::scanner::{scan_body, Token};
use super::IndexError;
use crate::core::frontmatter::{Entry, Value};

/// Full transactional upsert of all rows derived from one parsed entry.
#[allow(clippy::too_many_arguments)]
pub fn upsert_entry(
    conn: &mut Connection,
    path: &str,
    slug: &str,
    group_path: &str,
    entry: &Entry,
    mtime: i64,
    size: i64,
    content_hash: &str,
) -> Result<(), IndexError> {
    let tx = conn.transaction()?;

    // ── 1. files ledger ──────────────────────────────────────────────────────
    tx.execute(
        "INSERT OR REPLACE INTO files (path, mtime, size, content_hash)
         VALUES (?1, ?2, ?3, ?4)",
        params![path, mtime, size, content_hash],
    )?;

    // ── 2. entries row ───────────────────────────────────────────────────────
    let title = entry.title();
    let entry_id_str = entry.id();
    let created = entry.created().map(format_datetime);
    let updated = entry.updated().map(format_datetime);
    let archived = entry.archived().unwrap_or(false) as i64;

    tx.execute(
        "INSERT INTO entries (entry_id, path, slug, group_path, title, created, updated, archived)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT(path) DO UPDATE SET
             entry_id   = excluded.entry_id,
             slug       = excluded.slug,
             group_path = excluded.group_path,
             title      = excluded.title,
             created    = excluded.created,
             updated    = excluded.updated,
             archived   = excluded.archived",
        params![
            entry_id_str,
            path,
            slug,
            group_path,
            title,
            created,
            updated,
            archived
        ],
    )?;

    // Get the rowid of the just-upserted entry.
    let row_id: i64 = tx.query_row(
        "SELECT id FROM entries WHERE path = ?1",
        params![path],
        |r| r.get(0),
    )?;

    // ── 3. properties ────────────────────────────────────────────────────────
    tx.execute(
        "DELETE FROM properties WHERE entry_id = ?1",
        params![row_id],
    )?;
    for (key, val) in &entry.properties {
        // Skip built-in scalar fields stored directly in `entries`.
        if matches!(
            key.as_str(),
            "id" | "created" | "updated" | "archived" | "tags" | "mentions"
        ) {
            continue;
        }
        let (declared_type, inferred_type) = type_names(val);
        let value_json = value_to_json(val);
        tx.execute(
            "INSERT OR IGNORE INTO properties (entry_id, key, declared_type, inferred_type, value_json)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![row_id, key, declared_type, inferred_type, value_json],
        )?;
    }

    // ── 4. tags (frontmatter surface) ────────────────────────────────────────
    tx.execute(
        "DELETE FROM tags WHERE entry_id = ?1 AND surface = 'frontmatter'",
        params![row_id],
    )?;
    for tag in entry.tags() {
        tx.execute(
            "INSERT OR IGNORE INTO tags (entry_id, tag, surface) VALUES (?1, ?2, 'frontmatter')",
            params![row_id, tag],
        )?;
    }

    // ── 5. mentions (frontmatter surface) ────────────────────────────────────
    tx.execute(
        "DELETE FROM mentions WHERE entry_id = ?1 AND surface = 'frontmatter'",
        params![row_id],
    )?;
    for m in entry.mentions() {
        tx.execute(
            "INSERT OR IGNORE INTO mentions (entry_id, slug, surface) VALUES (?1, ?2, 'frontmatter')",
            params![row_id, m],
        )?;
    }

    // ── 6. body surface scan ─────────────────────────────────────────────────
    tx.execute(
        "DELETE FROM tags WHERE entry_id = ?1 AND surface = 'body'",
        params![row_id],
    )?;
    tx.execute(
        "DELETE FROM mentions WHERE entry_id = ?1 AND surface = 'body'",
        params![row_id],
    )?;
    tx.execute("DELETE FROM links WHERE src_entry_id = ?1", params![row_id])?;

    let body_tokens = scan_body(&entry.body);
    for token in &body_tokens {
        match token {
            Token::Tag(tag) => {
                tx.execute(
                    "INSERT OR IGNORE INTO tags (entry_id, tag, surface) VALUES (?1, ?2, 'body')",
                    params![row_id, tag],
                )?;
            }
            Token::Mention(slug) => {
                tx.execute(
                    "INSERT OR IGNORE INTO mentions (entry_id, slug, surface) VALUES (?1, ?2, 'body')",
                    params![row_id, slug],
                )?;
            }
            Token::WikiLink(target) => {
                tx.execute(
                    "INSERT INTO links (src_entry_id, target_raw) VALUES (?1, ?2)",
                    params![row_id, target],
                )?;
            }
        }
    }

    // ── 7. FTS: push title + body text ───────────────────────────────────────
    // The FTS table uses external-content mode (content='entries'), so we need
    // to explicitly update it.  The triggers on `entries` fire on INSERT/UPDATE
    // but only have access to `title`; `body` is not stored in `entries`.
    // We delete the old FTS row and re-insert with both title and body.
    tx.execute(
        "INSERT INTO fts(fts, rowid, title, body) VALUES ('delete', ?1, '', '')",
        params![row_id],
    )?;
    tx.execute(
        "INSERT INTO fts(rowid, title, body) VALUES (?1, ?2, ?3)",
        params![row_id, title.as_deref().unwrap_or(""), &entry.body],
    )?;

    tx.commit()?;
    Ok(())
}

/// Replace all people rows atomically.
pub fn set_people(
    conn: &mut Connection,
    rows: &[super::query::PeopleRow],
) -> Result<(), IndexError> {
    let tx = conn.transaction()?;
    tx.execute("DELETE FROM people", [])?;
    for r in rows {
        tx.execute(
            "INSERT INTO people (slug, full_name, color, avatar_path) VALUES (?1, ?2, ?3, ?4)",
            params![r.slug, r.full_name, r.color, r.avatar_path],
        )?;
    }
    tx.commit()?;
    Ok(())
}

/// Replace all global tag_meta rows (scope_path IS NULL) atomically.
/// Scoped rows from _group.md are left untouched.
pub fn set_tag_meta(conn: &mut Connection, rows: &[super::TagMetaRow]) -> Result<(), IndexError> {
    let tx = conn.transaction()?;
    tx.execute("DELETE FROM tag_meta WHERE scope_path IS NULL", [])?;
    for r in rows {
        tx.execute(
            "INSERT OR REPLACE INTO tag_meta (tag, description, color, icon, scope_path) \
             VALUES (?1, ?2, ?3, ?4, NULL)",
            params![r.tag, r.description, r.color, r.icon],
        )?;
    }
    tx.commit()?;
    Ok(())
}

/// Replace all scoped tag_meta rows for a given `scope_path` atomically.
/// Global rows (scope_path IS NULL) are not touched.
pub fn set_scoped_tag_meta(
    conn: &mut Connection,
    scope_path: &str,
    rows: &[super::TagMetaRow],
) -> Result<(), IndexError> {
    let tx = conn.transaction()?;
    tx.execute(
        "DELETE FROM tag_meta WHERE scope_path = ?1",
        params![scope_path],
    )?;
    for r in rows {
        tx.execute(
            "INSERT OR REPLACE INTO tag_meta (tag, description, color, icon, scope_path) \
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![r.tag, r.description, r.color, r.icon, scope_path],
        )?;
    }
    tx.commit()?;
    Ok(())
}

/// Upsert a single group_meta row.
pub fn set_group_meta(conn: &mut Connection, row: &super::GroupMetaRow) -> Result<(), IndexError> {
    conn.execute(
        "INSERT INTO group_meta (path, name, icon, color, sort_order, view, schema_json)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(path) DO UPDATE SET
             name        = excluded.name,
             icon        = excluded.icon,
             color       = excluded.color,
             sort_order  = excluded.sort_order,
             view        = excluded.view,
             schema_json = excluded.schema_json",
        params![
            row.path,
            row.name,
            row.icon,
            row.color,
            row.sort_order,
            row.view,
            row.schema_json,
        ],
    )?;
    Ok(())
}

// ── Helpers ──────────────────────────────────────────────────────────────────

fn format_datetime(dt: &crate::core::frontmatter::DatetimeValue) -> String {
    let c = dt.civil;
    match dt.offset_seconds {
        Some(0) => format!(
            "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
            c.year(),
            c.month(),
            c.day(),
            c.hour(),
            c.minute(),
            c.second()
        ),
        Some(off) => {
            let sign = if off >= 0 { '+' } else { '-' };
            let abs = off.unsigned_abs();
            let h = abs / 3600;
            let m = (abs % 3600) / 60;
            format!(
                "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}{}{:02}:{:02}",
                c.year(),
                c.month(),
                c.day(),
                c.hour(),
                c.minute(),
                c.second(),
                sign,
                h,
                m
            )
        }
        None => format!(
            "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}",
            c.year(),
            c.month(),
            c.day(),
            c.hour(),
            c.minute(),
            c.second()
        ),
    }
}

fn type_names(val: &Value) -> (Option<&'static str>, Option<&'static str>) {
    let t = match val {
        Value::String(_) => "string",
        Value::Number(_) => "number",
        Value::Boolean(_) => "boolean",
        Value::Date(_) => "date",
        Value::Datetime(_) => "datetime",
        Value::Range(_) => "range",
        Value::Tags(_) => "tag[]",
        Value::Enum(_) => "enum",
        Value::Refs(_) => "ref[]",
        Value::Opaque(_) => "opaque",
    };
    (None, Some(t))
}

fn value_to_json(val: &Value) -> String {
    match val {
        Value::String(s) => serde_json::to_string(s).unwrap_or_default(),
        Value::Number(n) => n.to_string(),
        Value::Boolean(b) => b.to_string(),
        Value::Date(d) => format!("\"{}\"", d),
        Value::Datetime(dt) => format!("\"{}\"", format_datetime(dt)),
        Value::Range(r) => {
            let start = match &r.start {
                crate::core::frontmatter::RangeEndpoint::Date(d) => format!("{d}"),
                crate::core::frontmatter::RangeEndpoint::Datetime(dt) => format_datetime(dt),
            };
            let end = match &r.end {
                crate::core::frontmatter::RangeEndpoint::Date(d) => format!("{d}"),
                crate::core::frontmatter::RangeEndpoint::Datetime(dt) => format_datetime(dt),
            };
            format!("\"{}..{}\"", start, end)
        }
        Value::Tags(tags) => serde_json::to_string(tags).unwrap_or_default(),
        Value::Enum(s) => serde_json::to_string(s).unwrap_or_default(),
        Value::Refs(refs) => serde_json::to_string(refs).unwrap_or_default(),
        Value::Opaque(s) => s.clone(),
    }
}
