---
id: docs/spec/0013-mobile
title: Mobile (iOS and Android)
kind: feature
status: accepted
related: [docs/spec/0001-product-vision, docs/spec/0002-entries, docs/spec/0006-markdown-editor, docs/spec/0007-keyboard-model, docs/spec/0009-search, docs/spec/0010-plugins, docs/spec/0011-settings, docs/tech/adr-0001-storage-format, docs/tech/adr-0002-tech-stack, docs/tech/design-0001-index-and-reconciliation]
---

# Mobile (iOS and Android)

## Problem

The feature specs (0002–0012) were written with a desktop posture — pointer, hardware keyboard, an always-running file watcher, a user-chosen folder on an open filesystem. v1 ships iOS and Android at **full feature parity**, so each desktop assumption needs a defined mobile equivalent, not a reduced "companion" subset. The risks to resolve: how every command stays reachable without a keyboard, how a sandboxed mobile filesystem hosts the library, and how the app behaves when the library is mid-flight through the user's own sync mechanism.

Parity is a claim about *capability*, not chrome: anything the user can do on desktop, they can do on a phone — possibly through a different gesture, never through a missing feature.

## User stories

- I edit the same library on my Mac and my phone. The phone's library folder lives in iCloud Drive; edits made on either device appear on the other after sync, and the app never corrupts or "converts" anything in transit.
- On the phone I tap the command button (or swipe down) and get the same command palette as `cmd+k` on desktop. Every command is there.
- I long-press an entry in the list and get the same operations the desktop context menu has.
- I reschedule an entry by dragging it across the calendar with my finger, same as with the mouse.
- I connect a hardware keyboard to my iPad and the entire keyboard model (0007), including the `vim-flavor` preset, works.
- The plugins I installed into my library on desktop are present on my phone — they arrived with the synced `.tonotedo/plugins/` folder and run there.
- My phone is in airplane mode for a week. Everything works; sync resumes when connectivity does.

## Behavior

**Parity rule.** Every command in the command registry (0007) is invocable on touch. The command palette is the universal fallback surface: any command not given a dedicated touch gesture is still reachable by name there. Acceptance criteria across 0002–0012 apply on mobile with the gesture translations below.

**Touch translation.** A fixed mapping, not per-feature improvisation:

- Palette (`cmd+k`) → persistent palette button + pull-down gesture.
- Search (`cmd+p`) → search tab/button; same overlay, same chips (0009).
- Context menus / right-click → long-press.
- Drag to reschedule, drag to move entries between groups → touch drag with the same drop semantics; drop targets enlarge for finger accuracy.
- Hover surfaces (tag descriptions on hover, 0004) → tap-and-hold on the chip shows the same card.
- Focus zones (0007) → on phones, zones become screens/sheets (sidebar, list, editor, properties, calendar); the zone model and per-zone command activation are unchanged, only their presentation differs. Tablets in wide layouts keep multi-zone windows.
- The cheatsheet (`?` / `cmd+?`) → a "gestures & commands" sheet listing the same per-zone commands.

**Hardware keyboard.** When a hardware keyboard is attached (tablets, phones, ChromeOS-like contexts), the full keyboard model (0007) applies verbatim, including presets and chords. Software-keyboard editing uses the platform's accessory row for the most frequent editor commands (heading, list, indent, checkbox, tag, mention, wikilink).

**Editor.** The same live-inline editor (0006), same dialect, same round-trip guarantees. Touch-specific behaviors: cursor-reveal of raw markdown follows the tap caret exactly as it follows the desktop cursor; selection uses native platform handles; image/file attach uses the platform document and photo pickers in place of drag-and-drop (producing the identical `_assets/` layout). Performance budgets (0006) apply on a 3-year-old mid-range phone: typing input-to-paint under 16ms, open under 150ms, switch under 75ms.

**Library location.**

- **iOS**: the library is a folder the user picks via the system document picker (security-scoped bookmark) — typically inside iCloud Drive for sync — or the app's own Documents folder (visible in the Files app, also iCloud-syncable). No private opaque container: the "your files, readable by any tool" promise (ADR 0001) holds on mobile.
- **Android**: a user-picked folder via the system folder picker (Storage Access Framework), or the app's public Documents directory. Works with Syncthing, folder-sync apps, or any provider that materializes real files.

**Sync posture.** Transport is the user's own file sync (per ADR 0001's portability promise — iCloud Drive, Syncthing, Dropbox, etc.); the app never ships or requires a sync service. The app's responsibilities end at being a *good citizen of a synced folder*:

- All reconciliation runs through the same index pipeline (design-0001); a remotely-changed file is just an external edit (0006's conflict rules apply when both sides changed).
- Sync-conflict artifacts produced by providers (e.g. "entry (conflicted copy).md") are detected by duplicate `id` (0002's duplicate-id rule) and surfaced as a conflict to resolve, never silently indexed as two entries.
- Cloud placeholder/"dataless" files (iCloud evicted content) are materialized on demand for indexing; until then the entry shows as pending, never as empty.
- `.tonotedo/index.db` and ephemeral state should be excluded from sync where the platform allows; the index is per-device and rebuildable, and two devices must never sync a SQLite file at each other.

**Plugins.** Full parity: plugins live in the library (`.tonotedo/plugins/`, 0010), so they travel to mobile with the library — except the index-exclusion above does not apply to `plugins/`, which must sync. The sandbox runs interpreter-only on iOS (no JIT — see adr-0005, which this requirement reinforces). Permissions, conflict policy, and the manager UI are identical; "drop a folder into plugins/" works through the Files app / file manager.

**Lifecycle.** Mobile apps are suspended, not quit. On foreground: rescan-diff the library (design-0001's startup path, incremental), reconcile, refresh views. Reminders (0012, post-v1) will need the platform's scheduled-notification path; nothing in v1 depends on background execution.

## Non-goals

- No OS-extra surfaces in v1: no home-screen widgets, share-sheet extension, Apple Watch / Wear OS app, Shortcuts/Intents integration. Parity covers the specs' features, not new platform-specific ones.
- No built-in sync transport, accounts, or relay — on mobile exactly as on desktop (no-forced-cloud anti-pillar).
- No separate "mobile edition" of the format or a reduced dialect. One format everywhere (ADR 0001).
- No background sync daemon; the app reconciles when it runs in the foreground (platform push/refresh tricks are not a v1 dependency).

## Edge cases

- **Sync delivers a torn state** (entry arrived, its `_assets/` image not yet). Render the entry; the missing asset uses 0006's broken-attachment state until it materializes; reconcile again on file arrival.
- **Both devices edited the same entry while offline.** The provider either picks a winner (detected as an external edit; the local unsaved buffer triggers 0006's conflict UX) or produces a conflicted copy (duplicate-id surface, see Sync posture). No third behavior.
- **Security-scoped access revoked / folder moved** (iOS). The app surfaces "library unavailable" with a re-pick flow; nothing is written anywhere else in the meantime.
- **Very large library on first mobile open.** Full index build runs as on desktop (background, partial-index hint per 0009); the UI is usable during the build. Budget: 10k entries indexed in under 60s on a mid-range phone.
- **Storage pressure.** The index is the only sizable app-owned artifact; it can be dropped and rebuilt (ADR 0001). The app never duplicates the library.
- **Phone-sized calendar Month view.** Density is reduced by layout (per 0008's `+M more` affordance), not by dropping the view: all four views (0008) exist on phones.

## Acceptance criteria

- Every acceptance criterion in 0002–0011 passes on iOS and Android, using the touch translations above or a hardware keyboard.
- Every command in the registry is invocable from the palette on a touchscreen with no hardware keyboard.
- A library round-trips desktop → cloud file sync → phone → edit → back to desktop with byte-identical untouched files and correctly merged touched ones (no rewrites of files the user didn't edit, per 0002/0006).
- A provider-generated conflicted copy appears as one conflict to resolve, not two entries.
- A plugin installed on desktop runs on the phone after sync with the same permission grants prompt.
- With a hardware keyboard attached, `cmd+k` opens the palette and the `vim-flavor` preset works in the editor.
- Editor typing latency under 16ms p95 in the 10k-word benchmark on the reference mid-range phone.
- Airplane mode for the full test suite: zero feature loss.

## Open questions

- iCloud Drive's eviction and rename behaviors under heavy churn need empirical testing early (part of the ADR 0002 mobile spike) — the conflict-copy and dataless-file handling above is designed from documented behavior, not yet from observation.
- **Android SAF folder trees**: Tauri's stock fs layer reads/writes individual `content://` URIs but cannot enumerate or create within a picked folder tree. Either a small custom Kotlin plugin closes this (spike item in adr-0002), or v1-Android scopes the library to the app's public Documents folder — still a real path, still syncable by folder-sync tools.
- **iOS persistent folder bookmarks**: per-access security scoping is handled by the platform layer, but persisting a bookmark to an arbitrary folder across launches and walking it from the core needs spike verification; the app-Documents/iCloud-container default (above) is the proven fallback.
- Index exclusion from sync: iOS can exclude items from iCloud backup/sync per-file; SAF folders on Android cannot always express this. Fallback: per-device index filename (`index-<device-id>.db`) so synced copies never collide.
- Phone information architecture (tabs vs drawer for the zone-screens) is a design-system decision for the UI design doc, not this spec.
