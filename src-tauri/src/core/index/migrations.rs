// Schema migrations for the index database.
//
// Each migration is identified by a monotonically increasing integer version
// stored in `meta(key='schema_version', value=N)`.  Migrations are applied
// in order and are idempotent: running `run()` on an already-migrated database
// is a no-op.
//
// All table definitions here are v1 per design-0001 §Model.

use rusqlite::Connection;

use super::IndexError;

/// Current target schema version.
const CURRENT_VERSION: i64 = 1;

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
        "INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?1)",
        rusqlite::params![CURRENT_VERSION.to_string()],
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
        assert_eq!(ver, CURRENT_VERSION);
    }
}
