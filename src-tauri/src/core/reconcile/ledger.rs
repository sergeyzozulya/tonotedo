// Reconciliation ledger helpers.
//
// The `files` table in the index is the ledger: one row per `.md` file,
// recording (mtime, size, content_hash).  The reconciler uses it to detect
// whether a file needs re-parsing on the fast path (mtime+size unchanged →
// skip hash; hash unchanged → skip re-parse).
//
// `LedgerRow` is defined in `core::index` to avoid a circular dependency
// (index does not depend on reconcile, but reconcile depends on index).
//
// INV (ledger freshness): the ledger row is updated as part of `upsert_entry`
// inside `Index::upsert_entry` (transactionally with all derived rows).
// A removal deletes the `files` row via `Index::remove_entry`.
// Therefore: a `files` row exists iff the index has an up-to-date view of
// that file.

use std::path::Path;

pub use crate::core::index::LedgerRow;

/// Stat result from the filesystem.
#[derive(Debug, Clone)]
pub struct FileStat {
    /// Modification time in seconds since Unix epoch.
    pub mtime: i64,
    /// File size in bytes.
    pub size: i64,
}

/// Read (mtime, size) from the OS for an absolute path.
///
/// Returns `None` if the file does not exist or cannot be stat'd.
pub fn stat(abs_path: &Path) -> Option<FileStat> {
    use std::os::unix::fs::MetadataExt;
    let meta = std::fs::metadata(abs_path).ok()?;
    Some(FileStat {
        mtime: meta.mtime(),
        size: meta.size() as i64,
    })
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
