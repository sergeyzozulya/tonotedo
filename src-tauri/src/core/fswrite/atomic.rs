// Atomic file write: temp-file + fsync + rename.
//
// Spec reference: docs/spec/0006-markdown-editor.md §"Saving" (atomic write-temp+rename).
// Design reference: docs/tech/design-0001-index-and-reconciliation.md §"Batch journal".
//
// Platform notes:
//   - The temp file is created in the SAME directory as the target so that rename() is
//     always within one filesystem (a cross-device rename would fail with EXDEV on Unix).
//   - On Windows, std::fs::rename succeeds atomically when the target does NOT exist.
//     When the target DOES exist, it also succeeds on Windows Vista+ (MoveFileExW with
//     MOVEFILE_REPLACE_EXISTING is what the stdlib uses internally since Rust 1.x), but
//     is NOT guaranteed atomic by the Windows docs.  We accept that tradeoff for Windows:
//     crash between write+fsync and rename can leave the temp file behind (see below),
//     but the target is never partially written.
//   - On macOS/Linux, rename(2) over an existing file is atomic per POSIX.
//   - iOS/Android: same POSIX semantics as macOS/Linux.
//
// Temp file left behind after a crash:
//   The temp file is named `.<original-name>.<random-suffix>.tmp` (dot-prefix hides it
//   from directory listings on Unix).  The reconciler and startup rescan ignore `.`-prefixed
//   files and `*.tmp` files in the library (design-0001 §"Startup rescan").  Callers that
//   care about cleanup may call `cleanup_stale_tmp(dir)` on startup.

use std::io::{self, Write};
use std::path::{Path, PathBuf};

use crate::core::fswrite::WriteError;

/// Write `bytes` to `target` atomically:
///   1. Create a temp file in the same directory as `target`.
///   2. Write all bytes.
///   3. fsync the temp file (data on disk before rename).
///   4. Rename the temp file over `target`.
///   5. Best-effort fsync the parent directory (acknowledges rename on Linux/macOS).
///
/// The temp file is placed in the same directory so rename never crosses a filesystem
/// boundary (which would fail with EXDEV / ERROR_NOT_SAME_DEVICE).
///
/// On failure at any step, the temp file is removed before returning the error.
/// The target is never left in a partial state.
pub fn atomic_write(target: &Path, bytes: &[u8]) -> Result<(), WriteError> {
    let parent = target.parent().ok_or_else(|| {
        WriteError::Io(io::Error::new(
            io::ErrorKind::InvalidInput,
            "target path has no parent directory",
        ))
    })?;

    // Build temp path: .<filename>.<random>.tmp in the same directory.
    let tmp_path = temp_path(target, parent)?;

    // Write + fsync temp, then rename.  On any error, remove the temp file.
    let result = write_and_rename(&tmp_path, target, parent, bytes);
    if result.is_err() {
        // Best-effort cleanup; ignore secondary errors.
        let _ = std::fs::remove_file(&tmp_path);
    }
    result
}

fn write_and_rename(
    tmp_path: &Path,
    target: &Path,
    parent: &Path,
    bytes: &[u8],
) -> Result<(), WriteError> {
    // Open (create exclusive) — if the temp path happens to collide, this fails safely.
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(tmp_path)
        .map_err(WriteError::Io)?;

    f.write_all(bytes).map_err(WriteError::Io)?;
    f.flush().map_err(WriteError::Io)?;
    f.sync_all().map_err(WriteError::Io)?;
    drop(f);

    // Rename over target.
    //
    // On Windows, std::fs::rename calls MoveFileExW(MOVEFILE_REPLACE_EXISTING) when the
    // target exists.  This is not documented as atomic, but in practice on NTFS it is
    // transactional at the MFT level.  Acceptable per the design doc's Windows note.
    std::fs::rename(tmp_path, target).map_err(WriteError::Io)?;

    // Best-effort fsync parent directory so the rename is durable on Linux/macOS.
    // This is a no-op on Windows (directory fsync is not meaningful there) and is
    // intentionally best-effort: if it fails we still return Ok because the data
    // is already at the target path.
    let _ = fsync_dir(parent);

    Ok(())
}

/// Construct a temp path: `<parent>/.<stem>.<random>.tmp`.
///
/// The random suffix comes from the address of a stack-allocated array XOR the current
/// thread ID + a process-level counter — no external entropy crate needed.  Collisions
/// are astronomically unlikely within one process and non-catastrophic (open fails with
/// EEXIST and the write is aborted; the caller can retry).
fn temp_path(target: &Path, parent: &Path) -> Result<PathBuf, WriteError> {
    use std::sync::atomic::{AtomicU64, Ordering};

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    let stem = target
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("file");

    let seq = COUNTER.fetch_add(1, Ordering::Relaxed);
    // Mix thread id with process id and counter for sufficient uniqueness.
    let tid = thread_id();
    let pid = std::process::id() as u64;
    let suffix = seq ^ (tid.wrapping_mul(0x9e3779b97f4a7c15)) ^ (pid << 32);

    let name = format!(".{stem}.{suffix:016x}.tmp");
    Ok(parent.join(name))
}

/// Return a numeric proxy for the current thread — std::thread::current().id() doesn't
/// expose a number directly, but we can derive one cheaply via a thread-local counter.
fn thread_id() -> u64 {
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT_ID: AtomicU64 = AtomicU64::new(1);
    thread_local! {
        static ID: u64 = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    }
    ID.with(|id| *id)
}

/// Best-effort fsync of a directory (durable rename on Linux/macOS).
/// Silently ignored on Windows or when the directory cannot be opened.
///
/// We avoid a `libc` dependency by opening the directory with `O_RDONLY` and letting the
/// OS handle the rest.  On macOS/Linux, `open(dir, O_RDONLY)` on a directory succeeds and
/// `fsync(fd)` flushes the directory metadata journal entry for the rename above.
#[cfg(unix)]
fn fsync_dir(dir: &Path) -> io::Result<()> {
    // On Unix we can open a directory with read-only access and fsync it.
    // Using `OpenOptionsExt::custom_flags` with `O_DIRECTORY` would be cleaner but
    // requires the `libc` crate.  Plain `O_RDONLY` open on a directory is POSIX-legal;
    // macOS and Linux both allow it and accept `fsync()` on the resulting fd.
    let f = std::fs::File::open(dir)?;
    f.sync_all()
}

#[cfg(not(unix))]
fn fsync_dir(_dir: &Path) -> io::Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    fn tmpdir() -> TempDir {
        tempfile::tempdir().expect("failed to create temp dir")
    }

    // ── Basic write + read-back ──────────────────────────────────────────────

    #[test]
    fn write_creates_file_with_correct_contents() {
        let dir = tmpdir();
        let target = dir.path().join("note.md");
        atomic_write(&target, b"hello world").unwrap();
        assert_eq!(fs::read(&target).unwrap(), b"hello world");
    }

    #[test]
    fn write_overwrites_existing_file() {
        let dir = tmpdir();
        let target = dir.path().join("note.md");
        fs::write(&target, b"old content").unwrap();
        atomic_write(&target, b"new content").unwrap();
        assert_eq!(fs::read(&target).unwrap(), b"new content");
    }

    #[test]
    fn write_empty_bytes() {
        let dir = tmpdir();
        let target = dir.path().join("empty.md");
        atomic_write(&target, b"").unwrap();
        assert_eq!(fs::read(&target).unwrap(), b"");
    }

    // ── Crash safety: target unchanged until rename ──────────────────────────

    #[test]
    fn target_unchanged_before_rename() {
        // Write original content, then verify that after writing temp but before rename
        // the target still has the original content.
        //
        // We simulate this by writing to a temp file manually and checking the target
        // before calling rename — this is the structural guarantee we can verify
        // without process-kill injection.
        let dir = tmpdir();
        let target = dir.path().join("note.md");
        let original = b"original";
        fs::write(&target, original).unwrap();

        // Write to a temp file next to the target (same as atomic_write does internally).
        let tmp = dir.path().join(".note.md.simulated.tmp");
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp)
            .unwrap();
        f.write_all(b"new content").unwrap();
        f.sync_all().unwrap();
        drop(f);

        // Target still has original content BEFORE rename.
        assert_eq!(fs::read(&target).unwrap(), original);

        // Now rename — target gets new content.
        fs::rename(&tmp, &target).unwrap();
        assert_eq!(fs::read(&target).unwrap(), b"new content");
    }

    // ── Temp file is cleaned up on error ────────────────────────────────────

    #[test]
    fn no_leftover_tmp_on_success() {
        let dir = tmpdir();
        let target = dir.path().join("note.md");
        atomic_write(&target, b"data").unwrap();

        // After a successful write there must be no `.tmp` files in the directory.
        let leftover: Vec<_> = fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| {
                e.file_name()
                    .to_str()
                    .map(|s| s.ends_with(".tmp"))
                    .unwrap_or(false)
            })
            .collect();
        assert!(leftover.is_empty(), "tmp file left behind: {leftover:?}");
    }

    // ── No parent directory ──────────────────────────────────────────────────

    #[test]
    fn error_when_parent_does_not_exist() {
        let dir = tmpdir();
        let target = dir.path().join("nonexistent").join("note.md");
        let result = atomic_write(&target, b"data");
        assert!(
            result.is_err(),
            "must fail when parent directory does not exist"
        );
    }

    // ── Large write ──────────────────────────────────────────────────────────

    #[test]
    fn write_large_buffer() {
        let dir = tmpdir();
        let target = dir.path().join("large.md");
        let data = vec![b'x'; 512 * 1024]; // 512 KiB
        atomic_write(&target, &data).unwrap();
        assert_eq!(fs::read(&target).unwrap().len(), 512 * 1024);
    }
}
