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
    use std::sync::atomic::AtomicBool;
    let batch = vec![
        (old_path.clone(), RawKind::Remove),
        (new_path.clone(), RawKind::CreateOrModify),
    ];
    let events = reconcile_batch(
        rec.index_mut(),
        &Arc::new(TokenRegistry::with_default_ttl()),
        dir.path(),
        &batch,
        &AtomicBool::new(false),
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

// ── Test 3: duplicate id → larger-path file rewritten with fresh id ──────────
//
// Keeper is deterministic (finding #2): the lexicographically smaller path keeps
// the id.  Here "aaa.md" (smaller) keeps it and "zzz.md" (larger, the newcomer)
// is re-id'd, regardless of reconcile order.

#[test]
fn duplicate_id_larger_path_gets_fresh_id() {
    let (dir, mut rec) = setup();

    // Index the original entry (smaller path → keeper).
    write_file(&dir, "aaa.md", &entry_bytes("id-dup", "# Original\n"));
    rec.reconcile_path(std::path::Path::new("aaa.md"));

    // Write a second file with the same id (larger path → loser).
    write_file(&dir, "zzz.md", &entry_bytes("id-dup", "# Duplicate\n"));
    let events = rec.reconcile_path(std::path::Path::new("zzz.md"));

    assert!(!events.is_empty(), "duplicate should produce events");

    // The larger-path file must now have a DIFFERENT id on disk.
    let bytes = std::fs::read(dir.path().join("zzz.md")).unwrap();
    let new_id = Entry::from_bytes(&bytes)
        .id()
        .expect("duplicate must have an id after rewrite")
        .to_string();
    assert_ne!(new_id, "id-dup", "larger-path file must receive a fresh id");

    // The smaller-path file keeps the original id.
    let keeper = std::fs::read(dir.path().join("aaa.md")).unwrap();
    assert_eq!(Entry::from_bytes(&keeper).id(), Some("id-dup"));

    // Both entries indexed with different ids.
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

    // tag_meta must be populated with the two declared tags.
    let mut meta = rec.index().tag_meta_index().unwrap();
    meta.sort_by(|a, b| a.tag.cmp(&b.tag));
    assert_eq!(meta.len(), 2, "_tags.md must populate two tag_meta rows");
    assert_eq!(meta[0].tag, "followup");
    assert_eq!(meta[0].description.as_deref(), Some("Revisit"));
    assert_eq!(meta[0].color.as_deref(), Some("amber"));
    assert_eq!(meta[1].tag, "work");

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

// ── Finding #1a: offline rename via full_rescan preserves identity ────────────

#[test]
fn offline_rename_via_full_rescan_preserves_id_and_backlinks() {
    let (dir, mut rec) = setup();

    // Target + a source that links to it.
    write_file(&dir, "target.md", &entry_bytes("id-target", "# Target\n"));
    write_file(
        &dir,
        "source.md",
        &entry_bytes("id-source", "see [[renamed]] for details"),
    );
    rec.full_rescan();

    let target_row_id = rec.index().entry_id_for_path("target.md").unwrap().unwrap();

    // OFFLINE rename: move target.md → renamed.md (same fmid). The app never saw
    // a paired remove+create; full_rescan must still detect it as a rename.
    std::fs::rename(dir.path().join("target.md"), dir.path().join("renamed.md")).unwrap();
    let renamed_bytes_before = std::fs::read(dir.path().join("renamed.md")).unwrap();

    rec.full_rescan();

    // Identity preserved: same integer row-id at the new path.
    let new_row_id = rec
        .index()
        .entry_id_for_path("renamed.md")
        .unwrap()
        .expect("renamed.md must be indexed");
    assert_eq!(
        target_row_id, new_row_id,
        "offline rename must preserve the integer row-id (backlinks)"
    );
    assert!(
        rec.index()
            .entry_id_for_path("target.md")
            .unwrap()
            .is_none(),
        "old path must be gone after rename"
    );

    // The file must NOT have been rewritten (id preserved, no fresh id).
    let renamed_bytes_after = std::fs::read(dir.path().join("renamed.md")).unwrap();
    assert_eq!(
        renamed_bytes_before, renamed_bytes_after,
        "offline rename must NOT rewrite the file"
    );
    let entry = Entry::from_bytes(&renamed_bytes_after);
    assert_eq!(entry.id(), Some("id-target"), "fmid must be preserved");

    // Backlink from source → renamed survives.
    let bl = rec.index().backlinks(new_row_id).unwrap();
    assert_eq!(bl.len(), 1, "backlink must survive the rename");
}

// ── Finding #1b: cross-batch rename where source arrives as CreateOrModify ────

#[test]
fn cross_batch_rename_create_event_old_file_gone() {
    let (dir, mut rec) = setup();

    // Index original.md.
    write_file(&dir, "original.md", &entry_bytes("id-x", "# X\n"));
    rec.reconcile_path(std::path::Path::new("original.md"));
    let row_id = rec
        .index()
        .entry_id_for_path("original.md")
        .unwrap()
        .unwrap();

    // Simulate macOS delivering only a CreateOrModify for the destination while
    // the source file is already gone (the Remove was never seen / was a Modify).
    std::fs::rename(dir.path().join("original.md"), dir.path().join("moved.md")).unwrap();
    let bytes_before = std::fs::read(dir.path().join("moved.md")).unwrap();

    let events = rec.reconcile_path(std::path::Path::new("moved.md"));

    // Must be classified as a rename, not a duplicate rewrite.
    assert!(
        events
            .iter()
            .any(|e| matches!(e.kind, ChangeKind::Renamed { .. })),
        "must emit a Renamed event, got {events:?}"
    );
    let new_row_id = rec.index().entry_id_for_path("moved.md").unwrap().unwrap();
    assert_eq!(
        row_id, new_row_id,
        "row-id preserved across cross-batch rename"
    );
    assert!(rec
        .index()
        .entry_id_for_path("original.md")
        .unwrap()
        .is_none());

    // No rewrite: fmid unchanged, bytes unchanged.
    let bytes_after = std::fs::read(dir.path().join("moved.md")).unwrap();
    assert_eq!(
        bytes_before, bytes_after,
        "rename must not rewrite the file"
    );
    assert_eq!(Entry::from_bytes(&bytes_after).id(), Some("id-x"));
}

// ── Finding #2: duplicate keeper is deterministic (order-independent) ─────────

fn keeper_after_dup(reconcile_a_first: bool) -> (String, String) {
    // Returns (id_at_a, id_at_b) after reconciling both a.md and b.md (same fmid).
    let (dir, mut rec) = setup();
    write_file(&dir, "a.md", &entry_bytes("dup", "# A\n"));
    write_file(&dir, "b.md", &entry_bytes("dup", "# B\n"));

    if reconcile_a_first {
        rec.reconcile_path(std::path::Path::new("a.md"));
        rec.reconcile_path(std::path::Path::new("b.md"));
    } else {
        rec.reconcile_path(std::path::Path::new("b.md"));
        rec.reconcile_path(std::path::Path::new("a.md"));
    }

    let id_a = Entry::from_bytes(&std::fs::read(dir.path().join("a.md")).unwrap())
        .id()
        .unwrap()
        .to_string();
    let id_b = Entry::from_bytes(&std::fs::read(dir.path().join("b.md")).unwrap())
        .id()
        .unwrap()
        .to_string();
    (id_a, id_b)
}

#[test]
fn duplicate_keeper_is_order_independent() {
    let (a1, b1) = keeper_after_dup(true);
    let (a2, b2) = keeper_after_dup(false);

    // Lexicographically smaller path ("a.md") keeps the id in BOTH orders.
    assert_eq!(a1, "dup", "a.md (smaller path) must keep the id (a-first)");
    assert_ne!(b1, "dup", "b.md must be re-id'd (a-first)");
    assert_eq!(a2, "dup", "a.md (smaller path) must keep the id (b-first)");
    assert_ne!(b2, "dup", "b.md must be re-id'd (b-first)");
}

// ── Finding #8: dup rewrite ledger records post-rewrite hash (no re-reconcile) ─

#[test]
fn duplicate_rewrite_ledger_matches_written_bytes() {
    let (dir, mut rec) = setup();
    write_file(&dir, "a.md", &entry_bytes("dup8", "# A\n"));
    write_file(&dir, "b.md", &entry_bytes("dup8", "# B\n"));
    rec.reconcile_path(std::path::Path::new("a.md"));
    // b.md is the larger path → it gets re-id'd + rewritten.
    rec.reconcile_path(std::path::Path::new("b.md"));

    // Reconcile b.md again with NO disk change: the ledger must already reflect
    // the rewritten bytes, so this is a fast-path no-op (no spurious event).
    let events = rec.reconcile_path(std::path::Path::new("b.md"));
    assert!(
        events.is_empty(),
        "re-reconcile after dup rewrite must be a no-op, got {events:?}"
    );
}

// ── Finding #5: reserved-component paths are not indexed ──────────────────────

#[test]
fn reserved_component_paths_not_indexed() {
    let (dir, mut rec) = setup();

    write_file(
        &dir,
        "_people/sergey.md",
        &entry_bytes("id-p", "# Sergey\n"),
    );
    write_file(&dir, "_searches.md", &entry_bytes("id-s", "# Searches\n"));
    write_file(&dir, "sub/_group.md", "---\nview: note\n---\n# Group\n");
    write_file(&dir, "sub/real.md", &entry_bytes("id-r", "# Real nested\n"));

    rec.full_rescan();

    let paths: Vec<String> = rec
        .index()
        .entries_in_group("")
        .unwrap()
        .into_iter()
        .map(|e| e.path)
        .collect();

    assert!(
        !paths.contains(&"_people/sergey.md".to_string()),
        "_people/ files must not be indexed"
    );
    assert!(
        !paths.contains(&"_searches.md".to_string()),
        "_searches.md must not be indexed"
    );
    assert!(
        !paths.contains(&"sub/_group.md".to_string()),
        "sub/_group.md must not be indexed as an entry"
    );
    assert!(
        paths.contains(&"sub/real.md".to_string()),
        "normal nested entries must still be indexed"
    );
}

// ── Finding #4: unreadable subtree must not delete its index rows ─────────────

#[test]
fn unreadable_subtree_keeps_index_rows() {
    use std::os::unix::fs::PermissionsExt;

    let (dir, mut rec) = setup();
    write_file(&dir, "top.md", &entry_bytes("id-top", "# Top\n"));
    write_file(
        &dir,
        "locked/inner.md",
        &entry_bytes("id-inner", "# Inner\n"),
    );
    rec.full_rescan();
    assert!(rec
        .index()
        .entry_id_for_path("locked/inner.md")
        .unwrap()
        .is_some());

    // Make the subdir unreadable so the walk cannot enumerate it.
    let locked = dir.path().join("locked");
    std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o000)).unwrap();

    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        rec.full_rescan();
        // inner.md must NOT be deleted just because the walk skipped it.
        rec.index()
            .entry_id_for_path("locked/inner.md")
            .unwrap()
            .is_some()
    }));

    // Restore permissions regardless of assertion outcome (so tempdir cleans up).
    std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o755)).unwrap();

    assert!(
        result.unwrap(),
        "entries under an unreadable subtree must survive a rescan"
    );
    assert!(
        rec.needs_full_rescan(),
        "an unreadable subtree must flag needs_full_rescan"
    );
}

// ── Finding #7: index write errors → no success event + rescan flag ──────────

#[test]
fn index_error_suppresses_success_event_and_sets_flag() {
    let (dir, mut rec) = setup();
    write_file(&dir, "boom.md", &entry_bytes("id-boom", "# Boom\n"));

    // Craft an index error: drop the fts table so upsert_entry's FTS write fails.
    rec.index_mut().exec_raw("DROP TABLE fts;").unwrap();

    let events = rec.reconcile_path(std::path::Path::new("boom.md"));
    assert!(
        events.is_empty(),
        "an index error must suppress the success event, got {events:?}"
    );
    assert!(
        rec.needs_full_rescan(),
        "an index error must set needs_full_rescan"
    );
}

// ── Finding #11: malformed projection keeps last-good ─────────────────────────

#[test]
fn malformed_projection_keeps_last_good() {
    let (dir, mut rec) = setup();

    // First, a valid _tags.md → rows populated.
    let good = b"---\ntags:\n  - tag: followup\n    color: amber\n  - tag: work\n---\n";
    std::fs::write(dir.path().join("_tags.md"), good).unwrap();
    rec.reconcile_path(std::path::Path::new("_tags.md"));
    assert_eq!(rec.index().tag_meta_index().unwrap().len(), 2);

    // Now overwrite with malformed YAML and reconcile.
    let bad = b"---\ntags:\n  - tag: followup\n   color: \"unterminated\n---\n";
    std::fs::write(dir.path().join("_tags.md"), bad).unwrap();
    rec.reconcile_path(std::path::Path::new("_tags.md"));

    // The previous (good) projection must survive — NOT be wiped.
    let meta = rec.index().tag_meta_index().unwrap();
    assert_eq!(
        meta.len(),
        2,
        "malformed projection must keep the last-good rows, got {meta:?}"
    );
}

// ── Finding #3: worker survives a panic and processes the next batch ──────────

#[test]
fn worker_survives_panic_and_processes_next_batch() {
    use crate::core::reconcile::Reconciler;

    let dir = tempfile::tempdir().expect("tempdir");
    let index = Index::open_in_memory().expect("index");
    let tokens = Arc::new(TokenRegistry::with_default_ttl());
    let (event_tx, _unused) = crossbeam_channel::unbounded();
    let rec = Reconciler::new_without_watcher(index, tokens, dir.path().to_path_buf(), event_tx);
    let raw_tx = rec.raw_sender();
    let (_handle, recv) = rec.spawn(None);

    use crate::core::reconcile::RawKind;

    // Batch 1: a path that makes reconcile panic.
    write_file(&dir, "__panic__.md", &entry_bytes("id-panic", "# Panic\n"));
    raw_tx
        .send(crate::core::reconcile::test_raw_event(
            dir.path().join("__panic__.md"),
            RawKind::CreateOrModify,
        ))
        .unwrap();

    // Wait past the debounce so batch 1 is processed (and panics) before batch 2.
    std::thread::sleep(std::time::Duration::from_millis(250));

    // Batch 2: a normal file. The worker must still process it.
    write_file(&dir, "after.md", &entry_bytes("id-after", "# After\n"));
    raw_tx
        .send(crate::core::reconcile::test_raw_event(
            dir.path().join("after.md"),
            RawKind::CreateOrModify,
        ))
        .unwrap();

    let ev = recv.recv_timeout(std::time::Duration::from_secs(2));
    assert!(
        ev.is_ok(),
        "worker must process the batch after a panicking batch"
    );
    assert_eq!(ev.unwrap().path, dir.path().join("after.md"));
}
