// Query layer for the index.

use rusqlite::{params, Connection};

use super::IndexError;

/// One FTS search hit.
#[derive(Debug, Clone, PartialEq)]
pub struct SearchResult {
    /// Integer row-id of the entry.
    pub id: i64,
    /// Frontmatter id string (may be None for entries lacking `id:`).
    pub entry_id: Option<String>,
    pub path: String,
    pub title: Option<String>,
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
pub fn search(
    conn: &Connection,
    text: &str,
    limit: usize,
) -> Result<Vec<SearchResult>, IndexError> {
    if text.trim().is_empty() {
        return recent_entries(conn, limit.min(50));
    }

    let mut stmt = conn.prepare(
        "SELECT e.id, e.entry_id, e.path, e.title, bm25(fts, 10, 1) AS rank
         FROM fts
         JOIN entries e ON e.id = fts.rowid
         WHERE fts MATCH ?1
         ORDER BY rank, e.updated DESC
         LIMIT ?2",
    )?;

    let rows = stmt.query_map(params![text, limit as i64], |r| {
        Ok(SearchResult {
            id: r.get(0)?,
            entry_id: r.get(1)?,
            path: r.get(2)?,
            title: r.get(3)?,
            rank: r.get(4)?,
        })
    })?;

    rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
}

fn recent_entries(conn: &Connection, limit: usize) -> Result<Vec<SearchResult>, IndexError> {
    let mut stmt = conn.prepare(
        "SELECT id, entry_id, path, title, 0.0
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
            rank: r.get(4)?,
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
