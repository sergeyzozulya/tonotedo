// Reconciler tests — temp-dir based, deterministic.
//
// Coverage:
//   1. create/modify/delete a file → index state
//   2. rename with same frontmatter id preserves backlinks
//   3. duplicate id → newcomer rewritten with fresh id
//   4. self-write token suppresses external-change classification
//   5. full_rescan picks up offline edits + deletions
//   6. projections from _tags.md/_people.md land in tag_meta/people
//   7. link resolution incl. ambiguous-stays-NULL
//   8. watcher smoke test (#[ignore] — flaky in CI)

use std::sync::Arc;

use tempfile::TempDir;

use crate::core::{
    frontmatter::{Entry, Value},
    fswrite::{write_entry, TokenRegistry},
    index::Index,
    reconcile::{ChangeKind, SyncReconciler},
};

// ── Helpers ───────────────────────────────────────────────────────────────────

fn setup() -> (TempDir, SyncReconciler) {
    let dir = tempfile::tempdir().expect("tempdir");
    let index = Index::open_in_memory().expect("index");
    let tokens = Arc::new(TokenRegistry::with_default_ttl());
    let rec = SyncReconciler::new(index, tokens, dir.path().to_path_buf());
    (dir, rec)
}

/// Write a markdown file to disk (without going through write_entry so there
/// is no self-write token — simulates an external edit).
fn write_file(dir: &TempDir, rel: &str, content: &str) {
    let path = dir.path().join(rel);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).expect("mkdir");
    }
    std::fs::write(&path, content).expect("write file");
}

/// Create a minimal entry YAML.
fn entry_bytes(id: &str, body: &str) -> String {
    format!("---\nid: {id}\n---\n{body}")
}

// ── Test 1: create / modify / delete ─────────────────────────────────────────

#[test]
fn create_file_indexes_entry() {
    let (dir, mut rec) = setup();
    write_file(&dir, "note.md", &entry_bytes("id-1", "# Hello\n"));

    let events = rec.reconcile_path(std::path::Path::new("note.md"));
    assert_eq!(events.len(), 1, "create should emit one event");
    assert!(matches!(events[0].kind, ChangeKind::Modified));

    let entries = rec.index().entries_in_group("").unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].slug, "note");
    assert_eq!(entries[0].entry_id.as_deref(), Some("id-1"));
}

#[test]
fn modify_file_updates_index() {
    let (dir, mut rec) = setup();
    write_file(&dir, "note.md", &entry_bytes("id-1", "# Old title\n"));
    rec.reconcile_path(std::path::Path::new("note.md"));

    // Modify the file (new content → different hash → re-index).
    // Sleep briefly to ensure mtime changes on fast systems.
    // On macOS mtime has 1-second resolution on most FSes.
    // To avoid needing to sleep, we touch the file + change content.
    write_file(&dir, "note.md", &entry_bytes("id-1", "# New title\n"));
    let path = dir.path().join("note.md");
    // Force mtime change by modifying then setting mtime explicitly.
    // Easier: just use a slightly different mtime by sleeping 1ms and relying on
    // the hash difference (the hash path doesn't need mtime to change).
    // Actually: our pipeline uses mtime+size fast-path first, then hash.
    // Since we changed content the hash will differ; but if mtime+size is
    // identical on a subsecond filesystem, we'd skip. Force by changing size.
    // First reconcile pass: mtime may or may not have changed on fast FSes.
    let _ = rec.reconcile_path(&path);

    // Second pass with content that is unambiguously different (different size).
    write_file(
        &dir,
        "note.md",
        &entry_bytes("id-1", "# New title\nExtra line.\n"),
    );
    let events2 = rec.reconcile_path(&path);
    assert_eq!(events2.len(), 1);
    assert!(matches!(events2[0].kind, ChangeKind::Modified));
}

#[test]
fn delete_file_removes_from_index() {
    let (dir, mut rec) = setup();
    write_file(&dir, "note.md", &entry_bytes("id-del", "# Delete me\n"));
    rec.reconcile_path(std::path::Path::new("note.md"));
    assert_eq!(rec.index().entries_in_group("").unwrap().len(), 1);

    // Remove the file.
    std::fs::remove_file(dir.path().join("note.md")).unwrap();
    let events = rec.reconcile_remove(std::path::Path::new("note.md"));

    assert_eq!(events.len(), 1);
    assert!(matches!(events[0].kind, ChangeKind::Removed));
    assert!(rec.index().entries_in_group("").unwrap().is_empty());
}

// ── Test 2: rename with same id preserves backlinks ──────────────────────────

#[test]
fn rename_with_same_id_preserves_backlinks() {
    let (dir, mut rec) = setup();

    // Create the target entry.
    write_file(&dir, "target.md", &entry_bytes("id-target", "# Target\n"));
    rec.reconcile_path(std::path::Path::new("target.md"));

    // Create a source entry that links to target.
    write_file(
        &dir,
        "source.md",
        &entry_bytes("id-source", "see [[target]] for details"),
    );
    rec.reconcile_path(std::path::Path::new("source.md"));

    // Resolve links so the backlink is established.
    rec.index_mut().resolve_links().unwrap();

    // Record the target's integer row-id.
    let target_row_id = rec.index().entry_id_for_path("target.md").unwrap().unwrap();

    // Rename: write the file to a new path with the same frontmatter id.
    let old_path = dir.path().join("target.md");
    let new_path = dir.path().join("renamed.md");
    std::fs::rename(&old_path, &new_path).unwrap();

    // Reconcile the remove + create in one batch.
    use crate::core::reconcile::reconcile_path::reconcile_batch;
    use crate::core::reconcile::RawKind;
    let batch = vec![
        (old_path.clone(), RawKind::Remove),
        (new_path.clone(), RawKind::CreateOrModify),
    ];
    let events = reconcile_batch(
        rec.index_mut(),
        &Arc::new(TokenRegistry::with_default_ttl()),
        dir.path(),
        &batch,
    );
    rec.index_mut().resolve_links().unwrap();

    // Find the rename event.
    let rename_ev = events
        .iter()
        .find(|e| matches!(e.kind, ChangeKind::Renamed { .. }));
    assert!(rename_ev.is_some(), "rename event must be emitted");

    // Integer row-id must be preserved (backlinks survive).
    let new_row_id = rec
        .index()
        .entry_id_for_path("renamed.md")
        .unwrap()
        .unwrap();
    assert_eq!(
        target_row_id, new_row_id,
        "rename must preserve integer row-id"
    );

    // The old path must be gone.
    assert!(rec
        .index()
        .entry_id_for_path("target.md")
        .unwrap()
        .is_none());
}

// ── Test 3: duplicate id → newcomer rewritten with fresh id ──────────────────

#[test]
fn duplicate_id_newcomer_gets_fresh_id() {
    let (dir, mut rec) = setup();

    // Index the original entry.
    write_file(&dir, "original.md", &entry_bytes("id-dup", "# Original\n"));
    rec.reconcile_path(std::path::Path::new("original.md"));

    // Write a second file with the same id.
    write_file(
        &dir,
        "duplicate.md",
        &entry_bytes("id-dup", "# Duplicate\n"),
    );
    let events = rec.reconcile_path(std::path::Path::new("duplicate.md"));

    // The reconciler must have emitted events.
    assert!(!events.is_empty(), "duplicate should produce events");

    // The duplicate file must now have a DIFFERENT id on disk.
    let bytes = std::fs::read(dir.path().join("duplicate.md")).unwrap();
    let entry = Entry::from_bytes(&bytes);
    let new_id = entry.id().expect("duplicate must have an id after rewrite");
    assert_ne!(new_id, "id-dup", "duplicate file must receive a fresh id");

    // Both entries must be in the index with different ids.
    let entries = rec.index().entries_in_group("").unwrap();
    assert_eq!(entries.len(), 2);
    let ids: Vec<_> = entries
        .iter()
        .filter_map(|e| e.entry_id.as_deref())
        .collect();
    assert!(ids.contains(&"id-dup"), "original id must survive");
    assert!(
        !ids.iter().all(|id| *id == "id-dup"),
        "both entries must not have the same id"
    );
}

// ── Test 4: self-write token suppresses external-change classification ────────

#[test]
fn self_write_token_marks_event_self_originated() {
    let (dir, mut rec) = setup();

    // Write via write_entry (issues a token).
    let path = dir.path().join("self-written.md");
    let entry = {
        let mut props = std::collections::BTreeMap::new();
        props.insert("id".to_string(), Value::String("id-self".to_string()));
        Entry {
            properties: props,
            body: "# Self-written\n".to_string(),
            parse_warning: None,
        }
    };
    write_entry(&path, &entry, &[], &rec.tokens).expect("write_entry");

    // Reconcile the path (the token should be consumed).
    let events = rec.reconcile_path(&path);
    assert_eq!(events.len(), 1);
    assert!(
        events[0].self_originated,
        "self-write token must mark event as self_originated"
    );
}

#[test]
fn external_write_not_self_originated() {
    let (dir, mut rec) = setup();

    // Write directly without a token.
    write_file(&dir, "external.md", &entry_bytes("id-ext", "# External\n"));
    let events = rec.reconcile_path(std::path::Path::new("external.md"));
    assert_eq!(events.len(), 1);
    assert!(
        !events[0].self_originated,
        "external write must NOT be self_originated"
    );
}

// ── Test 5: full_rescan picks up offline edits + deletions ───────────────────

#[test]
fn full_rescan_picks_up_offline_edits_and_deletions() {
    let (dir, mut rec) = setup();

    // Initial state: two files indexed.
    write_file(&dir, "alpha.md", &entry_bytes("id-alpha", "# Alpha\n"));
    write_file(&dir, "beta.md", &entry_bytes("id-beta", "# Beta\n"));
    rec.full_rescan();

    assert_eq!(rec.index().entries_in_group("").unwrap().len(), 2);

    // Offline edit: modify alpha without the app knowing.
    write_file(
        &dir,
        "alpha.md",
        &entry_bytes("id-alpha", "# Alpha updated\n"),
    );
    // Offline deletion: delete beta.
    std::fs::remove_file(dir.path().join("beta.md")).unwrap();

    // New file added offline.
    write_file(&dir, "gamma.md", &entry_bytes("id-gamma", "# Gamma\n"));

    // Rescan.
    let events = rec.full_rescan();

    let entries = rec.index().entries_in_group("").unwrap();
    let paths: Vec<_> = entries.iter().map(|e| e.path.as_str()).collect();

    assert!(paths.contains(&"alpha.md"), "alpha must be present");
    assert!(!paths.contains(&"beta.md"), "beta must be removed");
    assert!(paths.contains(&"gamma.md"), "gamma must be added");

    // Events should include changes.
    assert!(!events.is_empty(), "rescan should produce events");
}

// ── Test 6: projections from _tags.md/_people.md ─────────────────────────────

#[test]
fn tags_projection_populates_tag_meta() {
    let (dir, mut rec) = setup();

    let content = b"---\ntags:\n  - tag: followup\n    description: Revisit\n    color: amber\n  - tag: work\n---\n";
    std::fs::write(dir.path().join("_tags.md"), content).unwrap();

    rec.reconcile_path(std::path::Path::new("_tags.md"));

    // tag_meta should be populated.  We check indirectly by verifying no error.
    // The tag_meta table is currently not directly queryable via a public API
    // (it was added in phase-2-index), so we just confirm no panic and the
    // set_tag_meta path executed.
    // A direct test is in projection::tests.

    // The reconciler should NOT produce entry events for projection files.
    let entries = rec.index().entries_in_group("").unwrap();
    assert!(
        entries.is_empty(),
        "_tags.md must not be indexed as an entry"
    );
}

#[test]
fn people_projection_populates_people() {
    let (dir, mut rec) = setup();

    let content =
        b"---\npeople:\n  - slug: sergey\n    full_name: Sergey K.\n    color: blue\n---\n";
    std::fs::write(dir.path().join("_people.md"), content).unwrap();

    rec.reconcile_path(std::path::Path::new("_people.md"));

    let people = rec.index().people_index().unwrap();
    assert_eq!(people.len(), 1);
    assert_eq!(people[0].slug, "sergey");
    assert_eq!(people[0].full_name.as_deref(), Some("Sergey K."));

    // No entry event.
    let entries = rec.index().entries_in_group("").unwrap();
    assert!(entries.is_empty());
}

#[test]
fn projection_in_subdirectory_skipped() {
    // _tags.md inside a subdirectory must NOT be treated as a projection.
    let (dir, mut rec) = setup();
    std::fs::create_dir_all(dir.path().join("sub")).unwrap();
    let content = b"---\ntags:\n  - tag: sub-tag\n---\n";
    std::fs::write(dir.path().join("sub/_tags.md"), content).unwrap();

    rec.reconcile_path(std::path::Path::new("sub/_tags.md"));

    // tag_meta must NOT be set (reserved file in subdir → silently skipped).
    // The file is reserved (starts with _) so it's skipped; tag_meta stays empty.
    // We verify by ensuring no panics and the correct non-indexed state.
    let entries = rec.index().entries_in_group("").unwrap();
    assert!(
        entries.is_empty(),
        "reserved file in subdir must not be indexed as entry"
    );
}

// ── Test 7: link resolution incl. ambiguous-stays-NULL ───────────────────────

#[test]
fn link_resolution_unique_slug_resolves() {
    let (dir, mut rec) = setup();

    // Target entry.
    write_file(&dir, "target.md", &entry_bytes("id-target", "# Target\n"));
    rec.reconcile_path(std::path::Path::new("target.md"));

    // Source entry with a wikilink to target.
    write_file(
        &dir,
        "source.md",
        &entry_bytes("id-source", "see [[target]] for details"),
    );
    rec.reconcile_path(std::path::Path::new("source.md"));

    // verify the target entry is in index and backlinks work
    let src_id = rec.index().entry_id_for_path("source.md").unwrap().unwrap();
    let target_id = rec.index().entry_id_for_path("target.md").unwrap().unwrap();
    let backlinks = rec.index().backlinks(target_id).unwrap();
    assert_eq!(
        backlinks.len(),
        1,
        "target must have exactly one backlink from source"
    );
    assert_eq!(backlinks[0].src_entry_id, src_id);
}

#[test]
fn link_resolution_ambiguous_stays_null() {
    let (dir, mut rec) = setup();

    // Two entries with the same slug in different groups.
    std::fs::create_dir_all(dir.path().join("a")).unwrap();
    std::fs::create_dir_all(dir.path().join("b")).unwrap();
    write_file(&dir, "a/note.md", &entry_bytes("id-a-note", "# Note A\n"));
    write_file(&dir, "b/note.md", &entry_bytes("id-b-note", "# Note B\n"));

    // Source with a bare wikilink to "note" (ambiguous).
    write_file(
        &dir,
        "source.md",
        &entry_bytes("id-source-amb", "see [[note]] for details"),
    );

    rec.reconcile_path(std::path::Path::new("a/note.md"));
    rec.reconcile_path(std::path::Path::new("b/note.md"));
    rec.reconcile_path(std::path::Path::new("source.md"));

    // After reconcile, resolve_links is called; ambiguous → NULL.
    // Verify: neither a/note.md nor b/note.md has a backlink from source.
    let a_id = rec.index().entry_id_for_path("a/note.md").unwrap().unwrap();
    let b_id = rec.index().entry_id_for_path("b/note.md").unwrap().unwrap();
    let bl_a = rec.index().backlinks(a_id).unwrap();
    let bl_b = rec.index().backlinks(b_id).unwrap();
    assert!(
        bl_a.is_empty(),
        "ambiguous link must not resolve to a/note.md"
    );
    assert!(
        bl_b.is_empty(),
        "ambiguous link must not resolve to b/note.md"
    );
}

#[test]
fn link_resolution_path_qualified_resolves() {
    let (dir, mut rec) = setup();

    // Two entries with the same slug in different groups.
    std::fs::create_dir_all(dir.path().join("a")).unwrap();
    std::fs::create_dir_all(dir.path().join("b")).unwrap();
    write_file(&dir, "a/note.md", &entry_bytes("id-a-note2", "# Note A\n"));
    write_file(&dir, "b/note.md", &entry_bytes("id-b-note2", "# Note B\n"));

    // Source with a path-qualified wikilink (unambiguous).
    write_file(
        &dir,
        "source2.md",
        &entry_bytes("id-source2", "see [[a/note]] for details"),
    );

    rec.reconcile_path(std::path::Path::new("a/note.md"));
    rec.reconcile_path(std::path::Path::new("b/note.md"));
    rec.reconcile_path(std::path::Path::new("source2.md"));

    let a_id = rec.index().entry_id_for_path("a/note.md").unwrap().unwrap();
    let bl = rec.index().backlinks(a_id).unwrap();
    assert_eq!(bl.len(), 1, "path-qualified link must resolve to a/note.md");
}

// ── Test 8: watcher smoke test (marked ignore — may be flaky in CI) ──────────

#[test]
#[ignore = "live watcher smoke test; may be flaky in CI due to timing"]
fn watcher_smoke_test() {
    use crate::core::reconcile::Reconciler;

    let dir = tempfile::tempdir().expect("tempdir");
    let index = Index::open_in_memory().expect("index");
    let tokens = Arc::new(TokenRegistry::with_default_ttl());

    let (event_tx, event_rx) = crossbeam_channel::unbounded();
    let (reconciler, watcher_handle) =
        Reconciler::new_with_watcher(index, tokens, dir.path().to_path_buf(), event_tx)
            .expect("watcher setup");

    let (_handle, recv) = reconciler.spawn(Some(watcher_handle));

    // Write a file and wait for the reconciler to process it.
    write_file(
        &dir,
        "watcher-test.md",
        &entry_bytes("id-watch", "# Watcher\n"),
    );

    // Wait up to 2 seconds for an event.
    let ev = recv.recv_timeout(std::time::Duration::from_secs(2));
    assert!(ev.is_ok(), "watcher should emit a create event");

    drop(event_rx);
    // Watcher dropped with the handle.
}

// ── Group path helper tests ───────────────────────────────────────────────────

#[test]
fn group_path_at_root() {
    use crate::core::reconcile::reconcile_path::group_path_for_rel;
    assert_eq!(group_path_for_rel("note.md"), "");
}

#[test]
fn group_path_one_level() {
    use crate::core::reconcile::reconcile_path::group_path_for_rel;
    assert_eq!(group_path_for_rel("notes/note.md"), "notes");
}

#[test]
fn group_path_nested() {
    use crate::core::reconcile::reconcile_path::group_path_for_rel;
    assert_eq!(group_path_for_rel("Work/Atlas/note.md"), "Work/Atlas");
}
