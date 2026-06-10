---
id: docs/tech/adr-0004-editor-base
title: Editor base component
kind: adr
status: accepted
related: [docs/spec/0002-entries, docs/spec/0004-tags, docs/spec/0005-mentions, docs/spec/0006-markdown-editor, docs/spec/0013-mobile, docs/tech/adr-0002-tech-stack, docs/tech/adr-0003-ui-framework]
supersedes:
---

# Editor base component

## Context

ADR 0002 deferred the editor base (CodeMirror 6 vs ProseMirror), to be driven by 0006's live-inline requirements. The decisive requirements from 0006 and 0002:

- **The markdown text is the document.** What is on disk is what the user wrote: trailing whitespace, BOM, odd quotes, and unknown syntax are preserved; nothing is rewritten unless the user edits that line. Tags, mentions, and wikilinks are literal text that must survive round-trips unchanged.
- **Live inline rendering, typora-style.** Cursor inside a token shows raw markdown; cursor outside shows the formatted form. No mode switch, no preview pane.
- **Performance budget**: <16ms input-to-paint at 10k words on a 5-year-old laptop; virtualized rendering for 100k-word entries.
- **Custom inline atoms**: tag chips, mention chips (with avatars), wikilink titles, attachment blocks — all rendered over literal text spans.

The two candidates model documents oppositely. CodeMirror 6 is a text editor: the buffer *is* the string on disk, and rendering is decorations layered onto it. ProseMirror is a rich-text editor: the document is a typed node tree, and markdown exists only via serialize/parse at the boundary.

## Decision

**CodeMirror 6**, with the live-inline behavior built as decoration extensions over the Lezer markdown parse tree.

- Source fidelity is structural, not an achievement: the buffer is byte-for-byte the file (modulo the line-ending normalization 0006 specifies on write). There is no serializer that could normalize, reorder, or lose syntax the user typed.
- The decoration system does exactly what live-inline needs: replace or style ranges of real text depending on cursor position; widget decorations carry tag/mention chips and attachment blocks; unknown markdown simply renders as text instead of being rejected by a schema.
- Viewport-only rendering is built in, which is how the 100k-word virtualization requirement and the 16ms budget stay realistic.
- This is the proven architecture for this exact product shape: Obsidian's live preview is CodeMirror 6, and independent implementations of Obsidian-style inline preview on CM6 exist in the open.

## Alternatives considered

**A. CodeMirror 6 (this ADR).** Pros as above; also first-class IME handling and a serious extension ecosystem (vim emulation exists if the `vim-flavor` preset of 0007 wants to lean on it). Cons: live-inline is assembled from decorations, not given — heading layout, list behaviors, and cursor-reveal logic are our code on top of the Lezer markdown tree; complex widget interactions (table editing UX) are more work than in a node-tree model.

**B. ProseMirror.** Pros: a real document model makes rich structural editing (tables, nested blocks, future collaborative editing) natural; mature, battle-tested core. Rejected on the source-fidelity requirement: markdown would be parse → node tree → serialize on every save, and a serializer is a normalizer by construction — emphasis style (`*` vs `_`), list markers, escaping, spacing, and any syntax outside the schema get rewritten or dropped. 0006's "preserve trailing whitespace, BOM, weird quotes" and the unknown-property/unknown-syntax round-trip posture of 0002 are precisely what lossy round-trips break. Mitigating this (token-preserving custom serializer, raw-text fallbacks per node) is a permanent fight against the model's grain. Markdown-WYSIWYG wrappers built on ProseMirror (e.g. Milkdown) inherit the same boundary.

**C. Custom editor on contenteditable.** Total control, no dependency risk. Rejected without much agony: a decade of editor projects demonstrates that selection, IME, undo, and cross-webview quirks consume teams far larger than this one. ADR 0002 already rejected stacks that would require hand-building "what CodeMirror gives us for free."

**D. Monaco.** A code editor, superb at code, but heavyweight (~5MB+), Chromium-tuned (risky on WKWebView/WebKitGTK), and its decoration model is less suited to replacing text with rendered widgets. Rejected.

## Consequences

**Good:**

- Disk fidelity guaranteed by architecture; the 0006 acceptance criteria about literal round-trips need no defensive machinery.
- Viewport rendering, IME correctness, undo history, and platform text behaviors are inherited, not built.
- The same component can later serve a raw-source view (0006 keeps it as a possible post-v1 concession) by switching off decorations — no second editor.

**Bad / costly:**

- The live-inline layer (cursor-reveal, heading/list/quote styling, chip widgets, checkbox interaction) is a substantial in-house extension set — this is where the editor budget goes, and it should be treated as the riskiest single component in the app.
- Block-level manipulation (0006's move/indent/convert commands) operates on parse-tree ranges rather than first-class nodes; correctness depends on our tree-walking code.
- Table editing UX on decorations will be modest in v1; Notion-grade table interaction is out of reach without disproportionate effort (acceptably aligned with the anti-database posture).

## Follow-ups

- Design doc: editor extension architecture — decoration sets, cursor-reveal rules per token type, chip widget lifecycle, and the checkbox/wikilink/tag interaction map (0006). — done (`design-0003-editor-extensions`).
- Spike the 10k-word typing benchmark on all webview targets early — including iOS WKWebView and Android System WebView, since mobile ships at parity (0013); touch selection, caret handles, and software-keyboard IME behavior over decorations are the riskiest unknowns and belong in the ADR 0002 mobile spike. This validates this ADR and ADR 0002's webview bet at once.
- Decide whether `vim-flavor` (0007) wraps `@replit/codemirror-vim` or implements a reduced mode set natively.
