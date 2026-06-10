// Change events emitted by the reconciler to downstream consumers.
//
// Design reference: design-0001 §"Interfaces":
//   "Emit coalesced change events (define `ChangeEvent { paths, kinds,
//    self_originated }` on a crossbeam/std mpsc channel) — no IPC wiring."
//
// INV (event semantics): every reconcile action produces at most one ChangeEvent.
// The `self_originated` flag is set when a token was consumed (the file change
// was caused by an in-app write), so the originating view can suppress its echo
// while OTHER views still refresh.

use std::path::PathBuf;

/// The kind of change that caused a `ChangeEvent`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ChangeKind {
    /// A path that was not previously in the ledger was indexed for the first time.
    Created,
    /// An existing entry's content changed.
    Modified,
    /// An entry was removed from the library.
    Removed,
    /// An entry was renamed (same frontmatter id, different path).
    /// Preserves backlinks — the integer row-id is unchanged.
    Renamed { old_path: PathBuf },
}

/// A coalesced change event emitted after a reconcile batch.
///
/// `paths` contains the affected library-relative path(s).
/// `self_originated` is true when the change was caused by an in-app write
/// (token consumed via `TokenRegistry::consume_if_match`).
#[derive(Debug, Clone)]
pub struct ChangeEvent {
    /// Library-relative path of the changed entry (or new path for renames).
    pub path: PathBuf,
    /// The kind of change.
    pub kind: ChangeKind,
    /// True when the change was caused by an in-app write (self-write token matched).
    /// The originating view should suppress its echo; other views still refresh.
    pub self_originated: bool,
}

/// Non-entry notifications emitted by the reconciler.
#[derive(Debug, Clone)]
pub enum ReconcileNotification {
    /// A file's id was already in use by a different live path;
    /// the new file was assigned a fresh id (spec 0002 §"Duplicate ids").
    DuplicateIdResolved {
        /// Library-relative path of the file that received the new id.
        path: PathBuf,
        /// The duplicate id that was already in use.
        duplicate_id: String,
        /// The fresh id assigned to the newcomer.
        new_id: String,
    },
    /// The projection file `_tags.md` was re-parsed and `tag_meta` updated.
    TagMetaUpdated,
    /// The projection file `_people.md` was re-parsed and `people` updated.
    PeopleUpdated,
}
