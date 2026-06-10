---
id: docs/spec/0002-entries
title: Entries
kind: feature
status: accepted
related: [docs/spec/0001-product-vision, docs/spec/0003-groups, docs/spec/0004-tags, docs/spec/0005-mentions, docs/spec/0006-markdown-editor, docs/spec/0008-calendar, docs/spec/0011-settings, docs/spec/0012-notifications, docs/tech/adr-0001-storage-format]
---

# Entries

## Problem

The app needs one primitive that can be a note, a task, a calendar event, a journal entry, a bookmark, a recipe — without the user feeling like they switched apps to write each of them. A rigid "task vs note vs event" split forces the user to decide upfront and re-decide every time the thing changes shape. A free-text-only "everything is a note" loses the structure needed for calendar views, filters, and reminders.

The entry is the resolution: one unit, markdown body, typed properties, optional schema per group.

## User stories

- As the user, I create an entry by pressing one key. It becomes a markdown file I could open in any editor.
- I write a meeting note. Later I add a `due` property and it shows up on the calendar. I did not have to convert it.
- I have a "Books" group where every entry has `author`, `read`, `rating`. I do not have to type those property names — the group's schema offers them.
- I delete the app. My entries are still readable as `.md` files in a folder.

## Behavior

**Identity.** Each entry is one `.md` file. The filename is the slug; the title is the first H1 in the body, or the slug if no H1 exists. The app maintains the slug ↔ title relationship on rename.

**Reserved names.** Files and folders whose names start with `_` are app metadata, not entries or groups: `_group.md` (group config, see 0003), `_tags.md` (0004), `_people.md` and `_people/` (0005), `_searches.md` (0009), `_settings.md` (0011), `_assets/` (0006). They do not appear in entry lists, search results, or the group tree. The one exception is `_group.md`, which is openable and editable as an entry (see 0003) but is still excluded from lists and search.

**Body.** Markdown (subset and extensions defined in 0006). The body is the content the user thinks of as "the thing they wrote."

**Properties.** Typed key-value pairs stored in YAML frontmatter at the top of the file. Supported types:

- `string`, `text` (multi-line string)
- `number`, `boolean`
- `date` (calendar date, no time)
- `datetime` (instant with timezone offset, e.g. `2026-05-20T14:00+02:00`). Values are stored with an explicit offset; rendering follows the current local zone (see 0008 for calendar specifics).
- `range` — a date or datetime range, written as `<start>..<end>` (`2026-06-01..2026-06-05` or `2026-06-01T09:00..2026-06-01T10:30`). Used by the calendar (see 0008) for multi-day or timed-span items.
- `tag` / `tag[]` (rendered as tags; see 0004)
- `enum` (one of a fixed list, defined at the group level)
- `ref` / `ref[]` (link to another entry by slug, path-qualified with the group path when the bare slug is ambiguous — same form as wikilinks, see 0006; rewritten on rename)

Unknown property types are preserved verbatim on read and written back unchanged. The app never silently drops properties it does not understand. This is the plugin escape hatch.

**Type inference.** Schemas are optional, so a property may have no declared type. The type is then inferred from the value's shape: ISO date (`2026-05-20`) → `date`; ISO datetime → `datetime`; `<start>..<end>` of dates/datetimes → `range`; YAML booleans and numbers → `boolean` / `number`; everything else → `string`. A schema-declared type always wins over inference; inference exists so that calendar and filter behavior work for schema-less entries (e.g. a bare `due: 2026-05-20` at the library root, see 0008).

**Built-in properties.** Every entry has:

- `id` — stable, opaque, generated at creation; never reused; survives rename.
- `created`, `updated` — datetime; the app maintains these.
- `title` — derived (see Identity). Never persisted to frontmatter; the first H1 (or the slug) is the single source of truth.
- `tags` — array of tag strings (see 0004).
- `mentions` — array of person slugs (see 0005).
- `archived` — optional boolean; `true` removes the entry from default lists and views without deleting it (see Lifecycle).
- `view` — optional; overrides the group's default rendering for this entry. See Rendering.

The user-facing app surfaces `id` only when explicitly requested.

**Well-known properties.** Not built-in (absent unless the user or a feature adds them), but other specs assign them meaning, so their names and types are fixed:

- `due` — `date` / `datetime` / `range`; the default primary date property for the calendar (0008).
- `done` — `boolean`; marks an entry task-like and drives task views. Independent of body checkboxes (see 0006).
- `repeat` — `string` carrying an iCalendar RRULE (0008).
- `overrides` — a YAML map of occurrence date → replacement value or `skip` (0008). This is the one map-shaped property in the model; it is written by the calendar UI and edited there, not through the generic property panel. It round-trips like any other property.
- `remind` — duration (or list of durations) before the primary date property (0012).

**Rendering.** Default rendering is a hybrid resolution: the group declares a `view` in its `_group.md` (see 0003) and an entry may override with its own `view` property. Resolution order, first match wins: entry's `view` → nearest ancestor group's `view` → app default (`note`). The v1 set of built-in views is intentionally small: `note` (standard markdown rendering) and `task-list` (checkbox-forward layout for entries dominated by `- [ ]` items). Plugins can register additional views.

**Schema.** A group (0003) may declare a property schema: which properties an entry in that group expects, their types, and defaults. Schemas are advisory: an entry can carry properties outside its group's schema, an entry without all schema properties is still valid, and values are never rewritten or coerced when an entry moves between groups whose schemas disagree on a property's type. The UI uses the schema to offer property pickers and column views.

**Lifecycle.** Entries are created, edited, archived (a property, not a deletion), or deleted. Deletion is a trash-bin operation; permanent deletion is a separate, confirmed step.

**Frontmatter write order.** Stable canonical order keeps diffs quiet across writes: built-in properties first (`id`, `created`, `updated`, `tags`, `mentions`; `title` is derived and never written), then user-defined properties in the order the entry's effective schema declares them, then any remaining properties alphabetically. Unknown properties round-trip in the trailing alphabetical bucket.

## Non-goals

- No rigid "type" enum (`type: task | note | event`). The presence of a `due` property is what makes an entry calendar-visible; the presence of a `done` property is what makes it task-like.
- No relational database semantics: no joins, no foreign keys enforced at the storage layer. Refs (if accepted) are best-effort.
- No per-entry permission model. Local-first; the file system is the boundary.

## Edge cases

- **External edits.** The user edits the `.md` file in vim while the app is running. Detected on file watch; if no in-app unsaved changes, reload silently. If conflict, surface a "you and the file system both edited this" UX (defined in 0006).
- **Malformed frontmatter.** Treat as an entry with no properties; show a non-blocking warning on the entry. Never refuse to open the file.
- **Duplicate ids.** If two files claim the same `id` (e.g. user duplicated a file outside the app), the app keeps both files; the second one gets a fresh id on next index rebuild, and the user is notified.
- **Filename collisions.** Slugs are unique per group. On rename collision, append `-2`, `-3`, etc.
- **Empty title.** Allowed. UI shows the slug or a placeholder.

## Acceptance criteria

- Create entry → file appears on disk with the expected frontmatter + empty body.
- Add a `due` property → entry appears on the calendar at that date.
- Add a `done` property → entry appears in task views; toggling it persists to disk.
- Rename entry → file rename on disk, in-app references update, `id` unchanged.
- Delete entry → moves to trash; restore returns it to the original group.
- Edit frontmatter externally → the file watcher reconciles and the app reflects the change, typically sub-second (see 0006 for the conflict case).
- Unknown property type round-trips: in, edit other fields, save, the unknown property is unchanged.
