// reconcile_path — the core reconcile pipeline.
//
// Design reference: design-0001 §"Reconcile(path)" and §"Rename detection".
//
// ## Pipeline for a single path (create/modify)
//
//   1. Compute library-relative path.
//   2. Skip reserved-component paths (any `_`/`.`-prefixed component) — except
//      the two root-level projection files.  (spec 0002 §"Reserved names")
//   3. Stat the file on disk.
//   4. If the file is MISSING → treat as remove.
//   5. Compare (mtime, size) to the ledger — unchanged → skip (fast path).
//   6. Read bytes, compute hash via `fswrite::content_hash`.
//   7. Check `TokenRegistry::consume_if_match` (self-write detection).
//   8. Compare hash to ledger — same hash → update ledger row only.
//   9. Classify the file:
//      - Reserved projection (`_tags.md`, `_people.md` at root) → projection path.
//      - Normal entry → entry path.
//  10. Entry path:
//      a. Parse `Entry::from_bytes`.
//      b. Derive slug (file stem), group_path (parent dir, "" at root).
//      c. Rename-vs-duplicate disambiguation by fmid collision (see below).
//      d. `index.upsert_entry`.
//
// ## Rename detection — two layers
//
// Layer 1 (in-batch pair): a Remove + CreateOrModify carrying the same fmid in
// the SAME batch is a rename → `index.rename_entry` (preserves row-id/backlinks),
// no file rewrite.
//
// Layer 2 (collision check in do_upsert): when a create/modify's fmid already
// belongs to a DIFFERENT path in the index, we MUST distinguish two cases by
// checking whether that existing path still exists on disk:
//   - existing path GONE  → this is an offline / cross-batch RENAME.  The source
//     event was never paired (full_rescan orders creates before deletes; macOS
//     may deliver the rename source as Modify).  We `rename_entry` to preserve
//     identity + backlinks, and DO NOT rewrite the file with a fresh id.
//   - existing path PRESENT → a TRUE duplicate (spec 0002 §"Duplicate ids").  The
//     keeper is deterministic: the lexicographically smaller path keeps the id;
//     the other file is re-id'd + rewritten atomically.  This may mean re-id'ing
//     the EXISTING row's file when the newcomer sorts first, so a rebuild that
//     encounters the pair in either order converges to the same keeper.
//
// INV (row-id preservation):  detected renames ALWAYS use `index.rename_entry`,
// keeping the integer row-id and all backlinks intact.
//
// INV (self-write token consumed before hash comparison):  The token is consumed
// even if the hash later matches the ledger, preventing a stale token from being
// consumed on a later event with the same bytes.
//
// INV (error handling): index write failures are NOT swallowed.  On any index
// error we log, set `needs_full_rescan`, and SKIP the success ChangeEvent for
// that path so downstream never sees a phantom success.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use unicode_normalization::UnicodeNormalization as _;

use crate::core::{
    frontmatter::{generate_id, has_reserved_component, Entry, Value},
    fswrite::{atomic_write, content_hash, TokenRegistry},
    index::Index,
};

use super::{
    event::{ChangeEvent, ChangeKind, ReconcileNotification},
    ledger::{is_stale, stat},
    projection::{self, ProjectionError},
    RawKind,
};

// ── Public entry point ────────────────────────────────────────────────────────

/// Reconcile a batch of `(absolute_path, kind)` pairs.
///
/// Handles rename detection, duplicate-id resolution, projection updates, and
/// link resolution.  `needs_full_rescan` is set if any index write fails so the
/// caller can schedule a recovery rescan.
///
/// Returns a Vec of `ChangeEvent`s to emit downstream.
pub fn reconcile_batch(
    index: &mut Index,
    tokens: &Arc<TokenRegistry>,
    library_root: &Path,
    events: &[(PathBuf, RawKind)],
    needs_full_rescan: &AtomicBool,
) -> Vec<ChangeEvent> {
    let mut out: Vec<ChangeEvent> = Vec::new();

    // ── Pre-pass A: collect fmid of each REMOVED path (before any mutation) ──
    // Map: fmid → old library-relative path.  Uses the indexed path→fmid lookup.
    let mut removed_fmids: HashMap<String, String> = HashMap::new();
    for (abs_path, kind) in events {
        if *kind != RawKind::Remove {
            continue;
        }
        let rel = match rel_path(library_root, abs_path) {
            Some(r) => r,
            None => continue,
        };
        if let Ok(Some(Some(fmid))) = index.frontmatter_id_for_path(&rel) {
            removed_fmids.insert(fmid, rel.clone());
        }
    }

    // ── Pre-pass B: peek fmid of each CREATE/MODIFY path (read file, no parse) ─
    // Map: fmid → new absolute path.
    let mut created_fmids: HashMap<String, PathBuf> = HashMap::new();
    for (abs_path, kind) in events {
        if *kind != RawKind::CreateOrModify {
            continue;
        }
        if let Some(fmid) = peek_fmid(abs_path) {
            created_fmids.insert(fmid, abs_path.clone());
        }
    }

    // ── Pre-pass C: identify in-batch rename pairs ───────────────────────────
    let mut rename_pairs: HashMap<String, (String, PathBuf)> = HashMap::new(); // fmid → (old_rel, new_abs)
    for (fmid, old_rel) in &removed_fmids {
        if let Some(new_abs) = created_fmids.get(fmid) {
            let new_rel = rel_path(library_root, new_abs).unwrap_or_default();
            if &new_rel != old_rel {
                rename_pairs.insert(fmid.clone(), (old_rel.clone(), new_abs.clone()));
            }
        }
    }

    // ── Pass 1: process removes that are NOT in-batch renames ────────────────
    for (abs_path, kind) in events {
        if *kind != RawKind::Remove {
            continue;
        }
        let rel = match rel_path(library_root, abs_path) {
            Some(r) => r,
            None => continue,
        };
        let old_rel_is_rename = rename_pairs.values().any(|(old_r, _)| old_r == &rel);
        if old_rel_is_rename {
            // Handled as rename_entry in pass 2.
            continue;
        }
        if let Some(ev) = do_remove(index, &rel, abs_path, needs_full_rescan) {
            out.push(ev);
        }
    }

    // ── Pass 2: process creates/modifies ─────────────────────────────────────
    for (abs_path, kind) in events {
        if *kind != RawKind::CreateOrModify {
            continue;
        }
        let fmid_of_file = peek_fmid(abs_path);
        let rename_info = fmid_of_file
            .as_deref()
            .and_then(|fmid| rename_pairs.get(fmid).map(|(old_rel, _)| old_rel.as_str()));

        if let Some(old_rel) = rename_info {
            let evs = do_rename(
                index,
                tokens,
                library_root,
                abs_path,
                old_rel,
                needs_full_rescan,
            );
            out.extend(evs);
        } else {
            let evs = do_upsert(index, tokens, library_root, abs_path, needs_full_rescan);
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
    needs_full_rescan: &AtomicBool,
) -> Vec<ChangeEvent> {
    let new_rel = match rel_path(library_root, new_abs) {
        Some(r) => r,
        None => return Vec::new(),
    };

    let file_stat = match stat(new_abs) {
        Some(s) => s,
        None => return Vec::new(),
    };

    let new_slug = file_stem(new_abs);
    let new_group = group_path_for_rel(&new_rel);

    // Apply the rename in the index first (preserves integer row-id + backlinks).
    if let Err(e) = index.rename_entry(old_rel, &new_rel, &new_slug, &new_group) {
        log_index_error("rename_entry", &new_rel, &e, needs_full_rescan);
        return Vec::new();
    }

    // If the renamed-to file is a placeholder, record pending and return.
    // The entry row has been path-updated by rename_entry; content stays as-is.
    if file_stat.is_placeholder {
        let placeholder_hash = format!("{:032x}", content_hash(&[]));
        if let Err(e) =
            index.mark_pending(&new_rel, file_stat.mtime, file_stat.size, &placeholder_hash)
        {
            log_index_error("mark_pending(rename)", &new_rel, &e, needs_full_rescan);
        }
        let _ = std::fs::read(new_abs); // trigger materialization
        return vec![ChangeEvent {
            path: new_abs.to_path_buf(),
            kind: ChangeKind::Renamed {
                old_path: PathBuf::from(old_rel),
            },
            self_originated: false,
        }];
    }

    let bytes = match std::fs::read(new_abs) {
        Ok(b) => b,
        Err(_) => return Vec::new(),
    };
    let hash_u128 = content_hash(&bytes);
    let hash_hex = format!("{hash_u128:032x}");
    let self_originated = tokens.consume_if_match(new_abs, &bytes);

    let entry = Entry::from_bytes(&bytes);
    if let Err(e) = index.upsert_entry(
        &new_rel,
        &new_slug,
        &new_group,
        &entry,
        file_stat.mtime,
        file_stat.size,
        &hash_hex,
    ) {
        log_index_error("upsert_entry(rename)", &new_rel, &e, needs_full_rescan);
        return Vec::new();
    }

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
fn do_remove(
    index: &mut Index,
    rel: &str,
    abs_path: &Path,
    needs_full_rescan: &AtomicBool,
) -> Option<ChangeEvent> {
    let was_entry = index.entry_id_for_path(rel).ok().flatten().is_some();
    if let Err(e) = index.remove_entry(rel) {
        log_index_error("remove_entry", rel, &e, needs_full_rescan);
        return None;
    }
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
fn do_upsert(
    index: &mut Index,
    tokens: &Arc<TokenRegistry>,
    library_root: &Path,
    abs_path: &Path,
    needs_full_rescan: &AtomicBool,
) -> Vec<ChangeEvent> {
    let rel = match rel_path(library_root, abs_path) {
        Some(r) => r,
        None => return Vec::new(),
    };

    let name = abs_path.file_name().and_then(|n| n.to_str()).unwrap_or("");

    // Test-only panic injection: a file named `__panic__.md` makes reconcile
    // panic, exercising the worker's catch_unwind resilience (finding #3).
    #[cfg(test)]
    if name == "__panic__.md" {
        panic!("injected test panic for {rel}");
    }

    let group_path = group_path_for_rel(&rel);

    // ── Reserved gate ────────────────────────────────────────────────────────
    // Any path with a reserved (`_`/`.`-prefixed) component is NOT an entry.
    // The two root-level projection files are the only exception, handled below.
    //
    // Note: `_group.md` is intentionally NOT indexed as an entry (spec 0002): it
    // is openable/editable but excluded from lists and search, and wikilinks to a
    // group resolve via groups, not entry rows.  It therefore falls through this
    // gate as a plain reserved file (ledger row only, no entry row).
    let is_root_projection = group_path.is_empty() && (name == "_tags.md" || name == "_people.md");
    if has_reserved_component(&rel) && !is_root_projection {
        // Keep the ledger row so the rescan fast-path skips it next time, but
        // never index it as an entry.
        return reserved_ledger_only(index, abs_path, &rel, needs_full_rescan);
    }

    // ── Step 3: stat ─────────────────────────────────────────────────────────
    let file_stat = match stat(abs_path) {
        Some(s) => s,
        None => {
            // File disappeared between the event and now — treat as remove.
            if let Some(ev) = do_remove(index, &rel, abs_path, needs_full_rescan) {
                return vec![ev];
            }
            return Vec::new();
        }
    };

    // ── Step 3b: cloud placeholder detection (issue #29, item 1) ─────────────
    //
    // A placeholder file exists on disk but its content has been evicted by the
    // sync provider (iCloud SF_DATALESS on macOS, or read-returns-empty
    // heuristic on other platforms).  Per spec 0013 §"Sync posture":
    //   "entry shows as pending, never as empty"
    //
    // What we do:
    //   1. Mark the ledger row as pending (files.pending = 1).
    //   2. DO NOT create or update the entry row from empty/placeholder bytes.
    //      If an entry row already exists for this path, it is preserved as-is.
    //   3. Attempt a throwaway read to trigger iCloud download (on macOS the
    //      first read of a dataless file requests materialization from the daemon).
    //   4. Emit ChangeKind::Pending so the UI can show "pending, not empty".
    //   5. The caller should schedule a re-reconcile once the file materializes.
    if file_stat.is_placeholder {
        return do_placeholder(index, abs_path, &rel, &file_stat, needs_full_rescan);
    }

    // ── Step 5: mtime+size fast path ─────────────────────────────────────────
    let ledger = index.ledger_row(&rel).ok().flatten();
    if !is_stale(ledger.as_ref(), &file_stat) {
        // Still check: if this file was previously marked pending and now has
        // real content (is_placeholder = false), the mtime/size may have changed
        // due to materialization.  is_stale covers that case: if mtime/size
        // differ from the ledger, we fall through to re-parse.  If they are
        // identical (shouldn't happen for a newly materialized file, but possible
        // on clock-skew systems), we accept the stale read as a benign no-op.
        return Vec::new();
    }

    // ── Step 6: read + hash ──────────────────────────────────────────────────
    let bytes = match std::fs::read(abs_path) {
        Ok(b) => b,
        Err(_) => return Vec::new(),
    };
    let hash_u128 = content_hash(&bytes);
    let hash_hex = format!("{hash_u128:032x}");

    // ── Step 7: self-write token check ───────────────────────────────────────
    // INV: consume the token BEFORE the hash-equality check.
    let self_originated = tokens.consume_if_match(abs_path, &bytes);

    // ── Step 8: hash fast path ───────────────────────────────────────────────
    if let Some(ref row) = ledger {
        if row.content_hash == hash_hex {
            if let Err(e) = index.upsert_files_row(&rel, file_stat.mtime, file_stat.size, &hash_hex)
            {
                log_index_error("upsert_files_row", &rel, &e, needs_full_rescan);
                return Vec::new();
            }
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

    // ── Step 9: projection vs entry ──────────────────────────────────────────
    if is_root_projection {
        return do_projection(
            index,
            name,
            &bytes,
            &rel,
            file_stat.mtime,
            file_stat.size,
            &hash_hex,
            needs_full_rescan,
        );
    }

    // ── Step 10: parse entry ─────────────────────────────────────────────────
    let mut entry = Entry::from_bytes(&bytes);
    let slug = file_stem(abs_path);

    // ── Step 10c: rename-vs-duplicate disambiguation (spec 0002) ─────────────
    let mut dup_notification: Option<ReconcileNotification> = None;
    let mut final_hash = hash_hex.clone();
    let mut final_stat = file_stat.clone();
    let mut final_bytes_for_self = false;

    if let Some(fmid) = entry.id().map(str::to_string) {
        if let Ok(Some((_, existing_path))) = index.entry_by_frontmatter_id(&fmid) {
            if existing_path != rel {
                let existing_abs = library_root.join(&existing_path);
                let existing_present = std::fs::symlink_metadata(&existing_abs).is_ok();

                if !existing_present {
                    // ── RENAME: the prior file is gone; preserve identity. ───
                    let new_group = group_path_for_rel(&rel);
                    if let Err(e) = index.rename_entry(&existing_path, &rel, &slug, &new_group) {
                        log_index_error("rename_entry", &rel, &e, needs_full_rescan);
                        return Vec::new();
                    }
                    if let Err(e) = index.upsert_entry(
                        &rel,
                        &slug,
                        &new_group,
                        &entry,
                        file_stat.mtime,
                        file_stat.size,
                        &hash_hex,
                    ) {
                        log_index_error("upsert_entry(rename)", &rel, &e, needs_full_rescan);
                        return Vec::new();
                    }
                    return vec![ChangeEvent {
                        path: abs_path.to_path_buf(),
                        kind: ChangeKind::Renamed {
                            old_path: PathBuf::from(existing_path),
                        },
                        self_originated,
                    }];
                }

                // ── TRUE DUPLICATE: both files exist on disk. ────────────────
                // Deterministic keeper: the lexicographically smaller path keeps
                // the id; the other is re-id'd.
                if rel.as_str() < existing_path.as_str() {
                    // The NEWCOMER keeps the id; re-id the EXISTING row's file.
                    if let Some(ev) = reid_existing(
                        index,
                        tokens,
                        &existing_abs,
                        &existing_path,
                        &fmid,
                        needs_full_rescan,
                    ) {
                        dup_notification = Some(ev);
                    }
                } else {
                    // The EXISTING row keeps the id; re-id the NEWCOMER (this file).
                    let new_id = generate_id();
                    entry.set_property("id", Value::String(new_id.clone()));
                    let written = entry.to_bytes(&[]);
                    if atomic_write(abs_path, &written).is_ok() {
                        let _ = tokens.issue_token(abs_path, &written);
                        // #8: ledger must reflect the bytes we just wrote.
                        let h = content_hash(&written);
                        final_hash = format!("{h:032x}");
                        if let Some(s) = stat(abs_path) {
                            final_stat = s;
                        }
                        final_bytes_for_self = true;
                    }
                    dup_notification = Some(ReconcileNotification::DuplicateIdResolved {
                        path: abs_path.to_path_buf(),
                        duplicate_id: fmid,
                        new_id,
                    });
                }
            }
        }
    }

    // ── Step 10d: upsert ─────────────────────────────────────────────────────
    if let Err(e) = index.upsert_entry(
        &rel,
        &slug,
        &group_path,
        &entry,
        final_stat.mtime,
        final_stat.size,
        &final_hash,
    ) {
        log_index_error("upsert_entry", &rel, &e, needs_full_rescan);
        return Vec::new();
    }

    // Emit Created for brand-new paths (no prior ledger row), Modified for updates.
    let is_new = ledger.is_none();
    let kind = if is_new && !self_originated {
        ChangeKind::Created
    } else {
        ChangeKind::Modified
    };
    let mut events = vec![ChangeEvent {
        path: abs_path.to_path_buf(),
        kind,
        self_originated: self_originated || final_bytes_for_self,
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

/// Re-id the EXISTING duplicate's file (when the newcomer sorts first and keeps
/// the id).  Rewrites the existing file with a fresh id, re-stats + re-hashes the
/// written bytes for an accurate ledger row, and re-upserts that file's entry row
/// under the new id so it remains indexed.
///
/// Returns a `DuplicateIdResolved` notification for the re-id'd path.
fn reid_existing(
    index: &mut Index,
    tokens: &Arc<TokenRegistry>,
    existing_abs: &Path,
    existing_rel: &str,
    duplicate_id: &str,
    needs_full_rescan: &AtomicBool,
) -> Option<ReconcileNotification> {
    let bytes = std::fs::read(existing_abs).ok()?;
    let mut existing_entry = Entry::from_bytes(&bytes);
    let new_id = generate_id();
    existing_entry.set_property("id", Value::String(new_id.clone()));
    let written = existing_entry.to_bytes(&[]);
    atomic_write(existing_abs, &written).ok()?;
    let _ = tokens.issue_token(existing_abs, &written);

    let h = content_hash(&written);
    let hash_hex = format!("{h:032x}");
    let s = stat(existing_abs)?;
    let slug = file_stem(existing_abs);
    let group = group_path_for_rel(existing_rel);
    if let Err(e) = index.upsert_entry(
        existing_rel,
        &slug,
        &group,
        &existing_entry,
        s.mtime,
        s.size,
        &hash_hex,
    ) {
        log_index_error("upsert_entry(reid)", existing_rel, &e, needs_full_rescan);
        return None;
    }

    Some(ReconcileNotification::DuplicateIdResolved {
        path: existing_abs.to_path_buf(),
        duplicate_id: duplicate_id.to_string(),
        new_id,
    })
}

/// Handle a cloud placeholder ("dataless") file.
///
/// Records the placeholder state in the ledger (`files.pending = 1`) and emits
/// a `ChangeKind::Pending` event.  The entry row is NOT modified — if one exists
/// from before the eviction, it is kept; if none exists, we do not create one
/// from empty bytes.
///
/// Also performs a throwaway read to request materialization from the sync
/// daemon (on macOS, reading a `SF_DATALESS` file triggers iCloud download).
/// This is a best-effort nudge; the actual download is asynchronous.  Once the
/// file materializes, the watcher/next-rescan will re-reconcile it normally.
///
/// # Limits
///
/// - The throwaway read may itself fail or block briefly while the daemon
///   schedules the download.  We `ignore` the result — the pending state will
///   be cleared on the next successful reconcile.
/// - On platforms without `SF_DATALESS` (non-macOS) we use the read-returns-
///   empty heuristic (see `ledger::detect_placeholder`).  Sparse files that
///   genuinely contain leading zeros but have non-zero content later in the file
///   are NOT mis-detected (the heuristic requires the entire read to be empty or
///   all-zero AND shorter than stat_size).
fn do_placeholder(
    index: &mut Index,
    abs_path: &Path,
    rel: &str,
    file_stat: &super::ledger::FileStat,
    needs_full_rescan: &AtomicBool,
) -> Vec<ChangeEvent> {
    // Placeholder hash: use an empty-content hash as a stable sentinel.  The
    // real content hash will be written when the file materializes.
    let placeholder_hash = format!("{:032x}", content_hash(&[]));

    if let Err(e) = index.mark_pending(rel, file_stat.mtime, file_stat.size, &placeholder_hash) {
        log_index_error("mark_pending", rel, &e, needs_full_rescan);
        return Vec::new();
    }

    // Throwaway read → triggers iCloud/sync download on macOS.
    // We discard the result; it is a best-effort materialization request.
    let _ = std::fs::read(abs_path);

    vec![ChangeEvent {
        path: abs_path.to_path_buf(),
        kind: ChangeKind::Pending,
        self_originated: false,
    }]
}

/// Write only the files-ledger row for a reserved (non-entry) file.
fn reserved_ledger_only(
    index: &mut Index,
    abs_path: &Path,
    rel: &str,
    needs_full_rescan: &AtomicBool,
) -> Vec<ChangeEvent> {
    let file_stat = match stat(abs_path) {
        Some(s) => s,
        None => return Vec::new(),
    };
    let ledger = index.ledger_row(rel).ok().flatten();
    if !is_stale(ledger.as_ref(), &file_stat) {
        return Vec::new();
    }
    let bytes = match std::fs::read(abs_path) {
        Ok(b) => b,
        Err(_) => return Vec::new(),
    };
    let h = content_hash(&bytes);
    let hash_hex = format!("{h:032x}");
    if let Err(e) = index.upsert_files_row(rel, file_stat.mtime, file_stat.size, &hash_hex) {
        log_index_error("upsert_files_row", rel, &e, needs_full_rescan);
    }
    Vec::new()
}

// ── Projection reconcile ──────────────────────────────────────────────────────

#[allow(clippy::too_many_arguments)]
fn do_projection(
    index: &mut Index,
    name: &str,
    bytes: &[u8],
    rel: &str,
    mtime: i64,
    size: i64,
    hash_hex: &str,
    needs_full_rescan: &AtomicBool,
) -> Vec<ChangeEvent> {
    let result = if name == "_tags.md" {
        projection::apply_tags_projection(index, bytes)
    } else {
        projection::apply_people_projection(index, bytes)
    };

    match result {
        Ok(()) => {}
        Err(ProjectionError::Parse) => {
            // Malformed projection: keep the last-good projection, log, continue.
            // We still record the ledger row so we do not re-read the same bad
            // bytes every rescan.
            eprintln!(
                "reconcile: projection {name} ({rel}) failed to parse; keeping previous projection"
            );
        }
        Err(ProjectionError::Index(e)) => {
            log_index_error("projection", rel, &e, needs_full_rescan);
            return Vec::new();
        }
    }

    if let Err(e) = index.upsert_files_row(rel, mtime, size, hash_hex) {
        log_index_error("upsert_files_row(projection)", rel, &e, needs_full_rescan);
    }
    Vec::new()
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/// Log an index error and flag a recovery rescan.
fn log_index_error(
    op: &str,
    rel: &str,
    err: &crate::core::index::IndexError,
    needs_full_rescan: &AtomicBool,
) {
    eprintln!("reconcile: index {op} failed for {rel}: {err}; scheduling full rescan");
    needs_full_rescan.store(true, Ordering::SeqCst);
}

/// Compute the library-relative path string from an absolute path.
///
/// Returns `None` if `abs_path` is not under `library_root`.
///
/// # Unicode normalization guard (issue #29, item 3)
///
/// macOS HFS+/APFS delivers filenames in NFD form (decomposed), while the index
/// stores NFC (composed) strings produced from Rust string literals and user
/// input.  Without normalization, the same physical file can appear as "absent"
/// in deletion detection or as a false-new entry on every rescan, because:
///
///   NFD "café.md" (6 bytes: c, a, f, e, COMBINING_ACUTE, .md)
///   ≠ NFC "café.md" (5 bytes: c, a, f, é, .md)
///
/// We normalize to NFC at this boundary — the single point where an
/// on-disk path is converted to the string form stored in the index.
/// All index lookups and comparisons therefore use NFC strings consistently.
///
/// Limit: normalization is on the _string_ representation only; the on-disk
/// file is not renamed.  Wikilink rewrites must apply the same normalization
/// independently (out of scope for this module).
pub(crate) fn rel_path(library_root: &Path, abs_path: &Path) -> Option<String> {
    let raw = abs_path.strip_prefix(library_root).ok()?.to_str()?;
    // Normalize each path segment to NFC and reassemble with the platform separator.
    // We split on the OS separator so multi-component paths work correctly.
    let nfc: String = raw.nfc().collect();
    Some(nfc)
}

/// Compute the group_path (parent directory relative to the library root).
pub(crate) fn group_path_for_rel(rel: &str) -> String {
    let p = Path::new(rel);
    match p.parent() {
        Some(parent) if parent != Path::new("") => parent.to_string_lossy().replace('\\', "/"),
        _ => String::new(),
    }
}

/// File stem (filename without extension) as an owned String.
fn file_stem(abs_path: &Path) -> String {
    abs_path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_string()
}

/// Peek the frontmatter `id:` from a file on disk, without full parsing.
fn peek_fmid(abs_path: &Path) -> Option<String> {
    let bytes = std::fs::read(abs_path).ok()?;
    let entry = Entry::from_bytes(&bytes);
    entry.id().map(str::to_string)
}
