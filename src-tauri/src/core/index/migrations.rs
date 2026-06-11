// Schema migrations for the index database.
//
// Each migration is identified by a monotonically increasing integer version
// stored in `meta(key='schema_version', value=N)`.  Migrations are applied
// in order and are idempotent: running `run()` on an already-migrated database
// is a no-op.
//
// All table definitions here are v1 per design-0001 §Model.
//
// ## v2 — cloud placeholder support (issue #29, item 1)
//
// Adds a nullable `pending` INTEGER column to `files`.  When non-NULL and
// non-zero, the path is a cloud placeholder ("dataless" file): the on-disk file
// exists but its content has been evicted by the sync provider.  The entry row
// for that path is preserved (or not created from empty bytes); the reconciler
// emits a `ChangeKind::Pending` event instead of `Created`/`Modified`.
//
// The column is added via `ALTER TABLE … ADD COLUMN` which is safe on existing
// databases — the new column defaults to NULL on pre-existing rows, and the
// migration is idempotent (the `ADD COLUMN` is wrapped in a check).

use rusqlite::Connection;

use super::IndexError;

/// Current target schema version.
const CURRENT_VERSION: i64 = 4;

/// Apply all pending migrations.
pub fn run(conn: &mut Connection) -> Result<(), IndexError> {
    // Bootstrap: create the meta table if it doesn't exist yet.
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS meta (
            key   TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );",
    )?;

    let version = current_version(conn)?;
    if version >= CURRENT_VERSION {
        return Ok(());
    }

    if version < 1 {
        apply_v1(conn)?;
    }
    if version < 2 {
        apply_v2(conn)?;
    }
    if version < 3 {
        apply_v3(conn)?;
    }
    if version < 4 {
        apply_v4(conn)?;
    }

    Ok(())
}

fn current_version(conn: &Connection) -> Result<i64, IndexError> {
    let result: rusqlite::Result<i64> = conn.query_row(
        "SELECT CAST(value AS INTEGER) FROM meta WHERE key = 'schema_version'",
        [],
        |row| row.get(0),
    );
    match result {
        Ok(v) => Ok(v),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(0),
        Err(e) => Err(e.into()),
    }
}

fn apply_v1(conn: &mut Connection) -> Result<(), IndexError> {
    let tx = conn.transaction()?;

    tx.execute_batch(
        // ── Reconciliation ledger ───────────────────────────────────────────
        "CREATE TABLE IF NOT EXISTS files (
            path         TEXT PRIMARY KEY,
            mtime        INTEGER NOT NULL,
            size         INTEGER NOT NULL,
            content_hash TEXT    NOT NULL
        );

        -- ── Entries ──────────────────────────────────────────────────────────
        -- id: frontmatter 'id' (ULID string); NULL when the file lacks one.
        CREATE TABLE IF NOT EXISTS entries (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            entry_id    TEXT    UNIQUE,          -- frontmatter id (may be NULL)
            path        TEXT    NOT NULL UNIQUE,
            slug        TEXT    NOT NULL,
            group_path  TEXT    NOT NULL DEFAULT '',
            title       TEXT,
            created     TEXT,                    -- ISO-8601
            updated     TEXT,                    -- ISO-8601
            archived    INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_entries_group_path ON entries(group_path);
        CREATE INDEX IF NOT EXISTS idx_entries_updated    ON entries(updated DESC);

        -- ── Properties ───────────────────────────────────────────────────────
        CREATE TABLE IF NOT EXISTS properties (
            entry_id      INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
            key           TEXT    NOT NULL,
            declared_type TEXT,
            inferred_type TEXT,
            value_json    TEXT    NOT NULL,
            PRIMARY KEY (entry_id, key)
        );

        -- ── Tags ─────────────────────────────────────────────────────────────
        -- surface: 'frontmatter' | 'body'
        CREATE TABLE IF NOT EXISTS tags (
            entry_id INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
            tag      TEXT    NOT NULL,
            surface  TEXT    NOT NULL CHECK(surface IN ('frontmatter','body')),
            PRIMARY KEY (entry_id, tag, surface)
        );
        CREATE INDEX IF NOT EXISTS idx_tags_tag ON tags(tag);

        -- ── Mentions ─────────────────────────────────────────────────────────
        CREATE TABLE IF NOT EXISTS mentions (
            entry_id INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
            slug     TEXT    NOT NULL,
            surface  TEXT    NOT NULL CHECK(surface IN ('frontmatter','body')),
            PRIMARY KEY (entry_id, slug, surface)
        );
        CREATE INDEX IF NOT EXISTS idx_mentions_slug ON mentions(slug);

        -- ── Links (wikilinks) ─────────────────────────────────────────────────
        CREATE TABLE IF NOT EXISTS links (
            id                 INTEGER PRIMARY KEY AUTOINCREMENT,
            src_entry_id       INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
            target_raw         TEXT    NOT NULL,
            resolved_entry_id  INTEGER REFERENCES entries(id) ON DELETE SET NULL,
            resolved_group_path TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_links_src        ON links(src_entry_id);
        CREATE INDEX IF NOT EXISTS idx_links_resolved   ON links(resolved_entry_id);

        -- ── People ────────────────────────────────────────────────────────────
        CREATE TABLE IF NOT EXISTS people (
            slug        TEXT PRIMARY KEY,
            full_name   TEXT,
            color       TEXT,
            avatar_path TEXT
        );

        -- ── Tag metadata ──────────────────────────────────────────────────────
        CREATE TABLE IF NOT EXISTS tag_meta (
            tag         TEXT PRIMARY KEY,
            description TEXT,
            color       TEXT,
            icon        TEXT
        );

        -- ── FTS5 virtual table ────────────────────────────────────────────────
        -- External-content mode keyed to `entries`.
        -- title is weighted 10× over body at query time via bm25(fts,10,1).
        -- porter stemmer + unicode61 for prefix/diacritic handling.
        CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(
            title,
            body,
            content='entries',
            content_rowid='id',
            tokenize='porter unicode61'
        );

        -- Triggers to keep the FTS table in sync with entries.
        CREATE TRIGGER IF NOT EXISTS fts_ai AFTER INSERT ON entries BEGIN
            INSERT INTO fts(rowid, title, body) VALUES (new.id, new.title, '');
        END;
        CREATE TRIGGER IF NOT EXISTS fts_ad AFTER DELETE ON entries BEGIN
            INSERT INTO fts(fts, rowid, title, body) VALUES ('delete', old.id, old.title, '');
        END;
        CREATE TRIGGER IF NOT EXISTS fts_au AFTER UPDATE ON entries BEGIN
            INSERT INTO fts(fts, rowid, title, body) VALUES ('delete', old.id, old.title, '');
            INSERT INTO fts(rowid, title, body) VALUES (new.id, new.title, '');
        END;
        ",
    )?;

    tx.execute(
        "INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '1')",
        [],
    )?;
    tx.commit()?;
    Ok(())
}

/// v2: add `pending` column to `files`.
///
/// `pending` is nullable INTEGER: NULL → not a placeholder; 1 → cloud placeholder
/// detected (dataless/evicted file).  Existing rows keep NULL (= not pending).
///
/// Uses `ALTER TABLE … ADD COLUMN` for in-place upgrade; wrapped in a "column
/// already exists" guard so the migration is idempotent.
fn apply_v2(conn: &mut Connection) -> Result<(), IndexError> {
    let tx = conn.transaction()?;

    // Check whether the column already exists (idempotency guard).
    let col_exists: bool = tx
        .query_row(
            "SELECT COUNT(*) FROM pragma_table_info('files') WHERE name='pending'",
            [],
            |r| r.get::<_, i64>(0),
        )
        .unwrap_or(0)
        > 0;

    if !col_exists {
        tx.execute_batch("ALTER TABLE files ADD COLUMN pending INTEGER;")?;
    }

    tx.execute(
        "INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '2')",
        [],
    )?;
    tx.commit()?;
    Ok(())
}

/// v3: add `group_meta` table and `scope_path` column on `tag_meta`.
///
/// `group_meta` stores parsed `_group.md` frontmatter (name, icon, color, order,
/// view, schema_json).  `tag_meta.scope_path` is the group path that owns a
/// scoped tag declaration (NULL for global tags from `_tags.md`).
fn apply_v3(conn: &mut Connection) -> Result<(), IndexError> {
    let tx = conn.transaction()?;

    // group_meta: one row per group folder that has a _group.md file.
    let table_exists: bool = tx
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='group_meta'",
            [],
            |r| r.get::<_, i64>(0),
        )
        .unwrap_or(0)
        > 0;

    if !table_exists {
        tx.execute_batch(
            "CREATE TABLE IF NOT EXISTS group_meta (
                path        TEXT PRIMARY KEY,   -- vault-relative group path
                name        TEXT,               -- display name override
                icon        TEXT,               -- emoji/icon string
                color       TEXT,               -- color token
                sort_order  INTEGER,            -- explicit ordering hint (0003)
                view        TEXT,               -- default view mode
                schema_json TEXT                -- JSON-encoded property schema map
            );",
        )?;
    }

    // tag_meta.scope_path: NULL = global (_tags.md), non-NULL = scoped to a group.
    let scope_col_exists: bool = tx
        .query_row(
            "SELECT COUNT(*) FROM pragma_table_info('tag_meta') WHERE name='scope_path'",
            [],
            |r| r.get::<_, i64>(0),
        )
        .unwrap_or(0)
        > 0;

    if !scope_col_exists {
        tx.execute_batch("ALTER TABLE tag_meta ADD COLUMN scope_path TEXT;")?;
    }

    tx.execute(
        "INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '3')",
        [],
    )?;
    tx.commit()?;
    Ok(())
}

/// v4: composite primary key `(tag, scope_path)` on `tag_meta`
/// (security/correctness: final-review F7).
///
/// v3 added `scope_path` as a plain column but left the PRIMARY KEY on `tag`
/// alone, so a global tag and a same-named scoped tag — or the same tag scoped
/// in two groups — collided on INSERT (`UNIQUE constraint failed: tag_meta.tag`).
/// The projection error then flagged a rescan and skipped the ledger row,
/// producing a *persistent rescan loop* and a group whose metadata never
/// projected. This rebuilds the table with `PRIMARY KEY (tag, scope_path)`.
///
/// SQLite permits NULLs in a non-`NOT NULL` PRIMARY KEY column and treats them
/// as distinct, so global rows keep their `scope_path IS NULL` semantics
/// untouched while `(tag, group)` pairs become independently unique. Upsert and
/// query code is unchanged.
fn apply_v4(conn: &mut Connection) -> Result<(), IndexError> {
    let tx = conn.transaction()?;

    // Idempotency: skip if tag_meta_new somehow exists from a partial run.
    tx.execute_batch(
        "DROP TABLE IF EXISTS tag_meta_new;
         CREATE TABLE tag_meta_new (
            tag         TEXT,
            description TEXT,
            color       TEXT,
            icon        TEXT,
            scope_path  TEXT,
            PRIMARY KEY (tag, scope_path)
         );
         INSERT INTO tag_meta_new (tag, description, color, icon, scope_path)
            SELECT tag, description, color, icon, scope_path FROM tag_meta;
         DROP TABLE tag_meta;
         ALTER TABLE tag_meta_new RENAME TO tag_meta;",
    )?;

    tx.execute(
        "INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '4')",
        [],
    )?;
    tx.commit()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migration_creates_all_tables() {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
        run(&mut conn).expect("migration must succeed");

        // Verify every table exists by querying sqlite_master.
        let tables = [
            "files",
            "entries",
            "properties",
            "tags",
            "mentions",
            "links",
            "people",
            "tag_meta",
            "meta",
        ];
        for t in &tables {
            let count: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?1",
                    rusqlite::params![t],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(count, 1, "table '{t}' must exist after migration");
        }

        // FTS virtual table exists.
        let fts_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='fts'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(fts_count, 1, "fts virtual table must exist");

        // v2: files.pending column exists.
        let pending_col: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('files') WHERE name='pending'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            pending_col, 1,
            "files.pending column must exist after v2 migration"
        );

        // v3: group_meta table exists.
        let gm_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='group_meta'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            gm_count, 1,
            "group_meta table must exist after v3 migration"
        );

        // v3: tag_meta.scope_path column exists.
        let scope_col: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('tag_meta') WHERE name='scope_path'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            scope_col, 1,
            "tag_meta.scope_path column must exist after v3 migration"
        );
    }

    #[test]
    fn migration_is_idempotent() {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
        run(&mut conn).expect("first run must succeed");
        run(&mut conn).expect("second run must be a no-op");

        let ver: i64 = conn
            .query_row(
                "SELECT CAST(value AS INTEGER) FROM meta WHERE key='schema_version'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(ver, 4);
    }

    #[test]
    fn v2_migration_is_idempotent_on_existing_v1_database() {
        // Simulate a v1 database (no `pending` column) and verify v2 can be
        // applied twice without error (idempotency guard).
        //
        // We bootstrap the meta table manually (as run() does) then call
        // apply_v1 directly to create a v1 schema, then downgrade the recorded
        // version to 1 so run() will apply v2.
        let mut conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
        // Bootstrap meta table (normally done by run() before apply_v1).
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);",
        )
        .unwrap();
        apply_v1(&mut conn).expect("v1 migration must succeed");
        // Force version back to 1 so run() will detect v2 is missing and apply it.
        conn.execute(
            "INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '1')",
            [],
        )
        .unwrap();
        run(&mut conn).expect("v2 migration on top of v1 must succeed");
        run(&mut conn).expect("second run (v2 already applied) must be a no-op");

        let ver: i64 = conn
            .query_row(
                "SELECT CAST(value AS INTEGER) FROM meta WHERE key='schema_version'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(ver, 4, "schema_version must be 4 after all migrations");

        // pending column must exist exactly once.
        let col_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('files') WHERE name='pending'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(col_count, 1, "pending column must exist exactly once");
    }

    #[test]
    fn v3_migration_is_idempotent_on_existing_v2_database() {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);",
        )
        .unwrap();
        apply_v1(&mut conn).expect("v1 must succeed");
        // Force version to 1 so v2 runs.
        conn.execute(
            "INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '1')",
            [],
        )
        .unwrap();
        apply_v2(&mut conn).expect("v2 must succeed");
        // Now force to 2 so v3 runs.
        conn.execute(
            "INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '2')",
            [],
        )
        .unwrap();
        run(&mut conn).expect("v3 on top of v2 must succeed");
        run(&mut conn).expect("second run must be a no-op");

        let ver: i64 = conn
            .query_row(
                "SELECT CAST(value AS INTEGER) FROM meta WHERE key='schema_version'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(ver, 4, "schema_version must be 4 after v3+v4 migrations");

        // group_meta table must exist.
        let gm: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='group_meta'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(gm, 1, "group_meta table must exist after v3");

        // scope_path column on tag_meta must exist exactly once.
        let sc: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('tag_meta') WHERE name='scope_path'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(sc, 1, "scope_path column must exist exactly once");
    }
}
