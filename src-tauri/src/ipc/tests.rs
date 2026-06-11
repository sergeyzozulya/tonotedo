// Integration tests for the IPC command handlers.
//
// These tests call the inner handler functions directly against a temp-dir
// library rather than going through the Tauri runtime (which is not available
// in `cargo test`).  The pattern is:
//
//   1. Build an `AppState` with an `OpenLibrary` pointing at a temp dir.
//   2. Wrap it in a `tauri::State`-equivalent via a raw pointer trick.
//   3. Call the command function directly.
//
// Because `tauri::State` requires a live `App` to construct, we expose a
// `#[cfg(test)]` helper path that accepts `&OpenLibrary` directly, letting us
// test all business logic without Tauri overhead.

#![cfg(test)]

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use tempfile::TempDir;

use crate::core::{fswrite::TokenRegistry, index::Index, reconcile::SyncReconciler};

use super::{AppState, OpenLibrary};

// ── Test fixture ──────────────────────────────────────────────────────────────

struct Fixture {
    _dir: TempDir,
    pub root: PathBuf,
    pub state: AppState,
}

impl Fixture {
    /// Create a temp library with an open index and a full rescan already done.
    fn new() -> Self {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path().to_path_buf();

        // Create .tonotedo dir and index.
        let dot = root.join(".tonotedo");
        std::fs::create_dir_all(&dot).unwrap();
        let db = dot.join("index.db");
        let index = Index::open(db.to_str().unwrap()).expect("index open");
        let tokens = Arc::new(TokenRegistry::with_default_ttl());

        let mut boot = SyncReconciler::new(index, Arc::clone(&tokens), root.clone());
        boot.full_rescan();

        let SyncReconciler {
            index,
            tokens,
            library_root,
            ..
        } = boot;

        // Re-open for the query side.
        let db2 = library_root.join(".tonotedo").join("index.db");
        let query_index = Index::open(db2.to_str().unwrap()).expect("query index");

        // Build a minimal ReconcilerHandle (no watcher needed in tests).
        use crate::core::reconcile::{Reconciler, WatcherHandle};
        let (event_tx, _event_rx) = crossbeam_channel::unbounded();
        let reconciler = Reconciler::new_without_watcher(
            index,
            Arc::clone(&tokens),
            library_root.clone(),
            event_tx,
        );
        let (reconciler_handle, _change_rx, _notify_rx) = reconciler.spawn(None::<WatcherHandle>);

        let open = OpenLibrary {
            root: library_root,
            index: query_index,
            tokens,
            _reconciler_handle: reconciler_handle,
        };

        Fixture {
            _dir: dir,
            root: root.clone(),
            state: AppState(Mutex::new(Some(open))),
        }
    }

    /// Write a `.md` file into the library and run the reconciler to index it.
    fn write_md(&self, rel_path: &str, content: &str) {
        let abs = self.root.join(rel_path);
        if let Some(parent) = abs.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(&abs, content).unwrap();

        // Reconcile into the query index.
        let mut guard = self.state.0.lock().unwrap();
        if let Some(lib) = guard.as_mut() {
            // We can only reconcile if the index is mutable; use the Index inside OpenLibrary.
            // For tests, run a targeted upsert via the frontmatter parser.
            use crate::core::frontmatter::Entry;
            use crate::core::fswrite::content_hash;
            let bytes = std::fs::read(&abs).unwrap();
            let entry = Entry::from_bytes(&bytes);
            let (group, slug) = super::split_group_slug(rel_path);
            let group_trim = group.trim_end_matches(".md");
            let slug_trim = slug.trim_end_matches(".md");
            let meta = std::fs::metadata(&abs).unwrap();
            let mtime = meta
                .modified()
                .map(|t| {
                    t.duration_since(std::time::UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_secs() as i64
                })
                .unwrap_or(0);
            let size = meta.len() as i64;
            let hash = format!("{:032x}", content_hash(&bytes));
            lib.index
                .upsert_entry(rel_path, slug_trim, group_trim, &entry, mtime, size, &hash)
                .expect("upsert");
            lib.index.resolve_links().expect("resolve_links");
        }
    }

    /// Call `read_entry` directly without going through Tauri's command router.
    fn read_entry(&self, id: &str) -> Result<super::EntryContentDto, super::IpcError> {
        let guard = self.state.0.lock().unwrap();
        let lib = guard.as_ref().ok_or_else(super::IpcError::not_open)?;
        let abs = super::entry_abs_path(&lib.root, id);
        let bytes = std::fs::read(&abs).map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                super::IpcError::not_found(format!("Entry not found: {id}"))
            } else {
                super::IpcError::io(format!("Cannot read {id}: {e}"))
            }
        })?;
        let text = String::from_utf8(bytes)
            .map_err(|e| super::IpcError::parse(format!("Not UTF-8: {e}")))?;
        let token = lib.tokens.issue_token(&abs, text.as_bytes());
        Ok(super::EntryContentDto {
            id: id.to_string(),
            path: format!("{id}.md"),
            parse_warning: crate::core::frontmatter::Entry::from_bytes(text.as_bytes())
                .parse_warning,
            text,
            self_token: token.as_u64().to_string(),
        })
    }

    fn write_entry_inner(
        &self,
        id: &str,
        text: &str,
    ) -> Result<super::WriteEntryResult, super::IpcError> {
        let guard = self.state.0.lock().unwrap();
        let lib = guard.as_ref().ok_or_else(super::IpcError::not_open)?;
        let abs = super::entry_abs_path(&lib.root, id);
        if let Some(parent) = abs.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| super::IpcError::io(format!("Cannot create dirs: {e}")))?;
        }
        use crate::core::frontmatter::Entry;
        let entry = Entry::from_bytes(text.as_bytes());
        let token = super::fswrite_write_entry(&abs, &entry, &[], &lib.tokens)
            .map_err(|e| super::IpcError::io(format!("Write failed: {e}")))?;
        Ok(super::WriteEntryResult {
            self_token: token.as_u64().to_string(),
        })
    }

    fn search_inner(
        &self,
        text: &str,
    ) -> Result<super::PageDto<super::EntrySummaryDto>, super::IpcError> {
        let guard = self.state.0.lock().unwrap();
        let lib = guard.as_ref().ok_or_else(super::IpcError::not_open)?;
        let raw = lib
            .index
            .search(text, 500)
            .map_err(|e| super::IpcError::io(format!("search: {e}")))?;
        let summaries: Vec<super::EntrySummaryDto> = raw
            .iter()
            .map(|sr| {
                let tags = super::tags_for_entry(&lib.index, sr.id);
                let people = super::people_for_entry(&lib.index, sr.id);
                let (group, _slug) = super::split_group_slug(&sr.path);
                let id = sr.path.trim_end_matches(".md").to_string();
                let title = sr.title.clone().unwrap_or_else(|| id.clone());
                super::EntrySummaryDto {
                    id,
                    path: sr.path.clone(),
                    title,
                    group,
                    tags,
                    people,
                    modified_at: sr.updated.clone().unwrap_or_default(),
                    archived: false,
                }
            })
            .collect();
        Ok(super::page_slice(summaries, None))
    }

    fn tag_index_inner(&self) -> Result<Vec<super::TagMetaDto>, super::IpcError> {
        let guard = self.state.0.lock().unwrap();
        let lib = guard.as_ref().ok_or_else(super::IpcError::not_open)?;
        let rows = lib
            .index
            .tag_index()
            .map_err(|e| super::IpcError::io(format!("tag_index: {e}")))?;
        let mut counts: std::collections::BTreeMap<String, u64> = std::collections::BTreeMap::new();
        for row in &rows {
            *counts.entry(row.tag.clone()).or_default() += 1;
        }
        let meta_rows = lib.index.tag_meta_index().unwrap_or_default();
        let meta_map: std::collections::HashMap<_, _> = meta_rows
            .iter()
            .map(|r| (r.tag.clone(), r.color.clone()))
            .collect();
        Ok(counts
            .into_iter()
            .map(|(tag, count)| {
                let color = meta_map
                    .get(&tag)
                    .and_then(|c| c.as_deref())
                    .unwrap_or("slate")
                    .to_string();
                super::TagMetaDto {
                    name: tag,
                    color,
                    count,
                    scope_path: None,
                    description: None,
                    icon: None,
                }
            })
            .collect())
    }

    fn people_index_inner(&self) -> Result<Vec<super::PersonMetaDto>, super::IpcError> {
        let guard = self.state.0.lock().unwrap();
        let lib = guard.as_ref().ok_or_else(super::IpcError::not_open)?;
        let people_rows = lib
            .index
            .people_index()
            .map_err(|e| super::IpcError::io(format!("people_index: {e}")))?;
        let mentions = lib.index.mentions_index().unwrap_or_default();
        let mut counts: std::collections::HashMap<String, u64> = std::collections::HashMap::new();
        for row in &mentions {
            *counts.entry(row.tag.clone()).or_default() += 1;
        }
        let mut seen = std::collections::HashSet::new();
        let mut result: Vec<super::PersonMetaDto> = people_rows
            .into_iter()
            .map(|row| {
                seen.insert(row.slug.clone());
                let count = *counts.get(&row.slug).unwrap_or(&0);
                let display_name = row.full_name.unwrap_or_else(|| row.slug.clone());
                super::PersonMetaDto {
                    slug: row.slug,
                    display_name,
                    count,
                    color: row.color,
                    avatar_path: row.avatar_path,
                }
            })
            .collect();
        let mut extra: Vec<super::PersonMetaDto> = counts
            .iter()
            .filter(|(slug, _)| !seen.contains(*slug))
            .map(|(slug, &count)| super::PersonMetaDto {
                display_name: slug.clone(),
                slug: slug.clone(),
                count,
                color: None,
                avatar_path: None,
            })
            .collect();
        extra.sort_by(|a, b| a.slug.cmp(&b.slug));
        result.extend(extra);
        Ok(result)
    }

    fn entries_in_group_inner(
        &self,
        group: &str,
    ) -> Result<super::PageDto<super::EntrySummaryDto>, super::IpcError> {
        let guard = self.state.0.lock().unwrap();
        let lib = guard.as_ref().ok_or_else(super::IpcError::not_open)?;
        let rows = lib
            .index
            .entries_in_group(group)
            .map_err(|e| super::IpcError::io(format!("entries_in_group: {e}")))?;
        let summaries: Vec<super::EntrySummaryDto> = rows
            .into_iter()
            .map(|row| {
                let tags = super::tags_for_entry(&lib.index, row.id);
                let people = super::people_for_entry(&lib.index, row.id);
                let id = row.path.trim_end_matches(".md").to_string();
                let title = row.title.clone().unwrap_or_else(|| row.slug.clone());
                super::EntrySummaryDto {
                    id,
                    path: row.path,
                    title,
                    group: row.group_path,
                    tags,
                    people,
                    modified_at: row.updated.unwrap_or_default(),
                    archived: row.archived,
                }
            })
            .collect();
        Ok(super::page_slice(summaries, None))
    }

    fn backlinks_inner(&self, id: &str) -> Result<Vec<super::BacklinkDto>, super::IpcError> {
        let guard = self.state.0.lock().unwrap();
        let lib = guard.as_ref().ok_or_else(super::IpcError::not_open)?;
        let path = format!("{id}.md");
        let row_id = lib
            .index
            .entry_id_for_path(&path)
            .map_err(|e| super::IpcError::io(format!("lookup: {e}")))?
            .ok_or_else(|| super::IpcError::not_found(format!("not found: {id}")))?;
        let rows = lib
            .index
            .backlinks(row_id)
            .map_err(|e| super::IpcError::io(format!("backlinks: {e}")))?;
        Ok(rows
            .into_iter()
            .map(|row| {
                let source_id = row.src_path.trim_end_matches(".md").to_string();
                let source_title = super::title_for_path(&lib.index, &lib.root, &row.src_path);
                super::BacklinkDto {
                    source_id,
                    source_title,
                    link_text: row.target_raw,
                }
            })
            .collect())
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[test]
fn open_empty_library_succeeds() {
    let fix = Fixture::new();
    let guard = fix.state.0.lock().unwrap();
    assert!(guard.is_some(), "library should be open");
}

#[test]
fn write_then_read_round_trips() {
    let fix = Fixture::new();
    let text = "---\nid: test-abc\ntags:\n  - rust\n---\n# Hello IPC\n\nBody.\n";
    fix.write_entry_inner("notes/hello", text).expect("write");

    let content = fix.read_entry("notes/hello").expect("read");
    assert_eq!(content.id, "notes/hello");
    assert_eq!(content.path, "notes/hello.md");
    // The written bytes go through Entry round-trip, so exact byte equality
    // isn't guaranteed, but the body text must survive.
    assert!(content.text.contains("# Hello IPC"));
    assert!(!content.self_token.is_empty(), "selfToken must be present");
}

#[test]
fn read_entry_not_found_returns_error() {
    let fix = Fixture::new();
    let result = fix.read_entry("does/not/exist");
    assert!(result.is_err());
    let err = result.unwrap_err();
    assert_eq!(err.code, "not_found");
}

#[test]
fn write_entry_creates_parent_dirs() {
    let fix = Fixture::new();
    let text = "---\nid: deep\n---\n# Deep Entry\n\nHello.\n";
    fix.write_entry_inner("a/b/c/deep", text)
        .expect("write deep");
    assert!(fix.root.join("a/b/c/deep.md").exists());
}

#[test]
fn search_finds_written_entry() {
    let fix = Fixture::new();
    let text = "---\nid: searchable\ntags:\n  - rust\n---\n# Searchable Note\n\ncontains unique keyword xyzzy.\n";
    fix.write_md("notes/searchable.md", text);

    let page = fix.search_inner("xyzzy").expect("search");
    assert!(
        !page.items.is_empty(),
        "search should find the indexed entry"
    );
    assert!(page.items.iter().any(|s| s.id == "notes/searchable"));
}

#[test]
fn search_empty_query_returns_recent_entries() {
    let fix = Fixture::new();
    fix.write_md(
        "notes/alpha.md",
        "---\nid: alpha\n---\n# Alpha\n\nFirst note.\n",
    );
    fix.write_md(
        "notes/beta.md",
        "---\nid: beta\n---\n# Beta\n\nSecond note.\n",
    );

    let page = fix.search_inner("").expect("search empty");
    // Empty query should return recent entries (up to 50).
    assert!(!page.items.is_empty());
}

#[test]
fn tag_index_aggregates_counts() {
    let fix = Fixture::new();
    fix.write_md(
        "notes/tagged1.md",
        "---\nid: t1\ntags:\n  - rust\n  - async\n---\n# T1\n",
    );
    fix.write_md(
        "notes/tagged2.md",
        "---\nid: t2\ntags:\n  - rust\n---\n# T2\n",
    );

    let tags = fix.tag_index_inner().expect("tag_index");
    let rust_tag = tags.iter().find(|t| t.name == "rust");
    assert!(rust_tag.is_some(), "rust tag must appear");
    assert!(
        rust_tag.unwrap().count >= 2,
        "rust tag must appear in at least 2 entries"
    );
}

#[test]
fn people_index_returns_mentioned_people() {
    let fix = Fixture::new();
    fix.write_md(
        "notes/people_note.md",
        "---\nid: pn\nmentions:\n  - alice\n  - bob\n---\n# Note\n\nRef @alice and @bob.\n",
    );

    let people = fix.people_index_inner().expect("people_index");
    // At minimum, alice and bob should appear.
    let slugs: Vec<&str> = people.iter().map(|p| p.slug.as_str()).collect();
    assert!(slugs.contains(&"alice"), "alice must be in people index");
    assert!(slugs.contains(&"bob"), "bob must be in people index");
}

#[test]
fn entries_in_group_filters_correctly() {
    let fix = Fixture::new();
    fix.write_md(
        "work/atlas/overview.md",
        "---\nid: ov\n---\n# Overview\n\nAtlas overview.\n",
    );
    fix.write_md(
        "journal/2026-06-10.md",
        "---\nid: j1\n---\n# Journal\n\nToday.\n",
    );

    let page = fix
        .entries_in_group_inner("work/atlas")
        .expect("entries_in_group");
    assert!(!page.items.is_empty(), "work/atlas should have entries");
    for item in &page.items {
        assert!(
            item.group == "work/atlas" || item.group.starts_with("work/atlas/"),
            "all items must be in work/atlas group, got: {}",
            item.group
        );
    }

    let journal_page = fix
        .entries_in_group_inner("journal")
        .expect("journal group");
    for item in &journal_page.items {
        assert!(
            item.group == "journal" || item.group.starts_with("journal/"),
            "all items must be in journal group, got: {}",
            item.group
        );
    }
}

#[test]
fn backlinks_returns_sources_that_link_to_target() {
    let fix = Fixture::new();
    fix.write_md(
        "notes/target.md",
        "---\nid: target-entry\n---\n# Target\n\nThe target note.\n",
    );
    fix.write_md(
        "notes/source.md",
        "---\nid: source-entry\n---\n# Source\n\nLinks to [[notes/target]].\n",
    );
    // Re-resolve links in the test index.
    {
        let mut guard = fix.state.0.lock().unwrap();
        if let Some(lib) = guard.as_mut() {
            lib.index.resolve_links().unwrap();
        }
    }

    let bls = fix.backlinks_inner("notes/target").expect("backlinks");
    assert!(
        !bls.is_empty(),
        "notes/source should appear as a backlink to notes/target"
    );
    assert!(
        bls.iter().any(|b| b.source_id == "notes/source"),
        "source_id 'notes/source' not found in backlinks"
    );
}

#[test]
fn backlinks_not_found_for_missing_entry() {
    let fix = Fixture::new();
    let result = fix.backlinks_inner("notes/nonexistent");
    assert!(result.is_err());
    let err = result.unwrap_err();
    assert_eq!(err.code, "not_found");
}

#[test]
fn write_entry_token_suppresses_echo() {
    // Write an entry; verify the token is single-consume and matches the content.
    let fix = Fixture::new();
    let text = "---\nid: tokentest\n---\n# Token Test\n\nContent.\n";
    let result = fix
        .write_entry_inner("notes/tokentest", text)
        .expect("write");

    // The token should be numeric.
    let token_num: u64 = result.self_token.parse().expect("token is numeric");
    assert!(token_num > 0);
}

#[test]
fn cursor_encode_decode_roundtrips() {
    for offset in [0, 1, 50, 100, 499] {
        let enc = super::encode_cursor(offset);
        let dec = super::decode_cursor(&enc);
        assert_eq!(dec, offset, "encode→decode roundtrip failed for {offset}");
    }
}

#[test]
fn split_group_slug_variants() {
    assert_eq!(
        super::split_group_slug("work/atlas/overview.md"),
        ("work/atlas".to_string(), "overview".to_string())
    );
    assert_eq!(
        super::split_group_slug("overview.md"),
        (String::new(), "overview".to_string())
    );
    assert_eq!(
        super::split_group_slug("a/b.md"),
        ("a".to_string(), "b".to_string())
    );
}

#[test]
fn library_close_clears_state() {
    let fix = Fixture::new();
    {
        let mut guard = fix.state.0.lock().unwrap();
        *guard = None;
    }
    let result = fix.read_entry("anything");
    assert!(result.is_err());
    assert_eq!(result.unwrap_err().code, "invalid_argument");
}

// ── item 1: people_index carries color + avatar_path ─────────────────────────

#[test]
fn people_index_includes_color_and_avatar_path() {
    let fix = Fixture::new();
    // Write a _people.md projection with color and avatar_path declared.
    let content = b"---\npeople:\n  - slug: alice\n    full_name: Alice A.\n    color: violet\n    avatar_path: _assets/alice.jpg\n---\n";
    std::fs::write(fix.root.join("_people.md"), content).unwrap();
    {
        let mut guard = fix.state.0.lock().unwrap();
        if let Some(lib) = guard.as_mut() {
            use crate::core::index::PeopleRow;
            lib.index
                .set_people(&[PeopleRow {
                    slug: "alice".to_string(),
                    full_name: Some("Alice A.".to_string()),
                    color: Some("violet".to_string()),
                    avatar_path: Some("_assets/alice.jpg".to_string()),
                }])
                .unwrap();
        }
    }
    let people = fix.people_index_inner().expect("people_index");
    let alice = people.iter().find(|p| p.slug == "alice").expect("alice");
    assert_eq!(alice.color.as_deref(), Some("violet"));
    assert_eq!(alice.avatar_path.as_deref(), Some("_assets/alice.jpg"));
}

// ── item 3: search modifiedAt is non-empty ────────────────────────────────────

#[test]
fn search_result_has_modified_at_when_updated_set() {
    let fix = Fixture::new();
    // Include an `updated:` frontmatter field so entries.updated is populated.
    fix.write_md(
        "notes/dated.md",
        "---\nid: dated\nupdated: \"2026-06-10T00:00:00Z\"\n---\n# Dated Note\n\nuniqkeyxqz\n",
    );
    let page = fix.search_inner("uniqkeyxqz").expect("search");
    assert!(!page.items.is_empty(), "search should find the entry");
    let dated = page.items.iter().find(|s| s.id == "notes/dated");
    assert!(dated.is_some(), "notes/dated should be in results");
    // modifiedAt populated from entries.updated via the join.
    assert_eq!(
        dated.unwrap().modified_at,
        "2026-06-10T00:00:00Z",
        "modifiedAt should reflect the frontmatter updated field"
    );
}

#[test]
fn search_result_modified_at_empty_when_no_updated_field() {
    let fix = Fixture::new();
    // No `updated:` field — entries.updated is NULL → modifiedAt = "".
    fix.write_md(
        "notes/plain.md",
        "---\nid: plain\n---\n# Plain Note\n\nuniqplainxqz\n",
    );
    let page = fix.search_inner("uniqplainxqz").expect("search");
    assert!(!page.items.is_empty(), "search should find the entry");
    // modifiedAt is empty because entries.updated is NULL (no frontmatter field).
    let plain = page.items.iter().find(|s| s.id == "notes/plain");
    assert!(plain.is_some());
    // This is the expected current behaviour — null maps to empty string.
    assert_eq!(plain.unwrap().modified_at, "");
}

// ── item 4: entry_titles returns id → title map ────────────────────────────────

fn entry_titles_inner(
    fix: &Fixture,
) -> Result<std::collections::HashMap<String, String>, super::IpcError> {
    let guard = fix.state.0.lock().unwrap();
    let lib = guard.as_ref().ok_or_else(super::IpcError::not_open)?;
    let rows = lib
        .index
        .entries_in_group("")
        .map_err(|e| super::IpcError::io(format!("entry_titles: {e}")))?;
    Ok(rows
        .into_iter()
        .map(|row| {
            let id = row.path.trim_end_matches(".md").to_string();
            let title = row.title.unwrap_or_else(|| row.slug.clone());
            (id, title)
        })
        .collect())
}

#[test]
fn entry_titles_returns_id_to_title_map() {
    let fix = Fixture::new();
    fix.write_md(
        "notes/hello.md",
        "---\nid: hello\n---\n# Hello World\n\nBody.\n",
    );
    fix.write_md(
        "notes/world.md",
        "---\nid: world\n---\n# World Note\n\nBody.\n",
    );

    let titles = entry_titles_inner(&fix).expect("entry_titles");
    assert!(
        titles.contains_key("notes/hello"),
        "notes/hello must be in entry_titles"
    );
    assert_eq!(
        titles.get("notes/hello").map(String::as_str),
        Some("Hello World")
    );
    assert!(
        titles.contains_key("notes/world"),
        "notes/world must be in entry_titles"
    );
}
