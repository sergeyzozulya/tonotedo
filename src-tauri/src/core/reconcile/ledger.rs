// Reconciliation ledger helpers.
//
// The `files` table in the index is the ledger: one row per `.md` file,
// recording (mtime, size, content_hash, pending).  The reconciler uses it to
// detect whether a file needs re-parsing on the fast path (mtime+size unchanged
// → skip hash; hash unchanged → skip re-parse).
//
// `LedgerRow` is defined in `core::index` to avoid a circular dependency
// (index does not depend on reconcile, but reconcile depends on index).
//
// INV (ledger freshness): the ledger row is updated as part of `upsert_entry`
// inside `Index::upsert_entry` (transactionally with all derived rows).
// A removal deletes the `files` row via `Index::remove_entry`.
// Therefore: a `files` row exists iff the index has an up-to-date view of
// that file.
//
// ## Cloud placeholder detection (issue #29, item 1)
//
// A cloud placeholder ("dataless") file exists on disk but its content has been
// evicted by the sync provider (iCloud, Dropbox, etc.).  Detecting this reliably
// requires a platform-specific check:
//
// **macOS** (authoritative): `st_flags & SF_DATALESS` (0x40000000).  This is the
// kernel-level flag set by the iCloud/APFS driver when the data has been evicted.
// Available via `std::os::unix::fs::MetadataExt::flags()`.  The constant value
// `0x40000000` is confirmed in macOS SDK `<sys/stat.h>` as `SF_DATALESS`; it is
// a system/superuser flag (SF_*), not a user flag (UF_*).  The UF_TRACKED flag
// (0x00000040) is a different, unrelated flag.
//
// **Cross-platform heuristic** (non-macOS): if `stat` reports `size > 0` but
// `read()` returns 0 bytes (or fewer bytes than reported size and all zeros), the
// file is a placeholder.  This is conservative: it may miss partial-data states,
// but it never falsely marks a normally-readable file as pending.
//
// **Limit**: the heuristic read on non-macOS causes a small I/O overhead for any
// file whose stat/read disagrees (network filesystems, sparse files, etc.).  A
// sparse file that legitimately starts with zeros will NOT be mis-detected because
// we compare `bytes_read < size` AND `all_zeros` together; a sparse file with
// non-zero content anywhere in the buffer will pass.  Files truncated by a crash
// are not placeholder-detectable by this heuristic and will be re-indexed normally.
//
// **Mobile parity**: on iOS the same `SF_DATALESS` flag (APFS) applies.  Android
// SAF-backed files do not have this concept; the heuristic is the fallback there.

use std::path::Path;

pub use crate::core::index::LedgerRow;

/// Stat result from the filesystem.
#[derive(Debug, Clone)]
pub struct FileStat {
    /// Modification time in seconds since Unix epoch.
    pub mtime: i64,
    /// File size in bytes (as reported by `stat`).
    pub size: i64,
    /// Whether this file is a cloud placeholder (evicted/dataless content).
    pub is_placeholder: bool,
}

/// Read (mtime, size, is_placeholder) from the OS for an absolute path.
///
/// Returns `None` if the file does not exist or cannot be stat'd.
pub fn stat(abs_path: &Path) -> Option<FileStat> {
    use std::os::unix::fs::MetadataExt;

    let meta = std::fs::metadata(abs_path).ok()?;
    let mtime = meta.mtime();
    let size = meta.size() as i64;

    let is_placeholder = detect_placeholder(abs_path, &meta, size);

    Some(FileStat {
        mtime,
        size,
        is_placeholder,
    })
}

/// Detect whether `abs_path` is a cloud placeholder (evicted/dataless file).
///
/// Returns `true` when the file exists on disk but its content is not locally
/// available.  See the module-level comment for the detection strategy.
fn detect_placeholder(abs_path: &Path, meta: &std::fs::Metadata, stat_size: i64) -> bool {
    // ── macOS: authoritative SF_DATALESS flag check ──────────────────────────
    #[cfg(target_os = "macos")]
    {
        use std::os::macos::fs::MetadataExt;
        // SF_DATALESS = 0x40000000 per macOS SDK <sys/stat.h>.
        // `st_flags()` returns the `st_flags` bitmask (file-system flags).
        // This is a superuser/system flag (SF_*) set by the APFS/iCloud driver
        // when the file's data has been evicted from local storage.
        // UF_TRACKED (0x00000040) is a different, unrelated flag — confirmed.
        const SF_DATALESS: u32 = 0x4000_0000;
        if meta.st_flags() & SF_DATALESS != 0 {
            return true;
        }
    }

    // ── Cross-platform heuristic ─────────────────────────────────────────────
    // stat says the file has content, but reading it yields 0 bytes or all-zero
    // bytes fewer than stat_size → provider placeholder.
    //
    // Only run when stat_size > 0 to avoid false positives on genuinely empty
    // files (which are not placeholders — they just have no content yet).
    #[cfg(not(target_os = "macos"))]
    let _ = meta; // suppress unused warning on non-macOS

    if stat_size > 0 {
        match std::fs::read(abs_path) {
            Ok(bytes) if bytes.is_empty() => return true,
            Ok(bytes) if (bytes.len() as i64) < stat_size && bytes.iter().all(|&b| b == 0) => {
                return true
            }
            _ => {}
        }
    }

    false
}

/// Whether the on-disk file is stale relative to the ledger.
///
/// Returns `true` when the file needs to be re-hashed (mtime or size changed,
/// or the path is not yet in the ledger).
pub fn is_stale(ledger: Option<&LedgerRow>, stat: &FileStat) -> bool {
    match ledger {
        None => true, // not yet indexed
        Some(row) => row.mtime != stat.mtime || row.size != stat.size,
    }
}
