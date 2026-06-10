// Filesystem watcher for the library root.
//
// Design reference: design-0001 §"Watcher":
//   "On desktop: platform watcher (FSEvents / inotify / ReadDirectoryChangesW
//   via the `notify` crate) on the library root, ignoring `.tonotedo/`.
//   Events are debounced (~100ms) and coalesced per path into a reconcile queue
//   consumed by a single worker — one writer to SQLite."
//
// Uses `notify::RecommendedWatcher` (platform-best watcher — FSEvents on macOS,
// inotify on Linux, ReadDirectoryChangesW on Windows).
//
// Overflow / error handling:
//   On `notify::Event::Kind::Other` or `Err` from the callback → enqueue a
//   `RawKind::FullRescanNeeded` sentinel.  The worker sets `needs_full_rescan`.
//
// INV (watcher lifetime): the `WatcherHandle` owns the `RecommendedWatcher`.
// Dropping it stops watching.  The `Sender` is cloned so the worker's `Receiver`
// stays open even while the watcher is being set up.

use std::path::Path;

use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};

use crossbeam_channel::Sender;

use super::{RawEvent, RawKind};

/// Owns the running `RecommendedWatcher`.  Drop to stop watching.
pub struct WatcherHandle {
    _watcher: RecommendedWatcher,
}

/// Start a `RecommendedWatcher` on `library_root` and forward events to `tx`.
///
/// The watcher is recursive (covers all subdirectories).  Events for paths
/// under `.tonotedo/` are silently dropped.
pub fn start_watcher(
    library_root: &Path,
    tx: Sender<RawEvent>,
) -> Result<WatcherHandle, notify::Error> {
    let root = library_root.to_path_buf();

    let mut watcher = notify::RecommendedWatcher::new(
        move |result: Result<notify::Event, notify::Error>| {
            match result {
                Ok(event) => {
                    let kind = match event_to_raw_kind(&event.kind) {
                        Some(k) => k,
                        None => return, // Access events and explicit ignores: drop here.
                    };
                    for path in event.paths {
                        // Skip .tonotedo/ and non-.md files for entry events.
                        if should_skip(&path, &root) {
                            continue;
                        }
                        let _ = tx.send(RawEvent { path, kind });
                    }
                }
                Err(_err) => {
                    // Watcher error (overflow, permission change, etc.).
                    // Signal the worker to do a full rescan.
                    let _ = tx.send(RawEvent {
                        path: std::path::PathBuf::new(),
                        kind: RawKind::FullRescanNeeded,
                    });
                }
            }
        },
        notify::Config::default(),
    )?;

    watcher.watch(library_root, RecursiveMode::Recursive)?;

    Ok(WatcherHandle { _watcher: watcher })
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/// Test-only re-export of `event_to_raw_kind` for unit tests.
#[cfg(test)]
pub(crate) fn event_to_raw_kind_for_test(kind: &notify::EventKind) -> Option<super::RawKind> {
    event_to_raw_kind(kind)
}

/// Map a notify `EventKind` to our coarser `RawKind`.
///
/// `EventKind::Access` is explicitly mapped to `None` (ignored) — issue #29,
/// item 2.  Access events fire on every file read and carry no information about
/// content changes; dispatching a reconcile for each one inflates the queue
/// without benefit.  The mtime/size fast-path in `reconcile_path` would make
/// them no-ops anyway, but it's cheaper to drop them here before they even enter
/// the debounce window.
fn event_to_raw_kind(kind: &EventKind) -> Option<RawKind> {
    match kind {
        EventKind::Create(_) | EventKind::Modify(_) => Some(RawKind::CreateOrModify),
        EventKind::Remove(_) => Some(RawKind::Remove),
        // Access: file was read but not modified — no reconcile needed.
        EventKind::Access(_) => None,
        EventKind::Other => Some(RawKind::FullRescanNeeded),
        EventKind::Any => Some(RawKind::CreateOrModify),
    }
}

/// Returns true if the event path should be ignored.
///
/// Ignored:
/// - Paths under `.tonotedo/`
/// - Paths not ending in `.md` (non-entry files: images, PDFs, etc.)
///
/// Note: projection files (`_tags.md`, `_people.md`) ARE `.md` files and
/// are NOT skipped here; the reconcile_path logic handles their special treatment.
fn should_skip(path: &Path, library_root: &Path) -> bool {
    // Check if any component is `.tonotedo`.
    let rel = match path.strip_prefix(library_root) {
        Ok(r) => r,
        Err(_) => return true, // outside the library root
    };

    for component in rel.components() {
        if let std::path::Component::Normal(s) = component {
            if s == ".tonotedo" {
                return true;
            }
        }
    }

    // Only index .md files.
    !matches!(path.extension().and_then(|e| e.to_str()), Some("md"))
}
