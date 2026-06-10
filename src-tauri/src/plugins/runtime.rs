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

use std::sync::atomic::{AtomicI64, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use crossbeam_channel::{Receiver, Sender};
use rquickjs::{Context, Function, Runtime};

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

/// Sentinel meaning "no deadline armed". The interrupt handler treats this as "never fire".
const NO_DEADLINE: i64 = i64::MAX;

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

        let join = std::thread::Builder::new()
            .name(format!("plugin-{}", manifest.id))
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

impl Drop for PluginRuntime {
    fn drop(&mut self) {
        let _ = self.job_tx.send(Job::Shutdown);
        if let Some(j) = self.join.take() {
            let _ = j.join();
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
// __host.__pluginId is injected by the host immediately before this bootstrap runs.
globalThis.__host = Object.assign(globalThis.__host || {}, {
  __regs: { commands: [], views: [] },
  __commands: {},
  __renderer: null,
});
// Force any registered id/name into the plugin's namespace (design-0002:
// "ids are forced into the plugin's namespace"). Idempotent if already prefixed.
function __ns(raw) {
  var p = __host.__pluginId + '.';
  raw = String(raw);
  return raw.indexOf(p) === 0 ? raw : p + raw;
}
globalThis.plugin = {
  registerCommand: function(id, title, handler) {
    if (typeof handler !== 'function') { throw new Error('handler must be a function'); }
    var nid = __ns(id);
    __host.__regs.commands.push({ id: nid, title: String(title) });
    __host.__commands[nid] = handler;
  },
  registerView: function(name) {
    __host.__regs.views.push({ name: __ns(name) });
  },
  registerCodeBlockRenderer: function(fn) {
    if (typeof fn !== 'function') { throw new Error('renderer must be a function'); }
    __host.__renderer = fn;
  },
};
// Host-call entry points, invoked by name from Rust. Each returns a JSON string.
globalThis.__invokeCommand = function(id, argsJson) {
  var fn = __host.__commands[id];
  if (!fn) { throw new Error('command not registered: ' + id); }
  var args = argsJson ? JSON.parse(argsJson) : null;
  var out = fn(args);
  return JSON.stringify(out === undefined ? null : out);
};
globalThis.__invokeRender = function(text, lang) {
  if (!__host.__renderer) { return JSON.stringify({ nodes: [] }); }
  var out = __host.__renderer(text, lang);
  if (out == null) { return JSON.stringify({ nodes: [] }); }
  return JSON.stringify(out);
};
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
    // Build the runtime + context. On any failure here, report and exit.
    let rt = match Runtime::new() {
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
    // overflowing the OS thread stack.
    rt.set_max_stack_size(512 * 1024);

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

    // Evaluate bootstrap + entry source under a command deadline, collecting registrations.
    let init = ctx.with(|ctx| -> Result<Registrations, PluginError> {
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
            // Inject the network bridge only when a `network` permission is declared
            // (INV-SANDBOX: no network surface otherwise).
            if manifest
                .permissions
                .iter()
                .any(|p| p == "network" || p.starts_with("network:"))
            {
                inject_network_api(&ctx, Arc::clone(&grants), manifest.id.clone())?;
            }
            ctx.eval::<(), _>(entry_source.as_bytes())
                .map_err(|e| map_eval_error(&ctx, e, &deadline, &strikes))?;
            collect_registrations(&ctx, &manifest)
        })();
        deadline.disarm();
        res
    });

    match init {
        Ok(regs) => {
            if ready_tx.send(Ok(regs)).is_err() {
                return; // host gave up; nothing to serve.
            }
        }
        Err(e) => {
            let _ = ready_tx.send(Err(e));
            return;
        }
    }

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
                    &deadline,
                    &strikes,
                    COMMAND_DEADLINE,
                    "__invokeCommand",
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
                    &deadline,
                    &strikes,
                    RENDER_DEADLINE,
                    "__invokeRender",
                    CallArgs::Render {
                        text: &text,
                        lang: &lang,
                    },
                );
                let parsed = out.and_then(|json| {
                    let mut ro: RenderOutput = serde_json::from_str(&json).map_err(|e| {
                        PluginError::js_exception(format!("renderer returned bad shape: {e}"))
                    })?;
                    ro.sanitize();
                    Ok(ro)
                });
                let _ = reply.send(parsed);
            }
        }
    }
}

enum CallArgs<'a> {
    Command { id: &'a str, args_json: &'a str },
    Render { text: &'a str, lang: &'a str },
}

/// Run one JS entry-point call with a deadline, panic guard, and strike accounting.
fn run_call(
    ctx: &Context,
    deadline: &Deadline,
    strikes: &Arc<AtomicU64>,
    dur: Duration,
    fn_name: &str,
    args: CallArgs<'_>,
) -> Result<String, PluginError> {
    // INV-PANIC: a panic across the FFI boundary becomes HostInternal, never an abort.
    // (The bin profile uses panic=abort in release, but tests use unwind; the guard is a
    // belt-and-braces boundary regardless.)
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        ctx.with(|ctx| -> Result<String, PluginError> {
            let globals = ctx.globals();
            let func: Function = globals
                .get(fn_name)
                .map_err(|e| PluginError::host_internal(format!("missing {fn_name}: {e}")))?;

            deadline.arm(dur);
            let call_res: Result<String, rquickjs::Error> = match args {
                CallArgs::Command { id, args_json } => {
                    func.call((id.to_string(), args_json.to_string()))
                }
                CallArgs::Render { text, lang } => func.call((text.to_string(), lang.to_string())),
            };
            // NB: do NOT disarm before classifying the error — `map_eval_error` reads
            // `deadline.elapsed()` to distinguish a deadline kill from an ordinary
            // exception, and disarms itself once it has classified. On the success path we
            // disarm here.
            match call_res {
                Ok(s) => {
                    deadline.disarm();
                    Ok(s)
                }
                Err(e) => Err(map_eval_error(&ctx, e, deadline, strikes)),
            }
        })
    }));

    match result {
        Ok(Ok(s)) => Ok(s),
        Ok(Err(e)) => Err(e),
        Err(_) => {
            record_strike(strikes);
            Err(PluginError::host_internal("plugin worker panicked"))
        }
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
/// Ids/names are already namespaced JS-side (the bootstrap forces the `<plugin-id>.`
/// prefix in `registerCommand`/`registerView`); we read them verbatim.
fn collect_registrations(
    ctx: &rquickjs::Ctx<'_>,
    _manifest: &Manifest,
) -> Result<Registrations, PluginError> {
    let globals = ctx.globals();
    let host: rquickjs::Object = globals
        .get("__host")
        .map_err(|e| PluginError::host_internal(format!("bootstrap missing __host: {e}")))?;
    let regs: rquickjs::Object = host
        .get("__regs")
        .map_err(|e| PluginError::host_internal(format!("bootstrap missing __regs: {e}")))?;

    let commands_arr: rquickjs::Array = regs
        .get("commands")
        .map_err(|e| PluginError::host_internal(format!("regs.commands: {e}")))?;
    let mut commands = Vec::new();
    for i in 0..commands_arr.len() {
        let obj: rquickjs::Object = commands_arr
            .get(i)
            .map_err(|e| PluginError::host_internal(format!("regs.commands[{i}]: {e}")))?;
        let id: String = obj.get("id").unwrap_or_default();
        let title: String = obj.get("title").unwrap_or_default();
        commands.push(RegisteredCommand { id, title });
    }

    let views_arr: rquickjs::Array = regs
        .get("views")
        .map_err(|e| PluginError::host_internal(format!("regs.views: {e}")))?;
    let mut views = Vec::new();
    for i in 0..views_arr.len() {
        let obj: rquickjs::Object = views_arr
            .get(i)
            .map_err(|e| PluginError::host_internal(format!("regs.views[{i}]: {e}")))?;
        let name: String = obj.get("name").unwrap_or_default();
        views.push(RegisteredView { name });
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
/// `network:<host>` (exact host match) OR the bare `network` grant. A granted-but-deferred
/// request returns `Unsupported`; an ungranted request returns `NetworkHostNotGranted`.
/// The grant is re-read per call so a revoke bites mid-session (design-0002).
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
                .map(|g| {
                    g.is_granted(&plugin_id, &format!("network:{host}"))
                        || g.is_granted(&plugin_id, "network")
                })
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
    fn render_empty_is_graceful_fallback() {
        let m = manifest_with("[render-code-block]", "[]");
        // No renderer registered → empty nodes → fallback.
        let rt =
            PluginRuntime::spawn(m, String::new(), empty_grants(), std::env::temp_dir()).unwrap();
        let out = rt.render("x", "y").unwrap();
        assert!(out.is_empty());
    }
}
