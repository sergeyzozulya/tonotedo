// Trash module — spec docs/spec/0002-entries.md (Lifecycle: deletion is trash-bin),
// docs/spec/0003-groups.md (Delete group → .tonotedo/trash/),
// docs/tech/adr-0001-storage-format.md (.tonotedo/ contents).
//
// ## Layout
//
//   <library_root>/.tonotedo/trash/<trash_id>/
//       manifest.json     — JSON sidecar (original relative path, trashed_at, kind)
//       <file or folder>  — the trashed item, moved verbatim
//
// A unique ULID-based `trash_id` per operation means repeatedly trashing the
// same-named item never collides in the trash directory.
//
// ## Public surface
//
//   trash_entry(library_root, rel_path)  → trash_id
//   trash_group(library_root, rel_path)  → trash_id
//   list_trash(library_root)             → Vec<TrashManifest>, newest first
//   restore(library_root, trash_id)      → RestoreOutcome
//   purge(library_root, trash_id)        → ()
//   purge_all(library_root)              → ()

mod manifest;
mod ops;

pub use manifest::{TrashKind, TrashManifest};
pub use ops::{
    list_trash, purge, purge_all, restore, trash_entry, trash_group, RestoreOutcome, TrashError,
};
