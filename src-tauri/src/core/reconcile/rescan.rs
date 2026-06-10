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
//   1. Walk the tree from `library_root`, skipping:
//      - `.tonotedo/` (index + journals) — spec 0002 §"Reserved names"
//      - Any path component starting with `.` (hidden files)
//      - Non-`.md` files (only `.md` files are indexed)
//      - `_assets/` directories (attachment storage, not entries)
//   2. For each discovered path: run `reconcile_one` (same as the watcher path).
//      The ledger's mtime+size fast-path makes this cheap for unchanged files.
//   3. After the walk, check all `files` ledger rows.  Any row whose path no
//      longer exists on disk → remove.
//
// INV (single function, two callers): `full_rescan` is called from:
//   - Startup (on a background thread via the spawned worker).
//   - Mobile foreground (via `SyncReconciler::full_rescan`).
//   No other code path does a tree walk.
//
// INV (deletion detection): we compare ALL ledger rows against the current disk
// state AFTER the walk, not during, to avoid TOCTOU races on the walk itself.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use crate::core::{fswrite::TokenRegistry, index::Index};

use super::{event::ChangeEvent, reconcile_path::reconcile_batch, RawKind};

/// Full tree rescan.
///
/// Walks `library_root`, reconciles all discovered `.md` files (fast-path for
/// unchanged files), then removes ledger rows for files that no longer exist.
///
/// Returns all `ChangeEvent`s produced during the scan.  Link resolution is
/// the caller's responsibility (call `index.resolve_links()` after this).
pub fn full_rescan(
    index: &mut Index,
    tokens: &Arc<TokenRegistry>,
    library_root: &Path,
) -> Vec<ChangeEvent> {
    // ── Step 1: walk the tree ────────────────────────────────────────────────
    let md_paths = walk_md_files(library_root);

    // Build a set of all paths discovered on disk (library-relative strings).
    let disk_set: std::collections::HashSet<String> = md_paths
        .iter()
        .filter_map(|p| {
            p.strip_prefix(library_root)
                .ok()?
                .to_str()
                .map(|s| s.to_string())
        })
        .collect();

    // ── Step 2: reconcile discovered files ───────────────────────────────────
    let batch: Vec<(PathBuf, RawKind)> = md_paths
        .into_iter()
        .map(|p| (p, RawKind::CreateOrModify))
        .collect();

    let mut events = reconcile_batch(index, tokens, library_root, &batch);

    // ── Step 3: detect deletions ─────────────────────────────────────────────
    // Collect ledger paths that are no longer on disk.
    let ledger_paths = index.all_ledger_paths().unwrap_or_default();
    let mut removes: Vec<(PathBuf, RawKind)> = Vec::new();
    for ledger_rel in ledger_paths {
        if !disk_set.contains(&ledger_rel) {
            let abs = library_root.join(&ledger_rel);
            removes.push((abs, RawKind::Remove));
        }
    }

    if !removes.is_empty() {
        let remove_events = reconcile_batch(index, tokens, library_root, &removes);
        events.extend(remove_events);
    }

    events
}

// ── Tree walker ───────────────────────────────────────────────────────────────

/// Walk `root` recursively, returning absolute paths to all `.md` files.
///
/// Skip rules (see INV at top of file):
/// - Directories starting with `.` (includes `.tonotedo`).
/// - The `_assets` directory (contains attachments, not entries).
/// - Non-`.md` files.
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

        // Skip hidden / system directories.
        if name.starts_with('.') {
            continue;
        }
        // Skip _assets directories.
        if name == "_assets" {
            continue;
        }

        let file_type = match entry.file_type() {
            Ok(t) => t,
            Err(_) => continue,
        };

        if file_type.is_dir() {
            walk_dir(&path, out);
        } else if file_type.is_file() && name.ends_with(".md") {
            out.push(path);
        }
        // Symlinks are ignored for now.
    }
}
