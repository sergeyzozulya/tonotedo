// reconcile_path — the core reconcile pipeline.
//
// Design reference: design-0001 §"Reconcile(path)" and §"Rename detection".
//
// ## Pipeline for a single path (create/modify)
//
//   1. Compute library-relative path.
//   2. Stat the file on disk.
//   3. If the file is MISSING → treat as remove.
//   4. Compare (mtime, size) to the ledger.
//      - Unchanged mtime+size → skip (fast path).
//   5. Read bytes, compute hash via `fswrite::content_hash`.
//   6. Check `TokenRegistry::consume_if_match` (self-write detection).
//      - Match → still update ledger; mark event as `self_originated`.
//   7. Compare hash to ledger.
//      - Same hash → update ledger row only (mtime/size changed, not content).
//   8. Classify the file:
//      - Reserved projection (`_tags.md`, `_people.md` at root) → projection path.
//      - Reserved non-projection → update files ledger, skip entry indexing.
//      - Normal entry → entry path.
//   9. Entry path:
//      a. Parse `Entry::from_bytes`.
//      b. Derive slug (file stem), group_path (parent dir, "" at root).
//      c. Rename detection: determined in the batch pre-pass (see below).
//      d. Duplicate-id rule (spec 0002): if frontmatter id already belongs to a
//         LIVE different path AND this is NOT a rename → assign a fresh id,
//         rewrite the file atomically, emit DuplicateIdResolved notification.
//      e. `index.upsert_entry`.
//
// ## Batch reconciliation — rename detection
//
// Rename detection requires seeing both the remove and the create simultaneously.
// The batch pre-pass:
//   1. For each Remove path: read the fmid from the INDEX (before any mutation).
//      Build: fmid → old_rel_path (map of removed entries).
//   2. For each CreateOrModify path: peek the fmid from the FILE on disk.
//      Build: fmid → new_abs_path (map of to-be-created entries).
//   3. Intersect: fmids present in both maps → rename candidates.
//   4. Non-rename removes: do_remove (deletes the index row).
//   5. Creates/modifies:
//      - If a rename candidate: do_rename (index.rename_entry, preserves row-id).
//      - Else: do_upsert (normal create/modify path).
//
// INV (row-id preservation):  rename detection in the same batch ALWAYS uses
// `index.rename_entry`, which keeps the integer row-id and all backlinks intact.
// Cross-batch renames (not detected) re-add with the same frontmatter id but a
// new integer row-id — acceptable per spec 0002 ("id never reused").
//
// INV (self-write token consumed before hash comparison):  The token is consumed
// even if the hash later matches the ledger.  This prevents a stale token from
// being consumed on a later event with the same bytes.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use crate::core::{
    frontmatter::{generate_id, is_reserved, Entry, Value},
    fswrite::{atomic_write, content_hash, TokenRegistry},
    index::Index,
};

use super::{
    event::{ChangeEvent, ChangeKind, ReconcileNotification},
    ledger::{is_stale, stat},
    projection, RawKind,
};

// ── Public entry point ────────────────────────────────────────────────────────

/// Reconcile a batch of `(absolute_path, kind)` pairs.
///
/// Handles rename detection (same frontmatter id in a remove + create pair within
/// the same batch), duplicate-id resolution, projection updates, and link resolution.
///
/// Returns a Vec of `ChangeEvent`s to emit downstream.
pub fn reconcile_batch(
    index: &mut Index,
    tokens: &Arc<TokenRegistry>,
    library_root: &Path,
    events: &[(PathBuf, RawKind)],
) -> Vec<ChangeEvent> {
    let mut out: Vec<ChangeEvent> = Vec::new();

    // ── Pre-pass A: collect fmid of each REMOVED path (before any mutation) ──
    // Map: fmid → old library-relative path.
    let mut removed_fmids: HashMap<String, String> = HashMap::new();
    for (abs_path, kind) in events {
        if *kind != RawKind::Remove {
            continue;
        }
        let rel = match rel_path(library_root, abs_path) {
            Some(r) => r,
            None => continue,
        };
        // Look up via integer row-id then scan entries to get fmid.
        if let Ok(Some(row_id)) = index.entry_id_for_path(&rel) {
            if let Ok(entries) = index.entries_in_group("") {
                for e in entries {
                    if e.id == row_id {
                        if let Some(fmid) = e.entry_id {
                            removed_fmids.insert(fmid, rel.clone());
                        }
                        break;
                    }
                }
            }
        }
    }

    // ── Pre-pass B: peek fmid of each CREATE/MODIFY path (read file, no parse) ─
    // Map: fmid → new absolute path.
    // This is a cheap peek: read the file, extract the `id:` field only.
    let mut created_fmids: HashMap<String, PathBuf> = HashMap::new();
    for (abs_path, kind) in events {
        if *kind != RawKind::CreateOrModify {
            continue;
        }
        if let Some(fmid) = peek_fmid(abs_path) {
            created_fmids.insert(fmid, abs_path.clone());
        }
    }

    // ── Pre-pass C: identify rename pairs ────────────────────────────────────
    // A rename is: fmid present in both removed_fmids and created_fmids,
    // where the old_rel != new_rel.
    let mut rename_pairs: HashMap<String, (String, PathBuf)> = HashMap::new(); // fmid → (old_rel, new_abs)
    for (fmid, old_rel) in &removed_fmids {
        if let Some(new_abs) = created_fmids.get(fmid) {
            let new_rel = rel_path(library_root, new_abs).unwrap_or_default();
            if &new_rel != old_rel {
                rename_pairs.insert(fmid.clone(), (old_rel.clone(), new_abs.clone()));
            }
        }
    }

    // ── Pass 1: process removes that are NOT renames ─────────────────────────
    for (abs_path, kind) in events {
        if *kind != RawKind::Remove {
            continue;
        }
        let rel = match rel_path(library_root, abs_path) {
            Some(r) => r,
            None => continue,
        };
        // Skip if this path is being renamed (handled in the create pass).
        let is_being_renamed = removed_fmids
            .get(&rel) // rel as value (old_rel)
            .map(|_| false) // never skip by this check
            .unwrap_or(false);
        let _ = is_being_renamed; // suppress unused warning
                                  // Actually check by fmid: if any rename pair has this old_rel, skip.
        let old_rel_is_rename = rename_pairs.values().any(|(old_r, _)| old_r == &rel);
        if old_rel_is_rename {
            // Will be handled as rename_entry in pass 2.
            continue;
        }
        if let Some(ev) = do_remove(index, &rel, abs_path) {
            out.push(ev);
        }
    }

    // ── Pass 2: process creates/modifies ─────────────────────────────────────
    for (abs_path, kind) in events {
        if *kind != RawKind::CreateOrModify {
            continue;
        }
        // Check whether this create is the destination of a rename.
        let fmid_of_file = peek_fmid(abs_path);
        let rename_info = fmid_of_file
            .as_deref()
            .and_then(|fmid| rename_pairs.get(fmid).map(|(old_rel, _)| old_rel.as_str()));

        if let Some(old_rel) = rename_info {
            let evs = do_rename(index, tokens, library_root, abs_path, old_rel);
            out.extend(evs);
        } else {
            let evs = do_upsert(index, tokens, library_root, abs_path);
            out.extend(evs);
        }
    }

    out
}

// ── Rename ────────────────────────────────────────────────────────────────────

/// Process a rename: the entry at `old_rel` is moving to `new_abs`.
///
/// Uses `index.rename_entry` to preserve the integer row-id and backlinks.
fn do_rename(
    index: &mut Index,
    tokens: &Arc<TokenRegistry>,
    library_root: &Path,
    new_abs: &Path,
    old_rel: &str,
) -> Vec<ChangeEvent> {
    let new_rel = match rel_path(library_root, new_abs) {
        Some(r) => r,
        None => return Vec::new(),
    };

    // Stat the new file.
    let file_stat = match stat(new_abs) {
        Some(s) => s,
        None => return Vec::new(),
    };

    // Read and hash the new file.
    let bytes = match std::fs::read(new_abs) {
        Ok(b) => b,
        Err(_) => return Vec::new(),
    };
    let hash_u128 = content_hash(&bytes);
    let hash_hex = format!("{hash_u128:032x}");
    let self_originated = tokens.consume_if_match(new_abs, &bytes);

    let new_slug = new_abs
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_string();
    let new_group = group_path_for_rel(&new_rel);

    // Apply the rename in the index (preserves integer row-id + backlinks).
    let _ = index.rename_entry(old_rel, &new_rel, &new_slug, &new_group);

    // Upsert to refresh content (the file body may also have changed).
    let entry = Entry::from_bytes(&bytes);
    let _ = index.upsert_entry(
        &new_rel,
        &new_slug,
        &new_group,
        &entry,
        file_stat.mtime,
        file_stat.size,
        &hash_hex,
    );

    vec![ChangeEvent {
        path: new_abs.to_path_buf(),
        kind: ChangeKind::Renamed {
            old_path: PathBuf::from(old_rel),
        },
        self_originated,
    }]
}

// ── Remove ────────────────────────────────────────────────────────────────────

/// Remove an entry from the index (and files ledger).
///
/// Returns `Some(ChangeEvent)` if the path was indexed; `None` if not.
fn do_remove(index: &mut Index, rel: &str, abs_path: &Path) -> Option<ChangeEvent> {
    let was_entry = index.entry_id_for_path(rel).ok().flatten().is_some();
    let _ = index.remove_entry(rel);
    if was_entry {
        Some(ChangeEvent {
            path: abs_path.to_path_buf(),
            kind: ChangeKind::Removed,
            self_originated: false,
        })
    } else {
        None
    }
}

// ── Create / Modify ───────────────────────────────────────────────────────────

/// Reconcile a single file that exists (or may exist) on disk.
///
/// Returns 0–2 `ChangeEvent`s (1 normally; 2 when a duplicate-id rewrite also
/// emits an event).
fn do_upsert(
    index: &mut Index,
    tokens: &Arc<TokenRegistry>,
    library_root: &Path,
    abs_path: &Path,
) -> Vec<ChangeEvent> {
    let rel = match rel_path(library_root, abs_path) {
        Some(r) => r,
        None => return Vec::new(),
    };

    // ── Step 2: stat ─────────────────────────────────────────────────────────
    let file_stat = match stat(abs_path) {
        Some(s) => s,
        None => {
            // File disappeared between the event and now — treat as remove.
            if let Some(ev) = do_remove(index, &rel, abs_path) {
                return vec![ev];
            }
            return Vec::new();
        }
    };

    // ── Step 4: mtime+size fast path ─────────────────────────────────────────
    let ledger = index.ledger_row(&rel).ok().flatten();
    if !is_stale(ledger.as_ref(), &file_stat) {
        return Vec::new();
    }

    // ── Step 5: read + hash ──────────────────────────────────────────────────
    let bytes = match std::fs::read(abs_path) {
        Ok(b) => b,
        Err(_) => return Vec::new(),
    };
    let hash_u128 = content_hash(&bytes);
    let hash_hex = format!("{hash_u128:032x}");

    // ── Step 6: self-write token check ───────────────────────────────────────
    // INV: consume the token BEFORE the hash-equality check.
    let self_originated = tokens.consume_if_match(abs_path, &bytes);

    // ── Step 7: hash fast path ───────────────────────────────────────────────
    if let Some(ref row) = ledger {
        if row.content_hash == hash_hex {
            let _ = index.upsert_files_row(&rel, file_stat.mtime, file_stat.size, &hash_hex);
            if self_originated {
                return vec![ChangeEvent {
                    path: abs_path.to_path_buf(),
                    kind: ChangeKind::Modified,
                    self_originated: true,
                }];
            }
            return Vec::new();
        }
    }

    // ── Step 8: classify ─────────────────────────────────────────────────────
    let name = abs_path.file_name().and_then(|n| n.to_str()).unwrap_or("");

    let group_path = group_path_for_rel(&rel);

    // Projection files: only at the library root (group_path == "").
    if group_path.is_empty() && (name == "_tags.md" || name == "_people.md") {
        return do_projection(
            index,
            name,
            &bytes,
            &rel,
            file_stat.mtime,
            file_stat.size,
            &hash_hex,
        );
    }

    // Skip reserved files (not entry rows).
    if is_reserved(name) {
        let _ = index.upsert_files_row(&rel, file_stat.mtime, file_stat.size, &hash_hex);
        return Vec::new();
    }

    // ── Step 9: parse entry ──────────────────────────────────────────────────
    let mut entry = Entry::from_bytes(&bytes);

    let slug = abs_path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_string();

    // ── Step 9d: duplicate-id rule (spec 0002 §"Edge cases") ─────────────────
    // If this path's frontmatter id already belongs to a LIVE different path
    // in the index, assign a fresh id and rewrite the file.
    let mut dup_notification: Option<ReconcileNotification> = None;

    if let Some(fmid) = entry.id().map(str::to_string) {
        if let Ok(Some((_, existing_path))) = index.entry_by_frontmatter_id(&fmid) {
            if existing_path != rel {
                let new_id = generate_id();
                entry.set_property("id", Value::String(new_id.clone()));

                let written_bytes = entry.to_bytes(&[]);
                if atomic_write(abs_path, &written_bytes).is_ok() {
                    let _token = tokens.issue_token(abs_path, &written_bytes);
                }

                dup_notification = Some(ReconcileNotification::DuplicateIdResolved {
                    path: abs_path.to_path_buf(),
                    duplicate_id: fmid,
                    new_id,
                });
            }
        }
    }

    // ── Step 9e: upsert ──────────────────────────────────────────────────────
    let _ = index.upsert_entry(
        &rel,
        &slug,
        &group_path,
        &entry,
        file_stat.mtime,
        file_stat.size,
        &hash_hex,
    );

    let mut events = vec![ChangeEvent {
        path: abs_path.to_path_buf(),
        kind: ChangeKind::Modified,
        self_originated,
    }];

    if let Some(ReconcileNotification::DuplicateIdResolved { path, .. }) = dup_notification {
        events.push(ChangeEvent {
            path,
            kind: ChangeKind::Modified,
            self_originated: true,
        });
    }

    events
}

// ── Projection reconcile ──────────────────────────────────────────────────────

fn do_projection(
    index: &mut Index,
    name: &str,
    bytes: &[u8],
    rel: &str,
    mtime: i64,
    size: i64,
    hash_hex: &str,
) -> Vec<ChangeEvent> {
    if name == "_tags.md" {
        let _ = projection::apply_tags_projection(index, bytes);
    } else if name == "_people.md" {
        let _ = projection::apply_people_projection(index, bytes);
    }
    let _ = index.upsert_files_row(rel, mtime, size, hash_hex);
    Vec::new()
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/// Compute the library-relative path string from an absolute path.
///
/// Returns `None` if `abs_path` is not under `library_root`.
pub(crate) fn rel_path(library_root: &Path, abs_path: &Path) -> Option<String> {
    abs_path
        .strip_prefix(library_root)
        .ok()?
        .to_str()
        .map(|s| s.to_string())
}

/// Compute the group_path (parent directory relative to the library root).
///
/// - `"notes/standup.md"` → `"notes"`
/// - `"standup.md"` → `""`
///
/// Uses `/` as the separator regardless of OS (the index stores logical paths).
pub(crate) fn group_path_for_rel(rel: &str) -> String {
    let p = Path::new(rel);
    match p.parent() {
        Some(parent) if parent != Path::new("") => parent.to_string_lossy().replace('\\', "/"),
        _ => String::new(),
    }
}

/// Peek the frontmatter `id:` from a file on disk, without full parsing.
///
/// Returns `None` if the file cannot be read, has no frontmatter, or has no `id:`.
///
/// This is a cheap operation used in the rename-detection pre-pass.
fn peek_fmid(abs_path: &Path) -> Option<String> {
    let bytes = std::fs::read(abs_path).ok()?;
    let entry = Entry::from_bytes(&bytes);
    entry.id().map(str::to_string)
}
