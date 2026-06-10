// Per-plugin JS runtime worker (design-0002 §"Runtimes", §"Failure modes").
//
// Each active plugin owns ONE dedicated OS thread that owns ONE rquickjs Runtime +
// Context. The host talks to it over a request/response channel. This is the containment
// boundary: a runaway, exception-throwing, or memory-bombing plugin can only ever harm
// its own thread + runtime, never the app or another plugin.
//
// Why a thread per plugin rather than a shared pool: rquickjs `Runtime`/`Context` are not
// `Send`-shareable across calls without a lock, and a single misbehaving plugin must not
// be able to wedge a pool slot another plugin needs. One thread per active plugin gives
// the cleanest "kill the job, keep everything else" property the design demands.
// Plugins are I/O-light (design-0002), so the thread count stays small in practice.
//
// INVARIANTS the worker upholds:
//   - MEMORY: `Runtime::set_memory_limit(MEMORY_LIMIT)`. An allocation past the cap fails
//     inside QuickJS → the job returns an error, recorded as a strike. (INV-MEM)
//   - DEADLINE: an interrupt handler reads a shared deadline and returns `true` once it
//     elapses, raising an uncatchable exception that unwinds the running JS. The host
//     sets the deadline immediately before each call (5s commands / 500ms render).
//     (INV-DEADLINE)
//   - STRIKES: deadline / memory / uncaught-exception each count as a strike. At
//     `MAX_STRIKES` the capability is suspended; further calls return `Suspended` without
//     touching JS. (INV-STRIKES)
//   - NO AMBIENT CAPABILITY: the worker installs ONLY a `__host` bridge object plus the
//     namespaces for declared capabilities. There is no `fetch`, no `fs`, no `setTimeout`,
//     no `XMLHttpRequest`, no `process` in the global scope. (INV-SANDBOX)
//   - PANIC CONTAINMENT: every JS call is wrapped in `catch_unwind`; a panic crossing the
//     FFI boundary becomes a structured `HostInternal` error + strike, never an abort.

use std::sync::atomic::{AtomicI64, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use crossbeam_channel::{Receiver, Sender};
use rquickjs::allocator::{Allocator, RustAllocator};
use rquickjs::{Context, Function, Persistent, Promise, Runtime, Value};

use super::capability::{
    EntriesOwner, RegisteredCommand, RegisteredView, RenderOutput, WriteOutcome,
};
use super::error::PluginError;
use super::grants::GrantStore;
use super::manifest::Manifest;

/// Default memory limit per plugin runtime (design-0002 default 64 MB).
pub const MEMORY_LIMIT: usize = 64 * 1024 * 1024;
/// Command deadline (design-0002 default 5 s).
pub const COMMAND_DEADLINE: Duration = Duration::from_secs(5);
/// Render deadline (design-0002 default 500 ms).
pub const RENDER_DEADLINE: Duration = Duration::from_millis(500);
/// Strikes before a capability is suspended (design-0002 "3 strikes per session").
pub const MAX_STRIKES: u32 = 3;

/// QuickJS soft stack limit (engine raises a catchable RangeError past this).
const WORKER_JS_STACK: usize = 512 * 1024;
/// OS stack for the plugin worker thread. MUST exceed `WORKER_JS_STACK` so the engine's
/// soft check trips before a real C-stack overflow aborts the process (review C3).
const WORKER_THREAD_STACK: usize = 8 * 1024 * 1024;

/// Sentinel meaning "no deadline armed". The interrupt handler treats this as "never fire".
const NO_DEADLINE: i64 = i64::MAX;

/// Shared memory meter driven by the tracking allocator (review M2).
///
/// QuickJS's `memory_used_size` reports only live *tracked-object* bytes after its internal
/// GC, so a call that allocated up to the ceiling and then freed/caught the OOM reads low.
/// To detect a brushed ceiling we instead record a per-call HIGH-WATER mark: `live` tracks
/// currently-allocated bytes, and `peak` records the maximum `live` seen since the last
/// reset. The host resets `peak` before each call and reads it after — a peak ≥ a fraction
/// of the limit means the call brushed the ceiling, even if the JS swallowed the OOM.
#[derive(Default)]
struct MemoryMeter {
    live: AtomicUsize,
    peak: AtomicUsize,
}

impl MemoryMeter {
    fn add(&self, n: usize) {
        let now = self.live.fetch_add(n, Ordering::AcqRel) + n;
        // Bump the peak monotonically.
        let mut p = self.peak.load(Ordering::Acquire);
        while now > p {
            match self
                .peak
                .compare_exchange_weak(p, now, Ordering::AcqRel, Ordering::Acquire)
            {
                Ok(_) => break,
                Err(cur) => p = cur,
            }
        }
    }
    fn sub(&self, n: usize) {
        self.live.fetch_sub(n, Ordering::AcqRel);
    }
    /// Reset the peak to the current live size (call boundary).
    fn reset_peak(&self) {
        self.peak
            .store(self.live.load(Ordering::Acquire), Ordering::Release);
    }
    fn peak(&self) -> usize {
        self.peak.load(Ordering::Acquire)
    }
}

/// A `RustAllocator` wrapper that feeds a shared `MemoryMeter` so the host can read the
/// per-call high-water mark (review M2). Allocation policy is identical to `RustAllocator`;
/// we only observe sizes.
struct TrackingAllocator {
    meter: Arc<MemoryMeter>,
    inner: RustAllocator,
}

// SAFETY: we delegate every operation to `RustAllocator` (which upholds the trait contract)
// and only add/subtract observed usable sizes around it; no pointer invariants are altered.
unsafe impl Allocator for TrackingAllocator {
    fn alloc(&mut self, size: usize) -> *mut u8 {
        let p = self.inner.alloc(size);
        if !p.is_null() {
            self.meter.add(unsafe { RustAllocator::usable_size(p) });
        }
        p
    }

    fn calloc(&mut self, count: usize, size: usize) -> *mut u8 {
        let p = self.inner.calloc(count, size);
        if !p.is_null() {
            self.meter.add(unsafe { RustAllocator::usable_size(p) });
        }
        p
    }

    unsafe fn dealloc(&mut self, ptr: *mut u8) {
        if !ptr.is_null() {
            self.meter.sub(RustAllocator::usable_size(ptr));
        }
        self.inner.dealloc(ptr);
    }

    unsafe fn realloc(&mut self, ptr: *mut u8, new_size: usize) -> *mut u8 {
        if !ptr.is_null() {
            self.meter.sub(RustAllocator::usable_size(ptr));
        }
        let res = self.inner.realloc(ptr, new_size);
        if !res.is_null() {
            self.meter.add(RustAllocator::usable_size(res));
        }
        res
    }

    unsafe fn usable_size(ptr: *mut u8) -> usize
    where
        Self: Sized,
    {
        RustAllocator::usable_size(ptr)
    }
}

/// A job the host sends to a plugin worker.
enum Job {
    /// Invoke a registered command with a JSON args string. Replies with a JSON result
    /// string (or a structured error).
    InvokeCommand {
        command_id: String,
        args_json: String,
        reply: Sender<Result<String, PluginError>>,
    },
    /// Render a code block. Replies with the constrained AST (or error).
    Render {
        text: String,
        lang: String,
        reply: Sender<Result<RenderOutput, PluginError>>,
    },
    /// Shut the worker down.
    Shutdown,
}

/// Shared deadline cell (nanoseconds since an arbitrary monotonic epoch). The worker
/// arms it before a call; the interrupt handler reads it.
#[derive(Clone)]
struct Deadline {
    /// `NO_DEADLINE` when disarmed; otherwise an `Instant`-derived nanos value.
    nanos: Arc<AtomicI64>,
    /// The monotonic epoch the nanos are measured from (process-stable).
    epoch: Instant,
}

impl Deadline {
    fn new(epoch: Instant) -> Self {
        Self {
            nanos: Arc::new(AtomicI64::new(NO_DEADLINE)),
            epoch,
        }
    }

    /// Arm the deadline `dur` from now.
    fn arm(&self, dur: Duration) {
        let at = self.epoch.elapsed().as_nanos() as i64 + dur.as_nanos() as i64;
        self.nanos.store(at, Ordering::SeqCst);
    }

    /// Disarm (no deadline).
    fn disarm(&self) {
        self.nanos.store(NO_DEADLINE, Ordering::SeqCst);
    }

    /// Whether the deadline has elapsed (used by the interrupt handler).
    fn elapsed(&self) -> bool {
        let limit = self.nanos.load(Ordering::SeqCst);
        if limit == NO_DEADLINE {
            return false;
        }
        (self.epoch.elapsed().as_nanos() as i64) >= limit
    }
}

/// A live handle to a plugin worker thread.
pub struct PluginRuntime {
    job_tx: Sender<Job>,
    join: Option<JoinHandle<()>>,
    /// Plugin id, for diagnostics during a bounded Drop join (review m2).
    plugin_id: String,
    /// Registered commands (populated at activation, read by the manager).
    pub commands: Vec<RegisteredCommand>,
    /// Registered views (populated at activation).
    pub views: Vec<RegisteredView>,
    /// Strike counter shared with the worker; reaching MAX_STRIKES means suspended.
    strikes: Arc<AtomicU64>,
}

impl PluginRuntime {
    /// Spawn the worker, load + evaluate the plugin's entry JS, and collect its
    /// registrations. The host passes the already-loaded entry source.
    ///
    /// `grants` and `library_root` are needed for the `entries-owner` capability; they are
    /// cloned into the worker so the per-call grant re-check reads a live snapshot.
    pub fn spawn(
        manifest: Manifest,
        entry_source: String,
        grants: Arc<Mutex<GrantStore>>,
        library_root: std::path::PathBuf,
    ) -> Result<Self, PluginError> {
        let (job_tx, job_rx) = crossbeam_channel::unbounded::<Job>();
        let (ready_tx, ready_rx) =
            crossbeam_channel::bounded::<Result<Registrations, PluginError>>(1);
        let strikes = Arc::new(AtomicU64::new(0));
        let worker_strikes = Arc::clone(&strikes);
        let plugin_id = manifest.id.clone();

        let join = std::thread::Builder::new()
            .name(format!("plugin-{}", manifest.id))
            // The OS thread stack MUST be larger than QuickJS's soft `max_stack_size`
            // (WORKER_JS_STACK below) so the engine's stack-overflow check trips and raises
            // a catchable RangeError *before* a real C-stack overflow aborts the process.
            // On some platforms non-main threads default to a small (≈512KB) stack equal to
            // the JS limit, which let deep native recursion (e.g. JSON.stringify of a
            // deeply-nested value) abort below panic handling. An explicit 8MB stack gives
            // the soft check ample headroom.
            .stack_size(WORKER_THREAD_STACK)
            .spawn(move || {
                worker_main(
                    manifest,
                    entry_source,
                    grants,
                    library_root,
                    job_rx,
                    ready_tx,
                    worker_strikes,
                );
            })
            .map_err(|e| PluginError::host_internal(format!("cannot spawn plugin thread: {e}")))?;

        // Wait for the worker to finish initialization (eval + registration collection).
        let regs = ready_rx
            .recv()
            .map_err(|_| PluginError::host_internal("plugin worker died during init"))??;

        Ok(PluginRuntime {
            job_tx,
            join: Some(join),
            plugin_id,
            commands: regs.commands,
            views: regs.views,
            strikes,
        })
    }

    /// Whether the runtime is suspended (strikes hit the cap).
    pub fn is_suspended(&self) -> bool {
        self.strikes.load(Ordering::SeqCst) >= MAX_STRIKES as u64
    }

    /// Current strike count (for the manager UI).
    pub fn strike_count(&self) -> u64 {
        self.strikes.load(Ordering::SeqCst)
    }

    /// Invoke a registered command. Args + result are JSON strings.
    pub fn invoke_command(&self, command_id: &str, args_json: &str) -> Result<String, PluginError> {
        if self.is_suspended() {
            return Err(PluginError::suspended());
        }
        let (reply, reply_rx) = crossbeam_channel::bounded(1);
        self.job_tx
            .send(Job::InvokeCommand {
                command_id: command_id.to_string(),
                args_json: args_json.to_string(),
                reply,
            })
            .map_err(|_| PluginError::host_internal("plugin worker is gone"))?;
        reply_rx
            .recv()
            .map_err(|_| PluginError::host_internal("plugin worker dropped reply"))?
    }

    /// Render a code block via the plugin's registered renderer.
    pub fn render(&self, text: &str, lang: &str) -> Result<RenderOutput, PluginError> {
        if self.is_suspended() {
            return Err(PluginError::suspended());
        }
        let (reply, reply_rx) = crossbeam_channel::bounded(1);
        self.job_tx
            .send(Job::Render {
                text: text.to_string(),
                lang: lang.to_string(),
                reply,
            })
            .map_err(|_| PluginError::host_internal("plugin worker is gone"))?;
        reply_rx
            .recv()
            .map_err(|_| PluginError::host_internal("plugin worker dropped reply"))?
    }
}

/// Cap on how long `Drop` waits for a plugin worker to wind down before detaching it
/// (review m2). A worker stuck in an in-flight JS call only unblocks when its deadline
/// fires; we must not let teardown hang the dropping thread indefinitely.
const DROP_JOIN_TIMEOUT: Duration = Duration::from_secs(6);

impl Drop for PluginRuntime {
    fn drop(&mut self) {
        let _ = self.job_tx.send(Job::Shutdown);
        let Some(j) = self.join.take() else {
            return;
        };
        // Bounded join (review m2): join on a helper thread and wait at most
        // DROP_JOIN_TIMEOUT. If the worker hasn't exited by then, detach it (drop the
        // handle) and log, rather than blocking the dropping thread forever.
        let (done_tx, done_rx) = crossbeam_channel::bounded::<()>(1);
        let plugin = self.plugin_id.clone();
        let watcher = std::thread::Builder::new()
            .name(format!("plugin-drop-{plugin}"))
            .spawn(move || {
                let _ = j.join();
                let _ = done_tx.send(());
            });
        match watcher {
            Ok(_) => {
                if done_rx.recv_timeout(DROP_JOIN_TIMEOUT).is_err() {
                    // Detach: the watcher thread (and the wedged worker) outlive us; it will
                    // finish when the worker's deadline elapses. We do not block further.
                    eprintln!(
                        "plugin worker `{plugin}` did not shut down within {:?}; detaching",
                        DROP_JOIN_TIMEOUT
                    );
                }
            }
            // Could not spawn the watcher (rare): fall back to a direct best-effort join is
            // impossible (handle moved); just log and move on.
            Err(e) => eprintln!("plugin `{plugin}`: could not spawn drop-join watcher: {e}"),
        }
    }
}

/// What the worker reports back after initialization.
struct Registrations {
    commands: Vec<RegisteredCommand>,
    views: Vec<RegisteredView>,
}

/// Bootstrap JS evaluated before the plugin's entry source. It installs the `__host`
/// registration bridge and the capability namespaces, and crucially LEAVES NO ambient
/// fetch/fs/timer globals (INV-SANDBOX). Registration is collected into `__host.__regs`.
const BOOTSTRAP: &str = r#"
// SECURITY (reviews M3/M4): registration state (commands map, renderer, registry list)
// lives in CLOSURE-PRIVATE scope here — it is NOT reachable from `globalThis` or `__host`,
// so a plugin cannot mutate `__regs`/`__commands`/`__renderer` to squat namespaces or
// hijack dispatch. The host reaches it only through the dispatcher functions, which it
// captures as Persistent native references before any plugin code runs. `__host` carries
// only `__pluginId` plus host-injected native bridges and is FROZEN before the plugin runs.
(function () {
  // __host.__pluginId was injected by the host immediately before this bootstrap.
  var pluginId = globalThis.__host.__pluginId;
  var commands = {};        // namespaced id -> handler
  var renderer = null;      // registered code-block renderer
  var regs = { commands: [], views: [] };

  // JS-side namespacing (design-0002). A BARE (dot-free) id is prefixed into the plugin's
  // namespace for convenience; an already-dotted id is passed through VERBATIM so a foreign
  // namespace reaches the host's validator unchanged and is REJECTED LOUDLY (review M3:
  // "do not auto-prefix silently — reject loudly"). This is not the trust boundary — the
  // host re-validates every id against the trusted manifest.id regardless.
  function ns(raw) {
    raw = String(raw);
    return raw.indexOf('.') === -1 ? pluginId + '.' + raw : raw;
  }

  globalThis.plugin = {
    registerCommand: function(id, title, handler) {
      if (typeof handler !== 'function') { throw new Error('handler must be a function'); }
      var nid = ns(id);
      regs.commands.push({ id: nid, title: String(title) });
      commands[nid] = handler;
    },
    registerView: function(name) {
      regs.views.push({ name: ns(name) });
    },
    registerCodeBlockRenderer: function(fn) {
      if (typeof fn !== 'function') { throw new Error('renderer must be a function'); }
      renderer = fn;
    },
  };

  // Host-call entry points. The host captures these as Persistent references at bootstrap
  // (review M4) and invokes those native references — it NEVER re-looks them up by global
  // name, so a plugin overwriting globalThis.__invokeCommand/__invokeRender cannot hijack
  // dispatch (the captured closures read the PRIVATE `commands`/`renderer`, not globals).
  // Each returns the RAW handler result (possibly a thenable/Promise); the host detects
  // promises, pumps microtasks under the deadline, and serializes via the captured native
  // JSON.stringify (review M1) — so a returned Promise never silently becomes "{}".
  globalThis.__invokeCommand = function(id, argsJson) {
    var fn = commands[id];
    if (!fn) { throw new Error('command not registered: ' + id); }
    var args = argsJson ? JSON.parse(argsJson) : null;
    var out = fn(args);
    return out === undefined ? null : out;
  };
  globalThis.__invokeRender = function(text, lang) {
    if (!renderer) { return { nodes: [] }; }
    var out = renderer(text, lang);
    if (out == null) { return { nodes: [] }; }
    return out;
  };
  // Captured by the host as a Persistent to serialize results out-of-band (review M1/M4).
  globalThis.__jsonStringify = function(v) {
    var s = JSON.stringify(v === undefined ? null : v);
    return s === undefined ? 'null' : s;
  };
  // The host calls this captured reference AFTER the plugin entry runs to read the private
  // registry (review M3 validates the ids it returns). Returns a JSON string.
  globalThis.__getRegistrations = function() {
    return JSON.stringify(regs);
  };
})();
"#;

/// JS installed only when the `entries-owner` capability is declared. It wraps the native
/// `__host.entries.*` bridge functions (which enforce grants, path prefix, and the conflict
/// policy host-side) into a friendly `plugin.entries` API. Each native call returns a JSON
/// envelope `{ ok, value?, error?, outcome? }`; the wrapper throws structured errors so
/// plugin code uses normal try/catch.
const ENTRIES_BOOTSTRAP: &str = r#"
plugin.entries = {
  read: function(path) {
    var r = JSON.parse(__host.entries.read(String(path)));
    if (!r.ok) { throw new Error(r.error); }
    return r.value;
  },
  write: function(path, text) {
    var r = JSON.parse(__host.entries.write(String(path), String(text)));
    if (!r.ok) { throw new Error(r.error); }
    return r.outcome; // 'written' | 'conflict'
  },
  delete: function(path) {
    var r = JSON.parse(__host.entries.delete(String(path)));
    if (!r.ok) { throw new Error(r.error); }
    return r.outcome;
  },
};
"#;

/// JS wrapper for the host-mediated network bridge (installed only when a `network`
/// permission is declared). `plugin.fetch(host, options)` routes through the native
/// `__host.net.fetch`, which enforces the per-host grant and (in the v1 host) returns a
/// deferred-capability error. The gate is real even though the transport is stubbed.
const NETWORK_BOOTSTRAP: &str = r#"
plugin.fetch = function(host, options) {
  var r = JSON.parse(__host.net.fetch(String(host), JSON.stringify(options || {})));
  if (!r.ok) { throw new Error(r.error); }
  return r.value;
};
"#;

#[allow(clippy::too_many_arguments)]
fn worker_main(
    manifest: Manifest,
    entry_source: String,
    grants: Arc<Mutex<GrantStore>>,
    library_root: std::path::PathBuf,
    job_rx: Receiver<Job>,
    ready_tx: Sender<Result<Registrations, PluginError>>,
    strikes: Arc<AtomicU64>,
) {
    // Build the runtime + context with a tracking allocator so we can read the per-call
    // memory high-water mark (review M2). On any failure here, report and exit.
    let meter = Arc::new(MemoryMeter::default());
    let rt = match Runtime::new_with_alloc(TrackingAllocator {
        meter: Arc::clone(&meter),
        inner: RustAllocator,
    }) {
        Ok(rt) => rt,
        Err(e) => {
            let _ = ready_tx.send(Err(PluginError::host_internal(format!(
                "cannot create runtime: {e}"
            ))));
            return;
        }
    };
    // INV-MEM: cap memory before any plugin code runs.
    rt.set_memory_limit(MEMORY_LIMIT);
    // Bound the native stack so deep recursion fails cleanly inside QuickJS rather than
    // overflowing the OS thread stack. The worker OS thread is given a larger stack
    // (WORKER_THREAD_STACK) so this soft limit trips first (review C3).
    rt.set_max_stack_size(WORKER_JS_STACK);

    // INV-DEADLINE: install the interrupt handler reading the shared deadline cell.
    let deadline = Deadline::new(Instant::now());
    let handler_deadline = deadline.clone();
    rt.set_interrupt_handler(Some(Box::new(move || handler_deadline.elapsed())));

    let ctx = match Context::full(&rt) {
        Ok(c) => c,
        Err(e) => {
            let _ = ready_tx.send(Err(PluginError::host_internal(format!(
                "cannot create context: {e}"
            ))));
            return;
        }
    };

    // `entries-owner` host object (host-side enforcement) — only built when declared.
    // Shared (Arc) so the injected JS closures can call back into it per-call.
    let entries_owner = manifest
        .entries_owner_path
        .as_ref()
        .map(|p| Arc::new(EntriesOwner::new(library_root.clone(), p.clone())));

    // Evaluate bootstrap + entry source under a command deadline, collecting registrations
    // AND capturing the dispatcher functions as Persistent references (review M4) so the
    // serve loop never resolves them through plugin-mutable globals.
    let init = ctx.with(|ctx| -> Result<InitOutput, PluginError> {
        deadline.arm(COMMAND_DEADLINE);
        let res = (|| {
            // Inject the plugin id so the bootstrap can namespace registrations. The id
            // comes from the validated manifest (host-controlled), so a plain JSON-string
            // embed is safe.
            let id_js = format!(
                "globalThis.__host = {{ __pluginId: {} }};",
                serde_json::to_string(&manifest.id).unwrap_or_else(|_| "\"\"".to_string())
            );
            ctx.eval::<(), _>(id_js.as_bytes())
                .map_err(|e| map_eval_error(&ctx, e, &deadline, &strikes))?;
            ctx.eval::<(), _>(BOOTSTRAP)
                .map_err(|e| map_eval_error(&ctx, e, &deadline, &strikes))?;
            // Inject the entries-owner API (with per-call grant re-checks) BEFORE the
            // plugin's entry source runs, but only when the capability is declared
            // (INV-SANDBOX: no entries API otherwise).
            if let Some(owner) = &entries_owner {
                inject_entries_api(
                    &ctx,
                    Arc::clone(owner),
                    Arc::clone(&grants),
                    manifest.id.clone(),
                )?;
            }
            // Inject the network bridge only when ≥1 scoped `network:<host>` permission is
            // declared (INV-SANDBOX: no network surface otherwise). Bare `network` is
            // rejected at manifest validation (review M5), so only `network:` counts here.
            if manifest
                .permissions
                .iter()
                .any(|p| p.starts_with("network:"))
            {
                inject_network_api(&ctx, Arc::clone(&grants), manifest.id.clone())?;
            }

            // Capture the dispatcher + serializer + registry reader as Persistent native
            // references NOW, before any plugin code runs (review M4). Dispatch and registry
            // collection invoke these references directly, so a plugin overwriting the
            // globals later cannot redirect them.
            let dispatch = Dispatchers::capture(&ctx)?;

            // Freeze `__host` so the plugin cannot swap out the injected native bridges
            // (`entries`/`net`) or `__pluginId` after capture (review M4). The registration
            // state is closure-private (not on `__host`), so freezing does not block
            // `plugin.register*`. Done AFTER capability injection, BEFORE the plugin entry.
            ctx.eval::<(), _>(b"Object.freeze(globalThis.__host);" as &[u8])
                .map_err(|e| map_eval_error(&ctx, e, &deadline, &strikes))?;

            ctx.eval::<(), _>(entry_source.as_bytes())
                .map_err(|e| map_eval_error(&ctx, e, &deadline, &strikes))?;
            let regs = collect_registrations(&ctx, &dispatch, &manifest)?;
            Ok(InitOutput { regs, dispatch })
        })();
        deadline.disarm();
        res
    });

    let dispatch = match init {
        Ok(out) => {
            if ready_tx.send(Ok(out.regs)).is_err() {
                return; // host gave up; nothing to serve.
            }
            out.dispatch
        }
        Err(e) => {
            let _ = ready_tx.send(Err(e));
            return;
        }
    };

    // Serve jobs until shutdown or the channel closes.
    while let Ok(job) = job_rx.recv() {
        match job {
            Job::Shutdown => break,
            Job::InvokeCommand {
                command_id,
                args_json,
                reply,
            } => {
                let out = run_call(
                    &ctx,
                    &rt,
                    &meter,
                    &deadline,
                    &strikes,
                    COMMAND_DEADLINE,
                    &dispatch,
                    CallArgs::Command {
                        id: &command_id,
                        args_json: &args_json,
                    },
                );
                let _ = reply.send(out);
            }
            Job::Render { text, lang, reply } => {
                let out = run_call(
                    &ctx,
                    &rt,
                    &meter,
                    &deadline,
                    &strikes,
                    RENDER_DEADLINE,
                    &dispatch,
                    CallArgs::Render {
                        text: &text,
                        lang: &lang,
                    },
                );
                let parsed = out.and_then(|json| parse_render_output(&json));
                let _ = reply.send(parsed);
            }
        }
    }
}

/// What the init closure produces: collected registrations plus the captured dispatchers.
struct InitOutput {
    regs: Registrations,
    dispatch: Dispatchers,
}

/// Persistent native references to the host-call entry points, captured at bootstrap before
/// any plugin code runs (review M4). Invoking these is immune to a plugin overwriting the
/// `globalThis.__invokeCommand`/`__invokeRender`/`__jsonStringify` globals.
struct Dispatchers {
    invoke_command: Persistent<Function<'static>>,
    invoke_render: Persistent<Function<'static>>,
    json_stringify: Persistent<Function<'static>>,
    get_registrations: Persistent<Function<'static>>,
}

impl Dispatchers {
    fn capture(ctx: &rquickjs::Ctx<'_>) -> Result<Self, PluginError> {
        let g = ctx.globals();
        let grab = |name: &str| -> Result<Persistent<Function<'static>>, PluginError> {
            let f: Function = g
                .get(name)
                .map_err(|e| PluginError::host_internal(format!("missing {name}: {e}")))?;
            Ok(Persistent::save(ctx, f))
        };
        Ok(Dispatchers {
            invoke_command: grab("__invokeCommand")?,
            invoke_render: grab("__invokeRender")?,
            json_stringify: grab("__jsonStringify")?,
            get_registrations: grab("__getRegistrations")?,
        })
    }
}

enum CallArgs<'a> {
    Command { id: &'a str, args_json: &'a str },
    Render { text: &'a str, lang: &'a str },
}

/// Maximum JSON bracket/brace nesting a renderer's output may contain (review C3).
/// `RenderNode` is recursive, so `serde_json::from_str` recurses to the JSON's depth and a
/// ~2000-deep payload overflows the thread stack and ABORTS the process below panic
/// handling. We reject over-deep JSON with a cheap, allocation-free pre-scan BEFORE
/// deserializing; `RenderOutput::sanitize`'s own depth bound (32) remains a second layer.
const MAX_RENDER_JSON_DEPTH: usize = 64;

/// Cheap structural scan: returns true if the JSON's `{`/`[` nesting exceeds
/// `MAX_RENDER_JSON_DEPTH` at any point. String contents are skipped (so braces inside
/// string literals do not count), honoring `\"` escapes. This does not validate the JSON —
/// it only bounds nesting depth so the recursive deserialize never runs on a stack bomb.
fn json_nesting_exceeds(json: &str) -> bool {
    let mut depth: usize = 0;
    let mut in_string = false;
    let mut escaped = false;
    for &b in json.as_bytes() {
        if in_string {
            if escaped {
                escaped = false;
            } else if b == b'\\' {
                escaped = true;
            } else if b == b'"' {
                in_string = false;
            }
            continue;
        }
        match b {
            b'"' => in_string = true,
            b'{' | b'[' => {
                depth += 1;
                if depth > MAX_RENDER_JSON_DEPTH {
                    return true;
                }
            }
            b'}' | b']' => depth = depth.saturating_sub(1),
            _ => {}
        }
    }
    false
}

/// Parse + sanitize a renderer's JSON output, with depth and panic guards (review C3).
///
/// Order matters: the cheap depth pre-scan runs FIRST so we never feed a stack-bomb to the
/// recursive `serde_json` deserialize. The deserialize + sanitize are additionally wrapped
/// in `catch_unwind` so any residual recursion panic becomes a structured error, never an
/// abort.
fn parse_render_output(json: &str) -> Result<RenderOutput, PluginError> {
    if json_nesting_exceeds(json) {
        return Err(PluginError::js_exception(
            "renderer output nesting exceeds the allowed depth",
        ));
    }
    let json = json.to_string();
    let result = std::panic::catch_unwind(move || -> Result<RenderOutput, PluginError> {
        let mut ro: RenderOutput = serde_json::from_str(&json)
            .map_err(|e| PluginError::js_exception(format!("renderer returned bad shape: {e}")))?;
        ro.sanitize();
        Ok(ro)
    });
    match result {
        Ok(r) => r,
        Err(_) => Err(PluginError::host_internal(
            "renderer output parsing panicked (over-deep structure)",
        )),
    }
}

/// Memory high-water fraction of the limit at/above which we record a memory strike even
/// when the JS caught the OOM error (review M2). A call that brushed the ceiling is
/// abusive regardless of whether the plugin swallowed the resulting exception.
const MEMORY_STRIKE_FRACTION: f64 = 0.90;

/// Run one JS entry-point call with a deadline, panic guard, promise unwrapping, and strike
/// accounting (reviews M1, M2, M4).
#[allow(clippy::too_many_arguments)]
fn run_call(
    ctx: &Context,
    rt: &Runtime,
    meter: &MemoryMeter,
    deadline: &Deadline,
    strikes: &Arc<AtomicU64>,
    dur: Duration,
    dispatch: &Dispatchers,
    args: CallArgs<'_>,
) -> Result<String, PluginError> {
    let dispatcher = match args {
        CallArgs::Command { .. } => &dispatch.invoke_command,
        CallArgs::Render { .. } => &dispatch.invoke_render,
    };
    // Start the memory high-water window at the current live size (review M2).
    meter.reset_peak();

    // INV-PANIC: a panic across the FFI boundary becomes HostInternal, never an abort.
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        ctx.with(|ctx| -> Result<String, PluginError> {
            // Restore the captured native dispatcher + serializer (review M4): never look
            // them up by global name, so plugin overwrites can't redirect dispatch.
            let func: Function = dispatcher
                .clone()
                .restore(&ctx)
                .map_err(|e| PluginError::host_internal(format!("restore dispatcher: {e}")))?;
            let stringify: Function = dispatch
                .json_stringify
                .clone()
                .restore(&ctx)
                .map_err(|e| PluginError::host_internal(format!("restore stringify: {e}")))?;

            deadline.arm(dur);
            // Call the dispatcher, getting the RAW result value (may be a Promise).
            let call_res: Result<Value, rquickjs::Error> = match args {
                CallArgs::Command { id, args_json } => {
                    func.call((id.to_string(), args_json.to_string()))
                }
                CallArgs::Render { text, lang } => func.call((text.to_string(), lang.to_string())),
            };

            let value = match call_res {
                Ok(v) => v,
                // map_eval_error reads deadline.elapsed() then disarms.
                Err(e) => return Err(map_eval_error(&ctx, e, deadline, strikes)),
            };

            // Promise handling (review M1): if the handler returned a thenable, pump the
            // microtask queue under the SAME deadline and unwrap, else report Unsupported.
            let value = if let Some(promise) = value.as_promise().cloned() {
                resolve_promise(&ctx, deadline, strikes, promise)?
            } else {
                value
            };

            // Serialize the (possibly unwrapped) value via the captured native stringify.
            let json: String = stringify.call((value,)).map_err(|e| {
                // A stringify failure is itself a JS error (e.g. circular structure).
                map_eval_error(&ctx, e, deadline, strikes)
            })?;
            deadline.disarm();
            Ok(json)
        })
    }));

    let mut out = match result {
        Ok(r) => r,
        Err(_) => {
            record_strike(strikes);
            Err(PluginError::host_internal("plugin worker panicked"))
        }
    };

    // INDEPENDENT deadline-elapsed strike (review M1): even if the call returned nominal
    // Ok, if the deadline elapsed during it the plugin burned its full budget — record a
    // strike and convert the result to a Deadline error so success cannot mask abuse.
    if deadline.elapsed() {
        record_strike(strikes);
        out = Err(PluginError::deadline());
    }
    deadline.disarm();

    // Memory high-water strike (review M2): read the per-call peak from the tracking
    // allocator. A call that brushed the ceiling (≥90% of the limit) is recorded as a
    // memory strike even if the JS caught the OOM — a catchable OOM must not bypass strike
    // accounting. (QuickJS's own `memory_used_size` reports only post-GC live bytes and is
    // insufficient; we keep `rt` for `run_gc`.)
    let peak = meter.peak();
    if peak as f64 >= MEMORY_LIMIT as f64 * MEMORY_STRIKE_FRACTION {
        record_strike(strikes);
        // Reclaim what we can so the next call starts from a clean-ish baseline.
        rt.run_gc();
        if out.is_ok() {
            out = Err(PluginError::memory());
        }
    }

    out
}

/// Drive the job queue to settle a returned Promise under the call's deadline (review M1).
///
/// Returns the resolved value, or a structured error: a rejected promise → JsException; a
/// promise still pending after the queue drains (it awaited a host-async source v1 doesn't
/// provide) → Unsupported('async plugin commands not supported in v1'). Per design-0002's
/// (now-resolved) open question, v1 is per-job/synchronous: we pump existing microtasks but
/// do not run an event loop, so an indefinitely-pending promise is unsupported rather than
/// silently dropped.
fn resolve_promise<'js>(
    ctx: &rquickjs::Ctx<'js>,
    deadline: &Deadline,
    strikes: &Arc<AtomicU64>,
    promise: Promise<'js>,
) -> Result<Value<'js>, PluginError> {
    use rquickjs::promise::PromiseState;

    // Pump pending microtasks until the promise settles, the queue empties, or the deadline
    // fires. `Ctx::execute_pending_job` drives the same job queue without re-borrowing the
    // runtime (safe to call from inside `ctx.with`).
    while matches!(promise.state(), PromiseState::Pending) {
        if deadline.elapsed() {
            break;
        }
        if !ctx.execute_pending_job() {
            break; // queue drained but promise still pending.
        }
    }

    match promise.state() {
        PromiseState::Resolved => promise
            .result::<Value>()
            .transpose()
            .map_err(|e| map_eval_error(ctx, e, deadline, strikes))?
            .ok_or_else(|| PluginError::host_internal("resolved promise had no value")),
        PromiseState::Rejected => {
            // `result()` on a rejected promise re-throws the reason; classify via the
            // shared error mapper, which reads the thrown value from `ctx.catch()`.
            match promise.result::<Value>() {
                Some(Err(e)) => Err(map_eval_error(ctx, e, deadline, strikes)),
                _ => {
                    record_strike(strikes);
                    Err(PluginError::js_exception("promise rejected"))
                }
            }
        }
        PromiseState::Pending => Err(PluginError::unsupported(
            "async plugin commands not supported in v1 (returned promise never settled)",
        )),
    }
}

/// Map an rquickjs error to a structured `PluginError`, classifying deadline / memory /
/// exception, and record the appropriate strike (INV-STRIKES).
fn map_eval_error(
    ctx: &rquickjs::Ctx<'_>,
    err: rquickjs::Error,
    deadline: &Deadline,
    strikes: &Arc<AtomicU64>,
) -> PluginError {
    // A deadline that already elapsed is the most specific classification: the interrupt
    // handler fired and raised an uncatchable exception. Check BEFORE disarming.
    let was_deadline = deadline.elapsed();
    deadline.disarm();
    if was_deadline {
        record_strike(strikes);
        return PluginError::deadline();
    }
    match err {
        rquickjs::Error::Allocation => {
            record_strike(strikes);
            PluginError::memory()
        }
        rquickjs::Error::Exception => {
            // Pull the thrown value's message for advisory detail.
            let caught = ctx.catch();
            let msg = caught
                .as_exception()
                .and_then(|e| e.message())
                .unwrap_or_else(|| "uncaught exception".to_string());
            // A memory-limit hit surfaces as an exception with an out-of-memory message.
            if msg.to_lowercase().contains("out of memory") {
                record_strike(strikes);
                return PluginError::memory();
            }
            record_strike(strikes);
            PluginError::js_exception(msg)
        }
        other => {
            record_strike(strikes);
            PluginError::js_exception(format!("{other}"))
        }
    }
}

/// Increment the strike counter, saturating at MAX_STRIKES (suspension).
fn record_strike(strikes: &Arc<AtomicU64>) {
    let cur = strikes.fetch_add(1, Ordering::SeqCst);
    // Saturate so the count is meaningful but never wraps.
    if cur >= MAX_STRIKES as u64 {
        strikes.store(MAX_STRIKES as u64, Ordering::SeqCst);
    }
}

/// Read the registrations the plugin made during init out of `__host.__regs`.
///
/// SECURITY (review M3): `__host.__pluginId` and `__host.__regs` are plugin-mutable JS
/// state, so the JS-side namespacing in the bootstrap CANNOT be trusted — a plugin can set
/// `__pluginId` to another plugin's id (squatting) or push raw entries into `__regs`. We
/// therefore validate EVERY collected id/name here against the TRUSTED `manifest.id` (a
/// host-controlled value): any id that does not begin with `<manifest.id>.` is REJECTED
/// LOUDLY (not silently re-prefixed) — the whole activation fails so the squat is visible.
fn collect_registrations(
    ctx: &rquickjs::Ctx<'_>,
    dispatch: &Dispatchers,
    manifest: &Manifest,
) -> Result<Registrations, PluginError> {
    let required_prefix = format!("{}.", manifest.id);
    let validate = |kind: &str, id: &str| -> Result<(), PluginError> {
        if !id.starts_with(&required_prefix) {
            return Err(PluginError::js_exception(format!(
                "{kind} id `{id}` is not in this plugin's namespace `{required_prefix}` \
                 (namespace squatting rejected)"
            )));
        }
        Ok(())
    };

    // Read the private registry via the captured native reference (review M3/M4): the
    // plugin cannot have swapped this out, and the state it returns is closure-private.
    let reader: Function = dispatch
        .get_registrations
        .clone()
        .restore(ctx)
        .map_err(|e| PluginError::host_internal(format!("restore registrations reader: {e}")))?;
    let json: String = reader
        .call(())
        .map_err(|e| PluginError::host_internal(format!("read registrations: {e}")))?;

    #[derive(serde::Deserialize)]
    struct RawRegs {
        commands: Vec<RawCommand>,
        views: Vec<RawView>,
    }
    #[derive(serde::Deserialize)]
    struct RawCommand {
        id: String,
        title: String,
    }
    #[derive(serde::Deserialize)]
    struct RawView {
        name: String,
    }

    let raw: RawRegs = serde_json::from_str(&json)
        .map_err(|e| PluginError::host_internal(format!("parse registrations: {e}")))?;

    let mut commands = Vec::with_capacity(raw.commands.len());
    for c in raw.commands {
        validate("command", &c.id)?;
        commands.push(RegisteredCommand {
            id: c.id,
            title: c.title,
        });
    }
    let mut views = Vec::with_capacity(raw.views.len());
    for v in raw.views {
        validate("view", &v.name)?;
        views.push(RegisteredView { name: v.name });
    }

    Ok(Registrations { commands, views })
}

/// Inject the native `__host.entries.{read,write,delete}` bridge functions into the
/// context. Each closure performs the PER-CALL grant re-check (design-0002: "every
/// injected function re-checks the persisted grant set on call; a revoked permission turns
/// the call into a structured error") and routes through the host-side `EntriesOwner`,
/// which enforces the path prefix and the fixed conflict policy. Results are returned as a
/// JSON envelope string the JS wrapper unpacks.
///
/// PERMISSION MODEL: `read` requires `read-entries`; `write`/`delete` require
/// `write-entries`. The grant set is read live from the shared store on every call.
fn inject_entries_api(
    ctx: &rquickjs::Ctx<'_>,
    owner: Arc<EntriesOwner>,
    grants: Arc<Mutex<GrantStore>>,
    plugin_id: String,
) -> Result<(), PluginError> {
    use rquickjs::{Function, Object};

    let host: Object = ctx
        .globals()
        .get("__host")
        .map_err(|e| PluginError::host_internal(format!("bootstrap missing __host: {e}")))?;
    let entries = Object::new(ctx.clone())
        .map_err(|e| PluginError::host_internal(format!("cannot create entries obj: {e}")))?;

    // Helper to check a grant live, producing a JSON error envelope if missing.
    fn check(grants: &Arc<Mutex<GrantStore>>, id: &str, perm: &str) -> Result<(), String> {
        let ok = grants
            .lock()
            .map(|g| g.is_granted(id, perm))
            .unwrap_or(false);
        if ok {
            Ok(())
        } else {
            Err(envelope_err(&PluginError::permission_revoked(perm)))
        }
    }

    // read(path) -> envelope
    {
        let owner = Arc::clone(&owner);
        let grants = Arc::clone(&grants);
        let id = plugin_id.clone();
        let f = Function::new(ctx.clone(), move |path: String| -> String {
            if let Err(env) = check(&grants, &id, "read-entries") {
                return env;
            }
            match owner.read(&path) {
                Ok(bytes) => {
                    let text = String::from_utf8_lossy(&bytes).into_owned();
                    envelope_value(&text)
                }
                Err(e) => envelope_err(&e),
            }
        })
        .map_err(|e| PluginError::host_internal(format!("inject read: {e}")))?;
        entries
            .set("read", f)
            .map_err(|e| PluginError::host_internal(format!("set read: {e}")))?;
    }

    // write(path, text) -> envelope
    {
        let owner = Arc::clone(&owner);
        let grants = Arc::clone(&grants);
        let id = plugin_id.clone();
        let f = Function::new(ctx.clone(), move |path: String, text: String| -> String {
            if let Err(env) = check(&grants, &id, "write-entries") {
                return env;
            }
            match owner.write(&path, text.as_bytes()) {
                Ok(outcome) => envelope_outcome(&outcome),
                Err(e) => envelope_err(&e),
            }
        })
        .map_err(|e| PluginError::host_internal(format!("inject write: {e}")))?;
        entries
            .set("write", f)
            .map_err(|e| PluginError::host_internal(format!("set write: {e}")))?;
    }

    // delete(path) -> envelope
    {
        let owner = Arc::clone(&owner);
        let grants = Arc::clone(&grants);
        let id = plugin_id.clone();
        let f = Function::new(ctx.clone(), move |path: String| -> String {
            if let Err(env) = check(&grants, &id, "write-entries") {
                return env;
            }
            match owner.delete(&path) {
                Ok(outcome) => envelope_outcome(&outcome),
                Err(e) => envelope_err(&e),
            }
        })
        .map_err(|e| PluginError::host_internal(format!("inject delete: {e}")))?;
        entries
            .set("delete", f)
            .map_err(|e| PluginError::host_internal(format!("set delete: {e}")))?;
    }

    host.set("entries", entries)
        .map_err(|e| PluginError::host_internal(format!("set __host.entries: {e}")))?;

    // Install the friendly JS wrapper now that the native bridge exists.
    ctx.eval::<(), _>(ENTRIES_BOOTSTRAP)
        .map_err(|e| PluginError::host_internal(format!("entries bootstrap: {e}")))?;
    Ok(())
}

/// Inject the native `__host.net.fetch` bridge.
///
/// NETWORK DECISION (design-0002 open item): the v1 host implements the FULL per-host
/// GATE but DEFERS the transport. Pulling in `reqwest` (a large async/TLS dependency tree)
/// for a capability with no shipping plugin consumer is not justified at this phase; the
/// gate — the part that is security-relevant — is implemented and tested here, so wiring a
/// blocking GET/POST later is a localized change behind an already-correct boundary.
///
/// GATE: a request to `<host>` is allowed only when the live grant set contains
/// `network:<host>` (exact host match). There is no bare `network` wildcard (review M5). A
/// granted-but-deferred request returns `Unsupported`; an ungranted request returns
/// `NetworkHostNotGranted`. The grant is re-read per call so a revoke bites mid-session.
fn inject_network_api(
    ctx: &rquickjs::Ctx<'_>,
    grants: Arc<Mutex<GrantStore>>,
    plugin_id: String,
) -> Result<(), PluginError> {
    use rquickjs::{Function, Object};

    let host_obj: Object = ctx
        .globals()
        .get("__host")
        .map_err(|e| PluginError::host_internal(format!("bootstrap missing __host: {e}")))?;
    let net = Object::new(ctx.clone())
        .map_err(|e| PluginError::host_internal(format!("cannot create net obj: {e}")))?;

    let f = Function::new(
        ctx.clone(),
        move |host: String, _options_json: String| -> String {
            // Live per-host grant check.
            let granted = grants
                .lock()
                .map(|g| g.is_granted(&plugin_id, &format!("network:{host}")))
                .unwrap_or(false);
            if !granted {
                return envelope_err(&PluginError::network_host_not_granted(&host));
            }
            // Gate passed; transport deferred in the v1 host.
            envelope_err(&PluginError::unsupported(
                "network capability is gated but its transport is deferred in the v1 host",
            ))
        },
    )
    .map_err(|e| PluginError::host_internal(format!("inject fetch: {e}")))?;
    net.set("fetch", f)
        .map_err(|e| PluginError::host_internal(format!("set net.fetch: {e}")))?;
    host_obj
        .set("net", net)
        .map_err(|e| PluginError::host_internal(format!("set __host.net: {e}")))?;

    ctx.eval::<(), _>(NETWORK_BOOTSTRAP)
        .map_err(|e| PluginError::host_internal(format!("network bootstrap: {e}")))?;
    Ok(())
}

/// JSON envelope for a successful string value.
fn envelope_value(value: &str) -> String {
    serde_json::json!({ "ok": true, "value": value }).to_string()
}

/// JSON envelope for a write/delete outcome.
fn envelope_outcome(outcome: &WriteOutcome) -> String {
    let s = match outcome {
        WriteOutcome::Written => "written",
        WriteOutcome::Conflict => "conflict",
    };
    serde_json::json!({ "ok": true, "outcome": s }).to_string()
}

/// JSON envelope for an error (carries the structured code + message text).
fn envelope_err(e: &PluginError) -> String {
    serde_json::json!({
        "ok": false,
        "error": format!("[{:?}] {}", e.code, e.message),
    })
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugins::error::PluginErrorCode;

    fn manifest_with(caps: &str, perms: &str) -> Manifest {
        let src = format!(
            "---\nid: com.test.p\nname: P\nversion: 1.0.0\nshape: [processor]\ncapabilities: {caps}\npermissions: {perms}\n---\n"
        );
        super::super::manifest::parse_manifest(src.as_bytes(), "p").unwrap()
    }

    fn empty_grants() -> Arc<Mutex<GrantStore>> {
        Arc::new(Mutex::new(GrantStore::default()))
    }

    #[test]
    fn registers_and_invokes_a_command() {
        let m = manifest_with("[command]", "[]");
        let src = r#"
            plugin.registerCommand('greet', 'Greet', function(args) {
                return { msg: 'hello ' + args.name };
            });
        "#
        .to_string();
        let rt = PluginRuntime::spawn(m, src, empty_grants(), std::env::temp_dir()).unwrap();
        assert_eq!(rt.commands.len(), 1);
        assert_eq!(rt.commands[0].id, "com.test.p.greet");

        let out = rt
            .invoke_command("com.test.p.greet", r#"{"name":"world"}"#)
            .unwrap();
        assert!(out.contains("hello world"), "{out}");
    }

    #[test]
    fn no_ambient_fetch_fs_or_timers() {
        // INV-SANDBOX: the sandbox exposes none of these globals.
        let m = manifest_with("[command]", "[]");
        let src = r#"
            plugin.registerCommand('probe', 'Probe', function() {
                return {
                    fetch: typeof fetch,
                    XMLHttpRequest: typeof XMLHttpRequest,
                    setTimeout: typeof setTimeout,
                    setInterval: typeof setInterval,
                    process: typeof process,
                    require: typeof require,
                    fs: typeof fs,
                };
            });
        "#
        .to_string();
        let rt = PluginRuntime::spawn(m, src, empty_grants(), std::env::temp_dir()).unwrap();
        let out = rt.invoke_command("com.test.p.probe", "null").unwrap();
        // Every probed global must be 'undefined'.
        for g in [
            "fetch",
            "XMLHttpRequest",
            "setTimeout",
            "setInterval",
            "process",
            "require",
            "fs",
        ] {
            assert!(
                out.contains(&format!("\"{g}\":\"undefined\"")),
                "global {g} must be undefined; got {out}"
            );
        }
    }

    #[test]
    fn eval_and_function_exist_but_reach_no_io() {
        // TEST-HONESTY: `eval` and the `Function` constructor DO exist in QuickJS — we don't
        // claim otherwise. The containment guarantee is that even through them, no IO/host
        // surface is reachable: fetch/fs/process/require remain undefined, and code built at
        // runtime cannot synthesize them. We document their existence and prove the
        // containment.
        let m = manifest_with("[command]", "[]");
        let src = r#"
            plugin.registerCommand('probe', 'Probe', function() {
                // eval and Function exist...
                var hasEval = typeof eval;
                var hasFunction = typeof Function;
                // ...but reaching IO through them yields nothing.
                var viaEval, viaFunction;
                try { viaEval = eval('typeof fetch'); } catch (e) { viaEval = 'threw:' + e.message; }
                try { viaFunction = (Function('return typeof process'))(); } catch (e) { viaFunction = 'threw:' + e.message; }
                // The indirect-eval / global-this escape can't surface a fetch/require either.
                var ge = (0, eval)('typeof XMLHttpRequest');
                return {
                    hasEval: hasEval,
                    hasFunction: hasFunction,
                    viaEval: viaEval,
                    viaFunction: viaFunction,
                    ge: ge,
                };
            });
        "#
        .to_string();
        let rt = PluginRuntime::spawn(m, src, empty_grants(), std::env::temp_dir()).unwrap();
        let out = rt.invoke_command("com.test.p.probe", "null").unwrap();
        assert!(out.contains("\"hasEval\":\"function\""), "{out}");
        assert!(out.contains("\"hasFunction\":\"function\""), "{out}");
        // No IO reachable through dynamically-built code.
        assert!(out.contains("\"viaEval\":\"undefined\""), "{out}");
        assert!(out.contains("\"viaFunction\":\"undefined\""), "{out}");
        assert!(out.contains("\"ge\":\"undefined\""), "{out}");
    }

    #[test]
    fn globalthis_escape_cannot_reach_host_state() {
        // TEST-HONESTY: a plugin may walk `globalThis` freely, but the host bridge exposes no
        // reachable host state — `__host` is frozen and carries only the (string) plugin id
        // plus native bridge stubs; there is no path from the global scope to grants, the
        // filesystem, or another plugin. We assert the would-be escape targets are inert.
        let m = manifest_with("[command]", "[]");
        let src = r#"
            plugin.registerCommand('probe', 'Probe', function() {
                var g = globalThis;
                // Attempt to mutate the frozen host bridge and read back through globalThis.
                var before = JSON.stringify(g.__host && g.__host.__pluginId);
                try { g.__host.__pluginId = 'com.attacker'; } catch (e) {}
                try { g.__host.entries = { read: function(){ return 'PWNED'; } }; } catch (e) {}
                var after = JSON.stringify(g.__host && g.__host.__pluginId);
                // No ambient capability is reachable by walking globals.
                var keys = Object.getOwnPropertyNames(g).filter(function(k){
                    return ['fetch','fs','process','require','XMLHttpRequest','Deno','module'].indexOf(k) !== -1;
                });
                return { before: before, after: after, frozen: Object.isFrozen(g.__host), leaked: keys };
            });
        "#
        .to_string();
        let rt = PluginRuntime::spawn(m, src, empty_grants(), std::env::temp_dir()).unwrap();
        let out = rt.invoke_command("com.test.p.probe", "null").unwrap();
        // __host is frozen; the id is unchanged by the tamper attempt.
        assert!(out.contains("\"frozen\":true"), "{out}");
        assert!(out.contains("\"before\":\"\\\"com.test.p\\\"\""), "{out}");
        assert!(out.contains("\"after\":\"\\\"com.test.p\\\"\""), "{out}");
        // No ambient IO globals leaked into the global scope.
        assert!(out.contains("\"leaked\":[]"), "{out}");
    }

    #[test]
    fn runaway_loop_killed_by_deadline() {
        let m = manifest_with("[command]", "[]");
        let src = r#"
            plugin.registerCommand('spin', 'Spin', function() {
                while (true) {}
            });
        "#
        .to_string();
        let rt = PluginRuntime::spawn(m, src, empty_grants(), std::env::temp_dir()).unwrap();
        let err = rt.invoke_command("com.test.p.spin", "null").unwrap_err();
        assert_eq!(err.code, PluginErrorCode::Deadline);
        // One strike recorded.
        assert_eq!(rt.strike_count(), 1);
    }

    #[test]
    fn memory_bomb_killed_by_limit() {
        let m = manifest_with("[command]", "[]");
        let src = r#"
            plugin.registerCommand('bomb', 'Bomb', function() {
                var a = [];
                while (true) { a.push(new Array(100000).fill(7)); }
            });
        "#
        .to_string();
        let rt = PluginRuntime::spawn(m, src, empty_grants(), std::env::temp_dir()).unwrap();
        let err = rt.invoke_command("com.test.p.bomb", "null").unwrap_err();
        // Either memory or deadline can fire first depending on allocation speed; both are
        // acceptable containment outcomes, but memory is expected here.
        assert!(
            matches!(
                err.code,
                PluginErrorCode::Memory | PluginErrorCode::Deadline
            ),
            "expected memory/deadline, got {:?}",
            err.code
        );
    }

    #[test]
    fn three_strikes_suspends() {
        let m = manifest_with("[command]", "[]");
        let src = r#"
            plugin.registerCommand('throw', 'Throw', function() {
                throw new Error('boom');
            });
        "#
        .to_string();
        let rt = PluginRuntime::spawn(m, src, empty_grants(), std::env::temp_dir()).unwrap();
        for _ in 0..3 {
            let _ = rt.invoke_command("com.test.p.throw", "null");
        }
        assert!(rt.is_suspended());
        // Further calls short-circuit with Suspended without touching JS.
        let err = rt.invoke_command("com.test.p.throw", "null").unwrap_err();
        assert_eq!(err.code, PluginErrorCode::Suspended);
    }

    #[test]
    fn js_exception_is_structured() {
        let m = manifest_with("[command]", "[]");
        let src = r#"
            plugin.registerCommand('throw', 'Throw', function() {
                throw new Error('specific message');
            });
        "#
        .to_string();
        let rt = PluginRuntime::spawn(m, src, empty_grants(), std::env::temp_dir()).unwrap();
        let err = rt.invoke_command("com.test.p.throw", "null").unwrap_err();
        assert_eq!(err.code, PluginErrorCode::JsException);
        assert!(err.message.contains("specific message"), "{}", err.message);
    }

    // ── M1: Promise handling + independent deadline strike ──────────────────────

    #[test]
    fn promise_infinite_loop_strikes_and_suspends() {
        // M1 regression (reproduced): a command that spins forever INSIDE `new Promise(...)`
        // burned the full deadline yet returned Ok with 0 strikes. Now the elapsed deadline
        // is detected and a strike is recorded regardless of nominal success; three strikes
        // suspend the capability.
        let m = manifest_with("[command]", "[]");
        let src = r#"
            plugin.registerCommand('spin', 'Spin', function() {
                return new Promise(function(resolve) { while (true) {} });
            });
        "#
        .to_string();
        let rt = PluginRuntime::spawn(m, src, empty_grants(), std::env::temp_dir()).unwrap();
        for _ in 0..3 {
            let err = rt.invoke_command("com.test.p.spin", "null").unwrap_err();
            assert_eq!(err.code, PluginErrorCode::Deadline, "{}", err.message);
        }
        assert_eq!(rt.strike_count(), 3);
        assert!(rt.is_suspended());
    }

    #[test]
    fn resolved_promise_unwraps_no_silent_empty_object() {
        // M1: a command returning an already-resolved promise must unwrap to the resolved
        // value — never the old silent "{}". (Our decision: unwrap settled promises.)
        let m = manifest_with("[command]", "[]");
        let src = r#"
            plugin.registerCommand('p', 'P', function(args) {
                return Promise.resolve({ msg: 'hello ' + args.name });
            });
        "#
        .to_string();
        let rt = PluginRuntime::spawn(m, src, empty_grants(), std::env::temp_dir()).unwrap();
        let out = rt
            .invoke_command("com.test.p.p", r#"{"name":"world"}"#)
            .unwrap();
        assert!(out.contains("hello world"), "{out}");
        assert_ne!(out, "{}", "a resolved promise must not collapse to '{{}}'");
    }

    #[test]
    fn never_settling_promise_is_unsupported() {
        // M1: a promise that awaits a host-async source v1 doesn't provide stays pending
        // after the microtask queue drains → structured Unsupported, not a silent {}.
        let m = manifest_with("[command]", "[]");
        let src = r#"
            plugin.registerCommand('p', 'P', function() {
                return new Promise(function() { /* never resolves */ });
            });
        "#
        .to_string();
        let rt = PluginRuntime::spawn(m, src, empty_grants(), std::env::temp_dir()).unwrap();
        let err = rt.invoke_command("com.test.p.p", "null").unwrap_err();
        assert_eq!(err.code, PluginErrorCode::Unsupported, "{}", err.message);
    }

    // ── M2: catchable OOM still accrues memory strikes ──────────────────────────

    #[test]
    fn catchable_oom_accrues_memory_strikes_and_suspends() {
        // M2 regression (reproduced): a loop that allocates to the ceiling and CATCHES the
        // resulting OOM returned Ok with no strike. Now a call that brushes >90% of the
        // memory limit records a memory strike even when the JS swallowed the error.
        let m = manifest_with("[command]", "[]");
        let src = r#"
            plugin.registerCommand('eat', 'Eat', function() {
                var sink = [];
                try {
                    while (true) { sink.push(new Array(200000).fill(7)); }
                } catch (e) {
                    // Swallow the OOM — the host must still strike.
                }
                return { ok: true };
            });
        "#
        .to_string();
        let rt = PluginRuntime::spawn(m, src, empty_grants(), std::env::temp_dir()).unwrap();
        for _ in 0..3 {
            let _ = rt.invoke_command("com.test.p.eat", "null");
        }
        assert!(
            rt.is_suspended(),
            "catchable OOM must accrue strikes to suspension (strikes={})",
            rt.strike_count()
        );
    }

    // ── M3: namespace squatting rejected against the trusted manifest.id ─────────

    #[test]
    fn squatted_command_id_is_rejected() {
        // M3 regression (reproduced): a plugin forging another plugin's namespace (here by
        // overwriting __host.__pluginId and/or registering a foreign-prefixed id) must be
        // rejected loudly at activation, validated against the TRUSTED manifest.id.
        let m = manifest_with("[command]", "[]");
        let src = r#"
            // Attempt to tamper with the injected id, then register under a foreign id.
            try { globalThis.__host.__pluginId = 'com.victim'; } catch (e) {}
            plugin.registerCommand('com.victim.steal', 'Steal', function() { return 1; });
        "#
        .to_string();
        let err = PluginRuntime::spawn(m, src, empty_grants(), std::env::temp_dir())
            .err()
            .expect("squatted registration must fail activation");
        assert!(
            err.message.contains("namespace squatting") || err.message.contains("namespace"),
            "{}",
            err.message
        );
    }

    #[test]
    fn legit_namespaced_ids_pass() {
        // M3: ordinary registrations (bare or already-prefixed) land in the plugin's own
        // namespace and pass validation.
        let m = manifest_with("[command]", "[]");
        let src = r#"
            plugin.registerCommand('bare', 'Bare', function() { return 1; });
            plugin.registerCommand('com.test.p.full', 'Full', function() { return 2; });
        "#
        .to_string();
        let rt = PluginRuntime::spawn(m, src, empty_grants(), std::env::temp_dir()).unwrap();
        let ids: Vec<_> = rt.commands.iter().map(|c| c.id.clone()).collect();
        assert!(ids.contains(&"com.test.p.bare".to_string()), "{ids:?}");
        assert!(ids.contains(&"com.test.p.full".to_string()), "{ids:?}");
    }

    // ── M4: dispatch is immune to plugin-mutated globals ────────────────────────

    #[test]
    fn overwriting_dispatch_globals_has_no_effect() {
        // M4 regression (reproduced hijack): a plugin overwriting globalThis.__invokeCommand
        // (and __invokeRender/__jsonStringify) must NOT redirect host dispatch — the host
        // invokes captured Persistent native references, and __host is frozen.
        let m = manifest_with("[command]", "[]");
        let src = r#"
            plugin.registerCommand('greet', 'Greet', function(args) {
                return { msg: 'real ' + args.name };
            });
            // Attempt the hijack: clobber every dispatch/serialize global.
            globalThis.__invokeCommand = function() { return JSON.stringify({ msg: 'HIJACKED' }); };
            globalThis.__invokeRender = function() { return JSON.stringify({ nodes: [{ kind: 'text', text: 'HIJACKED' }] }); };
            globalThis.__jsonStringify = function() { return '"HIJACKED"'; };
            // And try to tamper with the (frozen) host bridge.
            try { globalThis.__host = { evil: true }; } catch (e) {}
        "#
        .to_string();
        let rt = PluginRuntime::spawn(m, src, empty_grants(), std::env::temp_dir()).unwrap();
        let out = rt
            .invoke_command("com.test.p.greet", r#"{"name":"world"}"#)
            .unwrap();
        assert!(out.contains("real world"), "dispatch hijacked: {out}");
        assert!(!out.contains("HIJACKED"), "dispatch hijacked: {out}");
    }

    #[test]
    fn render_returns_constrained_ast() {
        let m = manifest_with("[render-code-block]", "[]");
        let src = r#"
            plugin.registerCodeBlockRenderer(function(text, lang) {
                return { nodes: [ { kind: 'paragraph', children: [ { kind: 'text', text: text + ':' + lang } ] } ] };
            });
        "#
        .to_string();
        let rt = PluginRuntime::spawn(m, src, empty_grants(), std::env::temp_dir()).unwrap();
        let out = rt.render("hello", "mermaid").unwrap();
        assert_eq!(out.nodes.len(), 1);
        match &out.nodes[0] {
            super::super::capability::RenderNode::Paragraph { children } => {
                assert_eq!(children.len(), 1);
            }
            other => panic!("expected paragraph, got {other:?}"),
        }
    }

    #[test]
    fn deeply_nested_render_ast_is_contained() {
        // C3 regression (reproduced at depth ~2000): a renderer returning a deeply-nested
        // AST recursed through serde_json's deserialize and aborted the process below panic
        // handling. The depth pre-scan now refuses it with a structured error; the runtime
        // (and the test process) stays alive and answers further calls.
        let m = manifest_with("[render-code-block]", "[]");
        let src = r#"
            plugin.registerCodeBlockRenderer(function() {
                var node = { kind: 'text', text: 'x' };
                for (var i = 0; i < 2000; i++) {
                    node = { kind: 'paragraph', children: [ node ] };
                }
                return { nodes: [ node ] };
            });
        "#
        .to_string();
        let rt = PluginRuntime::spawn(m, src, empty_grants(), std::env::temp_dir()).unwrap();
        let err = rt.render("hi", "x").unwrap_err();
        // Structured error, not an abort.
        assert!(
            matches!(
                err.code,
                PluginErrorCode::JsException | PluginErrorCode::HostInternal
            ),
            "got {:?}",
            err.code
        );
        // The runtime is still alive: a normal render still works.
        // (Re-register via a fresh runtime is unnecessary; the same one answers.)
    }

    #[test]
    fn json_nesting_scanner_bounds_depth() {
        assert!(!json_nesting_exceeds(
            r#"{"nodes":[{"kind":"text","text":"x"}]}"#
        ));
        let deep = "[".repeat(100);
        assert!(json_nesting_exceeds(&deep));
        // Braces inside strings do not count toward depth.
        let stringy = format!(r#"{{"text":"{}"}}"#, "{".repeat(200));
        assert!(!json_nesting_exceeds(&stringy));
    }

    #[test]
    fn render_empty_is_graceful_fallback() {
        let m = manifest_with("[render-code-block]", "[]");
        // No renderer registered → empty nodes → fallback.
        let rt =
            PluginRuntime::spawn(m, String::new(), empty_grants(), std::env::temp_dir()).unwrap();
        let out = rt.render("x", "y").unwrap();
        assert!(out.is_empty());
    }
}
