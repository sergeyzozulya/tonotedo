// Base editor extensions: markdown language + a curated "standard setup".
//
// design-0003 §Model: "Lezer markdown with GFM extensions, plus three small
// custom inline parsers". 0006 narrows the standard CM6 setup:
//   - No source-only / preview mode toggle (live-inline is the only model).
//   - No multi-cursor in v1 — `allowMultipleSelections` stays off (CM6 default),
//     and we do NOT install `rectangularSelection`/`drawSelection`'s multi-range
//     behavior via the multi-selection keymap.
//   - No line numbers / fold gutter chrome: this is a prose editor, not an IDE.
//
// We deliberately do NOT use `basicSetup` (it bundles line numbers, a fold
// gutter, the search panel, bracket-closing, and multi-selection bindings). The
// curated list below is the minimum that supports a faithful prose buffer plus
// the decoration layers that compose on top (cursor-reveal, frontmatter-fold,
// and the later chips/blocks issues #12/#13).

import { markdown as markdownLang, markdownLanguage } from "@codemirror/lang-markdown";
import { GFM } from "@lezer/markdown";
import { history, defaultKeymap, historyKeymap, indentWithTab } from "@codemirror/commands";
import {
  indentOnInput,
  bracketMatching,
  syntaxHighlighting,
  defaultHighlightStyle,
  codeFolding,
} from "@codemirror/language";
import {
  EditorView,
  keymap,
  drawSelection,
  dropCursor,
  highlightSpecialChars,
} from "@codemirror/view";
import { EditorState, type Extension } from "@codemirror/state";

import { customTokens } from "./inline-tokens.js";

/**
 * The markdown language support: CommonMark floor + GFM (tables, strikethrough,
 * task list items, autolink) + our three custom inline tokens. `addKeymap` stays
 * on so list/heading continuation behaves; `defaultCodeLanguage` is left unset —
 * fenced code highlighting by language is out of scope for the architecture
 * layer (specs allow language hints; per-language packages can be added later).
 */
export const markdownExtension: Extension = markdownLang({
  base: markdownLanguage,
  extensions: [GFM, customTokens],
  // Live-inline renders links; the paste-as-link heuristic stays on as a nicety.
  // HTML-tag completion is harmless and cheap; leave defaults.
});

/** Keys whose bindings the 0007 command engine owns (see baseSetup comment). */
const BLOCK_OWNED_KEYS = new Set(["Alt-ArrowUp", "Alt-ArrowDown", "Mod-]", "Mod-["]);

/**
 * Curated base setup. Order matters only where CM6 documents it; decoration
 * layers (cursor-reveal, frontmatter-fold) are appended by the Editor component
 * AFTER this so their precedence sits above the base highlight.
 */
export const baseSetup: Extension = [
  highlightSpecialChars(),
  history(),
  drawSelection(),
  dropCursor(),
  indentOnInput(),
  bracketMatching(),
  codeFolding(),
  // Fallback highlight for any nodes the editor theme's HighlightStyle does not
  // cover; the themed HighlightStyle (in theme.ts) is layered above it.
  syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
  // Single cursor only (0006 non-goal: no multi-cursor in v1).
  EditorState.allowMultipleSelections.of(false),
  EditorView.lineWrapping,
  // Drop the default block-move / indent bindings: spec 0007 makes the command
  // keymap engine the single owner of these (editor.move-block-up/-down,
  // editor.indent/-outdent), dispatched from the global keydown listener. Leaving
  // CM's own bindings active would double-fire (the global listener is an
  // ancestor; the keydown bubbles up after CM already ran the command).
  keymap.of([
    ...defaultKeymap.filter((b) => !BLOCK_OWNED_KEYS.has(b.key ?? "")),
    ...historyKeymap,
    indentWithTab,
  ]),
];
