// Trash operations — spec docs/spec/0002-entries.md (Lifecycle), docs/spec/0003-groups.md
// (Delete group → .tonotedo/trash/), docs/tech/adr-0001-storage-format.md (.tonotedo/).
//
// ## Move strategy
//
// Prefer `fs::rename` (atomic, fast, within-volume).  If that fails with a cross-device
// error (EXDEV) we fall back to a recursive copy followed by removal of the source.  This
// happens when the library root and the OS temp dir are on different volumes (e.g. a
// network mount or a separate partition).  Both paths produce the same observable result.
//
// ## Assets note (spec 0006)
//
// Trashing an *entry* moves only the `.md` file.  The `_assets/` directory is shared
// across all entries in a group; orphan-asset cleanup is a separate feature (issue #6
// reconciler).  Trashing a *group* moves everything under the folder, including `_assets/`
// and `_group.md`, so no orphan concern there.
//
// ## Restore edge cases
//
// - **Missing ancestor directories**: recreated automatically (spec-author ruling).
// - **Target path occupied**: the item is restored with a `-restored-N` suffix appended
//   to the stem (for entries: before the `.md` extension; for groups: after the last path
//   component), where N counts up from 1 until an unused name is found.  The caller
//   receives the final path via `RestoreOutcome::path`.

use std::io;
use std::path::{Path, PathBuf};

use ulid::Ulid;

use super::manifest::{TrashKind, TrashManifest};

// ── Error type ───────────────────────────────────────────────────────────────

/// Errors from trash operations.
#[derive(Debug)]
pub enum TrashError {
    /// An I/O error from the filesystem.
    Io(io::Error),
    /// The requested trash slot does not exist.
    NotFound(String),
    /// Manifest could not be parsed.
    BadManifest(serde_json::Error),
    /// The trash id was not a valid ULID, or a manifest carried an unsafe
    /// `original_rel_path` (security: final-review F4 — path-join injection).
    InvalidId(String),
}

impl std::fmt::Display for TrashError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            TrashError::Io(e) => write!(f, "trash io error: {e}"),
            TrashError::NotFound(id) => write!(f, "trash slot not found: {id}"),
            TrashError::BadManifest(e) => write!(f, "trash manifest parse error: {e}"),
            TrashError::InvalidId(id) => write!(f, "invalid trash id: {id}"),
        }
    }
}

impl std::error::Error for TrashError {}

impl From<io::Error> for TrashError {
    fn from(e: io::Error) -> Self {
        TrashError::Io(e)
    }
}

/// Reject any trash id that is not a syntactically valid ULID before it is ever
/// joined into `.tonotedo/trash/<id>`. Without this, `purge("../../x")` or
/// `purge("/etc/passwd")` would `remove_dir_all` an arbitrary directory
/// (final-review F4).
fn validate_trash_id(trash_id: &str) -> Result<(), TrashError> {
    Ulid::from_string(trash_id)
        .map(|_| ())
        .map_err(|_| TrashError::InvalidId(trash_id.to_string()))
}

// ── Path helpers ─────────────────────────────────────────────────────────────

/// `.tonotedo/trash/` directory inside the library root.
fn trash_root(library_root: &Path) -> PathBuf {
    library_root.join(".tonotedo").join("trash")
}

/// Directory for a single trash slot.
fn slot_dir(library_root: &Path, trash_id: &str) -> PathBuf {
    trash_root(library_root).join(trash_id)
}

/// Path to the manifest file inside a slot.
fn manifest_path(library_root: &Path, trash_id: &str) -> PathBuf {
    slot_dir(library_root, trash_id).join("manifest.json")
}

// ── UTC timestamp ─────────────────────────────────────────────────────────────

fn utc_now_rfc3339() -> String {
    let ts = jiff::Timestamp::now();
    let zdt = ts.to_zoned(jiff::tz::TimeZone::UTC);
    let dt = zdt.datetime();
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        dt.year(),
        dt.month(),
        dt.day(),
        dt.hour(),
        dt.minute(),
        dt.second(),
    )
}

// ── Move helpers ─────────────────────────────────────────────────────────────

/// Move `src` to `dst` using rename; fall back to copy+remove on EXDEV.
fn move_path(src: &Path, dst: &Path) -> io::Result<()> {
    // Attempt atomic rename first.
    match std::fs::rename(src, dst) {
        Ok(()) => Ok(()),
        Err(e) if is_cross_device(&e) => {
            // Cross-device: copy recursively then remove source.
            copy_recursive(src, dst)?;
            remove_recursive(src)?;
            Ok(())
        }
        Err(e) => Err(e),
    }
}

/// True when `e` is a cross-device / cross-volume rename error (EXDEV on Unix,
/// ERROR_NOT_SAME_DEVICE on Windows).
fn is_cross_device(e: &io::Error) -> bool {
    // io::ErrorKind::CrossesDevices is stabilised in Rust 1.75.
    e.kind() == io::ErrorKind::CrossesDevices || e.raw_os_error() == Some(libc_exdev())
}

/// Returns the EXDEV errno value for the current platform.
fn libc_exdev() -> i32 {
    // EXDEV = 18 on Linux/macOS; 17 on some BSDs — but CrossesDevices covers it
    // on modern Rust.  Fall back to 18 as the common value.
    18
}

/// Recursively copy `src` (file or directory) to `dst`.
fn copy_recursive(src: &Path, dst: &Path) -> io::Result<()> {
    if src.is_dir() {
        std::fs::create_dir_all(dst)?;
        for entry in std::fs::read_dir(src)? {
            let entry = entry?;
            let child_dst = dst.join(entry.file_name());
            copy_recursive(&entry.path(), &child_dst)?;
        }
    } else {
        if let Some(parent) = dst.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::copy(src, dst)?;
    }
    Ok(())
}

/// Recursively remove `path` (file or directory).
fn remove_recursive(path: &Path) -> io::Result<()> {
    if path.is_dir() {
        std::fs::remove_dir_all(path)
    } else {
        std::fs::remove_file(path)
    }
}

// ── Internal: write manifest ──────────────────────────────────────────────────

fn write_manifest(library_root: &Path, manifest: &TrashManifest) -> Result<(), TrashError> {
    let path = manifest_path(library_root, &manifest.trash_id);
    let json = manifest.to_json().map_err(TrashError::BadManifest)?;
    std::fs::write(path, json.as_bytes())?;
    Ok(())
}

fn read_manifest(library_root: &Path, trash_id: &str) -> Result<TrashManifest, TrashError> {
    let path = manifest_path(library_root, trash_id);
    if !path.exists() {
        return Err(TrashError::NotFound(trash_id.to_string()));
    }
    let bytes = std::fs::read(&path)?;
    TrashManifest::from_json(&bytes).map_err(TrashError::BadManifest)
}

// ── Internal: generate trash ID ──────────────────────────────────────────────

fn new_trash_id() -> String {
    Ulid::new().to_string()
}

// ── Public API ────────────────────────────────────────────────────────────────

/// Trash a single entry (`.md` file).
///
/// Moves the file at `library_root/rel_path` into
/// `library_root/.tonotedo/trash/<trash_id>/<filename>` and writes a sidecar
/// `manifest.json`.
///
/// # Assets
///
/// Only the `.md` file is moved.  The `_assets/` directory is shared across all
/// entries in a group; orphan-asset cleanup is deferred to issue #6's reconciler.
///
/// Returns the assigned `trash_id`.
pub fn trash_entry(library_root: &Path, rel_path: &Path) -> Result<String, TrashError> {
    let src = library_root.join(rel_path);
    if !src.exists() {
        return Err(TrashError::Io(io::Error::new(
            io::ErrorKind::NotFound,
            format!("entry not found: {}", src.display()),
        )));
    }

    let trash_id = new_trash_id();
    let slot = slot_dir(library_root, &trash_id);
    std::fs::create_dir_all(&slot)?;

    let filename = src
        .file_name()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "rel_path has no file name"))?;
    let dst = slot.join(filename);
    move_path(&src, &dst)?;

    let manifest = TrashManifest {
        trash_id: trash_id.clone(),
        original_rel_path: rel_path.to_string_lossy().into_owned(),
        trashed_at: utc_now_rfc3339(),
        kind: TrashKind::Entry,
    };
    write_manifest(library_root, &manifest)?;

    Ok(trash_id)
}

/// Trash a group folder and all its descendants.
///
/// Moves the entire folder at `library_root/rel_path` (including `_assets/`,
/// `_group.md`, and all nested entries/sub-groups) into
/// `library_root/.tonotedo/trash/<trash_id>/<folder_name>`.
///
/// Returns the assigned `trash_id`.
pub fn trash_group(library_root: &Path, rel_path: &Path) -> Result<String, TrashError> {
    let src = library_root.join(rel_path);
    if !src.exists() {
        return Err(TrashError::Io(io::Error::new(
            io::ErrorKind::NotFound,
            format!("group not found: {}", src.display()),
        )));
    }
    if !src.is_dir() {
        return Err(TrashError::Io(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("not a directory: {}", src.display()),
        )));
    }

    let trash_id = new_trash_id();
    let slot = slot_dir(library_root, &trash_id);
    std::fs::create_dir_all(&slot)?;

    let folder_name = src
        .file_name()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "rel_path has no file name"))?;
    let dst = slot.join(folder_name);
    move_path(&src, &dst)?;

    let manifest = TrashManifest {
        trash_id: trash_id.clone(),
        original_rel_path: rel_path.to_string_lossy().into_owned(),
        trashed_at: utc_now_rfc3339(),
        kind: TrashKind::Group,
    };
    write_manifest(library_root, &manifest)?;

    Ok(trash_id)
}

/// List all trashed items, newest first (by `trashed_at` descending).
///
/// Slots with unreadable or missing manifests are silently skipped.
pub fn list_trash(library_root: &Path) -> Vec<TrashManifest> {
    let root = trash_root(library_root);
    let mut manifests: Vec<TrashManifest> = Vec::new();

    let dir = match std::fs::read_dir(&root) {
        Ok(d) => d,
        Err(_) => return manifests,
    };

    for entry in dir.flatten() {
        let trash_id = entry.file_name().to_string_lossy().into_owned();
        // Skip non-directories (e.g. stray files) and the manifest itself if
        // somehow at the root level.
        if !entry.path().is_dir() {
            continue;
        }
        if let Ok(m) = read_manifest(library_root, &trash_id) {
            manifests.push(m);
        }
    }

    // Sort newest first.
    manifests.sort_by(|a, b| b.trashed_at.cmp(&a.trashed_at));
    manifests
}

/// The outcome of a restore operation.
#[derive(Debug)]
pub struct RestoreOutcome {
    /// The final path (relative to library_root) where the item was restored.
    /// Usually equals `manifest.original_rel_path`; differs when the target was
    /// occupied (a `-restored-N` suffix was appended).
    pub path: PathBuf,
    /// True when a suffix was added because the original path was already occupied.
    pub had_collision: bool,
}

/// Restore a trashed item to its original location.
///
/// # Ancestor directories
///
/// Missing ancestor directories are recreated automatically.
///
/// # Occupied target
///
/// If the original path already exists, the item is restored with a `-restored-N`
/// suffix (N = 1, 2, …) until a free name is found.  For entries the suffix is
/// inserted before the `.md` extension; for groups it is appended to the folder name.
/// The actual restored path is reported in `RestoreOutcome::path`.
pub fn restore(library_root: &Path, trash_id: &str) -> Result<RestoreOutcome, TrashError> {
    validate_trash_id(trash_id)?;
    let manifest = read_manifest(library_root, trash_id)?;
    let slot = slot_dir(library_root, trash_id);

    // The manifest's original_rel_path is data the slot carries; a crafted slot
    // could point it outside the library. Re-validate before joining (F4).
    if !crate::core::frontmatter::is_safe_rel_path(&manifest.original_rel_path) {
        return Err(TrashError::InvalidId(format!(
            "unsafe original_rel_path in manifest: {}",
            manifest.original_rel_path
        )));
    }

    // Locate the trashed item inside the slot (everything except manifest.json).
    let item_name = find_slot_item(&slot)?;
    let trashed_item = slot.join(&item_name);

    // Compute the destination path, handling collisions.
    let original = PathBuf::from(&manifest.original_rel_path);
    let (dst_rel, had_collision) =
        resolve_restore_path(library_root, &original, &manifest.kind, &item_name);
    let dst_abs = library_root.join(&dst_rel);

    // Recreate missing ancestors.
    if let Some(parent) = dst_abs.parent() {
        std::fs::create_dir_all(parent)?;
    }

    move_path(&trashed_item, &dst_abs)?;

    // Clean up the now-empty slot directory.
    let _ = std::fs::remove_dir_all(&slot);

    Ok(RestoreOutcome {
        path: dst_rel,
        had_collision,
    })
}

/// Permanently delete a single trash slot.
///
/// The confirmed-deletion UI lives in the frontend; this function only removes the
/// files.  Returns `Ok(())` if the slot does not exist (idempotent).
pub fn purge(library_root: &Path, trash_id: &str) -> Result<(), TrashError> {
    validate_trash_id(trash_id)?;
    let slot = slot_dir(library_root, trash_id);
    if slot.exists() {
        std::fs::remove_dir_all(&slot)?;
    }
    Ok(())
}

/// Permanently delete all trash slots.
///
/// Equivalent to removing the entire `.tonotedo/trash/` directory and recreating
/// an empty one.
pub fn purge_all(library_root: &Path) -> Result<(), TrashError> {
    let root = trash_root(library_root);
    if root.exists() {
        std::fs::remove_dir_all(&root)?;
    }
    Ok(())
}

// ── Restore helpers ───────────────────────────────────────────────────────────

/// Find the single non-manifest item inside a slot directory.
fn find_slot_item(slot: &Path) -> Result<String, TrashError> {
    let mut items: Vec<String> = Vec::new();
    for entry in std::fs::read_dir(slot)?.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name != "manifest.json" {
            items.push(name);
        }
    }
    match items.len() {
        1 => Ok(items.remove(0)),
        0 => Err(TrashError::Io(io::Error::new(
            io::ErrorKind::NotFound,
            "slot is empty (no trashed item found)",
        ))),
        _ => Err(TrashError::Io(io::Error::new(
            io::ErrorKind::InvalidData,
            "slot contains more than one item",
        ))),
    }
}

/// Compute the final restore path, adding a `-restored-N` suffix if occupied.
///
/// Returns `(relative_path, had_collision)`.
fn resolve_restore_path(
    library_root: &Path,
    original: &Path,
    kind: &TrashKind,
    _item_name: &str,
) -> (PathBuf, bool) {
    let candidate = library_root.join(original);
    if !candidate.exists() {
        return (original.to_path_buf(), false);
    }

    // Target is occupied — generate a suffixed name.
    for n in 1u32.. {
        let suffixed = add_restore_suffix(original, kind, n);
        let abs = library_root.join(&suffixed);
        if !abs.exists() {
            return (suffixed, true);
        }
    }

    // Unreachable in practice.
    (original.to_path_buf(), true)
}

/// Append `-restored-N` to `original_rel`, respecting the `.md` extension for entries.
fn add_restore_suffix(original: &Path, kind: &TrashKind, n: u32) -> PathBuf {
    match kind {
        TrashKind::Entry => {
            // Insert before `.md`: `note.md` → `note-restored-1.md`
            let parent = original.parent().unwrap_or_else(|| Path::new(""));
            let stem = original
                .file_stem()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_default();
            let ext = original
                .extension()
                .map(|e| format!(".{}", e.to_string_lossy()))
                .unwrap_or_default();
            let new_name = format!("{stem}-restored-{n}{ext}");
            parent.join(new_name)
        }
        TrashKind::Group => {
            // Append to folder name: `project` → `project-restored-1`
            let parent = original.parent().unwrap_or_else(|| Path::new(""));
            let name = original
                .file_name()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_default();
            let new_name = format!("{name}-restored-{n}");
            parent.join(new_name)
        }
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    // ── Fixtures ─────────────────────────────────────────────────────────────

    /// Create a temporary library root with a unique name.
    fn temp_library() -> PathBuf {
        let id = Ulid::new().to_string();
        let path = std::env::temp_dir().join(format!("tonotedo-test-{id}"));
        fs::create_dir_all(&path).unwrap();
        path
    }

    /// Write a file, creating parent directories if needed.
    fn write_file(path: &Path, content: &[u8]) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, content).unwrap();
    }

    // ── Entry trash/restore round-trip ────────────────────────────────────────

    #[test]
    fn entry_trash_restore_preserves_bytes() {
        let lib = temp_library();
        let content = b"---\nid: abc\n---\n# Hello\n\nBody text.\n";
        let rel = PathBuf::from("notes/hello.md");
        write_file(&lib.join(&rel), content);

        let trash_id = trash_entry(&lib, &rel).unwrap();

        // File must no longer be at original location.
        assert!(
            !lib.join(&rel).exists(),
            "source must be removed after trash"
        );

        // Manifest must exist and be parseable.
        let manifest = read_manifest(&lib, &trash_id).unwrap();
        assert_eq!(manifest.kind, TrashKind::Entry);
        assert_eq!(manifest.original_rel_path, rel.to_string_lossy());

        // Restore.
        let outcome = restore(&lib, &trash_id).unwrap();
        assert!(!outcome.had_collision);
        assert_eq!(outcome.path, rel);

        // File must be back with identical bytes.
        let restored = fs::read(lib.join(&rel)).unwrap();
        assert_eq!(restored, content, "restored bytes must match original");

        // Slot must be cleaned up.
        assert!(!slot_dir(&lib, &trash_id).exists());
    }

    // ── Group trash/restore: 50-entry acceptance test ─────────────────────────

    #[test]
    fn group_trash_restore_50_entries() {
        let lib = temp_library();
        // Build a group with nested sub-groups and 50 entries total.
        let group_rel = PathBuf::from("big-project");
        let group_abs = lib.join(&group_rel);

        // _group.md
        write_file(&group_abs.join("_group.md"), b"# Big Project\n");

        // 30 entries at top level
        for i in 0..30 {
            write_file(
                &group_abs.join(format!("entry-{i}.md")),
                format!("# Entry {i}\n").as_bytes(),
            );
        }

        // Sub-group with 20 more entries
        let sub = group_abs.join("sub-group");
        write_file(&sub.join("_group.md"), b"# Sub\n");
        for i in 0..20 {
            write_file(
                &sub.join(format!("sub-entry-{i}.md")),
                format!("# Sub Entry {i}\n").as_bytes(),
            );
        }

        let trash_id = trash_group(&lib, &group_rel).unwrap();

        // Original group must be gone.
        assert!(!group_abs.exists(), "group must be removed after trash");

        // Manifest kind = group.
        let manifest = read_manifest(&lib, &trash_id).unwrap();
        assert_eq!(manifest.kind, TrashKind::Group);

        // Restore.
        let outcome = restore(&lib, &trash_id).unwrap();
        assert!(!outcome.had_collision);

        // All 50 entries + _group.md + sub-group/_group.md must be back.
        for i in 0..30 {
            assert!(
                group_abs.join(format!("entry-{i}.md")).exists(),
                "entry-{i}.md must be restored"
            );
        }
        for i in 0..20 {
            assert!(
                sub.join(format!("sub-entry-{i}.md")).exists(),
                "sub-entry-{i}.md must be restored"
            );
        }
        assert!(group_abs.join("_group.md").exists());
        assert!(sub.join("_group.md").exists());
    }

    // ── Restore after ancestor deleted (recreates ancestors) ──────────────────

    #[test]
    fn restore_recreates_missing_ancestors() {
        let lib = temp_library();
        let content = b"# Note\n";
        let rel = PathBuf::from("deep/nested/path/note.md");
        write_file(&lib.join(&rel), content);

        let trash_id = trash_entry(&lib, &rel).unwrap();

        // Remove the ancestor directories entirely.
        fs::remove_dir_all(lib.join("deep")).unwrap();

        // Restore must recreate ancestors.
        let outcome = restore(&lib, &trash_id).unwrap();
        assert!(!outcome.had_collision);
        assert!(
            lib.join(&rel).exists(),
            "file must be restored after ancestor removal"
        );
    }

    // ── Restore into occupied path (suffix) ───────────────────────────────────

    #[test]
    fn restore_into_occupied_path_adds_suffix() {
        let lib = temp_library();
        let content = b"# Original\n";
        let rel = PathBuf::from("notes/note.md");
        write_file(&lib.join(&rel), content);

        let trash_id = trash_entry(&lib, &rel).unwrap();

        // Recreate a file at the original path so restore will collide.
        write_file(&lib.join(&rel), b"# Blocker\n");

        let outcome = restore(&lib, &trash_id).unwrap();
        assert!(outcome.had_collision, "must detect collision");
        // Suffix must be applied.
        let expected_suffix = PathBuf::from("notes/note-restored-1.md");
        assert_eq!(outcome.path, expected_suffix);
        assert!(lib.join(&expected_suffix).exists());
        // Collider still at original path.
        assert!(lib.join(&rel).exists());
    }

    #[test]
    fn restore_collision_n_increments() {
        let lib = temp_library();
        let rel = PathBuf::from("notes/note.md");
        write_file(&lib.join(&rel), b"# v1\n");

        let id1 = trash_entry(&lib, &rel).unwrap();
        write_file(&lib.join(&rel), b"# blocker\n");

        // Restore first trashed copy → collision → restored-1.
        let o1 = restore(&lib, &id1).unwrap();
        assert!(o1.had_collision);
        assert_eq!(o1.path, PathBuf::from("notes/note-restored-1.md"));

        // Trash the restored-1 copy and re-restore when both original and restored-1 exist.
        let id2 = trash_entry(&lib, &PathBuf::from("notes/note-restored-1.md")).unwrap();
        // read the manifest to change its original_rel_path back to the original
        // so we test N=2 incrementing. Instead, we can just trash original again.
        let _ = id2; // id2 used for cleanup; let's do a simpler increment test below.

        // Simpler: trash a second copy with same original path.
        write_file(&lib.join(&rel), b"# v2\n");
        let id3 = trash_entry(&lib, &rel).unwrap();
        write_file(&lib.join(&rel), b"# blocker2\n");
        // -restored-1 is already occupied from o1; expect -restored-2.
        write_file(
            &lib.join("notes/note-restored-1.md"),
            b"# already restored-1\n",
        );
        let o3 = restore(&lib, &id3).unwrap();
        assert!(o3.had_collision);
        assert_eq!(o3.path, PathBuf::from("notes/note-restored-2.md"));
    }

    // ── Double-trash same name → unique IDs ───────────────────────────────────

    #[test]
    fn double_trash_same_name_unique_ids() {
        let lib = temp_library();
        let rel = PathBuf::from("notes/note.md");

        write_file(&lib.join(&rel), b"# First\n");
        let id1 = trash_entry(&lib, &rel).unwrap();

        write_file(&lib.join(&rel), b"# Second\n");
        let id2 = trash_entry(&lib, &rel).unwrap();

        assert_ne!(id1, id2, "each trash operation must produce a unique ID");

        // Both slots must exist with correct manifests.
        let m1 = read_manifest(&lib, &id1).unwrap();
        let m2 = read_manifest(&lib, &id2).unwrap();
        assert_eq!(m1.original_rel_path, m2.original_rel_path);

        // Each slot contains a file.
        assert!(slot_dir(&lib, &id1).exists());
        assert!(slot_dir(&lib, &id2).exists());
    }

    // ── list_trash ordering ───────────────────────────────────────────────────

    #[test]
    fn list_trash_newest_first() {
        let lib = temp_library();

        for i in 0..5u32 {
            let rel = PathBuf::from(format!("note-{i}.md"));
            write_file(&lib.join(&rel), format!("# {i}\n").as_bytes());
            trash_entry(&lib, &rel).unwrap();
            // Small sleep so ULID-based trashed_at timestamps differ.
            std::thread::sleep(std::time::Duration::from_millis(2));
        }

        let list = list_trash(&lib);
        assert_eq!(list.len(), 5);

        // Verify descending order.
        for w in list.windows(2) {
            assert!(
                w[0].trashed_at >= w[1].trashed_at,
                "list must be newest first"
            );
        }
    }

    #[test]
    fn list_trash_empty_when_no_trash_dir() {
        let lib = temp_library();
        let list = list_trash(&lib);
        assert!(list.is_empty());
    }

    // ── purge removes single slot ─────────────────────────────────────────────

    #[test]
    fn purge_removes_slot() {
        let lib = temp_library();
        let rel = PathBuf::from("note.md");
        write_file(&lib.join(&rel), b"# X\n");

        let trash_id = trash_entry(&lib, &rel).unwrap();
        assert!(slot_dir(&lib, &trash_id).exists());

        purge(&lib, &trash_id).unwrap();
        assert!(
            !slot_dir(&lib, &trash_id).exists(),
            "slot must be removed after purge"
        );
    }

    #[test]
    fn purge_nonexistent_is_ok() {
        let lib = temp_library();
        // Must not error on a missing slot.
        purge(&lib, "00000000000000000000000000").unwrap();
    }

    // ── purge_all ─────────────────────────────────────────────────────────────

    #[test]
    fn purge_all_removes_all_slots() {
        let lib = temp_library();

        for i in 0..3u32 {
            let rel = PathBuf::from(format!("n{i}.md"));
            write_file(&lib.join(&rel), b"x\n");
            trash_entry(&lib, &rel).unwrap();
        }

        assert_eq!(list_trash(&lib).len(), 3);
        purge_all(&lib).unwrap();
        assert_eq!(list_trash(&lib).len(), 0, "all slots must be removed");
        assert!(!trash_root(&lib).exists());
    }

    #[test]
    fn purge_all_empty_is_ok() {
        let lib = temp_library();
        purge_all(&lib).unwrap();
    }

    // ── trash non-existent entry returns error ────────────────────────────────

    #[test]
    fn trash_entry_missing_file_errors() {
        let lib = temp_library();
        let result = trash_entry(&lib, &PathBuf::from("ghost.md"));
        assert!(matches!(result, Err(TrashError::Io(_))));
    }

    #[test]
    fn trash_group_missing_dir_errors() {
        let lib = temp_library();
        let result = trash_group(&lib, &PathBuf::from("ghost-group"));
        assert!(matches!(result, Err(TrashError::Io(_))));
    }

    // ── group collision restore ───────────────────────────────────────────────

    #[test]
    fn restore_group_collision_adds_suffix() {
        let lib = temp_library();
        let rel = PathBuf::from("my-group");
        let group_abs = lib.join(&rel);

        write_file(&group_abs.join("entry.md"), b"# E\n");
        let trash_id = trash_group(&lib, &rel).unwrap();

        // Recreate group at original path.
        write_file(&group_abs.join("blocker.md"), b"# B\n");

        let outcome = restore(&lib, &trash_id).unwrap();
        assert!(outcome.had_collision);
        let expected = PathBuf::from("my-group-restored-1");
        assert_eq!(outcome.path, expected);
        assert!(lib.join(&expected).join("entry.md").exists());
    }
}

#[cfg(test)]
mod security_tests {
    use super::*;
    use tempfile::tempdir;

    // F4 — trash id injection.
    #[test]
    fn purge_rejects_non_ulid_ids() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        let victim = dir.path().parent().unwrap().join("victim-dir");
        std::fs::create_dir_all(&victim).unwrap();
        // Absolute, traversal, and junk ids must all be refused before any rm.
        assert!(matches!(
            purge(root, "/etc/passwd"),
            Err(TrashError::InvalidId(_))
        ));
        assert!(matches!(
            purge(root, "../../../victim-dir"),
            Err(TrashError::InvalidId(_))
        ));
        assert!(matches!(
            purge(root, "not-a-ulid"),
            Err(TrashError::InvalidId(_))
        ));
        assert!(victim.exists(), "purge must not delete an arbitrary dir");
        std::fs::remove_dir_all(&victim).unwrap();
    }

    #[test]
    fn restore_rejects_non_ulid_and_unsafe_manifest() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        assert!(matches!(
            restore(root, "../escape"),
            Err(TrashError::InvalidId(_))
        ));
        // Craft a slot with a valid ULID name but a malicious original_rel_path.
        let id = Ulid::new().to_string();
        let slot = slot_dir(root, &id);
        std::fs::create_dir_all(&slot).unwrap();
        std::fs::write(slot.join("note.md"), "x").unwrap();
        let bad = "{\"original_rel_path\":\"/tmp/evil.md\",\"trashed_at\":\"2026-01-01T00:00:00Z\",\"kind\":\"entry\"}";
        std::fs::write(slot.join("manifest.json"), bad).unwrap();
        assert!(
            restore(root, &id).is_err(),
            "unsafe manifest path must be refused"
        );
    }

    #[test]
    fn valid_ulid_round_trip_still_works() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("work")).unwrap();
        std::fs::write(root.join("work/note.md"), "hello").unwrap();
        let id = trash_entry(root, std::path::Path::new("work/note.md")).unwrap();
        assert!(restore(root, &id).is_ok());
        assert!(root.join("work/note.md").exists());
    }
}
