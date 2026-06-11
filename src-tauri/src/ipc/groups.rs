// IPC commands for group management and trash — phase 6 (issue #28, spec 0003 audit).
//
// Commands:
//   create_group(path)          — mkdir (one level, no -p beyond parents); reserved-name check
//   rename_group(old, new)      — fs::rename; sibling-collision rejection
//   move_group(src, dst_parent) — reject circular moves; fs::rename
//   move_entry(path, dst_group) — fs::rename the .md file; id preserved
//   trash_entry(path)           — core::trash + reconcile signal
//   trash_group(path)           — core::trash + reconcile signal
//   trash_list()                — list all trash slots
//   trash_restore(id)           — restore + reconcile signal
//   trash_purge(id)             — permanent delete single slot
//
// ## Reconciler signalling
//
// The reconciler is a separate thread that watches the filesystem.  After any
// operation that moves/renames files we write a tombstone flag into
// `OpenLibrary::_reconciler_handle.needs_full_rescan` so the next reconcile
// cycle picks up the structural change.  This is coarser than emitting targeted
// events but is correct and simple; a future phase can emit finer-grained events.
//
// ## Reserved names (spec 0002)
//
// Group folder names must not start with `_` or `.` — those are reserved for
// app metadata.  `create_group` and `rename_group` enforce this.

use std::path::Path;

use serde::Serialize;
use tauri::State;

use crate::core::{
    frontmatter::{is_reserved, is_safe_rel_path},
    trash::{self, RestoreOutcome, TrashManifest},
};

use super::{AppState, IpcError};

type CmdResult<T> = Result<T, IpcError>;

/// Acquire the guard and return a typed error when no library is open.
macro_rules! require_open {
    ($state:expr) => {{
        $state
            .0
            .lock()
            .map_err(|_| IpcError::io("State lock poisoned".to_string()))?
    }};
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/// Assert that `name` (a single path component) is not reserved and contains
/// no path separators.
fn validate_group_name(name: &str) -> CmdResult<()> {
    if name.is_empty() {
        return Err(IpcError {
            code: "invalid_argument",
            message: "Group name must not be empty.".into(),
            detail: None,
        });
    }
    if name.contains('/') || name.contains('\\') {
        return Err(IpcError {
            code: "invalid_argument",
            message: format!("Group name '{name}' must be a single path component (no slashes)."),
            detail: None,
        });
    }
    if is_reserved(name) {
        return Err(IpcError {
            code: "invalid_argument",
            message: format!("Group name '{name}' is reserved (starts with '_' or '.')."),
            detail: None,
        });
    }
    Ok(())
}

/// Validate a user-supplied, library-relative path before any filesystem op.
///
/// Security (final-review F1-F3): the previous version filtered EMPTY
/// components, which silently accepted a leading-slash absolute path
/// (`/tmp/evil` -> ["","tmp","evil"] -> `root.join("/tmp/evil")` discards root).
/// Delegates to the shared `is_safe_rel_path`, which rejects absolute paths,
/// `..` traversal, empty/`//` components, and reserved components.
fn validate_rel_path(rel_path: &str) -> CmdResult<()> {
    if is_safe_rel_path(rel_path) {
        Ok(())
    } else {
        Err(IpcError {
            code: "invalid_argument",
            message: format!(
                "Unsafe path: '{rel_path}' (must be relative, no '..', no reserved names)."
            ),
            detail: None,
        })
    }
}

/// Signal the reconciler for a full rescan after a structural filesystem change.
fn signal_rescan(state: &AppState) {
    use std::sync::atomic::Ordering;
    if let Ok(guard) = state.0.lock() {
        if let Some(lib) = guard.as_ref() {
            lib._reconciler_handle
                .needs_full_rescan
                .store(true, Ordering::SeqCst);
        }
    }
}

/// True when `descendant` is equal to `ancestor` or starts with `ancestor/`.
fn is_under(ancestor: &str, descendant: &str) -> bool {
    descendant == ancestor || descendant.starts_with(&format!("{ancestor}/"))
}

// ── create_group ──────────────────────────────────────────────────────────────

/// `create_group(path)` — create a new group folder at `path` (library-relative).
///
/// Creates parent directories if they exist; rejects reserved component names.
/// Returns an error if the target already exists.
#[tauri::command]
pub fn create_group(path: String, state: State<'_, AppState>) -> CmdResult<()> {
    let guard = require_open!(state);
    let lib = guard.as_ref().ok_or_else(IpcError::not_open)?;
    create_group_inner(&lib.root, &path)?;
    drop(guard);
    signal_rescan(&state);
    Ok(())
}

pub fn create_group_inner(root: &Path, rel_path: &str) -> CmdResult<()> {
    validate_rel_path(rel_path)?;

    let abs = root.join(rel_path);
    if abs.exists() {
        return Err(IpcError {
            code: "conflict",
            message: format!("Group already exists: {rel_path}"),
            detail: None,
        });
    }
    // Ensure immediate parent exists (no deep mkdir -p; caller must create ancestors).
    if let Some(parent) = abs.parent() {
        if !parent.exists() {
            return Err(IpcError {
                code: "not_found",
                message: format!("Parent directory does not exist for: {rel_path}"),
                detail: None,
            });
        }
    }
    std::fs::create_dir(&abs)
        .map_err(|e| IpcError::io(format!("Cannot create group '{rel_path}': {e}")))?;
    Ok(())
}

// ── rename_group ──────────────────────────────────────────────────────────────

/// `rename_group(old_path, new_name)` — rename the last path component of `old_path`
/// to `new_name` (a single component, not a full path).
///
/// Rejects reserved names and sibling collisions.
#[tauri::command]
pub fn rename_group(
    old_path: String,
    new_name: String,
    state: State<'_, AppState>,
) -> CmdResult<()> {
    let guard = require_open!(state);
    let lib = guard.as_ref().ok_or_else(IpcError::not_open)?;
    rename_group_inner(&lib.root, &old_path, &new_name)?;
    drop(guard);
    signal_rescan(&state);
    Ok(())
}

pub fn rename_group_inner(root: &Path, old_path: &str, new_name: &str) -> CmdResult<()> {
    validate_rel_path(old_path)?;
    validate_group_name(new_name)?;

    let old_abs = root.join(old_path);
    if !old_abs.exists() {
        return Err(IpcError::not_found(format!("Group not found: {old_path}")));
    }
    if !old_abs.is_dir() {
        return Err(IpcError {
            code: "invalid_argument",
            message: format!("Not a directory: {old_path}"),
            detail: None,
        });
    }

    // Compute sibling path: replace last component.
    let new_rel = if let Some(slash) = old_path.rfind('/') {
        format!("{}/{}", &old_path[..slash], new_name)
    } else {
        new_name.to_string()
    };
    let new_abs = root.join(&new_rel);

    if new_abs.exists() {
        return Err(IpcError {
            code: "conflict",
            message: format!("Name already in use: {new_name}"),
            detail: None,
        });
    }

    std::fs::rename(&old_abs, &new_abs)
        .map_err(|e| IpcError::io(format!("Cannot rename group: {e}")))?;
    Ok(())
}

// ── move_group ────────────────────────────────────────────────────────────────

/// `move_group(src_path, dst_parent)` — move the group at `src_path` under
/// `dst_parent` (an existing group, or `""` for library root).
///
/// Rejects circular moves (dst_parent is src_path or a descendant).
/// Rejects sibling collisions at the destination.
#[tauri::command]
pub fn move_group(
    src_path: String,
    dst_parent: String,
    state: State<'_, AppState>,
) -> CmdResult<()> {
    let guard = require_open!(state);
    let lib = guard.as_ref().ok_or_else(IpcError::not_open)?;
    move_group_inner(&lib.root, &src_path, &dst_parent)?;
    drop(guard);
    signal_rescan(&state);
    Ok(())
}

pub fn move_group_inner(root: &Path, src_path: &str, dst_parent: &str) -> CmdResult<()> {
    validate_rel_path(src_path)?;
    if !dst_parent.is_empty() {
        validate_rel_path(dst_parent)?;
    }
    let src_abs = root.join(src_path);
    if !src_abs.exists() {
        return Err(IpcError::not_found(format!("Group not found: {src_path}")));
    }
    if !src_abs.is_dir() {
        return Err(IpcError {
            code: "invalid_argument",
            message: format!("Not a directory: {src_path}"),
            detail: None,
        });
    }

    // Circular move check: dst_parent must not be src_path or below it.
    if is_under(src_path, dst_parent) {
        return Err(IpcError {
            code: "invalid_argument",
            message: format!(
                "Cannot move '{src_path}' into itself or one of its descendants ('{dst_parent}')."
            ),
            detail: None,
        });
    }

    // Validate dst_parent exists (or is root).
    let dst_parent_abs = if dst_parent.is_empty() {
        root.to_path_buf()
    } else {
        let abs = root.join(dst_parent);
        if !abs.is_dir() {
            return Err(IpcError::not_found(format!(
                "Destination group not found: {dst_parent}"
            )));
        }
        abs
    };

    // Derive the folder name from src_path.
    let folder_name = src_abs
        .file_name()
        .ok_or_else(|| IpcError::io("src_path has no file name".to_string()))?;

    let new_abs = dst_parent_abs.join(folder_name);
    if new_abs.exists() {
        let name = folder_name.to_string_lossy();
        return Err(IpcError {
            code: "conflict",
            message: format!("Name already in use at destination: {name}"),
            detail: None,
        });
    }

    std::fs::rename(&src_abs, &new_abs)
        .map_err(|e| IpcError::io(format!("Cannot move group: {e}")))?;
    Ok(())
}

// ── move_entry ────────────────────────────────────────────────────────────────

/// `move_entry(path, dst_group)` — move a `.md` file from its current location to
/// `dst_group` (library-relative folder path, or `""` for root).
///
/// The entry `id` is unchanged (embedded in the file); the reconciler's
/// rename-detection handles index update.
#[tauri::command]
pub fn move_entry(path: String, dst_group: String, state: State<'_, AppState>) -> CmdResult<()> {
    let guard = require_open!(state);
    let lib = guard.as_ref().ok_or_else(IpcError::not_open)?;
    move_entry_inner(&lib.root, &path, &dst_group)?;
    drop(guard);
    signal_rescan(&state);
    Ok(())
}

pub fn move_entry_inner(root: &Path, rel_path: &str, dst_group: &str) -> CmdResult<()> {
    validate_rel_path(rel_path)?;
    if !dst_group.is_empty() {
        validate_rel_path(dst_group)?;
    }
    let src_abs = root.join(rel_path);
    if !src_abs.exists() {
        return Err(IpcError::not_found(format!("Entry not found: {rel_path}")));
    }
    if !src_abs.is_file() {
        return Err(IpcError {
            code: "invalid_argument",
            message: format!("Not a file: {rel_path}"),
            detail: None,
        });
    }

    let dst_dir_abs = if dst_group.is_empty() {
        root.to_path_buf()
    } else {
        let abs = root.join(dst_group);
        if !abs.is_dir() {
            return Err(IpcError::not_found(format!(
                "Destination group not found: {dst_group}"
            )));
        }
        abs
    };

    let filename = src_abs
        .file_name()
        .ok_or_else(|| IpcError::io("path has no file name".to_string()))?;
    let new_abs = dst_dir_abs.join(filename);

    if new_abs.exists() {
        return Err(IpcError {
            code: "conflict",
            message: format!(
                "File already exists at destination: {}",
                filename.to_string_lossy()
            ),
            detail: None,
        });
    }

    std::fs::rename(&src_abs, &new_abs)
        .map_err(|e| IpcError::io(format!("Cannot move entry: {e}")))?;
    Ok(())
}

// ── rename_entry ────────────────────────────────────────────────────────────

/// `rename_entry(path, new_slug)` — rename the `.md` file at `path` to
/// `new_slug` within the same group (a slug change; spec 0002 §Identity).
///
/// The entry `id` is unchanged (it lives in the file body, not the name) and the
/// reconciler's rename-detection treats it as a rename, not delete+create.  On a
/// slug collision within the group the suffix `-2`, `-3`, … is appended.  After
/// the file move, in-app references — wikilinks `[[old]]` / `[[group/old]]` and
/// `ref`/`ref[]` frontmatter — are rewritten via the journaled batch machinery.
///
/// Reserved names (`_`/`.` prefixes) are rejected.  `new_slug` must be a single
/// path component.
#[tauri::command]
pub fn rename_entry(path: String, new_slug: String, state: State<'_, AppState>) -> CmdResult<()> {
    let guard = require_open!(state);
    let lib = guard.as_ref().ok_or_else(IpcError::not_open)?;

    let outcome = rename_entry_inner(&lib.root, &path, &new_slug)?;

    // Rewrite in-app references (wikilinks + ref properties) pointing at the old
    // slug.  The index still reflects the pre-move state here, which is exactly
    // what discovery needs to find the referrers.
    crate::core::journal::rename_slug(
        &lib.root,
        &lib.index,
        &lib.tokens,
        &outcome.group_path,
        &outcome.old_slug,
        &outcome.new_slug,
    )
    .map_err(|e| IpcError::io(format!("rename_entry reference rewrite failed: {e}")))?;

    drop(guard);
    signal_rescan(&state);
    Ok(())
}

/// Result of the filesystem half of a rename: the group the entry lives in, the
/// old slug, and the final new slug (after any collision suffixing).
#[derive(Debug)]
pub struct RenameEntryOutcome {
    pub group_path: String,
    pub old_slug: String,
    pub new_slug: String,
}

pub fn rename_entry_inner(
    root: &Path,
    rel_path: &str,
    new_slug: &str,
) -> CmdResult<RenameEntryOutcome> {
    validate_rel_path(rel_path)?;
    // `new_slug` is a single component, validated like a group name (no slashes,
    // not reserved, non-empty).
    validate_group_name(new_slug)?;

    let src_abs = root.join(rel_path);
    if !src_abs.exists() {
        return Err(IpcError::not_found(format!("Entry not found: {rel_path}")));
    }
    if !src_abs.is_file() {
        return Err(IpcError {
            code: "invalid_argument",
            message: format!("Not a file: {rel_path}"),
            detail: None,
        });
    }

    let old_slug = src_abs
        .file_stem()
        .and_then(|s| s.to_str())
        .ok_or_else(|| IpcError::io("path has no file stem".to_string()))?
        .to_string();

    // Group path: everything before the final component (empty = library root).
    let group_path = match rel_path.rfind('/') {
        Some(slash) => rel_path[..slash].to_string(),
        None => String::new(),
    };

    let parent_abs = src_abs
        .parent()
        .ok_or_else(|| IpcError::io("path has no parent".to_string()))?
        .to_path_buf();

    // No-op when the slug is unchanged.
    if new_slug == old_slug {
        return Ok(RenameEntryOutcome {
            group_path,
            old_slug: old_slug.clone(),
            new_slug: old_slug,
        });
    }

    // Collision-suffix the new slug: `new_slug`, then `new_slug-2`, `-3`, …
    let final_slug = unique_slug_in_dir(&parent_abs, new_slug);
    let new_abs = parent_abs.join(format!("{final_slug}.md"));

    std::fs::rename(&src_abs, &new_abs)
        .map_err(|e| IpcError::io(format!("Cannot rename entry: {e}")))?;

    Ok(RenameEntryOutcome {
        group_path,
        old_slug,
        new_slug: final_slug,
    })
}

/// Return a `.md` slug unique within `dir`: `base`, else `base-2`, `base-3`, …
/// (spec 0002 §"Filename collisions").
fn unique_slug_in_dir(dir: &Path, base: &str) -> String {
    if !dir.join(format!("{base}.md")).exists() {
        return base.to_string();
    }
    let mut n = 2u32;
    loop {
        let candidate = format!("{base}-{n}");
        if !dir.join(format!("{candidate}.md")).exists() {
            return candidate;
        }
        n += 1;
    }
}

// ── Trash IPC wrappers ────────────────────────────────────────────────────────

/// `TrashManifestDto` — serialisable form of `TrashManifest` for the IPC boundary.
#[derive(Serialize)]
pub struct TrashManifestDto {
    #[serde(rename = "trashId")]
    pub trash_id: String,
    #[serde(rename = "originalRelPath")]
    pub original_rel_path: String,
    #[serde(rename = "trashedAt")]
    pub trashed_at: String,
    /// `"entry"` or `"group"`.
    pub kind: String,
}

impl From<TrashManifest> for TrashManifestDto {
    fn from(m: TrashManifest) -> Self {
        TrashManifestDto {
            trash_id: m.trash_id,
            original_rel_path: m.original_rel_path,
            trashed_at: m.trashed_at,
            kind: match m.kind {
                crate::core::trash::TrashKind::Entry => "entry".into(),
                crate::core::trash::TrashKind::Group => "group".into(),
            },
        }
    }
}

/// `TrashEntryResult` — returned by `trash_entry` / `trash_group`.
#[derive(Serialize)]
pub struct TrashOpResult {
    #[serde(rename = "trashId")]
    pub trash_id: String,
}

/// `trash_entry(path)` — move a single `.md` file to the library trash.
///
/// Returns the new `trashId`.
#[tauri::command]
pub fn ipc_trash_entry(path: String, state: State<'_, AppState>) -> CmdResult<TrashOpResult> {
    let guard = require_open!(state);
    let lib = guard.as_ref().ok_or_else(IpcError::not_open)?;
    let trash_id =
        trash::trash_entry(&lib.root, Path::new(&path)).map_err(|e| IpcError::io(e.to_string()))?;
    drop(guard);
    signal_rescan(&state);
    Ok(TrashOpResult { trash_id })
}

/// `trash_group(path)` — move an entire group folder to the library trash.
///
/// Returns the new `trashId`.
#[tauri::command]
pub fn ipc_trash_group(path: String, state: State<'_, AppState>) -> CmdResult<TrashOpResult> {
    let guard = require_open!(state);
    let lib = guard.as_ref().ok_or_else(IpcError::not_open)?;
    let trash_id =
        trash::trash_group(&lib.root, Path::new(&path)).map_err(|e| IpcError::io(e.to_string()))?;
    drop(guard);
    signal_rescan(&state);
    Ok(TrashOpResult { trash_id })
}

/// `trash_list()` — list all trashed items, newest first.
#[tauri::command]
pub fn trash_list(state: State<'_, AppState>) -> CmdResult<Vec<TrashManifestDto>> {
    let guard = require_open!(state);
    let lib = guard.as_ref().ok_or_else(IpcError::not_open)?;
    let items = trash::list_trash(&lib.root);
    Ok(items.into_iter().map(TrashManifestDto::from).collect())
}

/// `RestoreResultDto` — returned by `trash_restore`.
#[derive(Serialize)]
pub struct RestoreResultDto {
    /// The final path (relative to library root) where the item was restored.
    pub path: String,
    /// True when a `-restored-N` suffix was added due to a collision.
    #[serde(rename = "hadCollision")]
    pub had_collision: bool,
}

impl From<RestoreOutcome> for RestoreResultDto {
    fn from(o: RestoreOutcome) -> Self {
        RestoreResultDto {
            path: o.path.to_string_lossy().into_owned(),
            had_collision: o.had_collision,
        }
    }
}

/// `trash_restore(id)` — restore a trashed item to its original location.
#[tauri::command]
pub fn trash_restore(id: String, state: State<'_, AppState>) -> CmdResult<RestoreResultDto> {
    let guard = require_open!(state);
    let lib = guard.as_ref().ok_or_else(IpcError::not_open)?;
    let outcome = trash::restore(&lib.root, &id).map_err(|e| match e {
        crate::core::trash::TrashError::NotFound(id) => IpcError::not_found(id),
        other => IpcError::io(other.to_string()),
    })?;
    drop(guard);
    signal_rescan(&state);
    Ok(RestoreResultDto::from(outcome))
}

/// `trash_purge(id)` — permanently delete a single trash slot.
#[tauri::command]
pub fn trash_purge(id: String, state: State<'_, AppState>) -> CmdResult<()> {
    let guard = require_open!(state);
    let lib = guard.as_ref().ok_or_else(IpcError::not_open)?;
    trash::purge(&lib.root, &id).map_err(|e| IpcError::io(e.to_string()))?;
    Ok(())
}

// ── Tests ──────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::{Arc, Mutex};
    use tempfile::TempDir;

    use crate::core::{fswrite::TokenRegistry, index::Index, reconcile::SyncReconciler};
    use crate::ipc::{AppState, OpenLibrary};

    // ── Fixture ───────────────────────────────────────────────────────────────

    struct Fixture {
        _dir: TempDir,
        pub root: PathBuf,
    }

    impl Fixture {
        fn new() -> Self {
            let dir = tempfile::tempdir().expect("tempdir");
            let root = dir.path().to_path_buf();
            Fixture { _dir: dir, root }
        }

        fn mkdir(&self, rel: &str) {
            std::fs::create_dir_all(self.root.join(rel)).unwrap();
        }

        fn write(&self, rel: &str, content: &[u8]) {
            let abs = self.root.join(rel);
            if let Some(p) = abs.parent() {
                std::fs::create_dir_all(p).unwrap();
            }
            std::fs::write(&abs, content).unwrap();
        }

        fn exists(&self, rel: &str) -> bool {
            self.root.join(rel).exists()
        }
    }

    // ── create_group ──────────────────────────────────────────────────────────

    #[test]
    fn create_group_basic() {
        let fix = Fixture::new();
        create_group_inner(&fix.root, "work").unwrap();
        assert!(fix.exists("work"), "group directory must be created");
    }

    #[test]
    fn create_group_nested() {
        let fix = Fixture::new();
        fix.mkdir("work");
        create_group_inner(&fix.root, "work/atlas").unwrap();
        assert!(fix.exists("work/atlas"));
    }

    #[test]
    fn create_group_rejects_reserved_underscore() {
        let fix = Fixture::new();
        let err = create_group_inner(&fix.root, "_private").unwrap_err();
        assert_eq!(err.code, "invalid_argument");
        assert!(err.message.contains("reserved"));
    }

    #[test]
    fn create_group_rejects_reserved_dot() {
        let fix = Fixture::new();
        let err = create_group_inner(&fix.root, ".hidden").unwrap_err();
        assert_eq!(err.code, "invalid_argument");
    }

    #[test]
    fn create_group_rejects_reserved_component_in_path() {
        let fix = Fixture::new();
        fix.mkdir("work");
        let err = create_group_inner(&fix.root, "work/_assets").unwrap_err();
        assert_eq!(err.code, "invalid_argument");
    }

    #[test]
    fn create_group_rejects_collision() {
        let fix = Fixture::new();
        fix.mkdir("work");
        let err = create_group_inner(&fix.root, "work").unwrap_err();
        assert_eq!(err.code, "conflict");
    }

    #[test]
    fn create_group_rejects_missing_parent() {
        let fix = Fixture::new();
        let err = create_group_inner(&fix.root, "ghost/atlas").unwrap_err();
        assert_eq!(err.code, "not_found");
    }

    // ── rename_group ──────────────────────────────────────────────────────────

    #[test]
    fn rename_group_basic() {
        let fix = Fixture::new();
        fix.mkdir("work");
        fix.write("work/note.md", b"# note");
        rename_group_inner(&fix.root, "work", "projects").unwrap();
        assert!(!fix.exists("work"), "old must be gone");
        assert!(fix.exists("projects"), "new must exist");
        assert!(fix.exists("projects/note.md"), "contents follow");
    }

    #[test]
    fn rename_group_rejects_reserved() {
        let fix = Fixture::new();
        fix.mkdir("work");
        let err = rename_group_inner(&fix.root, "work", "_archive").unwrap_err();
        assert_eq!(err.code, "invalid_argument");
    }

    #[test]
    fn rename_group_rejects_sibling_collision() {
        let fix = Fixture::new();
        fix.mkdir("work");
        fix.mkdir("projects");
        let err = rename_group_inner(&fix.root, "work", "projects").unwrap_err();
        assert_eq!(err.code, "conflict");
    }

    #[test]
    fn rename_group_not_found() {
        let fix = Fixture::new();
        let err = rename_group_inner(&fix.root, "ghost", "new-name").unwrap_err();
        assert_eq!(err.code, "not_found");
    }

    #[test]
    fn rename_group_nested() {
        let fix = Fixture::new();
        fix.mkdir("work/atlas");
        fix.write("work/atlas/overview.md", b"# Atlas");
        rename_group_inner(&fix.root, "work/atlas", "titan").unwrap();
        assert!(!fix.exists("work/atlas"));
        assert!(fix.exists("work/titan"));
        assert!(fix.exists("work/titan/overview.md"));
    }

    // ── move_group ────────────────────────────────────────────────────────────

    #[test]
    fn move_group_to_root() {
        let fix = Fixture::new();
        fix.mkdir("work/atlas");
        fix.write("work/atlas/overview.md", b"# Atlas");
        move_group_inner(&fix.root, "work/atlas", "").unwrap();
        assert!(!fix.exists("work/atlas"), "must leave source");
        assert!(fix.exists("atlas"), "must arrive at root");
        assert!(fix.exists("atlas/overview.md"));
    }

    #[test]
    fn move_group_rejects_circular_self() {
        let fix = Fixture::new();
        fix.mkdir("work");
        let err = move_group_inner(&fix.root, "work", "work").unwrap_err();
        assert_eq!(err.code, "invalid_argument");
        assert!(err.message.contains("circular") || err.message.contains("itself"));
    }

    #[test]
    fn move_group_rejects_circular_descendant() {
        let fix = Fixture::new();
        fix.mkdir("work/atlas/phase1");
        let err = move_group_inner(&fix.root, "work", "work/atlas").unwrap_err();
        assert_eq!(err.code, "invalid_argument");
    }

    #[test]
    fn move_group_rejects_collision_at_dst() {
        let fix = Fixture::new();
        fix.mkdir("archive");
        fix.mkdir("archive/work");
        fix.mkdir("work");
        let err = move_group_inner(&fix.root, "work", "archive").unwrap_err();
        assert_eq!(err.code, "conflict");
    }

    #[test]
    fn move_group_to_sibling() {
        let fix = Fixture::new();
        fix.mkdir("archive");
        fix.mkdir("work/atlas");
        move_group_inner(&fix.root, "work/atlas", "archive").unwrap();
        assert!(!fix.exists("work/atlas"));
        assert!(fix.exists("archive/atlas"));
    }

    // ── move_entry ────────────────────────────────────────────────────────────

    #[test]
    fn move_entry_between_groups() {
        let fix = Fixture::new();
        fix.mkdir("work");
        fix.mkdir("archive");
        fix.write("work/note.md", b"---\nid: abc123\n---\n# Note");
        move_entry_inner(&fix.root, "work/note.md", "archive").unwrap();
        assert!(!fix.exists("work/note.md"));
        assert!(fix.exists("archive/note.md"));
        // ID must be preserved in the file contents.
        let content = std::fs::read_to_string(fix.root.join("archive/note.md")).unwrap();
        assert!(content.contains("id: abc123"), "id must be preserved");
    }

    #[test]
    fn move_entry_to_root() {
        let fix = Fixture::new();
        fix.mkdir("work");
        fix.write("work/note.md", b"# X");
        move_entry_inner(&fix.root, "work/note.md", "").unwrap();
        assert!(fix.exists("note.md"));
    }

    #[test]
    fn move_entry_rejects_collision() {
        let fix = Fixture::new();
        fix.mkdir("work");
        fix.mkdir("archive");
        fix.write("work/note.md", b"# A");
        fix.write("archive/note.md", b"# B");
        let err = move_entry_inner(&fix.root, "work/note.md", "archive").unwrap_err();
        assert_eq!(err.code, "conflict");
    }

    #[test]
    fn move_entry_not_found() {
        let fix = Fixture::new();
        fix.mkdir("archive");
        let err = move_entry_inner(&fix.root, "ghost.md", "archive").unwrap_err();
        assert_eq!(err.code, "not_found");
    }

    // ── rename_entry ──────────────────────────────────────────────────────────

    #[test]
    fn rename_entry_basic_slug_change() {
        let fix = Fixture::new();
        fix.mkdir("work");
        fix.write("work/old-note.md", b"---\nid: abc\n---\n# Old Note");
        let out = rename_entry_inner(&fix.root, "work/old-note.md", "new-note").unwrap();
        assert!(!fix.exists("work/old-note.md"));
        assert!(fix.exists("work/new-note.md"));
        assert_eq!(out.group_path, "work");
        assert_eq!(out.old_slug, "old-note");
        assert_eq!(out.new_slug, "new-note");
        // id preserved (lives in the body).
        let content = std::fs::read_to_string(fix.root.join("work/new-note.md")).unwrap();
        assert!(content.contains("id: abc"));
    }

    #[test]
    fn rename_entry_collision_appends_suffix() {
        let fix = Fixture::new();
        fix.mkdir("work");
        fix.write("work/a.md", b"# A");
        fix.write("work/target.md", b"# Existing");
        let out = rename_entry_inner(&fix.root, "work/a.md", "target").unwrap();
        // Collision → target-2.
        assert!(fix.exists("work/target-2.md"));
        assert!(fix.exists("work/target.md"), "existing must be untouched");
        assert_eq!(out.new_slug, "target-2");
    }

    #[test]
    fn rename_entry_collision_increments() {
        let fix = Fixture::new();
        fix.mkdir("work");
        fix.write("work/a.md", b"# A");
        fix.write("work/target.md", b"# 1");
        fix.write("work/target-2.md", b"# 2");
        let out = rename_entry_inner(&fix.root, "work/a.md", "target").unwrap();
        assert_eq!(out.new_slug, "target-3");
        assert!(fix.exists("work/target-3.md"));
    }

    #[test]
    fn rename_entry_at_root_has_empty_group() {
        let fix = Fixture::new();
        fix.write("note.md", b"# N");
        let out = rename_entry_inner(&fix.root, "note.md", "renamed").unwrap();
        assert_eq!(out.group_path, "");
        assert!(fix.exists("renamed.md"));
    }

    #[test]
    fn rename_entry_rejects_reserved_slug() {
        let fix = Fixture::new();
        fix.write("note.md", b"# N");
        let err = rename_entry_inner(&fix.root, "note.md", "_secret").unwrap_err();
        assert_eq!(err.code, "invalid_argument");
        let err = rename_entry_inner(&fix.root, "note.md", ".hidden").unwrap_err();
        assert_eq!(err.code, "invalid_argument");
    }

    #[test]
    fn rename_entry_rejects_slug_with_slash() {
        let fix = Fixture::new();
        fix.write("note.md", b"# N");
        let err = rename_entry_inner(&fix.root, "note.md", "a/b").unwrap_err();
        assert_eq!(err.code, "invalid_argument");
    }

    #[test]
    fn rename_entry_not_found() {
        let fix = Fixture::new();
        let err = rename_entry_inner(&fix.root, "ghost.md", "new").unwrap_err();
        assert_eq!(err.code, "not_found");
    }

    #[test]
    fn rename_entry_noop_same_slug() {
        let fix = Fixture::new();
        fix.write("note.md", b"# N");
        let out = rename_entry_inner(&fix.root, "note.md", "note").unwrap();
        assert_eq!(out.old_slug, "note");
        assert_eq!(out.new_slug, "note");
        assert!(fix.exists("note.md"));
    }

    // ── Trash IPC round-trip ──────────────────────────────────────────────────

    // Helper: build an AppState without a real watcher (for trash IPC tests).
    fn make_appstate(root: &Path) -> AppState {
        use crate::core::reconcile::{Reconciler, WatcherHandle};
        let dot = root.join(".tonotedo");
        std::fs::create_dir_all(&dot).unwrap();
        let db = dot.join("index.db");
        let index = Index::open(db.to_str().unwrap()).expect("index");
        let tokens = Arc::new(TokenRegistry::with_default_ttl());
        let mut boot = SyncReconciler::new(index, Arc::clone(&tokens), root.to_path_buf());
        boot.full_rescan();
        let SyncReconciler {
            index,
            tokens,
            library_root,
            ..
        } = boot;
        let db2 = library_root.join(".tonotedo").join("index.db");
        let query_index = Index::open(db2.to_str().unwrap()).expect("query index");
        let (event_tx, _rx) = crossbeam_channel::unbounded();
        let reconciler = Reconciler::new_without_watcher(
            index,
            Arc::clone(&tokens),
            library_root.clone(),
            event_tx,
        );
        let (handle, _change_rx, _notify_rx) = reconciler.spawn(None::<WatcherHandle>);
        AppState(Mutex::new(Some(OpenLibrary {
            root: library_root,
            index: query_index,
            tokens,
            _reconciler_handle: handle,
        })))
    }

    #[test]
    fn trash_entry_and_restore_via_ipc() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_path_buf();
        std::fs::create_dir_all(root.join("notes")).unwrap();
        std::fs::write(root.join("notes/todo.md"), b"---\nid: xyz\n---\n# Todo").unwrap();

        let state = make_appstate(&root);
        let guard = state.0.lock().unwrap();
        let lib = guard.as_ref().unwrap();

        let trash_id =
            trash::trash_entry(&lib.root, Path::new("notes/todo.md")).expect("trash_entry");
        assert!(!root.join("notes/todo.md").exists());

        let outcome = trash::restore(&lib.root, &trash_id).expect("restore");
        assert!(root.join("notes/todo.md").exists());
        assert!(!outcome.had_collision);

        let content = std::fs::read_to_string(root.join("notes/todo.md")).unwrap();
        assert!(content.contains("id: xyz"), "id preserved after restore");
    }

    #[test]
    fn trash_group_and_purge_via_ipc() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_path_buf();
        let group = root.join("project");
        std::fs::create_dir_all(&group).unwrap();
        std::fs::write(group.join("note.md"), b"# Note").unwrap();

        let state = make_appstate(&root);
        let guard = state.0.lock().unwrap();
        let lib = guard.as_ref().unwrap();

        let trash_id = trash::trash_group(&lib.root, Path::new("project")).expect("trash_group");
        assert!(!group.exists());

        // purge (permanent delete).
        trash::purge(&lib.root, &trash_id).expect("purge");
        let remaining = trash::list_trash(&lib.root);
        assert!(remaining.is_empty(), "purge must remove the slot");
    }

    #[test]
    fn trash_list_returns_both_kinds() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_path_buf();
        std::fs::create_dir_all(root.join("grp")).unwrap();
        std::fs::write(root.join("grp/e.md"), b"# E").unwrap();
        std::fs::write(root.join("n.md"), b"# N").unwrap();

        let state = make_appstate(&root);
        let guard = state.0.lock().unwrap();
        let lib = guard.as_ref().unwrap();

        trash::trash_entry(&lib.root, Path::new("n.md")).unwrap();
        trash::trash_group(&lib.root, Path::new("grp")).unwrap();

        let list = trash::list_trash(&lib.root);
        assert_eq!(list.len(), 2, "both items must appear in trash list");

        // Both kinds must be present (order is best-effort by trashed_at).
        let has_entry = list
            .iter()
            .any(|m| m.kind == crate::core::trash::TrashKind::Entry);
        let has_group = list
            .iter()
            .any(|m| m.kind == crate::core::trash::TrashKind::Group);
        assert!(has_entry, "entry kind must be in list");
        assert!(has_group, "group kind must be in list");
    }

    #[test]
    fn trash_restore_not_found_returns_error() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_path_buf();
        std::fs::create_dir_all(root.join(".tonotedo")).unwrap();
        let err = trash::restore(&root, "00000000000000000000000000").unwrap_err();
        assert!(matches!(err, crate::core::trash::TrashError::NotFound(_)));
    }
}

#[cfg(test)]
mod security_tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    // F1/F2/F3 — path validation across all group fs commands.
    #[test]
    fn rejects_absolute_and_traversal_paths() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        // create_group: absolute path must not escape root.
        assert!(create_group_inner(root, "/tmp/evil").is_err());
        assert!(!std::path::Path::new("/tmp/evil").exists());
        assert!(create_group_inner(root, "../escape").is_err());
        assert!(create_group_inner(root, "_reserved").is_err());
        // a normal nested group still works (parent must exist first).
        create_group_inner(root, "work").unwrap();
        create_group_inner(root, "work/atlas").unwrap();
        assert!(root.join("work/atlas").is_dir());
    }

    #[test]
    fn move_entry_cannot_pull_file_from_outside_root() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        let outside = dir.path().parent().unwrap().join("outside-secret.md");
        let _ = fs::write(&outside, "secret");
        // absolute src is rejected before any fs op.
        assert!(move_entry_inner(root, "/etc/hosts", "work").is_err());
        assert!(move_entry_inner(root, "../outside-secret.md", "work").is_err());
        // absolute/escaping dst is rejected too.
        fs::create_dir_all(root.join("work")).unwrap();
        fs::write(root.join("work/note.md"), "x").unwrap();
        assert!(move_entry_inner(root, "work/note.md", "/tmp").is_err());
        assert!(move_entry_inner(root, "work/note.md", "../../tmp").is_err());
        let _ = fs::remove_file(&outside);
    }

    #[test]
    fn move_and_rename_group_reject_unsafe_paths() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        fs::create_dir_all(root.join("work")).unwrap();
        assert!(move_group_inner(root, "/abs", "work").is_err());
        assert!(move_group_inner(root, "work", "/tmp").is_err());
        assert!(rename_group_inner(root, "/abs", "x").is_err());
        assert!(rename_group_inner(root, "../up", "x").is_err());
    }

    #[test]
    fn rename_entry_rejects_unsafe_paths() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        fs::write(root.join("note.md"), "x").unwrap();
        // Absolute / traversal source paths rejected before any fs op.
        assert!(rename_entry_inner(root, "/etc/hosts", "x").is_err());
        assert!(rename_entry_inner(root, "../escape.md", "x").is_err());
        // Reserved / slash-bearing new slug rejected.
        assert!(rename_entry_inner(root, "note.md", "_meta").is_err());
        assert!(rename_entry_inner(root, "note.md", "a/b").is_err());
    }
}
