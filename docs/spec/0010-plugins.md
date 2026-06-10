---
id: docs/spec/0010-plugins
title: Plugins (providers and processors)
kind: feature
status: accepted
related: [docs/spec/0001-product-vision, docs/spec/0002-entries, docs/spec/0006-markdown-editor, docs/spec/0007-keyboard-model, docs/tech/adr-0001-storage-format, docs/tech/adr-0002-tech-stack, docs/tech/adr-0005-plugin-sandbox-engine]
---

# Plugins (providers and processors)

## Problem

The vision lists plugins as a pillar and also lists three anti-pillars that constrain plugins: no forced cloud, no AI-everywhere, no ugly database feeling. The contract has to be expressive enough that real extensions (calendar sync, math rendering, AI summarization for those who want it, git auto-commit, RSS) can be built — but tight enough that a plugin cannot turn the app into something that fights the pillars.

The two extension shapes match the two natural seams in the app: things that bring entries in or push them out (**providers**), and things that change how existing entries are read or displayed (**processors**). Both run locally, both are sandboxed, both are optional.

## User stories

- I install a "Google Calendar" provider plugin. It owns the `Calendar/Google/` group. When I invoke its `gcal.sync` command, it pulls events into that group as normal entries; I can drag, tag, and filter them.
- I install a "Mermaid" processor plugin. Fenced ```mermaid blocks render as diagrams in the editor. No core change.
- I install a "git commit" plugin. It registers a `git.commit` command; I bind it to a key and commit manually after a writing session.
- A plugin asks for permission to read my entries the first time it runs. I grant or deny it; the choice is durable.
- I uninstall a plugin. The entries it produced stay on disk (they are normal `.md` files); the processor effects revert to plain markdown.
- I write a small plugin myself. The plugin's source is markdown + code in one folder. I drop it into `.tonotedo/plugins/` and it loads.

## Behavior

**Two shapes.**

- **Providers** create, update, and remove entries based on an outside source: a remote service, a feed, a filesystem somewhere else, a sensor. Providers own a group (or a subtree of groups); entries inside it are the provider's responsibility.
- **Processors** transform existing entries at read or render time: render a code block as a diagram, expose a "summarize" command, run a link checker. Processors never own entries; they read and may suggest edits, but the user (or a separate provider) writes.

A plugin can be one shape, the other, or both.

**Manifest.** Every plugin ships a `plugin.md` with frontmatter:

```yaml
---
id: com.example.mermaid
name: Mermaid renderer
version: 0.1.0
shape: [processor]
capabilities: [render-code-block]
permissions: [read-entries]
---
```

The body of `plugin.md` is the plugin's README; the app surfaces it in the plugin manager.

**Capabilities.** A plugin declares the seams it hooks into. v1 capability set is intentionally small:

- `command` — processor or provider; registers commands that show up in the palette and keymap (see 0007).
- `view` — processor; provides an entry view (see 0002 rendering).
- `render-code-block` — processor; takes a code block, returns rendered output.
- `entries-owner` — provider; declares a group path the plugin owns. Sync, import, and export are expressed as commands the user invokes on this group (no scheduled background sync in v1).

The set is closed in v1. Extending it (`watcher`, `render-property`, scheduled `sync`, etc.) requires an ADR.

**Permissions.** A plugin requests scoped permissions in its manifest: `read-entries`, `write-entries`, `network` (each requested host pattern is its own permission entry, e.g. `network:api.example.com`), `filesystem` (a path pattern outside the library). Registering commands is not a permission — it is the `command` capability above; capabilities describe what a plugin hooks into, permissions gate what it can touch. On first run, the user sees the requested permissions in plain language and confirms. Permissions are persisted; revoking a permission disables the plugin's affected behaviors. No silent permission upgrade across versions.

**Settings.** Plugins declare a settings schema in their manifest — a list of typed fields (`string`, `boolean`, `number`, `enum`, `secret`) with labels, descriptions, and defaults. The app renders the settings panel from this schema. Plugins do not draw their own UI inside the host. This keeps plugin UX uniform with the rest of the app, simplifies sandboxing, and bounds what plugins can put on screen.

**API stability.** The plugin API follows semver. Breaking changes require a major version bump; deprecated symbols remain available for one full major version with a runtime warning before removal. Plugin authors get a predictable migration runway; the core can still iterate.

**Runtime.** A sandboxed JavaScript runtime that exposes a typed API surface for the declared capabilities. The plugin cannot reach arbitrary filesystem paths, network hosts, or system APIs — only those mediated by the API. (See ADR `adr-0002-tech-stack` for the runtime choice; the plugin runtime is a function of the platform decision.)

**Distribution.**

- A plugin is a folder containing `plugin.md` and code/asset files.
- Installation in v1: drop the folder into `.tonotedo/plugins/`. The app picks it up on next launch (or on a "reload plugins" command). No remote registry in v1.
- A future registry is out of scope for v1 but the manifest format is designed to support one.

**Integration points.**

- A plugin's commands integrate with the keymap (0007) via the same command-registry mechanism core uses. Plugin command ids are namespaced (`com.example.mermaid.refresh`).
- A plugin's views integrate with the rendering resolution (0002): a `view` capability registers a view name addressable from a group's `view` property.
- A plugin owning entries via `entries-owner` reserves a group subtree. The user can move entries into it, but conflicts on re-sync are flagged, never auto-resolved (see Conflict policy).
- Processors that mutate disk content (rare) must do so through the same atomic-write path as the editor (0006). The API enforces this.

**Conflict policy.** When a provider runs a sync command and finds that the user (or another process) has edited an entry the provider owns, the provider may not overwrite that entry. The conflict is surfaced to the user with three actions: keep local (mark the entry as detached from the provider), accept remote (replace with the incoming version), or merge manually (open a diff). This policy is fixed at the API level — plugins do not declare or override it. Plugin authors design their UX assuming "you never overwrite user edits."

## Non-goals

- No remote code loading at runtime. A plugin's code ships in its folder; updating means replacing the folder.
- No background telemetry from plugins. Plugins cannot phone home about user behavior. A plugin that opts the user into reporting must do so explicitly via its UI.
- No paid plugin marketplace / commerce surface in v1.
- No "auto-install recommended plugins" first-run flow. Plugins are opt-in.
- No plugin that can disable the core privacy posture (no plugin can force-enable network without user permission per-host).
- No language other than JavaScript in v1's bundled runtime. No WebAssembly module loading in v1 either — the chosen sandbox engine (adr-0005) has no engine-native WASM, and a host-mediated WASM facility would be a new capability requiring its own ADR; revisit if real plugin demand appears. Native shared libraries are not loadable, ever.

## Edge cases

- **Plugin crashes.** Caught at the runtime boundary; the affected capability is disabled for the session; the user sees a non-blocking notification with a link to logs. The app does not crash.
- **Two plugins claim the same `entries-owner` path.** Second one to load is rejected with a clear error. No silent override.
- **Plugin writes to the filesystem outside its declared paths.** API refuses; logged.
- **Permissions revoked while plugin is running.** Affected capabilities suspend; provider sync stops; commands stay registered but error if invoked.
- **Plugin version downgrade across launches.** If a new version dropped a permission, it is removed (no zombie permissions). If a new version asks for *more*, the user is re-prompted.
- **Plugin without `plugin.md`.** Ignored with a warning. Folders without the manifest are not plugins.
- **Plugin renders a code block that contains nothing.** Renderer returns nothing; the block remains rendered as a code block (graceful fallback).

## Acceptance criteria

- Dropping a plugin folder with a valid manifest into `.tonotedo/plugins/` loads the plugin on next launch.
- A processor with `render-code-block` capability is invoked for matching code blocks and its output replaces the default rendering.
- A provider with `entries-owner` can create, update, and delete entries inside its declared group path; entries outside the path are not affected.
- A plugin requesting a permission triggers a first-run prompt; the answer persists across launches.
- A plugin crash does not crash the app; the failing capability is disabled and surfaced in the plugin manager.
- A plugin command appears in the palette with its namespaced id and can be bound in the keymap.

## Open questions

- ~~**Runtime detail.**~~ Resolved: the engine is QuickJS via rquickjs, one runtime per plugin (`adr-0005-plugin-sandbox-engine`); WASM loading is dropped from v1 (see Non-goals). The host architecture is specified in `design-0002-plugin-host`.
- **Local-network plugins.** A plugin that talks to `localhost:1234` — counts as `network` permission or as something looser? Default to `network` strict; revisit if friction is high.
