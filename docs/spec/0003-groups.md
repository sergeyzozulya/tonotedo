---
id: docs/spec/0003-groups
title: Groups
kind: feature
status: accepted
related: [docs/spec/0001-product-vision, docs/spec/0002-entries, docs/spec/0004-tags, docs/spec/0006-markdown-editor, docs/tech/adr-0001-storage-format]
---

# Groups

## Problem

Users accumulate entries. Without a structuring primitive they pile up into an undifferentiated list and the app becomes "search-only." On the other extreme, a rigid notebook/section model (one entry, one place, deep nesting required) fights how users actually think — some things are "the recipe folder," some things are projects with phases, some things are loose ideas that do not belong anywhere yet.

Groups are the structural primitive: a multi-level hierarchy that organizes entries, scopes property schemas, and scopes tags, while staying optional in spirit (an entry can sit at the root).

## User stories

- I make a "Work" group, then a "Project Atlas" group inside it. I drop meeting notes into "Project Atlas." On disk it is just nested folders.
- I create a "Books" group. I define a schema there: `author: string`, `read: boolean`, `rating: number`. Every new entry I make inside Books prompts me for those fields.
- I have a scoped tag `#decided` that only makes sense inside "Project Atlas." It does not pollute my global tag list.
- I move a project entry into the archive group. Its tags and properties come with it.

## Behavior

**Identity.** A group is a folder. Nested groups are nested folders. The library root is the top-level group (implicit, unnamed). Folders whose names start with `_` (e.g. `_assets/`, `_people/`) or `.` (e.g. `.tonotedo/`) are reserved and are not groups (see 0002, Reserved names).

**Group metadata.** Optional `_group.md` file inside the folder, with frontmatter and a markdown body:

- `name` — display name (defaults to folder name).
- `description` — body of `_group.md`.
- `icon`, `color` — optional UI hints.
- `schema` — property schema for entries in this group (and, by default, in descendants).
- `scoped_tags` — list of tags that are local to this group (see 0004).
- `order` — display ordering hint relative to siblings.
- `view` — default rendering for entries in this group (see 0002). Inherited by descendants unless overridden.

The `_group.md` file is itself a valid entry that can be edited, with the side effect that its frontmatter configures the group.

**Schema inheritance.** A child group inherits its parent's schema and adds to or overrides it. An entry's effective schema is the merge of its group's schema chain, child overriding parent. There is no "remove inherited property" gesture: schemas are advisory (see 0002), so if a child group does not want a property, the user simply does not fill it in for entries there. Inherited property suggestions can be hidden from the UI per group as a display setting, but the property remains addressable.

**Membership.** Every entry belongs to exactly one group (its containing folder). No multi-parenting. Cross-cutting classification is what tags are for.

**Operations.**

- Create group → new folder (and optional `_group.md`).
- Rename group → folder rename; entry ids unchanged; in-app cross-references update.
- Move group → folder move; all descendants come along.
- Delete group → move to `.tonotedo/trash/` at the library root (original path preserved as metadata for restore), including all descendants. Permanent delete is a separate confirmed step.
- Move entry between groups → file move; entry's `id` unchanged; effective schema is recomputed.

**Sidebar UX.** The group tree is the primary navigation surface. Collapsing and expanding state is per-user UI state, not stored in the entries.

**Sibling ordering.** Groups with an explicit `order` value come first, sorted by that integer. Groups without `order` come after, sorted alphabetically. Ties on `order` break alphabetically.

**Wikilink target.** A wikilink (see 0006) can resolve to a group, not just an entry. The resolution order is: entry by slug → group by name → ambiguous (UI prompts; the resolved link is stored path-qualified, see 0006). Linking to a group opens the group's `_group.md` view, which is a natural home for project overviews.

## Non-goals

- No "this entry belongs to multiple groups" (symlinks, aliases, joins). Use tags for cross-cutting.
- No group-level access control or encryption. Local-first; the file system is the boundary.
- No automatic / smart / saved-search groups in v1. Filters and saved views are a separate feature.
- No unlimited nesting depth in the UI. The format allows any depth; the sidebar may collapse very deep paths for readability. UI choice, not a format constraint.

## Edge cases

- **`_group.md` malformed.** Group still works as a plain folder; its schema is empty; a non-blocking warning surfaces on the group.
- **Schema change with existing entries.** Changing a property's type in the schema does not rewrite existing entries. Their values are preserved as-is; the schema is advisory.
- **Renaming a group to collide with a sibling.** Disallowed by the filesystem; UI surfaces a "name in use" message before the move.
- **Circular move (drag a group into itself or a descendant).** Disallowed; UI rejects.
- **Group containing only `_group.md` and no entries.** Valid; appears as an empty group in the sidebar.
- **Hidden folders (starts with `.`).** Ignored by the app. Reserved for the app's own state (`.tonotedo/`).
- **Underscore folders (starts with `_`).** Not groups; reserved for app metadata (`_assets/`, `_people/` — see 0002, Reserved names). They never appear in the sidebar.

## Acceptance criteria

- Create a group → folder appears at the chosen path.
- Add a `_group.md` with a schema → new entries in that group offer the schema's properties.
- Nest groups three deep, move the middle one elsewhere → all descendants follow; entry ids stable.
- Delete a group with 50 entries → all 50 plus the group end up in trash; restore restores everything in place.
- Move an entry into a group with a stricter schema → existing properties on the entry are preserved; missing schema properties are offered but not auto-added.
