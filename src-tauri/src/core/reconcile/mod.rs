// Reconciler — watcher + filesystem reconciliation pipeline.
//
// Spec:  docs/tech/design-0001-index-and-reconciliation.md
// Issue: #6
//
// ## Architecture
//
// The `Reconciler` owns:
//   - an `Index`             — single SQLite writer; ALL index mutations go here
//   - an `Arc<TokenRegistry>` — shared with the write path (fswrite::write_entry)
//   - the library root path
//   - a notify `RecommendedWatcher` on the library root (desktop only)
//   - a worker thread that drains a debounce queue and calls `reconcile_path`
//   - a `ChangeEvent` sender for downstream consumers (IPC layer, tests)
//
// ## Invariants (for the Opus reviewer)
//
// INV-1  Single writer: `Index` is not `Sync`; all mutations flow through the
//        worker thread's `reconcile_path` / `full_rescan` calls.  Nothing else
//        holds a mutable reference to `Index` after construction.
//
// INV-2  Self-write suppression: before classifying a change as external, the
//        worker calls `TokenRegistry::consume_if_match`.  On a match, the ledger
//        is still refreshed (mtime/size) but `ChangeEvent::self_originated` is
//        set, so the originating view does not echo.
//
// INV-3  Rename detection (two layers): an in-batch remove+create with the SAME
//        frontmatter id → `index.rename_entry`.  Cross-batch / offline renames are
//        also detected: when a create's fmid collides with a different indexed
//        path whose file is now GONE on disk, it is treated as a rename (identity
//        + backlinks preserved, NO file rewrite) rather than a duplicate.
//
// INV-4  Duplicate-id rule (spec 0002 §"Edge cases"):  when two LIVE files claim
//        one id, the keeper is deterministic — the lexicographically smaller path
//        keeps the id; the other is re-id'd (fresh generated id, atomic rewrite
//        with a token) and a second `ChangeEvent` (self_originated=true) is
//        emitted.  This converges on the same keeper regardless of scan order.
//
// INV-5  Projection files (_tags.md, _people.md): parsed with saphyr directly;
//        their schema (lists-of-maps) does NOT go through Entry::from_bytes.  A
//        MALFORMED projection keeps the last-good projection (parse failure is
//        logged and `set_*` is skipped); a genuinely-empty projection replaces it.
//
// INV-6  Watcher overflow → `needs_full_rescan` flag is set; the consumer should
//        call `full_rescan()` on next opportunity (e.g. app foreground, 0013).
//
// INV-7  `full_rescan` is the single path for BOTH startup and mobile foreground
//        (spec 0013).  It diffs the on-disk tree against the `files` ledger,
//        reconciles new/modified files, and removes ledger rows for deleted files.

pub mod event;
pub(crate) mod ledger;
pub(crate) mod projection;
pub mod reconcile_path;
pub(crate) mod rescan;
pub(crate) mod watcher;

#[cfg(test)]
mod tests;

pub use event::{ChangeEvent, ChangeKind, ReconcileNotification};
pub use watcher::WatcherHandle;

use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};

use crossbeam_channel::{Receiver, Sender};

use crate::core::{fswrite::TokenRegistry, index::Index};

/// Raw filesystem event (path + optional kind) from the notify callback.
pub(crate) struct RawEvent {
    pub path: PathBuf,
    pub kind: RawKind,
}

/// Test-only constructor for a `RawEvent` (fields are private otherwise).
#[cfg(test)]
pub(crate) fn test_raw_event(path: PathBuf, kind: RawKind) -> RawEvent {
    RawEvent { path, kind }
}

/// Coarse event kind used inside the reconciler.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RawKind {
    CreateOrModify,
    Remove,
    /// Sentinel: full rescan requested (overflow / error).
    FullRescanNeeded,
}

/// Handle returned to the caller after spawning the reconciler worker.
///
/// Dropping this handle signals the worker to stop.
pub struct ReconcilerHandle {
    /// Set to request a full rescan (e.g. after watcher overflow).
    pub needs_full_rescan: Arc<AtomicBool>,
    /// Optional watcher handle; kept alive until this handle is dropped.
    pub _watcher: Option<WatcherHandle>,
}

/// The reconciler — owns the Index and drives all reconciliation.
///
/// Callers construct this via [`Reconciler::new`] or [`Reconciler::new_without_watcher`],
/// then call [`Reconciler::spawn`] to start the background worker.
///
/// After `spawn`, all index writes happen on the worker thread.
pub struct Reconciler {
    /// Owned index — passed to the worker on spawn.
    index: Index,
    /// Shared registry with the write path.
    tokens: Arc<TokenRegistry>,
    /// Absolute path to the library root.
    library_root: PathBuf,
    /// Sender that the watcher pushes raw paths onto; worker drains it.
    /// Also used by `raw_sender()` for IPC wiring.
    #[allow(dead_code)]
    raw_tx: Sender<RawEvent>,
    raw_rx: Receiver<RawEvent>,
    /// Change events emitted to downstream (IPC / tests).
    /// Stored so spawn() can pass it to the worker without re-creating the channel.
    #[allow(dead_code)]
    event_tx: Sender<ChangeEvent>,
}

impl Reconciler {
    /// Build a `Reconciler` without starting the watcher (useful for tests and
    /// for the mobile path where there is no reliable watcher).
    pub fn new_without_watcher(
        index: Index,
        tokens: Arc<TokenRegistry>,
        library_root: PathBuf,
        event_tx: Sender<ChangeEvent>,
    ) -> Self {
        let (raw_tx, raw_rx) = crossbeam_channel::unbounded();
        Reconciler {
            index,
            tokens,
            library_root,
            raw_tx,
            raw_rx,
            event_tx,
        }
    }

    /// Build a `Reconciler` and attach a filesystem watcher on `library_root`.
    pub fn new_with_watcher(
        index: Index,
        tokens: Arc<TokenRegistry>,
        library_root: PathBuf,
        event_tx: Sender<ChangeEvent>,
    ) -> Result<(Self, WatcherHandle), notify::Error> {
        let (raw_tx, raw_rx) = crossbeam_channel::unbounded::<RawEvent>();
        let watcher_handle = watcher::start_watcher(&library_root, raw_tx.clone())?;
        Ok((
            Reconciler {
                index,
                tokens,
                library_root,
                raw_tx,
                raw_rx,
                event_tx,
            },
            watcher_handle,
        ))
    }

    /// Consume the `Reconciler` and spawn a background worker thread.
    ///
    /// The worker owns the `Index` (enforcing INV-1: single writer).
    /// Returns a [`ReconcilerHandle`] and a `Receiver<ChangeEvent>` for the
    /// downstream consumer.
    pub fn spawn(
        self,
        watcher: Option<WatcherHandle>,
    ) -> (
        ReconcilerHandle,
        Receiver<ChangeEvent>,
        Receiver<ReconcileNotification>,
    ) {
        let needs_full_rescan = Arc::new(AtomicBool::new(false));
        let flag = Arc::clone(&needs_full_rescan);

        let raw_rx = self.raw_rx;
        let (event_tx, event_rx) = crossbeam_channel::unbounded::<ChangeEvent>();
        let (notify_tx, notify_rx) = crossbeam_channel::unbounded::<ReconcileNotification>();
        let tokens = Arc::clone(&self.tokens);
        let library_root = self.library_root.clone();

        // The worker OWNS its state directly (no shared Mutex): it is the only
        // thread that touches the Index after spawn (INV-1).  This removes the
        // mutex-poisoning failure mode entirely — a panic can no longer poison a
        // lock and permanently wedge the worker.
        let state = WorkerState {
            index: self.index,
            tokens,
            library_root,
            event_tx,
            notify_tx,
        };

        std::thread::Builder::new()
            .name("reconcile-worker".to_string())
            .spawn(move || {
                worker_loop(raw_rx, state, flag);
            })
            .expect("failed to spawn reconcile worker");

        let handle = ReconcilerHandle {
            needs_full_rescan,
            _watcher: watcher,
        };
        (handle, event_rx, notify_rx)
    }

    /// Get a clone of the raw-event sender (for wiring tests / IPC layer).
    #[allow(dead_code)]
    pub(crate) fn raw_sender(&self) -> crossbeam_channel::Sender<RawEvent> {
        self.raw_tx.clone()
    }
}

// ── Worker ────────────────────────────────────────────────────────────────────

struct WorkerState {
    index: Index,
    tokens: Arc<TokenRegistry>,
    library_root: PathBuf,
    event_tx: Sender<ChangeEvent>,
    notify_tx: Sender<ReconcileNotification>,
}

/// Debounce window: coalesce events within this duration before processing.
const DEBOUNCE_MS: u64 = 100;

fn worker_loop(
    raw_rx: Receiver<RawEvent>,
    mut state: WorkerState,
    needs_full_rescan: Arc<AtomicBool>,
) {
    use std::collections::HashMap;
    use std::time::{Duration, Instant};

    let debounce = Duration::from_millis(DEBOUNCE_MS);

    while let Ok(first) = raw_rx.recv() {
        if matches!(first.kind, RawKind::FullRescanNeeded) {
            needs_full_rescan.store(true, Ordering::SeqCst);
            continue;
        }

        // Coalesce: drain for up to DEBOUNCE_MS, keep one event per path.
        let deadline = Instant::now() + debounce;
        let mut coalesced: HashMap<PathBuf, RawKind> = HashMap::new();
        coalesce_one(&mut coalesced, first);

        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                break;
            }
            match raw_rx.recv_timeout(remaining) {
                Ok(ev) => {
                    if matches!(ev.kind, RawKind::FullRescanNeeded) {
                        needs_full_rescan.store(true, Ordering::SeqCst);
                    } else {
                        coalesce_one(&mut coalesced, ev);
                    }
                }
                Err(crossbeam_channel::RecvTimeoutError::Timeout) => break,
                Err(crossbeam_channel::RecvTimeoutError::Disconnected) => return,
            }
        }

        // Build the batch.
        let batch: Vec<(PathBuf, RawKind)> = coalesced.into_iter().collect();

        // Process the batch.  A panic inside reconcile must NOT kill the worker:
        // catch it, log it, request a recovery rescan, and CONTINUE the loop so
        // subsequent batches are still processed.
        //
        // NOTE: this relies on unwinding.  Release builds set `panic = "abort"`
        // (Cargo.toml), where a panic aborts the process before `catch_unwind`
        // runs; the safety net here is effective in dev/test (unwind) builds.
        let state_ref = &mut state;
        let flag_ref = &needs_full_rescan;
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            process_batch(state_ref, flag_ref, &batch);
        }));
        if let Err(panic) = result {
            let msg = panic_message(&panic);
            eprintln!(
                "reconcile worker: panicked while processing a batch: {msg}; \
                       scheduling full rescan and continuing"
            );
            needs_full_rescan.store(true, Ordering::SeqCst);
            continue;
        }
    }
}

/// Process one coalesced batch: reconcile, resolve links, emit events.
fn process_batch(
    state: &mut WorkerState,
    needs_full_rescan: &AtomicBool,
    batch: &[(PathBuf, RawKind)],
) {
    let mut notifications: Vec<ReconcileNotification> = Vec::new();
    let events = reconcile_path::reconcile_batch(
        &mut state.index,
        &state.tokens,
        &state.library_root,
        batch,
        needs_full_rescan,
        &mut notifications,
    );

    if !events.is_empty() {
        let _ = state.index.resolve_links();
    }

    for ev in events {
        let _ = state.event_tx.send(ev);
    }

    for notif in notifications {
        let _ = state.notify_tx.send(notif);
    }
}

/// Extract a human-readable message from a caught panic payload.
fn panic_message(panic: &(dyn std::any::Any + Send)) -> String {
    if let Some(s) = panic.downcast_ref::<&str>() {
        (*s).to_string()
    } else if let Some(s) = panic.downcast_ref::<String>() {
        s.clone()
    } else {
        "<non-string panic payload>".to_string()
    }
}

/// Coalesce a raw event into the map: last event per path wins.
///
/// INV: a CreateOrModify after a Remove means the file was deleted then
/// recreated; the final state is CreateOrModify (the file exists).
/// A Remove after a CreateOrModify means the file was created then deleted;
/// Remove wins.  Taking the latest event is correct for both cases.
fn coalesce_one(map: &mut std::collections::HashMap<PathBuf, RawKind>, ev: RawEvent) {
    map.insert(ev.path, ev.kind);
}

// ── Standalone synchronous reconciler (for tests and mobile foreground) ───────

/// A self-contained reconciler for synchronous use (tests, mobile foreground).
///
/// Unlike the spawned worker, this struct is driven directly by the caller.
/// All reconcile operations are synchronous.
///
/// This is also the mobile foreground path: spec 0013 says `full_rescan` runs
/// on every app foreground — callers just call `sync.full_rescan()`.
pub struct SyncReconciler {
    pub(crate) index: Index,
    pub(crate) tokens: Arc<TokenRegistry>,
    pub(crate) library_root: PathBuf,
    /// Set when an index write fails or an unreadable subtree blocks deletion
    /// detection; the caller should run another `full_rescan` to recover.
    needs_full_rescan: AtomicBool,
}

impl SyncReconciler {
    pub fn new(index: Index, tokens: Arc<TokenRegistry>, library_root: PathBuf) -> Self {
        SyncReconciler {
            index,
            tokens,
            library_root,
            needs_full_rescan: AtomicBool::new(false),
        }
    }

    /// Whether a recovery `full_rescan` has been requested (index error or an
    /// unreadable subtree during deletion detection).
    pub fn needs_full_rescan(&self) -> bool {
        self.needs_full_rescan.load(Ordering::SeqCst)
    }

    /// Reconcile a create/modify event for a single path.
    ///
    /// `path` may be absolute or library-relative.
    pub fn reconcile_path(&mut self, path: &Path) -> Vec<ChangeEvent> {
        let abs = if path.is_absolute() {
            path.to_path_buf()
        } else {
            self.library_root.join(path)
        };
        let mut notifications = Vec::new();
        let events = reconcile_path::reconcile_batch(
            &mut self.index,
            &self.tokens,
            &self.library_root,
            &[(abs, RawKind::CreateOrModify)],
            &self.needs_full_rescan,
            &mut notifications,
        );
        if !events.is_empty() {
            let _ = self.index.resolve_links();
        }
        events
    }

    /// Reconcile a remove event for a single path.
    pub fn reconcile_remove(&mut self, path: &Path) -> Vec<ChangeEvent> {
        let abs = if path.is_absolute() {
            path.to_path_buf()
        } else {
            self.library_root.join(path)
        };
        let mut notifications = Vec::new();
        let events = reconcile_path::reconcile_batch(
            &mut self.index,
            &self.tokens,
            &self.library_root,
            &[(abs, RawKind::Remove)],
            &self.needs_full_rescan,
            &mut notifications,
        );
        if !events.is_empty() {
            let _ = self.index.resolve_links();
        }
        events
    }

    /// Full tree rescan — startup path and mobile foreground path (spec 0013).
    ///
    /// Walks the tree, reconciles new/changed files, removes deleted entries.
    /// Returns all `ChangeEvent`s produced.
    pub fn full_rescan(&mut self) -> Vec<ChangeEvent> {
        let mut notifications = Vec::new();
        let events = rescan::full_rescan(
            &mut self.index,
            &self.tokens,
            &self.library_root,
            &self.needs_full_rescan,
            &mut notifications,
        );
        let _ = self.index.resolve_links();
        events
    }

    /// Immutable borrow of the underlying index for test assertions.
    pub fn index(&self) -> &Index {
        &self.index
    }

    /// Mutable borrow of the underlying index (e.g. to seed test data).
    pub fn index_mut(&mut self) -> &mut Index {
        &mut self.index
    }
}
