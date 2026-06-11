---
id: docs/spec/0011-settings
title: Settings and theming
kind: feature
status: implemented
related: [docs/spec/0001-product-vision, docs/spec/0004-tags, docs/spec/0005-mentions, docs/spec/0006-markdown-editor, docs/spec/0007-keyboard-model, docs/spec/0008-calendar, docs/tech/adr-0001-storage-format]
---

# Settings and theming

## Problem

Other specs already depend on settings without saying where they live: keybindings are "stored in user settings" and "travel with the user, not the library" (0007); the calendar's primary date property is "a library setting" (0008); tag and mention color tokens resolve "via the active theme" (0004, 0005); the image-paste asset folder is "configurable" (0006). Three different lifetimes are hiding in there — preferences that follow the person, configuration that belongs to a library of entries, and ephemeral UI state that belongs to neither — and without a defined home for each, every feature invents its own.

## User stories

- I rebind a key on my laptop. When I open the same library on my desktop, the binding is not there — bindings follow the machine's user profile, not the library. (See Open questions for whether an export/import gesture is wanted.)
- I set the calendar's primary date property to `scheduled` for my work library. My journal library still uses `due`.
- I switch the theme to dark. Every color token (tag chips, mention chips, group colors) re-resolves; nothing on disk changes.
- I delete `.tonotedo/` to reset a misbehaving library. My library settings survive, because they live in `_settings.md`, which syncs with the library like any other `_` file.

## Behavior

**Three scopes, three homes.**

- **User settings** — preferences that follow the person across libraries: the keymap and all bindings, the applied keymap preset and modal flag (0007), the active theme, editor preferences (font, line width). Stored as a single JSON file in the platform config directory (`~/Library/Application Support/ToNoteDo/settings.json` on macOS, XDG config dir on Linux, `%APPDATA%` on Windows). Not part of any library; never synced by syncing a library.
- **Library settings** — configuration that is meaningful only for one library and should travel with it: the calendar's primary date property (0008, default `due`), the asset folder name (0006, default `_assets`), per-library display defaults. Stored in `_settings.md` at the library root — frontmatter holds the settings, the body is freeform user notes, same shape as `_tags.md` and `_people.md`. It is a reserved `_` file (0002) and syncs with the library by any file-copy mechanism.
- **Ephemeral UI state** — window layout, sidebar expansion, per-entry outline toggles, recents. Lives in `.tonotedo/` (ADR 0001). Losing it is harmless; it is never a setting.

The rule for placing a new setting: if losing it would change what the user's *data* means, it is a library setting; if it encodes how the *person* works, it is a user setting; if nobody would notice it gone after a restart, it is ephemeral state.

**Settings UI.** One settings surface, opened via command (`app.settings`). Sections mirror the scopes; each setting shows which scope it belongs to. Edits apply immediately — no restart, no save button (consistent with 0006's no-explicit-save posture). Files written by the app are also hand-editable; the file watcher picks up external edits to `_settings.md` like any other file.

**Theming.** A theme is a named set of resolved values for: the eight color tokens (`slate`, `red`, `amber`, `green`, `teal`, `blue`, `violet`, `pink` — see 0004), base surfaces (background, text, borders), and syntax/editor colors. v1 ships three: `light`, `dark`, and `system` (follows the OS appearance, switching live). Tag, mention, and group colors declared as tokens re-resolve when the theme changes; hex escape-hatch values render verbatim and do not adapt (0004). Custom user themes are deferred (see Non-goals).

**Defaults.** Every setting has a default; a missing file or missing key means "default," and the app never writes a settings file just to record defaults. `_settings.md` is created on the first non-default library setting.

## Non-goals

- No custom user-authored themes in v1. The token contract is designed so a theme can later be a plugin-provided or user-provided file, but only `light` / `dark` / `system` ship.
- No settings sync service. User settings travel by the user copying the file; library settings travel with the library.
- No per-group or per-entry settings overrides (the `view` property and `_group.md` fields already cover the cases that matter).
- No settings versioning/migration framework in v1; unknown keys are preserved verbatim, mirroring the property round-trip rule in 0002.

## Edge cases

- **Malformed `_settings.md` or `settings.json`.** All defaults apply; a non-blocking warning surfaces; the file is never overwritten until the user changes a setting, and then only the keys the app understands are rewritten — unknown keys round-trip.
- **Conflicting external edit while settings UI is open.** Same conflict policy as entries (0006): clean buffer reloads silently; dirty buffer surfaces the conflict banner.
- **A library setting names a missing referent** (e.g. primary date property renamed away). The setting stays; behavior follows it literally (entries without the property are simply absent from the calendar, per 0008). No auto-correction.
- **Theme `system` on a platform without appearance signal.** Falls back to `light`.

## Acceptance criteria

- Rebinding a key writes the user settings file in the platform config dir; the library contains no trace of it.
- Setting the primary date property writes `_settings.md` at the library root; opening the library on another machine applies it.
- `_settings.md` does not appear in entry lists or search results (reserved name, 0002).
- Switching `light` → `dark` re-resolves all token-declared colors in the same session without restart; hex-declared colors are unchanged.
- Deleting `.tonotedo/` resets window layout and recents but changes no setting in `settings.json` or `_settings.md`.
- A hand-added unknown key in either settings file survives the app changing an unrelated setting.

## Open questions

- Does `system` theme need a scheduled variant (light by day, dark by night) or is OS-following enough?
- Is an explicit "export / import user settings" command wanted, or is copying the JSON file acceptable?
- Week-start day and first-day-of-week localization: user setting or library setting? Leaning user; decide when the calendar implementation needs it.
