---
id: docs/tech/design-0004-ipc-boundary
title: Rust ↔ TypeScript boundary and IPC surface
kind: design
status: draft
related: [docs/spec/0007-keyboard-model, docs/spec/0009-search, docs/spec/0013-mobile, docs/tech/adr-0002-tech-stack, docs/tech/design-0001-index-and-reconciliation, docs/tech/design-0002-plugin-host]
supersedes:
---

# Rust ↔ TypeScript boundary and IPC surface

## Context

ADR 0002's follow-up: define what lives in Rust, what lives in TypeScript, and what crosses Tauri IPC. The boundary is the real interface of the application — adr-0003 explicitly treats the UI framework as replaceable *because* this contract, not the framework, carries the architecture.

## Constraints

- The UI never touches the filesystem or SQLite directly; the core never renders (adr-0002).
- One IPC contract for all five targets; mobile lifecycle differences live behind it (0013, design-0001).
- Large result sets must not freeze the webview: streaming or pagination, no megabyte JSON bursts.
- Types are generated, not hand-mirrored: the Rust command/event definitions are the single source; TS bindings are emitted at build time (tauri-specta or equivalent — pinned during scaffold).

## Model

**Lives in Rust (core):** filesystem read/write (atomic path), watcher + reconciler + index (design-0001), frontmatter parse/serialize (canonical write order, 0002), batch operations with journal (tag/person rename, merges), RRULE expansion (0008), search queries (0009), trash operations, settings file I/O (0011), plugin host (design-0002).

**Lives in TypeScript (webview):** all rendering, the editor (design-0003), the command registry and keymap (0007 — commands are a UI concept; core-backed commands invoke IPC inside their handlers), palette/search overlays, calendar layout (the core supplies occurrences; the UI lays them out), focus zones, theming.

**Deliberately duplicated, by spec:** nothing. Where both sides need a rule (e.g. the tag character set), it is defined once in Rust and exposed as a validation command plus a generated constant — drift is a build error, not a runtime surprise.

**Command surface (sketch, names indicative):**

- Entries: `read_entry(path)`, `write_entry(path, text, self_token)`, `create_entry(group, slug?)`, `move_entry`, `rename_entry`, `trash_entry`, `restore_entry`
- Queries: `search(text, filters, sort, cursor)`, `entries_in_group(path, cursor)`, `backlinks(entry_id)`, `calendar_window(from, to, filters)`, `tag_index()`, `people_index()`
- Mutations-at-scale: `rename_tag(old, new)`, `merge_person(a, b)` … → return a `job_id`; progress and completion arrive as events (0007's async long-command rule)
- Settings: `get_settings(scope)`, `set_setting(scope, key, value)`
- Plugins: `list_plugins()`, `set_permission(plugin, grant)`, `invoke_plugin_command(id, args)`

Query commands take a cursor and return bounded pages (search caps at 500 per 0009 anyway); entry bodies stream over Tauri's channel API past a size threshold. Binary assets (avatars, images) never cross IPC as payloads — the webview loads them via the asset protocol with library-scoped access.

**Event surface (core → UI):** `index_changed(paths, kinds)` (debounced, coalesced), `file_conflict(path)`, `job_progress(job_id, done, total)`, `plugin_event(plugin, kind)`, `watcher_state(degraded | ok)`. The UI subscribes once and fans out through its reactive stores; no polling anywhere.

**Self-write token:** `write_entry` returns the token recorded by the reconciler (design-0001) so the originating view ignores its own echo while other views still refresh.

## Interfaces

- Generated TS bindings package consumed by both the app UI and (in reduced, capability-filtered form) the plugin SDK's host-API typings (design-0002) — one schema, two audiences.
- Mobile lifecycle (foreground/background) enters the core as two commands the shell layer calls (`app_foregrounded`, `app_backgrounded`); the UI does not orchestrate rescans (0013, design-0001).

## Failure modes

- **Event storms** (git checkout into the library): the core coalesces `index_changed` to ≤10 events/sec with batched paths; the UI treats any event as "re-query what I show," never as an incremental patch protocol — correctness does not depend on event completeness.
- **Command failure**: every command returns a typed result (`Ok | Err(code, message, detail)`); the UI maps codes to the non-blocking warning surfaces specs prescribe; no stringly-typed errors across the boundary.
- **Version skew** (plugin SDK compiled against older bindings): the host API carries a semver handshake per adr-0005's API-stability rule; mismatches degrade per 0010, not crash.

## Open questions

- tauri-specta vs hand-rolled codegen for the bindings — decide at scaffold time; the requirement (generated, single-source) is fixed, the tool is not.
- Page sizes and the streaming threshold need numbers from the design-0001 benchmarks.
- Whether calendar expansion results are cached core-side per window or recomputed per query — measure first.
