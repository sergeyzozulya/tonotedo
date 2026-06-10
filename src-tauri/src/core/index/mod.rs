// SQLite index module — spec: design-0001-index-and-reconciliation, issue #5.
//
// Public API:
//   - `Index`           — the index handle (open/create, query, upsert, remove)
//   - `IndexError`      — error type
//   - `SearchResult`    — one FTS hit with entry_id + rank
//   - `TagSurface`      — frontmatter | body
//   - `scanner`         — body inline scanner (exported for tests)

mod error;
mod migrations;
mod query;
mod scanner;
mod upsert;

#[cfg(test)]
mod tests;

pub use error::IndexError;
pub use query::{BacklinkRow, EntryRow, PeopleRow, SearchResult, TagRow};
pub use scanner::scan_body;

use rusqlite::{params, Connection, OpenFlags};

/// The index handle.  A single `Connection` in WAL mode; the design (design-0001)
/// mandates a single writer — callers must not share across threads without
/// external serialisation.  For in-memory databases (tests) the connection is
/// opened with `:memory:`.
pub struct Index {
    conn: Connection,
}

impl Index {
    /// Open (or create) the index database at `path`.
    ///
    /// Applies all pending schema migrations and sets WAL mode on first open.
    pub fn open(path: &str) -> Result<Self, IndexError> {
        let conn = Connection::open_with_flags(
            path,
            OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_CREATE,
        )?;
        let mut idx = Index { conn };
        idx.configure()?;
        migrations::run(&mut idx.conn)?;
        Ok(idx)
    }

    /// Open an in-memory database.  Intended for tests.
    pub fn open_in_memory() -> Result<Self, IndexError> {
        let conn = Connection::open_in_memory()?;
        let mut idx = Index { conn };
        idx.configure()?;
        migrations::run(&mut idx.conn)?;
        Ok(idx)
    }

    fn configure(&mut self) -> Result<(), IndexError> {
        // WAL mode for concurrent readers with a single writer.
        self.conn
            .execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;")?;
        Ok(())
    }

    // ── Write API ────────────────────────────────────────────────────────────

    /// Insert or replace all derived rows for one entry, transactionally.
    ///
    /// `path`       — library-relative path (the PK in `files` / UNIQUE in `entries`)
    /// `slug`       — filename without extension
    /// `group_path` — parent group path (empty string at library root)
    /// `entry`      — parsed frontmatter + body from the frontmatter module
    /// `mtime`      — file modification time (seconds since epoch)
    /// `size`       — file size in bytes
    /// `content_hash` — hex-encoded hash for staleness detection
    #[allow(clippy::too_many_arguments)]
    pub fn upsert_entry(
        &mut self,
        path: &str,
        slug: &str,
        group_path: &str,
        entry: &crate::core::frontmatter::Entry,
        mtime: i64,
        size: i64,
        content_hash: &str,
    ) -> Result<(), IndexError> {
        upsert::upsert_entry(
            &mut self.conn,
            path,
            slug,
            group_path,
            entry,
            mtime,
            size,
            content_hash,
        )
    }

    /// Remove all rows derived from `path` (cascade deletes handle child tables).
    pub fn remove_entry(&mut self, path: &str) -> Result<(), IndexError> {
        let tx = self.conn.transaction()?;
        tx.execute("DELETE FROM files WHERE path = ?1", params![path])?;
        tx.execute("DELETE FROM entries WHERE path = ?1", params![path])?;
        tx.commit()?;
        Ok(())
    }

    /// Rename an entry in place, preserving its id and all derived rows.
    ///
    /// Updates `files.path`, `entries.path`, `entries.slug`, `entries.group_path`
    /// atomically.  Backlinks (links.src_entry_id) survive because they reference
    /// the integer PK, not the path.
    pub fn rename_entry(
        &mut self,
        old_path: &str,
        new_path: &str,
        new_slug: &str,
        new_group_path: &str,
    ) -> Result<(), IndexError> {
        let tx = self.conn.transaction()?;
        tx.execute(
            "UPDATE files SET path = ?1 WHERE path = ?2",
            params![new_path, old_path],
        )?;
        tx.execute(
            "UPDATE entries SET path = ?1, slug = ?2, group_path = ?3 WHERE path = ?4",
            params![new_path, new_slug, new_group_path, old_path],
        )?;
        tx.commit()?;
        Ok(())
    }

    // ── Read API ─────────────────────────────────────────────────────────────

    /// Full-text search.  Returns up to `limit` results ranked by BM25 score
    /// (title weighted 10× over body) with `updated` as the tiebreak.
    pub fn search(&self, text: &str, limit: usize) -> Result<Vec<SearchResult>, IndexError> {
        query::search(&self.conn, text, limit)
    }

    /// All entries whose `group_path` starts with `prefix`.
    pub fn entries_in_group(&self, prefix: &str) -> Result<Vec<EntryRow>, IndexError> {
        query::entries_in_group(&self.conn, prefix)
    }

    /// Aggregate tag index — union of frontmatter and body surfaces.
    pub fn tag_index(&self) -> Result<Vec<TagRow>, IndexError> {
        query::tag_index(&self.conn)
    }

    /// Aggregate mentions index — union of frontmatter and body surfaces.
    pub fn mentions_index(&self) -> Result<Vec<TagRow>, IndexError> {
        query::mentions_index(&self.conn)
    }

    /// People metadata.
    pub fn people_index(&self) -> Result<Vec<PeopleRow>, IndexError> {
        query::people_index(&self.conn)
    }

    /// Backlinks: all entries that link to `entry_id`.
    pub fn backlinks(&self, entry_id: i64) -> Result<Vec<BacklinkRow>, IndexError> {
        query::backlinks(&self.conn, entry_id)
    }

    // ── Bulk upserts ─────────────────────────────────────────────────────────

    /// Replace all rows in the `people` table from a list of declarations.
    pub fn set_people(&mut self, rows: &[PeopleRow]) -> Result<(), IndexError> {
        upsert::set_people(&mut self.conn, rows)
    }

    /// Replace all rows in the `tag_meta` table.
    pub fn set_tag_meta(&mut self, rows: &[TagMetaRow]) -> Result<(), IndexError> {
        upsert::set_tag_meta(&mut self.conn, rows)
    }

    /// Return the integer row-id for an entry path (used by tests / callers).
    pub fn entry_id_for_path(&self, path: &str) -> Result<Option<i64>, IndexError> {
        query::entry_id_for_path(&self.conn, path)
    }
}

/// Tag metadata row (mirrors `tag_meta` table).
#[derive(Debug, Clone, PartialEq)]
pub struct TagMetaRow {
    pub tag: String,
    pub description: Option<String>,
    pub color: Option<String>,
    pub icon: Option<String>,
}
