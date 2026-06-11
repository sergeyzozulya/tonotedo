// Full tree rescan — startup and mobile foreground path (spec 0013).
//
// Design reference: design-0001 §"Startup rescan":
//   "Walk the tree; diff against `files`; reconcile differences.  An empty or
//   version-mismatched `index.db` triggers a full rebuild on a background thread."
//
// Spec 0013 §"Lifecycle":
//   "On foreground: rescan-diff the library (design-0001's startup path,
//   incremental), reconcile, refresh views."
//
// ## Algorithm
//
//   1. Walk the tree from `library_root`, skipping any path component that is
//      reserved (`_`/`.`-prefixed) — `.tonotedo/`, `_assets/`, `_people/`, etc.
//      Only `.md` files are collected.  (spec 0002 §"Reserved names")
//   2. For each discovered path: run `reconcile_batch` (same as the watcher path).
//      The ledger's mtime+size fast-path makes this cheap for unchanged files.
//   3. After the walk, check all `files` ledger rows.  A row is removed ONLY
//      when its absolute path is CONFIRMED ABSENT on disk (symlink_metadata
//      errors with NotFound).  A row that we simply failed to encounter because
//      a subtree was unreadable (permission error) is KEPT and `needs_full_rescan`
//      is set so the deletion can be retried once the subtree is readable again.
//
// INV (single function, two callers): `full_rescan` is called from startup (via
// the spawned worker) and mobile foreground (`SyncReconciler::full_rescan`).
//
// INV (deletion safety): "not encountered in the walk" is NOT sufficient to
// delete a ledger row — an unreadable subtree must not orphan its index rows.
// We confirm absence per-path with `symlink_metadata` before deleting.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use crate::core::{fswrite::TokenRegistry, index::Index};

use super::{
    event::{ChangeEvent, ReconcileNotification},
    reconcile_path::reconcile_batch,
    RawKind,
};

/// Full tree rescan.
///
/// Walks `library_root`, reconciles all discovered `.md` files (fast-path for
/// unchanged files), then removes ledger rows for files CONFIRMED absent on disk.
///
/// Returns all `ChangeEvent`s produced during the scan.  Link resolution is
/// the caller's responsibility (call `index.resolve_links()` after this).
pub fn full_rescan(
    index: &mut Index,
    tokens: &Arc<TokenRegistry>,
    library_root: &Path,
    needs_full_rescan: &AtomicBool,
    notifications: &mut Vec<ReconcileNotification>,
) -> Vec<ChangeEvent> {
    // ── Step 1: walk the tree ────────────────────────────────────────────────
    let md_paths = walk_md_files(library_root);

    // NFC-normalized rel-path set of everything the walk actually found. Ledger
    // paths are also NFC-normalized (reconcile_path::rel_path), so a file that
    // exists on disk under ANY Unicode normalization is present in this set.
    // This is the authoritative "present" check for deletion detection: on a
    // non-normalizing filesystem (ext4) the on-disk bytes may be NFD while the
    // ledger key is NFC, so re-`stat`-ing the NFC string would falsely miss it.
    let disk_set: std::collections::HashSet<String> = md_paths
        .iter()
        .filter_map(|p| super::reconcile_path::rel_path(library_root, p))
        .collect();

    // ── Step 2: reconcile discovered files ───────────────────────────────────
    let batch: Vec<(PathBuf, RawKind)> = md_paths
        .into_iter()
        .map(|p| (p, RawKind::CreateOrModify))
        .collect();

    let mut events = reconcile_batch(
        index,
        tokens,
        library_root,
        &batch,
        needs_full_rescan,
        notifications,
    );

    // ── Step 3: detect deletions (confirm absence per-path) ──────────────────
    // A ledger row is removed ONLY if its absolute path is genuinely gone.  An
    // I/O error other than NotFound (e.g. an unreadable subtree) keeps the row
    // and flags a recovery rescan — we must never delete index rows for a
    // subtree we simply could not read.
    let ledger_paths = index.all_ledger_paths().unwrap_or_default();
    let mut removes: Vec<(PathBuf, RawKind)> = Vec::new();
    for ledger_rel in ledger_paths {
        // Present in the walk (under any normalization) → definitively keep.
        // This handles non-normalizing filesystems where the on-disk path is
        // NFD but the ledger key is NFC — the file IS there, the stat below
        // would falsely miss it.
        if disk_set.contains(&ledger_rel) {
            continue;
        }
        let abs = library_root.join(&ledger_rel);
        // Not found by the walk. It is either genuinely gone OR under a subtree
        // the walk could not read. Confirm with a per-path stat (F4 protection):
        // only NotFound deletes; other I/O errors keep the row and reschedule.
        match std::fs::symlink_metadata(&abs) {
            Ok(_) => {} // still present (e.g. a path the walk filtered) → keep
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                removes.push((abs, RawKind::Remove));
            }
            Err(_) => {
                // Unreadable (permission, transient I/O): keep the row, retry later.
                eprintln!(
                    "rescan: cannot confirm absence of {ledger_rel}; keeping ledger row, \
                     scheduling rescan"
                );
                needs_full_rescan.store(true, Ordering::SeqCst);
            }
        }
    }

    if !removes.is_empty() {
        let remove_events = reconcile_batch(
            index,
            tokens,
            library_root,
            &removes,
            needs_full_rescan,
            notifications,
        );
        events.extend(remove_events);
    }

    events
}

// ── Tree walker ───────────────────────────────────────────────────────────────

/// Walk `root` recursively, returning absolute paths to all `.md` files.
///
/// Skip rules: any directory whose name is reserved (`_`/`.`-prefixed) — this
/// covers `.tonotedo`, `_assets`, `_people`, etc.  Only `.md` files are returned.
fn walk_md_files(root: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    walk_dir(root, &mut out);
    out
}

fn walk_dir(dir: &Path, out: &mut Vec<PathBuf>) {
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };

    for entry in entries.flatten() {
        let path = entry.path();
        let name = match path.file_name().and_then(|n| n.to_str()) {
            Some(n) => n.to_string(),
            None => continue,
        };

        let file_type = match entry.file_type() {
            Ok(t) => t,
            Err(_) => continue,
        };

        if file_type.is_dir() {
            // Skip reserved directories at any depth (`.tonotedo`, `_assets`,
            // `_people`, …).  A reserved directory never contains entries.
            if name.starts_with('_') || name.starts_with('.') {
                continue;
            }
            walk_dir(&path, out);
        } else if file_type.is_file() && name.ends_with(".md") {
            // Hand every `.md` not under a reserved subtree to the reconciler.
            // Reserved FILES at this level (root `_tags.md`/`_people.md` →
            // projections; `_searches.md` etc. → ledger-only) are routed by
            // `reconcile_batch` via `has_reserved_component`; we do not filter
            // them here.
            out.push(path);
        }
    }
}
