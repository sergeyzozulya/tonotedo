---
id: docs/tech/design-0003-editor-extensions
title: Editor extension architecture (live-inline on CodeMirror 6)
kind: design
status: draft
related: [docs/spec/0002-entries, docs/spec/0004-tags, docs/spec/0005-mentions, docs/spec/0006-markdown-editor, docs/spec/0013-mobile, docs/tech/adr-0003-ui-framework, docs/tech/adr-0004-editor-base]
supersedes:
---

# Editor extension architecture (live-inline on CodeMirror 6)

## Context

adr-0004 picks CodeMirror 6; 0006 defines the behavior: typora-style live-inline rendering over a byte-faithful buffer, with chips for tags/mentions, resolved wikilinks, attachment blocks, and a frontmatter panel instead of raw YAML. This doc names the extension layers that deliver it. It is the riskiest component in the app (adr-0004) and the first thing the benchmarks must validate.

## Constraints

- The buffer is the file, byte-for-byte; every visual effect is a decoration, never a text mutation the user didn't make.
- <16ms input-to-paint at 10k words (0006), on mobile webviews too (0013).
- IME composition is sacred: no decoration churn and no command dispatch inside a composition range (0007).
- Unknown markdown renders as text; nothing is rejected.

## Model

**Parse layer.** Lezer markdown with GFM extensions, plus three small custom inline parsers: `#tag` (charset per 0004), `@mention` (word-boundary rule per 0005), `[[wikilink]]` (with `|display` and path-qualified targets per 0006). Fenced code and inline code suppress all three (0005's rule, applied uniformly). Frontmatter is a single document-start region parsed by a YAML island parser.

**Decoration layers**, in precedence order:

1. **Frontmatter fold** — the YAML block renders as a collapsed affordance; its content is edited in the properties panel (0006). The raw view toggle removes this fold only.
2. **Cursor-reveal** — replace-decorations render formatted markdown (headings, emphasis, links) except on lines/ranges touched by a selection head, where raw syntax shows. Implemented as a ViewPlugin recomputing only viewport decorations on selection change.
3. **Chips** — widget decorations over `#tag`, `@mention`, `[[wikilink]]` literal spans, marked atomic for cursor motion (arrowing skips over a chip; entering with explicit gesture reveals raw text per cursor-reveal). Chip data (color, avatar, resolved title) comes from a per-document metadata cache fed by index queries; chips re-render on metadata change events without reparse (0005's same-session update criterion).
4. **Blocks** — checkbox toggles (a click dispatches a real text edit `[ ]`↔`[x]`; content-only per 0006), attachment blocks over `_assets/` links, image rendering.

**Commands.** Block move/indent/convert (0006) compute target ranges from the Lezer tree and dispatch ordinary changesets; they register in the app command registry (0007) under the `editor` zone context. The `vim-flavor` preset wraps `@replit/codemirror-vim` scoped to the editor zone (adr-0004 follow-up — working assumption, validated in the spike).

**Save pipeline.** Document changes mark the buffer dirty; a 500ms debounce (and blur) sends the full text over IPC to the core's atomic write (design-0004). The self-write token (design-0001) suppresses the echo. Conflict events from the core raise the banner UX (0006); the editor never auto-merges.

**Autocomplete.** `#`, `@`, and `[[` trigger sources backed by index queries (scoped tags first, etc. per 0004/0005); selection inserts literal text only.

## Interfaces

- **Editor ↔ Svelte boundary** (adr-0003 follow-up): the editor is one Svelte component owning a CM6 instance; props in = entry text + settings facets (theme tokens, font, line width); events out = dirty/save-request, selection context (drives the properties panel and zone-aware commands), autocomplete queries. Focus is owned by CM6 inside the `editor` zone; the zone manager (0007) owns it outside.
- **Theme**: editor styling reads the same CSS custom-property tokens as the chrome (0011); no second theming system.

## Failure modes

- **Pathological documents** (100k words, single 1MB line): viewport-only decoration plus Lezer's incremental parsing keep typing bounded; the open-entry budget may degrade gracefully past the 0006 envelope with a one-time "large entry" hint.
- **Decoration/IME interaction**: decorations never replace ranges overlapping an active composition; verified per webview in the mobile spike (adr-0002 checklist item d).
- **Metadata cache miss** (chip for a tag the index hasn't seen yet): chip renders in default style and upgrades on the next change event — never blocks typing.

## Open questions

- Atomic chip ranges vs raw-reveal ergonomics: whether entering a chip requires a gesture or happens on adjacent cursor arrival — prototype both, pick by feel.
- Whether frontmatter fold belongs to this layer or to a document-splitting approach (panel edits write through the core, editor never sees YAML). Working assumption: fold in-editor, single source buffer.
- Touch caret handles vs cursor-reveal: on mobile, does raw-reveal trigger on tap-into or only on edit? Decide during the spike with real fingers.
