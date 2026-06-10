---
id: docs/tech/adr-0005-plugin-sandbox-engine
title: Plugin sandbox engine
kind: adr
status: accepted
related: [docs/spec/0001-product-vision, docs/spec/0010-plugins, docs/spec/0013-mobile, docs/tech/adr-0002-tech-stack]
supersedes:
---

# Plugin sandbox engine

## Context

ADR 0002 places the plugin runtime in the Rust core as a sandboxed JavaScript engine, isolated from the UI webview, and defers the engine pick (QuickJS vs V8 isolates). 0010 defines what the sandbox must enforce: plugins reach nothing except the typed API for their declared capabilities; permissions gate entries, network hosts, and filesystem paths; a crashing or runaway plugin must not take the app down; revoking a permission suspends behavior immediately.

What plugins actually execute is small: render a code block, run a sync command against a declared host, register palette commands. Throughput is not the constraint. The constraints that matter, in order: containment (deny-by-default must be airtight and auditable), resource control (interrupt a runaway script, cap its memory), binary size (ADR 0002 promises 10–20MB downloads), and build/maintenance burden for a solo developer.

## Decision

**QuickJS, embedded via the `rquickjs` bindings (quickjs-ng line), one runtime per plugin.**

- **Containment by poverty.** QuickJS ships with no I/O, no network, no filesystem, no timers — nothing exists in the global scope except what the host injects. The sandbox audit surface is exactly the API we expose, which is the boundary 0010 already specifies. There is no ambient platform to wall off.
- **Resource control is first-class and simple**: a per-runtime memory limit and an interrupt handler (fuel/deadline) are single calls; a plugin stuck in a loop is killed at the next interrupt check without affecting other plugins, satisfying 0010's crash-containment edge cases.
- **Size and build fit**: a few hundred KB of compiled engine per ADR 0002's binary budget, compiled from source by Cargo on all three platforms with no exotic build steps. One engine instance per plugin is cheap enough (sub-millisecond creation) that isolation between plugins falls out of the architecture.
- ES2020+ support (modules, async generators, BigInt) covers the plugin SDK shapes 0010 needs; the SDK's TypeScript types compile down to plain JS that QuickJS runs as-is.
- **Mobile-compatible by construction.** iOS forbids JIT compilation in shipped apps; QuickJS is a pure interpreter, so the identical plugin host runs on all five v1 targets (0013, adr-0002). This is not incidental — with mobile at full parity, an engine that needs JIT to perform is structurally disadvantaged.

## Alternatives considered

**A. QuickJS via rquickjs (this ADR).** Cons, honestly: interpreter-speed execution (roughly an order of magnitude slower than JIT-ed V8 — irrelevant at plugin workloads, but a real ceiling if someone ships a heavy processor); single-threaded per runtime behind a lock (fine: each plugin gets its own runtime on the plugin host thread pool); **no built-in WebAssembly**, which collides with 0010's "WASM modules may be loaded by JS plugins" — see Consequences; bindings maintenance depends on a smaller open-source project than V8.

**B. V8 isolates via rusty_v8.** Pros: fastest execution, native WASM, the Deno project keeps bindings current. Rejected: the static library adds tens of MB to every platform binary, directly breaking ADR 0002's download-size posture; build times and toolchain weight are notorious; the V8 sandbox model (memory cages reserving ~1TB of virtual address space, evolving API constraints) is engineered for hostile-web-scale threats and brings operational complexity this product does not need; and on iOS (a full-parity v1 target, 0013) V8 must run JIT-less anyway, surrendering its main advantage while keeping all its weight. Choosing V8 here is buying a data-center fence for a garden.

**C. Boa (pure-Rust JS engine).** Attractive direction — one language, no C — but spec conformance and performance still trail QuickJS, and betting the public plugin API on a moving engine is premature. Worth re-evaluating at a future major version of the plugin API.

**D. Run plugins in the UI webview (hidden iframe/worker sandbox).** Zero extra engine. Rejected: it puts third-party code in the same process and origin context as the app UI, makes permission mediation depend on web-platform sandbox subtleties that differ across the three webviews, and contradicts ADR 0002's stated isolation boundary.

**E. WASM-only plugin runtime (wasmtime, no JS).** Cleanest sandbox theory. Rejected as the primary runtime: 0010 commits to JavaScript as the v1 plugin language, and the TS-authoring → WASM toolchain story for casual plugin authors is far heavier than "drop a folder with a .js file in it."

## Consequences

**Good:**

- The permission model in 0010 maps to code almost mechanically: every host function injected into a runtime checks the persisted grants; revocation removes the binding.
- Per-plugin runtimes give crash and memory isolation between plugins for free; the host enforces deadlines centrally.
- Binary stays small; plugin host adds no meaningful download or startup weight.

**Bad / costly:**

- **0010 needs one amendment**: "WASM modules may be loaded by JS plugins" cannot be engine-native. Either the host exposes a mediated WASM facility backed by a Rust runtime such as wasmtime (a new capability, requiring its own ADR per 0010's closed-set rule), or the clause is dropped from v1. Recommendation: drop from v1; revisit on demand.
- A future compute-heavy processor plugin (local semantic search, large diagram layout) may hit the interpreter ceiling; the escape path is host-provided capabilities rather than a faster engine, and that should be the documented answer to plugin authors.
- rquickjs/quickjs-ng is a smaller dependency community than V8; pin versions, vendor if necessary, and keep the engine behind an internal trait so a swap (Boa, V8) stays a bounded change.

## Follow-ups

- Amend 0010: WASM-loading clause (per the consequence above) and record the runtime decision in its open questions. — done (0010 Non-goals and Open questions updated: WASM dropped from v1).
- Design doc: plugin host — runtime lifecycle, thread pool, API injection per capability, permission re-checks, deadline/fuel policy, and the structured error surface for the plugin manager (0010's crash edge cases). — done (`design-0002-plugin-host`).
- Define the engine-abstraction trait so the engine remains swappable at a major version boundary.
