---
id: docs/tech/design-0002-plugin-host
title: Plugin host architecture
kind: design
status: draft
related: [docs/spec/0010-plugins, docs/spec/0011-settings, docs/tech/adr-0002-tech-stack, docs/tech/adr-0005-plugin-sandbox-engine, docs/tech/design-0004-ipc-boundary]
supersedes:
---

# Plugin host architecture

## Context

adr-0005 picks QuickJS via `rquickjs`, one runtime per plugin, hosted in the Rust core (adr-0002). 0010 defines the contract the host must enforce: capability-scoped API, permission gating, crash containment, immediate revocation, and the fixed provider conflict policy. This doc specifies how.

## Constraints

- A plugin sees nothing but the API injected for its declared capabilities; permission checks happen on every host call, not at injection time only (revocation must bite mid-session, per 0010).
- A runaway or crashing plugin is contained: no UI jank, no app crash, no effect on other plugins.
- Identical behavior on all five targets; interpreter-only on iOS (adr-0005).
- Disk writes by plugins go through the same atomic write path as the editor (0010, 0006).

## Model

**Lifecycle.** `discovered → manifest-validated → permissions-pending → active → (suspended | failed)`. Discovery scans `.tonotedo/plugins/*/plugin.md` at launch and on the reload command. Invalid manifest → ignored with a warning (0010 edge case). First activation prompts for permissions.

**Grant store location (device-local, app-private).** The grant set persists in **device-local** OS app-config storage — *outside* the synced library — in a file keyed by a hash of the canonical library-root path. It is **never** written into `.tonotedo/`, and any `plugin-grants.json` found inside the library is **ignored on load and the user is warned**.

Security rationale (the synced-grants attack): an earlier design stored grants at `<library>/.tonotedo/state/plugin-grants.json`. Because plugins (and `.tonotedo/state`) travel with the library via sync (0013), an attacker (or a compromised/co-operating sync peer) could author a grants file that pre-authorizes full permissions; on a fresh device the host would trust it and activate a plugin with **zero prompts**. Moving grants to per-device app-private storage breaks this: synced-in state can never be trusted as a grant.

Consequence (intended, per 0013/0010): because grants are per-device, a plugin synced in from another device is always **permissions-pending** on a new device and the user must re-prompt before it activates. This per-device re-prompt is the deliberate, specified behavior — plugins travel with the library, but the *decision to trust* them does not.

**Runtimes.** One `rquickjs` Runtime+Context per active plugin, owned by a dedicated plugin-host thread pool (N small threads; plugins are I/O-light). Each runtime gets: a memory limit (default 64MB), an interrupt handler driven by a per-call deadline (default 5s for commands, 500ms for `render-code-block`), and a microtask pump integrated with the host's async executor. Exceeding limits kills the job, not the app; repeated kills (3 strikes per session) suspend the capability and surface in the plugin manager.

**Capability injection.** At context creation, the host injects only the namespaces for declared capabilities:

- `command` → `registerCommand(id, handler)`; ids are forced into the plugin's namespace; registrations bridge to the UI command registry over the event channel (design-0004).
- `view` → `registerView(name, renderSpec)`; names are namespaced; the rendering resolution (0002) sees them as addressable views.
- `render-code-block` → the host calls the plugin's registered renderer with the block text and language; output is sanitized markup rendered in an isolated container in the webview, never raw HTML injection.
- `entries-owner` → read/write/delete entry APIs that hard-check the path prefix against the declared group subtree and route writes through the atomic write path; the conflict policy (0010) is implemented here, not in plugins — a write to a user-modified entry returns a `Conflict` result the plugin cannot override.

Every injected function re-checks the persisted grant set on call; a revoked permission turns the call into a structured `PermissionRevoked` error.

**Network and filesystem permissions.** `network:<host-pattern>` grants gate a host-provided `fetch`-like API (no raw sockets); the host enforces the pattern at request time. `filesystem:<path-pattern>` grants gate explicit read/write APIs for paths outside the library. There is no ambient `fetch` or `fs` in the runtime.

**Settings.** The manifest's settings schema (0010) renders in the app's settings surface; values store per-library in app-private state, except `secret` fields, which go to the OS keychain/keystore and are handed to the plugin only at call time.

## Interfaces

- Plugin-facing: a single typed API surface published as a TypeScript declaration package; plugins author in TS, ship compiled JS (ES2020).
- Host-facing: the plugin host is a core module behind a trait (`EngineHost`) so the engine can be swapped at a major version (adr-0005 follow-up); the UI talks to plugins only via the command/event bridge (design-0004), never directly.

## Failure modes

- **Plugin throws / panics inside JS** → job fails with a structured error; logged; surfaced as a non-blocking notification (0010 edge case).
- **Deadline exceeded** → interrupt fires, job killed, strike recorded.
- **Memory limit hit** → allocation fails inside the runtime; job killed; strike recorded.
- **Two plugins claim one `entries-owner` path** → second activation rejected with a clear error (0010).
- **Host thread pool exhaustion** (many slow plugins) → jobs queue with the palette's progress affordance (0007); the UI thread is never blocked by construction.

## Open questions

- Deadline/fuel defaults need empirical tuning once real plugins exist; the numbers above are starting points, not commitments.
- Async shape of the plugin API: promises pumped per-job vs a long-lived event loop per plugin. **Resolved for v1 (review M1):** per-job, under the call's existing deadline. When a command/renderer returns a thenable/Promise, the host drains the microtask queue *under the same deadline* and unwraps the resolved value; a Promise still pending after the queue drains (i.e. it awaited a host async source v1 does not provide) yields a structured `Unsupported('async plugin commands not supported in v1')` rather than a silent `{}`. This keeps containment (the deadline still bounds the whole call) and gives a real provider plugin a deterministic answer; a long-lived event loop is deferred until a shipping provider needs genuine host-async I/O.
- Whether `render-code-block` output is a sanitized HTML subset or a constrained AST the UI renders; the AST is safer and is the working assumption.
