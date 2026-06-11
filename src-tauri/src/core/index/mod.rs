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
pub use query::{sanitize_fts_query, BacklinkRow, EntryRow, PeopleRow, SearchResult, TagRow};
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

    /// Update (or insert) the `files` ledger row for a path without touching
    /// the `entries` row.
    ///
    /// Used for reserved / projection files that have a ledger row but no
    /// entry row.  This lets the rescan skip re-reading unchanged projection
    /// files.
    pub fn upsert_files_row(
        &mut self,
        path: &str,
        mtime: i64,
        size: i64,
        content_hash: &str,
    ) -> Result<(), IndexError> {
        self.conn.execute(
            "INSERT OR REPLACE INTO files (path, mtime, size, content_hash)
             VALUES (?1, ?2, ?3, ?4)",
            params![path, mtime, size, content_hash],
        )?;
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

    /// Replace all global rows in the `tag_meta` table (scope_path IS NULL).
    /// Scoped rows (from _group.md) are preserved.
    pub fn set_tag_meta(&mut self, rows: &[TagMetaRow]) -> Result<(), IndexError> {
        upsert::set_tag_meta(&mut self.conn, rows)
    }

    /// Replace all scoped tag rows for a given `scope_path` (from _group.md).
    /// Global rows (scope_path IS NULL) are not touched.
    pub fn set_scoped_tag_meta(
        &mut self,
        scope_path: &str,
        rows: &[TagMetaRow],
    ) -> Result<(), IndexError> {
        upsert::set_scoped_tag_meta(&mut self.conn, scope_path, rows)
    }

    /// Upsert a single `group_meta` row from a parsed `_group.md` file.
    pub fn set_group_meta(&mut self, row: &GroupMetaRow) -> Result<(), IndexError> {
        upsert::set_group_meta(&mut self.conn, row)
    }

    /// Remove the `group_meta` row for a given path (e.g. when _group.md deleted).
    pub fn remove_group_meta(&mut self, path: &str) -> Result<(), IndexError> {
        self.conn
            .execute("DELETE FROM group_meta WHERE path = ?1", params![path])?;
        Ok(())
    }

    /// Fetch the `group_meta` row for a path, if any.
    pub fn group_meta_for_path(&self, path: &str) -> Result<Option<GroupMetaRow>, IndexError> {
        query::group_meta_for_path(&self.conn, path)
    }

    /// All group_meta rows (for list_groups augmentation).
    pub fn all_group_meta(&self) -> Result<Vec<GroupMetaRow>, IndexError> {
        query::all_group_meta(&self.conn)
    }

    /// Compute the effective schema for a group by merging ancestor chain.
    /// Child overrides parent for any given property key.
    /// Returns a JSON string of the merged schema map, or `None` if none found.
    pub fn effective_schema(&self, group_path: &str) -> Result<Option<String>, IndexError> {
        query::effective_schema(&self.conn, group_path)
    }

    /// Return the integer row-id for an entry path (used by tests / callers).
    pub fn entry_id_for_path(&self, path: &str) -> Result<Option<i64>, IndexError> {
        query::entry_id_for_path(&self.conn, path)
    }

    /// All entry paths (union of both surfaces) that carry `tag`, case-insensitively.
    ///
    /// Used by the journal module for pre-flight discovery before batch rewrites.
    pub fn paths_with_tag(&self, tag: &str) -> Result<Vec<String>, IndexError> {
        query::paths_with_tag(&self.conn, tag)
    }

    /// All entry paths (union of both surfaces) that carry mention `slug`, case-insensitively.
    ///
    /// Used by the journal module for pre-flight discovery before batch rewrites.
    pub fn paths_with_mention(&self, slug: &str) -> Result<Vec<String>, IndexError> {
        query::paths_with_mention(&self.conn, slug)
    }

    /// All entry paths that reference entry `slug` (located in `group_path`) via a
    /// wikilink or a `ref`/`ref[]` frontmatter property, case-insensitively.
    ///
    /// Used by the journal module for pre-flight discovery before a slug-rename
    /// batch rewrite (spec 0002 — refs/wikilinks "rewritten on rename").
    pub fn paths_referencing_slug(
        &self,
        group_path: &str,
        slug: &str,
    ) -> Result<Vec<String>, IndexError> {
        query::paths_referencing_slug(&self.conn, group_path, slug)
    }

    /// Return the frontmatter `id` string for an entry path (indexed lookup).
    ///
    /// `Ok(None)` → no entry row for that path; `Ok(Some(None))` → row exists but
    /// has no frontmatter id.
    pub fn frontmatter_id_for_path(
        &self,
        path: &str,
    ) -> Result<Option<Option<String>>, IndexError> {
        query::frontmatter_id_for_path(&self.conn, path)
    }

    /// All rows from the `tag_meta` projection table.
    pub fn tag_meta_index(&self) -> Result<Vec<TagMetaRow>, IndexError> {
        query::tag_meta_index(&self.conn)
    }

    // ── Link-resolution helpers (reconciler use) ─────────────────────────────

    /// Look up an entry by its frontmatter `id` string.
    ///
    /// Returns `(row_id, path)` if found.  Used by rename detection in the reconciler:
    /// a file that disappeared and a new file that carries the same frontmatter id
    /// → this is a rename, not a delete+create pair.
    pub fn entry_by_frontmatter_id(&self, fmid: &str) -> Result<Option<(i64, String)>, IndexError> {
        query::entry_by_frontmatter_id(&self.conn, fmid)
    }

    /// Re-resolve all wikilink `target_raw` values to `resolved_entry_id`.
    ///
    /// Called after every batch of upserts so that links added or changed in that
    /// batch get resolved immediately.  Ambiguous (multiple slug matches) stays NULL.
    ///
    /// Invariant: this is idempotent — calling it multiple times is safe.
    pub fn resolve_links(&mut self) -> Result<(), IndexError> {
        query::resolve_links(&self.conn)
    }

    /// All entries with a given slug; used internally by the reconciler tests.
    #[cfg(test)]
    pub fn entries_by_slug(&self, slug: &str) -> Result<Vec<(i64, String)>, IndexError> {
        query::entries_by_slug(&self.conn, slug)
    }

    /// Execute raw SQL.  Test-only: used to craft index-error states (e.g. drop a
    /// table so the next write fails) without exposing the connection publicly.
    #[cfg(test)]
    pub fn exec_raw(&self, sql: &str) -> Result<(), IndexError> {
        self.conn.execute_batch(sql)?;
        Ok(())
    }

    /// Look up `(rowid, group_path)` pairs for a slug. Public for reconciler.
    pub fn slug_matches(&self, slug: &str) -> Result<Vec<(i64, String)>, IndexError> {
        query::entries_by_slug(&self.conn, slug)
    }

    // ── Ledger helpers (reconciler use) ──────────────────────────────────────

    /// Fetch the `files` ledger row for a library-relative path.
    ///
    /// Returns `None` when the path is not yet in the ledger.
    pub fn ledger_row(&self, rel_path: &str) -> Result<Option<LedgerRow>, IndexError> {
        let result: rusqlite::Result<(i64, i64, String, Option<i64>)> = self.conn.query_row(
            "SELECT mtime, size, content_hash, pending FROM files WHERE path = ?1",
            params![rel_path],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        );
        match result {
            Ok((mtime, size, content_hash, pending)) => Ok(Some(LedgerRow {
                mtime,
                size,
                content_hash,
                pending: pending.unwrap_or(0) != 0,
            })),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    /// Mark a ledger row as a cloud placeholder (pending).
    ///
    /// Creates or updates the `files` row for `path` with `pending = 1` and the
    /// provided `mtime`/`size`/`content_hash` values.  The entry row is NOT
    /// touched — existing entry content is preserved while the placeholder is active.
    pub fn mark_pending(
        &mut self,
        path: &str,
        mtime: i64,
        size: i64,
        content_hash: &str,
    ) -> Result<(), IndexError> {
        self.conn.execute(
            "INSERT OR REPLACE INTO files (path, mtime, size, content_hash, pending)
             VALUES (?1, ?2, ?3, ?4, 1)",
            params![path, mtime, size, content_hash],
        )?;
        Ok(())
    }

    /// Clear the pending flag on a ledger row (file has been materialized).
    ///
    /// Used when a subsequent reconcile reads actual content from the file.
    pub fn clear_pending(&mut self, path: &str) -> Result<(), IndexError> {
        self.conn.execute(
            "UPDATE files SET pending = NULL WHERE path = ?1",
            params![path],
        )?;
        Ok(())
    }

    /// All library-relative paths currently in the `files` ledger.
    ///
    /// Used by `full_rescan` to detect deletions (paths in the ledger but no
    /// longer on disk).
    pub fn all_ledger_paths(&self) -> Result<Vec<String>, IndexError> {
        let mut stmt = self.conn.prepare("SELECT path FROM files ORDER BY path")?;
        let rows = stmt.query_map([], |r| r.get(0))?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }
}

/// A row from the `files` reconciliation ledger.
///
/// Defined here (in the index module) rather than in the reconciler so that
/// the index does not depend on the reconciler module.
#[derive(Debug, Clone)]
pub struct LedgerRow {
    pub mtime: i64,
    pub size: i64,
    pub content_hash: String,
    /// Whether this path is a cloud placeholder (dataless/evicted file).
    /// NULL in the database is represented as `false` here.
    pub pending: bool,
}

/// Tag metadata row (mirrors `tag_meta` table).
#[derive(Debug, Clone, PartialEq)]
pub struct TagMetaRow {
    pub tag: String,
    pub description: Option<String>,
    pub color: Option<String>,
    pub icon: Option<String>,
    /// NULL for global tags (_tags.md); set to a group path for scoped tags
    /// declared in a `_group.md` `scoped_tags:` block.
    pub scope_path: Option<String>,
}

/// Group metadata row (mirrors `group_meta` table).
#[derive(Debug, Clone, PartialEq)]
pub struct GroupMetaRow {
    /// Vault-relative group path (the primary key).
    pub path: String,
    pub name: Option<String>,
    pub icon: Option<String>,
    pub color: Option<String>,
    /// Explicit ordering hint (0003).
    pub sort_order: Option<i64>,
    pub view: Option<String>,
    /// JSON-encoded map of property name → {type, default?}.
    pub schema_json: Option<String>,
}
