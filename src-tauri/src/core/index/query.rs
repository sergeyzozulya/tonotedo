// Query layer for the index.

use rusqlite::{params, Connection};
use serde_json;

use super::IndexError;

// ── FTS query sanitisation ────────────────────────────────────────────────────

/// Escape a raw user query string into a safe FTS5 MATCH expression.
///
/// Rules (FTS5 §Full-text query syntax):
///   - Split on whitespace.
///   - Preserve quoted phrases ("exact phrase") as a single token.
///   - Each bare token is wrapped in double-quotes with any internal double-
///     quotes doubled (e.g. `O"Reilly` → `"O""Reilly"`).
///   - The last bare/phrase token gets a `*` suffix for prefix matching
///     (spec 0009: prefix matching is the floor).
///   - Tokens are joined with a single space (FTS5 implicit AND).
///
/// Empty or whitespace-only input returns an empty string (caller must handle
/// the empty-query path before calling this).
pub fn sanitize_fts_query(raw: &str) -> String {
    if raw.trim().is_empty() {
        return String::new();
    }

    let mut tokens: Vec<String> = Vec::new();
    let chars: Vec<char> = raw.chars().collect();
    let mut i = 0;

    while i < chars.len() {
        // Skip whitespace between tokens.
        if chars[i].is_whitespace() {
            i += 1;
            continue;
        }

        if chars[i] == '"' {
            // Quoted phrase: consume up to the next unescaped `"`.
            i += 1; // skip opening `"`
            let mut phrase = String::new();
            while i < chars.len() && chars[i] != '"' {
                phrase.push(chars[i]);
                i += 1;
            }
            if i < chars.len() {
                i += 1; // skip closing `"`
            }
            if !phrase.is_empty() {
                // Re-wrap the phrase, doubling any internal quotes.
                let escaped = phrase.replace('"', "\"\"");
                tokens.push(format!("\"{}\"", escaped));
            }
        } else {
            // Bare word: consume until whitespace.
            let mut word = String::new();
            while i < chars.len() && !chars[i].is_whitespace() {
                word.push(chars[i]);
                i += 1;
            }
            if !word.is_empty() {
                // Double any internal double-quotes, then wrap.
                let escaped = word.replace('"', "\"\"");
                tokens.push(format!("\"{}\"", escaped));
            }
        }
    }

    if tokens.is_empty() {
        return String::new();
    }

    // Append `*` to the last token for prefix matching (strip the trailing `"`,
    // append `*`, then re-add the `"`).
    if let Some(last) = tokens.last_mut() {
        // last looks like `"something"` — strip the trailing quote and add `*"`.
        if last.ends_with('"') {
            last.pop();
            last.push('*');
            last.push('"');
        }
    }

    tokens.join(" ")
}

/// Expand a raw user query into FTS slugs via the people table.
///
/// For each whitespace-separated token in `raw` (case-insensitive):
/// - If a people row exists whose `slug` or `full_name` contains the token
///   (LIKE `%token%`) → collect those slugs.
///
/// Returns the set of matching slugs (may be empty).
fn slugs_matching_query(conn: &Connection, raw: &str) -> Vec<String> {
    let mut slugs: Vec<String> = Vec::new();
    for token in raw.split_whitespace() {
        let pattern = format!("%{}%", token.to_lowercase());
        let mut stmt = match conn.prepare(
            "SELECT slug FROM people \
             WHERE lower(slug) LIKE ?1 OR lower(full_name) LIKE ?1",
        ) {
            Ok(s) => s,
            Err(_) => continue,
        };
        let rows = stmt.query_map(params![pattern], |r| r.get::<_, String>(0));
        if let Ok(rows) = rows {
            for row in rows.flatten() {
                if !slugs.contains(&row) {
                    slugs.push(row);
                }
            }
        }
    }
    slugs
}

/// One FTS search hit.
#[derive(Debug, Clone, PartialEq)]
pub struct SearchResult {
    /// Integer row-id of the entry.
    pub id: i64,
    /// Frontmatter id string (may be None for entries lacking `id:`).
    pub entry_id: Option<String>,
    pub path: String,
    pub title: Option<String>,
    /// ISO-8601 last-modified timestamp from `entries.updated` (None if unset).
    pub updated: Option<String>,
    /// BM25 score (negative: lower = more relevant).
    pub rank: f64,
}

/// One entry row (for `entries_in_group` results).
#[derive(Debug, Clone, PartialEq)]
pub struct EntryRow {
    pub id: i64,
    pub entry_id: Option<String>,
    pub path: String,
    pub slug: String,
    pub group_path: String,
    pub title: Option<String>,
    pub created: Option<String>,
    pub updated: Option<String>,
    pub archived: bool,
}

/// One row from the aggregated tag index.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct TagRow {
    pub entry_id: i64,
    pub tag: String,
    pub surface: String,
}

/// One row from the people table.
#[derive(Debug, Clone, PartialEq)]
pub struct PeopleRow {
    pub slug: String,
    pub full_name: Option<String>,
    pub color: Option<String>,
    pub avatar_path: Option<String>,
}

/// One backlink row.
#[derive(Debug, Clone, PartialEq)]
pub struct BacklinkRow {
    pub src_entry_id: i64,
    pub src_path: String,
    pub target_raw: String,
}

// ── search ───────────────────────────────────────────────────────────────────

/// Full-text search with BM25 ranking.
///
/// Title column is weighted 10×, body 1× via `bm25(fts, 10, 1)`.
/// Ties broken by `updated DESC` (recency weighting per 0009).
///
/// Empty `text` returns the 50 most-recently-updated entries (spec 0009 "Empty
/// query: show recently updated entries (top 50)").
///
/// ## People-name join (spec 0005 AC10)
///
/// For each whitespace-separated token in the query the people table is checked
/// for slugs whose `full_name` or `slug` contains the token (case-insensitive
/// LIKE).  Entries that mention any of those slugs (via the `mentions` table,
/// both surfaces) are unioned into the result set, ranked below direct FTS hits
/// (rank = 0, recency-ordered), and deduplicated.
pub fn search(
    conn: &Connection,
    text: &str,
    limit: usize,
) -> Result<Vec<SearchResult>, IndexError> {
    if text.trim().is_empty() {
        return recent_entries(conn, limit.min(50));
    }

    let fts_query = sanitize_fts_query(text);

    // Direct FTS hits (title/body).
    let mut fts_results: Vec<SearchResult> = if !fts_query.is_empty() {
        let mut stmt = conn.prepare(
            "SELECT e.id, e.entry_id, e.path, e.title, e.updated, bm25(fts, 10, 1) AS rank
             FROM fts
             JOIN entries e ON e.id = fts.rowid
             WHERE fts MATCH ?1
             ORDER BY rank, e.updated DESC
             LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![fts_query, limit as i64], |r| {
            Ok(SearchResult {
                id: r.get(0)?,
                entry_id: r.get(1)?,
                path: r.get(2)?,
                title: r.get(3)?,
                updated: r.get(4)?,
                rank: r.get(5)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>()?
    } else {
        Vec::new()
    };

    // People-name join (AC10): expand tokens to slugs via the people table,
    // then find entries that mention those slugs.
    let matched_slugs = slugs_matching_query(conn, text);
    if !matched_slugs.is_empty() {
        // Collect ids already in fts_results to avoid duplicates.
        let seen_ids: std::collections::HashSet<i64> = fts_results.iter().map(|r| r.id).collect();

        for slug in &matched_slugs {
            let mut stmt = conn.prepare(
                "SELECT DISTINCT e.id, e.entry_id, e.path, e.title, e.updated
                 FROM mentions m
                 JOIN entries e ON e.id = m.entry_id
                 WHERE lower(m.slug) = lower(?1)
                 ORDER BY e.updated DESC",
            )?;
            let rows = stmt.query_map(params![slug], |r| {
                Ok(SearchResult {
                    id: r.get(0)?,
                    entry_id: r.get(1)?,
                    path: r.get(2)?,
                    title: r.get(3)?,
                    updated: r.get(4)?,
                    rank: 0.0, // ranked below direct FTS hits
                })
            })?;
            for row in rows {
                let sr = row?;
                if !seen_ids.contains(&sr.id) {
                    fts_results.push(sr);
                }
            }
        }
    }

    fts_results.truncate(limit);
    Ok(fts_results)
}

fn recent_entries(conn: &Connection, limit: usize) -> Result<Vec<SearchResult>, IndexError> {
    let mut stmt = conn.prepare(
        "SELECT id, entry_id, path, title, updated, 0.0
         FROM entries
         ORDER BY updated DESC, id DESC
         LIMIT ?1",
    )?;
    let rows = stmt.query_map(params![limit as i64], |r| {
        Ok(SearchResult {
            id: r.get(0)?,
            entry_id: r.get(1)?,
            path: r.get(2)?,
            title: r.get(3)?,
            updated: r.get(4)?,
            rank: r.get(5)?,
        })
    })?;
    rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
}

// ── entries_in_group ─────────────────────────────────────────────────────────

/// All entries whose group_path equals or is a descendant of `prefix`.
///
/// `prefix = ""` returns all entries.
/// `prefix = "Work"` returns entries in Work and Work/Atlas etc.
pub fn entries_in_group(conn: &Connection, prefix: &str) -> Result<Vec<EntryRow>, IndexError> {
    // Match the group itself or true descendants ("Work" must not match "Workshop").
    let (exact, pattern) = if prefix.is_empty() {
        ("%".to_string(), "%".to_string())
    } else {
        (prefix.to_string(), format!("{}/%", prefix))
    };

    let mut stmt = conn.prepare(
        "SELECT id, entry_id, path, slug, group_path, title, created, updated, archived
         FROM entries
         WHERE group_path = ?1 OR group_path LIKE ?2
         ORDER BY updated DESC",
    )?;

    let rows = stmt.query_map(params![exact, pattern], |r| {
        Ok(EntryRow {
            id: r.get(0)?,
            entry_id: r.get(1)?,
            path: r.get(2)?,
            slug: r.get(3)?,
            group_path: r.get(4)?,
            title: r.get(5)?,
            created: r.get(6)?,
            updated: r.get(7)?,
            archived: r.get::<_, i64>(8)? != 0,
        })
    })?;

    rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
}

// ── tag_index ────────────────────────────────────────────────────────────────

/// Aggregate tag index — all (entry_id, tag, surface) rows.
pub fn tag_index(conn: &Connection) -> Result<Vec<TagRow>, IndexError> {
    let mut stmt =
        conn.prepare("SELECT entry_id, tag, surface FROM tags ORDER BY entry_id, tag, surface")?;
    let rows = stmt.query_map([], |r| {
        Ok(TagRow {
            entry_id: r.get(0)?,
            tag: r.get(1)?,
            surface: r.get(2)?,
        })
    })?;
    rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
}

// ── mentions_index ───────────────────────────────────────────────────────────

/// Aggregate mentions index — all (entry_id, slug, surface) rows.
pub fn mentions_index(conn: &Connection) -> Result<Vec<TagRow>, IndexError> {
    let mut stmt = conn
        .prepare("SELECT entry_id, slug, surface FROM mentions ORDER BY entry_id, slug, surface")?;
    let rows = stmt.query_map([], |r| {
        Ok(TagRow {
            entry_id: r.get(0)?,
            tag: r.get(1)?,
            surface: r.get(2)?,
        })
    })?;
    rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
}

// ── people_index ─────────────────────────────────────────────────────────────

pub fn people_index(conn: &Connection) -> Result<Vec<PeopleRow>, IndexError> {
    let mut stmt =
        conn.prepare("SELECT slug, full_name, color, avatar_path FROM people ORDER BY slug")?;
    let rows = stmt.query_map([], |r| {
        Ok(PeopleRow {
            slug: r.get(0)?,
            full_name: r.get(1)?,
            color: r.get(2)?,
            avatar_path: r.get(3)?,
        })
    })?;
    rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
}

// ── backlinks ────────────────────────────────────────────────────────────────

/// Entries that link TO `entry_id` (via wikilinks in the body).
pub fn backlinks(conn: &Connection, entry_id: i64) -> Result<Vec<BacklinkRow>, IndexError> {
    let mut stmt = conn.prepare(
        "SELECT l.src_entry_id, e.path, l.target_raw
         FROM links l
         JOIN entries e ON e.id = l.src_entry_id
         WHERE l.resolved_entry_id = ?1
         ORDER BY e.updated DESC",
    )?;
    let rows = stmt.query_map(params![entry_id], |r| {
        Ok(BacklinkRow {
            src_entry_id: r.get(0)?,
            src_path: r.get(1)?,
            target_raw: r.get(2)?,
        })
    })?;
    rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
}

// ── paths_with_tag ───────────────────────────────────────────────────────────

/// All entry paths (both surfaces) that carry `tag`, case-insensitively.
pub fn paths_with_tag(conn: &Connection, tag: &str) -> Result<Vec<String>, IndexError> {
    let mut stmt = conn.prepare(
        "SELECT DISTINCT e.path
         FROM tags t
         JOIN entries e ON e.id = t.entry_id
         WHERE lower(t.tag) = lower(?1)
         ORDER BY e.path",
    )?;
    let rows = stmt.query_map(params![tag], |r| r.get(0))?;
    rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
}

// ── paths_with_mention ────────────────────────────────────────────────────────

/// All entry paths (both surfaces) that carry mention `slug`, case-insensitively.
pub fn paths_with_mention(conn: &Connection, slug: &str) -> Result<Vec<String>, IndexError> {
    let mut stmt = conn.prepare(
        "SELECT DISTINCT e.path
         FROM mentions m
         JOIN entries e ON e.id = m.entry_id
         WHERE lower(m.slug) = lower(?1)
         ORDER BY e.path",
    )?;
    let rows = stmt.query_map(params![slug], |r| r.get(0))?;
    rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
}

// ── entry_id_for_path ────────────────────────────────────────────────────────

pub fn entry_id_for_path(conn: &Connection, path: &str) -> Result<Option<i64>, IndexError> {
    let result: rusqlite::Result<i64> = conn.query_row(
        "SELECT id FROM entries WHERE path = ?1",
        params![path],
        |r| r.get(0),
    );
    match result {
        Ok(id) => Ok(Some(id)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

// ── entry_id_for_frontmatter_id ───────────────────────────────────────────────

/// Look up the integer row-id and path of an entry by its frontmatter `id` string.
///
/// Used by rename detection: when a file disappears and a new one appears with
/// the same frontmatter id, the reconciler can detect a rename rather than a
/// delete+create pair.
pub fn entry_by_frontmatter_id(
    conn: &Connection,
    frontmatter_id: &str,
) -> Result<Option<(i64, String)>, IndexError> {
    let result: rusqlite::Result<(i64, String)> = conn.query_row(
        "SELECT id, path FROM entries WHERE entry_id = ?1",
        params![frontmatter_id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    );
    match result {
        Ok(row) => Ok(Some(row)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

// ── frontmatter_id_for_path ───────────────────────────────────────────────────

/// Look up the frontmatter `id` string for an entry path (indexed lookup).
///
/// Returns `Ok(None)` when the path has no entry row, and `Ok(Some(None))`
/// when the row exists but lacks a frontmatter id.
pub fn frontmatter_id_for_path(
    conn: &Connection,
    path: &str,
) -> Result<Option<Option<String>>, IndexError> {
    let result: rusqlite::Result<Option<String>> = conn.query_row(
        "SELECT entry_id FROM entries WHERE path = ?1",
        params![path],
        |r| r.get(0),
    );
    match result {
        Ok(fmid) => Ok(Some(fmid)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

// ── tag_meta_index ────────────────────────────────────────────────────────────

/// All rows from the `tag_meta` projection table (includes scoped rows).
pub fn tag_meta_index(conn: &Connection) -> Result<Vec<super::TagMetaRow>, IndexError> {
    let mut stmt = conn
        .prepare("SELECT tag, description, color, icon, scope_path FROM tag_meta ORDER BY tag")?;
    let rows = stmt.query_map([], |r| {
        Ok(super::TagMetaRow {
            tag: r.get(0)?,
            description: r.get(1)?,
            color: r.get(2)?,
            icon: r.get(3)?,
            scope_path: r.get(4)?,
        })
    })?;
    rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
}

// ── group_meta queries ────────────────────────────────────────────────────────

/// Fetch the group_meta row for a given path.
pub fn group_meta_for_path(
    conn: &Connection,
    path: &str,
) -> Result<Option<super::GroupMetaRow>, IndexError> {
    let result = conn.query_row(
        "SELECT path, name, icon, color, sort_order, view, schema_json \
         FROM group_meta WHERE path = ?1",
        params![path],
        |r| {
            Ok(super::GroupMetaRow {
                path: r.get(0)?,
                name: r.get(1)?,
                icon: r.get(2)?,
                color: r.get(3)?,
                sort_order: r.get(4)?,
                view: r.get(5)?,
                schema_json: r.get(6)?,
            })
        },
    );
    match result {
        Ok(row) => Ok(Some(row)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

/// All group_meta rows.
pub fn all_group_meta(conn: &Connection) -> Result<Vec<super::GroupMetaRow>, IndexError> {
    let mut stmt = conn.prepare(
        "SELECT path, name, icon, color, sort_order, view, schema_json \
         FROM group_meta ORDER BY path",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(super::GroupMetaRow {
            path: r.get(0)?,
            name: r.get(1)?,
            icon: r.get(2)?,
            color: r.get(3)?,
            sort_order: r.get(4)?,
            view: r.get(5)?,
            schema_json: r.get(6)?,
        })
    })?;
    rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
}

/// Compute the effective schema for a group by merging ancestor chain.
///
/// The chain is built from the root down to `group_path` (e.g. for
/// "work/atlas/phase1" the chain is ["work", "work/atlas", "work/atlas/phase1"]).
/// Child properties override ancestor properties.  Returns a JSON string of the
/// merged property map, or `None` when no group in the chain has a schema.
pub fn effective_schema(conn: &Connection, group_path: &str) -> Result<Option<String>, IndexError> {
    if group_path.is_empty() {
        return Ok(None);
    }

    // Build ancestor chain from root to the target group.
    let parts: Vec<&str> = group_path.split('/').collect();
    let mut chain: Vec<String> = Vec::with_capacity(parts.len());
    for i in 1..=parts.len() {
        chain.push(parts[..i].join("/"));
    }

    // Collect schema_json from each level (root first, child last).
    // We merge: child overrides parent.
    let mut merged: serde_json::Map<String, serde_json::Value> = serde_json::Map::new();
    let mut any_schema = false;

    for ancestor in &chain {
        let row = group_meta_for_path(conn, ancestor)?;
        if let Some(r) = row {
            if let Some(schema_str) = r.schema_json {
                if let Ok(serde_json::Value::Object(map)) =
                    serde_json::from_str::<serde_json::Value>(&schema_str)
                {
                    for (k, v) in map {
                        merged.insert(k, v);
                    }
                    any_schema = true;
                }
            }
        }
    }

    if any_schema {
        Ok(Some(serde_json::to_string(&merged).unwrap_or_default()))
    } else {
        Ok(None)
    }
}

// ── entries_by_slug ───────────────────────────────────────────────────────────

/// All entries with the given slug.  Used for link resolution (spec 0006):
/// - exactly one match → resolve; zero or two+ → leave NULL (ambiguous).
///
/// Returns (rowid, group_path) pairs.
pub fn entries_by_slug(conn: &Connection, slug: &str) -> Result<Vec<(i64, String)>, IndexError> {
    let mut stmt =
        conn.prepare("SELECT id, group_path FROM entries WHERE slug = ?1 ORDER BY id")?;
    let rows = stmt.query_map(params![slug], |r| Ok((r.get(0)?, r.get(1)?)))?;
    rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
}

// ── resolve_links ─────────────────────────────────────────────────────────────

/// Resolve wikilink `target_raw` values to `resolved_entry_id` for all
/// unresolved links (where `resolved_entry_id IS NULL`).
///
/// Resolution rules (spec 0006):
/// - `[[slug]]`             → find by bare slug; unique → resolve; ambiguous → NULL.
/// - `[[group/path/slug]]`  → find by exact (group_path, slug) pair; unique → resolve.
///
/// Any currently-resolved link whose target no longer exists is NULLed out.
/// This function is a full re-resolution pass — called after a batch of upserts.
///
/// Invariant: callers should call this after every batch to keep links consistent.
/// The full pass is O(#unresolved_links × index_lookup); acceptable for small
/// post-upsert batches.  A global re-resolve is done at startup rescan completion.
pub fn resolve_links(conn: &Connection) -> Result<(), IndexError> {
    // Collect all link rows that need resolution.
    let links: Vec<(i64, String)> = {
        let mut stmt = conn.prepare("SELECT id, target_raw FROM links")?;
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
        rows.collect::<Result<Vec<_>, _>>()?
    };

    for (link_id, target_raw) in links {
        let resolved = resolve_one(conn, &target_raw)?;
        conn.execute(
            "UPDATE links SET resolved_entry_id = ?1, resolved_group_path = NULL WHERE id = ?2",
            params![resolved, link_id],
        )?;
    }
    Ok(())
}

/// Resolve a single `target_raw` string to an entry row-id or None.
///
/// Formats handled:
/// - `slug` — bare slug; unique entry match required.
/// - `group/path/slug` — path-qualified; last component is slug, everything
///   before is the group_path prefix.
fn resolve_one(conn: &Connection, target_raw: &str) -> Result<Option<i64>, IndexError> {
    // Strip leading/trailing whitespace that may appear in hand-written wikilinks.
    let target = target_raw.trim();

    // Determine if this is a path-qualified target.
    if let Some(slash_pos) = target.rfind('/') {
        // Path-qualified: `group_path/slug`
        let group_path = &target[..slash_pos];
        let slug = &target[slash_pos + 1..];
        let result: rusqlite::Result<i64> = conn.query_row(
            "SELECT id FROM entries WHERE group_path = ?1 AND slug = ?2",
            params![group_path, slug],
            |r| r.get(0),
        );
        return match result {
            Ok(id) => Ok(Some(id)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e.into()),
        };
    }

    // Bare slug: look up all entries with this slug.
    let matches = entries_by_slug(conn, target)?;
    if matches.len() == 1 {
        Ok(Some(matches[0].0))
    } else {
        // Zero or more than one match → leave unresolved (NULL).
        Ok(None)
    }
}
