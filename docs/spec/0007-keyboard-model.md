---
id: docs/spec/0007-keyboard-model
title: Keyboard model
kind: feature
status: implemented
related: [docs/spec/0001-product-vision, docs/spec/0006-markdown-editor, docs/spec/0009-search, docs/spec/0011-settings, docs/spec/0013-mobile]
---

# Keyboard model

## Problem

"Keyboard-friendly" can mean three different things, and conflating them produces an app that satisfies none of its users: (a) every UI action is reachable without the mouse, (b) the app is fast for users who know the shortcuts, (c) the app accommodates users with their own muscle memory (vim, emacs, Sublime, VS Code). Most apps do (a) cleanly, (b) inconsistently, and (c) not at all.

This spec defines the keyboard contract: a single command system, a discoverable palette, sensible defaults, and a user-overridable keymap that does not require a config file.

## User stories

- I press one key (default: `cmd+k`) and a command palette opens. I type "new entry" and hit enter.
- Every action I can do with the mouse has a name in the palette and a default shortcut.
- I bind `cmd+enter` to "toggle done." It works the next time I press it; no restart.
- I import a "vim-style" keymap preset. `j`/`k` move between entries in the sidebar; insert mode entered by `i` inside the editor.
- I forget a shortcut. I press the palette key, search for "tag," and the result shows me the binding next to the action.

## Behavior

**Commands.** Every user-facing action is a command with:

- a stable `id` (`entry.create`, `entry.toggle-done`, `group.move-into`, `nav.go-to-entry`, `editor.heading-1`, etc.)
- a human-readable name and short description
- a category (Navigation, Editor, Entry, Group, Tag, View, App)
- a default binding (may be empty)
- a "when" context (e.g. `editor.heading-1` is only active when focus is in the editor)

The command list is the source of truth. UI menus, the palette, and keybindings are all projections of it.

**Command palette.** A single overlay opened by `cmd+k` (mac) / `ctrl+k` (win/linux). Fuzzy-matches command names and recent items (entries, groups, tags). Arrow keys navigate, enter runs, escape closes. The palette is the discovery surface — users learn the app by opening it.

**Keymap.**

- A default keymap ships with the app. Conservative: standard platform shortcuts where they exist (`cmd+s` forces an immediate save — saving is otherwise automatic, see 0006; `cmd+f` finds within the open entry; `cmd+n` creates a new entry; global search is `cmd+p`, see 0009), app-specific bindings otherwise.
- The user can rebind any command. Rebinding UI is a panel in settings, but the palette also exposes a "bind this command" action on any result.
- Bindings are stored in user settings (see 0011), not in the entries. Bindings travel with the user, not the library.
- Multiple bindings per command are allowed.
- Chord bindings (`cmd+e cmd+t`) are allowed. Chord notation is space-separated, VS Code style; this is the form used in display, in settings, and on disk. A chord's first stroke cannot also be a complete binding in the same "when" context (e.g. nothing may chord off `cmd+k`, the palette key) — the conflict rules below apply to prefixes too. There is no first-class "leader key" field; vim-style leader patterns are expressed as chords (the `vim-flavor` preset can bind sequences beginning with `space`).

**Keymap presets.** A few presets ship in the box: `default`, `vim-flavor`, `emacs-flavor`. A preset is a bindings table plus at most one flag: whether the editor-zone modal engine is enabled (only `vim-flavor` sets it — modal editing is a built-in editor capability the preset switches on, not something a bindings table can express). Presets are import-once: applying a preset overwrites bindings and the modal flag; further edits are the user's. No live re-skin from presets.

Preset definitions live as markdown files (one per preset) in the application source tree once it exists — not as a new top-level folder in this spec-first repo (see AGENTS.md). The bindings table is a typed code block inside the markdown; a build step parses these into the app. Contributors propose new or revised presets via markdown PRs — same ergonomics as the specs.

**Touch devices.** On iOS and Android (0013) the command system is unchanged underneath: every command stays invocable via the palette and the touch translations defined in 0013. With a hardware keyboard attached, this spec applies verbatim, presets included. The keyboard model is therefore a projection of the command registry, not a precondition for it.

**Focus zones.** The window has named focus zones: `sidebar`, `entry-list`, `editor`, `properties`, `calendar`. Each zone defines which command "when" contexts are active. Switching focus is itself a command (`focus.sidebar`, etc.). A command invoked while its "when" context is inactive is a no-op; a transient hint banner says where the command applies. Focus never auto-jumps in response to a command.

**Modal vs modeless.** The default keymap is modeless. The `vim-flavor` preset introduces modes scoped to the `editor` zone only. Modes never leak into the sidebar or palette.

**Cheatsheet.** A contextual cheatsheet shows the commands active in the current zone, their bindings, grouped by category. In non-text zones (`sidebar`, `entry-list`, `calendar`) it opens with `?`. In text-input contexts (`editor`, `properties`, the search box) `?` must type a literal question mark, so the cheatsheet there is `cmd+?` (i.e. `shift+cmd+/`, the platform Help convention); `cmd+?` also works in the non-text zones for muscle-memory consistency.

**Discovery surfaces.** Every menu item shows its current binding. Every palette result shows its binding. There is no place a user sees a command name without also seeing how to bind / invoke it.

## Non-goals

- No mouse-only paths that have no keyboard equivalent.
- No keybinding learned from "watching the user." No telemetry-driven defaults.
- No per-entry or per-group keybindings.
- No macros / recorded action sequences in v1. Plugin territory.
- No bundled vim emulator with full fidelity; the `vim-flavor` preset is "vim-ish," not a vim emulator.

## Edge cases

- **OS-reserved shortcuts.** Never override `cmd+space`, `cmd+tab`, etc. If a user attempts to bind one, refuse with an explanation.
- **Conflicting bindings.** Two commands cannot share the same binding within the same "when" context. The settings UI surfaces conflicts and asks the user to resolve. Across contexts, same binding is fine (`enter` does different things in palette vs editor).
- **Dead keys / IME.** While an IME composition is active in the editor, no command bindings fire on the composing keys. The platform owns composition.
- **Palette while a command is running.** Long commands (rename a tag across thousands of entries) run async; the palette stays usable, the running command shows progress as a transient banner.
- **Plugin commands.** A plugin can register commands; they participate in the palette and keymap like built-ins. Plugin commands carry the plugin id in their `id` namespace.

## Acceptance criteria

- `cmd+k` opens the palette in every focus zone.
- Every action exposed in any menu has a corresponding command id, queryable in the palette.
- Rebinding a command in settings takes effect without restart.
- Applying the `vim-flavor` preset enables modal editing inside the editor; the sidebar and palette remain modeless.
- `cmd+?` from the editor shows only editor-relevant commands; `?` from the sidebar shows only sidebar-relevant commands; `?` in the editor types a literal question mark.
- A conflicting binding cannot be saved without explicit resolution.
