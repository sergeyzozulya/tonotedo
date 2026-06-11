---
id: docs/spec/0005-mentions
title: Mentions
kind: feature
status: implemented
related: [docs/spec/0001-product-vision, docs/spec/0002-entries, docs/spec/0004-tags, docs/spec/0006-markdown-editor, docs/spec/0009-search]
---

# Mentions

## Problem

A journal is full of people. The user writes "had lunch with sergey", "owe mom a call", "review with anna on friday." In plain prose, once buried in a long entry, "sergey" is just a substring — there is no way to ask "every entry that mentions Sergey" or "what did I commit to with Anna last month."

Tags ([0004](0004-tags.md)) almost fit — a person could be `#sergey` — but a person carries its own light identity (a real name, often a color, sometimes a face) and is queried by *who*, not by *what*. Wikilinks ([0006](0006-markdown-editor.md)) almost fit, but a mention is a softer gesture: it does not promise the target is an entry, it does not behave as a navigational link, and it appears inline with prose rather than as a chunked-out reference.

The tensions to resolve: how light a person declaration is, where their metadata lives, how mentions sit alongside tags and wikilinks without overlapping them, and how rename / delete behave so the user can groom their list of people without losing references.

## User stories

- I type "had lunch with @" → a person picker opens. I pick "Sergey." `@sergey` lands in the body.
- I haven't declared `@anna` anywhere. I just type `@anna` and the literal stays. The mention is still indexed; the people view lists it as "unmanaged."
- I add `@anna` to the entry's `mentions:` from the property panel without typing her name anywhere in the body. The entry still appears in Anna's mentions view.
- I select the `@sergey` chip → a side panel shows everywhere I have mentioned him, most recent first.
- I give `@sergey` a description ("colleague, infra team") and a blue color. The chip picks up the color everywhere.
- I rename `@sergey` to `@sergey-k` (two Sergeys now). All entries that referenced the old form rewrite.
- I drag a photo onto `@mom`'s row in the people view. The image is saved next to `_people.md`; from then on, every chip for `@mom` shows her face.

## Behavior

**Form.** A mention is `@slug` written inline in the body. Allowed characters in `slug`: letters, digits, `-`, `_`. No slash — people are not a tree. Slugs are case-insensitive for matching, case-preserving for display.

**Storage on entries.** Mentions live in two coexisting surfaces, neither of which rewrites the other:

- Frontmatter `mentions:` — an array of slugs:

  ```yaml
  mentions: [sergey, mom]
  ```

- Body `@mention` — written inline as part of the markdown text. Renders as a styled mention chip in the editor (see [0006](0006-markdown-editor.md)). The literal `@mention` text is preserved on disk.

Both surfaces are first-class and both are indexed. An entry "mentions X" if X appears in frontmatter, in the body, or in both. The user picks the surface that fits how they think: structured metadata at the top (`mentions:`), or names woven into prose (`had lunch with @sergey`). Removing a mention from one surface does not remove it from the other; the property panel and the body edit are independent gestures.

The people view and search treat the union: a query for `@sergey` finds every entry that references him anywhere.

**Declaration.** A person can be declared with light metadata in a library-root `_people.md`, frontmatter array:

```yaml
---
people:
  - name: sergey
    full_name: Sergey K.
    description: Colleague, infra team.
    color: blue
  - name: mom
    full_name: My mom
    avatar: _people/mom.jpg
---
```

The body of `_people.md` is freeform user notes about the people list itself.

Declaration is optional. An undeclared `@name` is still a valid mention; it shows in the people sidebar under "unmanaged" until the user declares it or removes the references.

**Metadata.**

- `name` — slug identity (required; matches `@<name>` in entries).
- `full_name` — display name shown in the chip and the people view.
- `description` — short markdown shown in the people view and on hover.
- `color` — same eight-token palette as tags ([0004](0004-tags.md)): `slate`, `red`, `amber`, `green`, `teal`, `blue`, `violet`, `pink`. Hex strings are accepted as an escape hatch.
- `avatar` — library-root-relative path to an image file. Shown as a thumbnail on every chip and at full size in the people view. See **Avatars** below.

Metadata is optional. A person used in an entry without any declaration is still valid; the chip just shows the slug.

**Avatars.** The `avatar` field is a path relative to the library root, pointing to an image file. Supported formats: PNG, JPG, WebP, GIF, SVG (the same set the editor accepts for image paste, see [0006](0006-markdown-editor.md)). The suggested layout is a `_people/` folder next to `_people.md`, with files named `<slug>.<ext>` — e.g. `_people/sergey.jpg`. The folder is created on first use.

Adding an avatar:

- **Drag** an image onto a person's row in the people view, or onto an existing chip in an entry. The app copies the file into `_people/<slug>.<ext>` (replacing any prior avatar for that person) and writes `avatar:` into `_people.md`.
- **Paste** from the clipboard onto a person's row produces the same outcome.
- **Manual** — the user can place an image anywhere in the library and point `avatar:` at it directly. The app does not move or rename the file.

The image file is the source of truth: nothing is embedded in `_people.md` or in entries. Renaming a person rewrites the slug everywhere but does not rename the avatar file; for app-managed avatars (drag/paste case), the people view offers a "tidy" command that renames file + `avatar:` path to match the new slug. Deleting a person from `_people.md` does not delete the avatar file.

**Rendering.** A mention renders as a chip carrying `full_name` if declared, otherwise the slug. If the person has an `avatar`, a small thumbnail of it leads the chip. Chip background uses the person's `color`; when no avatar is set, the leading slot shows a colored initial (first letter of `full_name`) on that color. With neither `avatar` nor `color` declared, the chip uses a default mention color. The chip is intentionally non-navigational on click: selection opens the side-panel mentions view for that person. Opening their declaration in `_people.md` is a secondary action (cmd+click or a command). This keeps mentions a "thinking surface" — looking up a person is not the same gesture as following a link.

**People view.** The sidebar has a People section listing every declared and used person, with a count badge of mentions. Selecting a person opens a view: the person's metadata at the top, then a chronological list of every entry that mentions them, most recent first. Undeclared people appear under "Unmanaged" until declared or pruned.

**Autocomplete.** When typing `@` in the body or selecting mentions in the property panel: declared people ranked by recent use, then undeclared-but-used names, then a "create person" affordance that pre-fills a new entry in `_people.md` with the typed slug.

**Operations.**

- Add mention to entry → frontmatter array update or body literal; index update.
- Edit person metadata → rewrite `_people.md`; no entry files change.
- Rename person → walk every entry that references it; rewrite `@old` to `@new`. Confirmed batch operation. The metadata entry in `_people.md` is renamed in place. Same journaling guarantees as tag rename ([0004](0004-tags.md)).
- Delete person from `_people.md` → metadata gone; mentions remain in entries as literal `@name`; the people view surfaces them under "Unmanaged" until the user runs a "clean up" gesture or removes manually.
- Merge person → "merge A into B" rewrites every `@A` to `@B` and removes A's metadata.

**Relation to tags and wikilinks.**

- A `#tag` describes *what* an entry is about. A `@mention` describes *who* it touches. The two are independent surfaces: an entry can have both, either, or neither.
- A `[[wikilink]]` resolves to an entry or group ([0006](0006-markdown-editor.md)) and behaves as a navigation gesture. A `@mention` resolves to a person record in `_people.md` and behaves as a soft reference. The chip styling differs to keep the two visually distinct.
- A slug collision between a wikilink and a mention (`[[sergey]]` and `@sergey`) is not a conflict: they are independent records kept in different surfaces of the index.

## Non-goals

- No external contact sync (CardDAV, Google Contacts, vCard import) in v1. That belongs to a people **provider** plugin ([0010](0010-plugins.md)).
- No social-graph features (relationships between people, "who knows whom"). A person is a flat record.
- No auto-detection of names in prose ("you wrote 'Sergey' — did you mean @sergey?"). Mentions are explicit. Auto-suggestion is the kind of AI-everywhere behavior the product vision rejects unless the user opts in.
- No mention-aware notifications, reminders, or follow-up prompts in v1.
- No multi-user or accounts. The user is journaling about their own life; "me" is implicit and is not a mention.
- No per-entry override of person metadata (an entry cannot color one of its mentions differently from the declared color).
- No required mentions or validation rules on entries.

## Edge cases

- **Body and frontmatter differ.** Not a conflict. Body has `@a @b`, frontmatter has `[a, c]` → the entry mentions `{a, b, c}`. Neither surface is rewritten. Removing `b` requires editing the body; removing `c` requires editing the property panel.
- **Mention without declaration.** Valid. Indexed. Surfaced in the people view under "Unmanaged" until declared or pruned.
- **Email addresses and code.** `email@example.com` is not a mention: the `@` is preceded by a word character, which fails the word-boundary rule. A mention requires whitespace, line start, or punctuation before the `@`. Mentions inside fenced code blocks or inline code are not parsed.
- **Disallowed characters.** Imported text with `@john.doe` parses `@john` as the mention; the `.doe` remains plain text. App-created mentions are restricted to the allowed character set.
- **Same display name, different slug.** `@sergey-k` and `@sergey-m` may both have `full_name: Sergey`. The slug is the identity; the display name is human-facing only.
- **Case difference.** Typing `@Sergey` when `@sergey` exists: normalize to the existing canonical slug on autocomplete; preserve user's casing if they explicitly type a new variant.
- **Renaming a person with thousands of references.** Long operation; progress UI; the rename is journaled so a crash mid-rename leaves a recoverable state.
- **Restore from trash after a rename.** Trashed entries are not rewritten by renames, so a restored entry may carry the old slug. It reappears in the people view under "Unmanaged" — same recovery surface as a deleted person.
- **Deleting a person referenced by many entries.** Metadata is removed; the literal `@name` stays in entries. The people view's "Unmanaged" section is the recovery surface.
- **Avatar file moved or deleted.** The path in `avatar:` no longer resolves. The chip falls back to its colored-initial form; the people view shows the broken path so the user can re-point it or clear the field.
- **Mention slug colliding with an entry slug.** Independent. `@sergey` does not resolve to an entry titled "sergey"; that is what `[[sergey]]` is for.

## Acceptance criteria

- Typing `@` in the body opens a person picker; selecting a person inserts `@slug` as literal text.
- Adding `@sergey` in the body makes the entry appear in Sergey's mentions view without touching frontmatter.
- Adding `sergey` to frontmatter `mentions:` makes the entry appear in Sergey's mentions view without touching the body.
- An entry that has `@sergey` in the body and `[anna]` in frontmatter `mentions:` appears in both Sergey's and Anna's mentions views.
- Declaring `@sergey` with a color and full name updates every chip rendering for that mention across the library in the same session, without restart.
- Renaming `@sergey` to `@sergey-k` rewrites every entry that references the old form; deleted entries in trash are not rewritten.
- Removing `@sergey` from `_people.md` does not strip the literal `@sergey` from entries; the mention appears under "Unmanaged" in the people view.
- A person with `avatar:` set renders the image as a thumbnail in every chip for that mention.
- Dragging an image onto `@sergey`'s row in the people view copies it to `_people/sergey.jpg` and writes `avatar: _people/sergey.jpg` to `_people.md`.
- A search ([0009](0009-search.md)) for a person's slug or `full_name` returns entries that mention them, ranked by recency.
- `email@example.com` in a body is not parsed as a mention; `@example` is not chipped.
