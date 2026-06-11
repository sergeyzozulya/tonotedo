---
id: docs/spec/0006-markdown-editor
title: Markdown editor
kind: feature
status: implemented
related: [docs/spec/0001-product-vision, docs/spec/0002-entries, docs/spec/0004-tags, docs/spec/0005-mentions, docs/spec/0007-keyboard-model, docs/spec/0011-settings, docs/tech/adr-0001-storage-format]
---

# Markdown editor

## Problem

The editor is the surface the user spends the most time in. It needs to feel calm and fast (no jank, no AI popups), respect the user's typing speed, and keep what is on disk identical to what the user wrote — no surprise rewrites, no proprietary encoding. At the same time, the editor must do more than a textarea: live formatting, headings that look like headings, lists that behave, links that resolve to other entries.

The hard question is the rendering model: WYSIWYG-like (typora-style) vs source + preview vs split, and how far we extend CommonMark for the things the app needs (frontmatter, tags, mentions, wikilinks, task checkboxes that bind to a property).

## User stories

- I open an entry, start typing. Headings, bold, lists, code blocks render inline as I type. I never see raw `**bold**` unless I move my cursor into it.
- I type `#tag` and the tag autocompletes from scoped + global tags. The literal `#tag` stays in the body and is indexed; frontmatter is untouched (see 0004 — body and frontmatter are independent surfaces).
- I type `@sergey` and a person picker appears. I pick one; it renders as a mention chip (with avatar if set). The literal `@sergey` stays in the body.
- I type `[[` and an entry picker appears. I pick one; the link renders as the target's title; on save it stores `[[entry-slug]]`. If I rename the target later, the app rewrites every reference.
- I check a `- [ ]` checkbox; the change persists to the body like any other edit. Checkboxes are content; the entry-level `done` property is separate (toggled via command or the properties panel, see 0002).
- I drag a `report.pdf` onto an entry. A small block with the file name appears. I click it and it opens in my system PDF viewer.
- I open an `.md` file directly from vim, save, switch to the app. The app reflects my edit without ceremony.

## Behavior

**Markdown dialect.** CommonMark is the floor. Extensions accepted:

- GFM tables, strikethrough, task list items (`- [ ]`, `- [x]`).
- YAML frontmatter at the start of the file (required for properties).
- Wikilinks: `[[target|optional display text]]`. The target is a slug; resolution is entry-first, then group by name (see 0003). Slugs are unique only per group (see 0002), so when more than one entry carries the slug, the stored target is path-qualified with the group path: `[[work/atlas/meeting-notes]]`. The picker writes the qualified form automatically on ambiguity; a hand-written bare `[[slug]]` that is ambiguous prompts the UI on first resolution. Renaming the target rewrites every wikilink that references it (see 0002, 0003); a rename that makes previously-bare links ambiguous qualifies them in the same batch.
- Tags: `#tag` and `#parent/child` inline. Indexed from the body; never copied into frontmatter — body and frontmatter are independent surfaces (see 0004).
- Mentions: `@slug` inline. Indexed from the body; never copied into frontmatter (see 0005).
- Fenced code blocks with language hints.

Extensions are stored as plain text. A non-app markdown reader sees `[[entry-slug]]`, `#tag`, and `@mention` as literal text; that is the price of portability.

**Rendering model.** Live inline formatting (typora-style), not source-and-preview. Cursor inside a syntax token reveals the raw markdown; cursor outside renders the formatted form. No mode switch; no separate preview pane in v1.

**Block model.** The editor operates on markdown blocks (paragraph, heading, list, code, quote, table). The user manipulates blocks with keyboard: move up/down, indent/outdent (lists), convert (paragraph → heading → list), delete. Blocks are not a separate data model; they are how the editor reads markdown. Default bindings for block moves are `alt+up` / `alt+down` (standard across modern editors); the `vim-flavor` preset (see 0007) maps `J` / `K` to the same commands inside the editor.

**Outline.** Long entries can opt into an outline / TOC sidebar listing the entry's headings. Hidden by default; toggled per entry via a command (and keybinding). The toggle state is per-entry UI state, not stored in the entry file. No auto-show heuristic.

**Frontmatter UX.** Frontmatter is not edited as raw YAML inline. A properties panel docks beside the editor and renders typed inputs (string, number, date, enum, tag, boolean). Power users can switch to a raw frontmatter view per entry. Writes go to disk as YAML with stable key ordering.

**Attachments.** Any non-image file can be attached. Drag a file onto the editor, paste it from the clipboard, or use an "attach file" command. The file is copied into the entry's `_assets/` folder (the same folder image paste uses) and a standard markdown link is inserted: `[report.pdf](_assets/report.pdf)`. No new syntax — a plain markdown reader sees a working relative link.

The editor renders a link that points at a non-image `_assets/` file as a compact **attachment block**: a file-type glyph and the file name, nothing else. Contents are never parsed, previewed, or thumbnailed — a PDF, a `.zip`, a `.docx` all look the same. Image links keep their existing inline-image rendering.

- **Click** opens the file with the operating system's default application (standard shell open). The app does not render the contents.
- **Delete** removes the file from `_assets/` and the link from the body in one confirmed action.

Removing only the link text through normal editing leaves the file in `_assets/` as an orphan; unreferenced assets are surfaced for cleanup (shared with image orphans).

**Saving.** Save-on-pause (debounced, ~500ms after last keystroke) and save-on-blur. No explicit save button. Crash safety: writes are atomic (`write-temp` + `rename`). No autosave indicator clutter; a tiny "saved" affordance fades in and out.

**External edits.** A file watcher detects changes on disk. If the in-app buffer has no unsaved changes, reload silently. If both sides changed, surface a conflict UX: a banner with "keep mine", "use disk", "show diff." No auto-merge.

**Performance budget.** Typing latency: input-to-paint under 16ms on a 5-year-old laptop for entries up to 10k words. Opening an entry: under 100ms. Switching between entries: under 50ms.

## Non-goals

- No real-time collaboration in v1.
- No AI completions, AI rewrites, or "improve this paragraph." The app may expose a hook for a plugin to do this, but nothing ships in the box.
- No rich content beyond markdown extensions listed above (no embedded video editor, no Notion-style databases-in-pages — that pattern is exactly the "ugly database feeling" anti-pillar).
- No source-only mode toggle in v1; the live-inline model is the only model. Reconsider if users push back.
- No spell-check engine of our own; defer to the platform.
- No multi-cursor in v1. Single cursor only. The live-inline render boundary makes arbitrary multi-cursor placement subtle; revisit after v1.
- No inline math (LaTeX), Mermaid, PlantUML, or other diagram / formula renderers in core. These belong to the processor plugin contract; the core editor renders CommonMark + GFM + frontmatter + wikilinks + tags + mentions only.
- No in-app preview, content extraction, or thumbnails for attachments (no PDF viewer, no text indexing of attachment contents). An attachment is an opaque file with a name; clicking hands it to the OS.

## Edge cases

- **File starts with frontmatter but no body.** Render as an entry with empty content; cursor lands in the body area.
- **File has no frontmatter.** Render as an entry with no properties. App writes frontmatter only when the user adds a property.
- **Very long lines / very long entries.** Virtualize rendering; do not load the full DOM for a 100k-word entry.
- **Mixed line endings.** Normalize to `\n` on write; preserve the user's original on read until first write.
- **Trailing whitespace, BOM, weird quotes.** Preserve on read; do not silently rewrite on save unless the user edits that line.
- **Image paste.** Save the image to a `_assets/` folder next to the entry; insert a relative link. The folder name is a library setting (see 0011). Accepted image formats: PNG, JPG, WebP, GIF, SVG (the same set 0005 references for avatars). Attachments share this same `_assets/` folder.
- **Attachment filename collision.** Two `report.pdf` files attached to the same entry: the second is stored as `report-2.pdf` and the link points at the suffixed name. The user's body text is not consulted for naming.
- **Attachment target missing.** The `_assets/` file behind an attachment link was deleted or moved externally. The block renders in a broken state; click is disabled; the block offers "relink…" or "remove link."
- **Pasted rich text.** Convert to markdown; never embed HTML in the body. Show a one-time "converted from rich text" affordance.

## Acceptance criteria

- Type `# heading` → renders as a heading; cursor in the line shows `# heading`, cursor elsewhere shows the styled heading.
- Type `[[` → entry picker appears; selection inserts a wikilink; on save the wikilink survives a round-trip through a plain markdown reader (i.e. stored as literal text).
- Type `#tag` → tag autocomplete; the literal stays in the body, frontmatter is not modified, and the entry is findable by that tag (see 0004).
- Type `@slug` → person autocomplete; the mention renders as a chip (with avatar if the person has one); the literal `@slug` survives a round-trip through a plain markdown reader.
- Drag a non-image file into an entry → it is copied into `_assets/` and `[name.ext](_assets/name.ext)` is inserted; the editor shows a name-only attachment block.
- Click an attachment block → the file opens via the OS default application; contents are not rendered in-app.
- Delete on an attachment block → both the `_assets/` file and the body link are removed.
- An attachment link survives a round-trip through a plain markdown reader as a relative link.
- Toggle a task checkbox → the body change persists to disk; the entry's `done` property is unaffected.
- External edit while app is open and buffer is clean → reload silent.
- External edit while app is open and buffer is dirty → conflict UX shown; no data lost on either side.
- Typing latency under 16ms p95 in the 10k-word benchmark.
