// CM6 theme for the editor.
//
// Per design-0003 §Interfaces ("Theme") and adr-0003: the editor reads the same
// CSS custom-property tokens as the chrome — there is no second theming system.
// A sibling agent owns the canonical `--tnd-*` token sheet (0011); here we only
// reference tokens via `var(--tnd-*, <fallback>)`. The fallbacks keep the editor
// legible if mounted before the sheet loads or in a bare test page; they are NOT
// a palette to be maintained here.

import { EditorView } from "@codemirror/view";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import type { Extension } from "@codemirror/state";

const v = (name: string, fallback: string) => `var(--tnd-${name}, ${fallback})`;

/** Base view theme: surfaces, caret, selection, gutter. Reads `--tnd-*`. */
export const baseTheme = EditorView.theme({
  "&": {
    color: v("editor-fg", "#1a1a1a"),
    backgroundColor: v("editor-bg", "#ffffff"),
    fontSize: v("editor-font-size", "15px"),
    height: "100%",
  },
  ".cm-content": {
    fontFamily: v("editor-font", "ui-monospace, SFMono-Regular, Menlo, monospace"),
    caretColor: v("editor-caret", "#1a1a1a"),
    maxWidth: v("editor-line-width", "42rem"),
    margin: "0 auto",
    padding: "1rem 0",
    lineHeight: v("editor-line-height", "1.6"),
  },
  ".cm-cursor, .cm-dropCursor": {
    borderLeftColor: v("editor-caret", "#1a1a1a"),
  },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
    backgroundColor: v("editor-selection", "#d7e6ff"),
  },
  ".cm-scroller": {
    fontFamily: "inherit",
    overflow: "auto",
  },
  ".cm-line": {
    padding: "0 1rem",
  },
});

/**
 * Highlight style mapping Lezer markdown highlight tags to `--tnd-*` colors.
 * Headings, emphasis, links, code, and the syntax punctuation that cursor-reveal
 * hides when the cursor leaves a token. The custom token nodes carry their own
 * `cm-tnd-*` mark classes (see cursor-reveal.ts), not highlight tags.
 */
export const markdownHighlight = HighlightStyle.define([
  { tag: t.heading1, fontWeight: "700", fontSize: "1.6em", color: v("editor-heading", "#111") },
  { tag: t.heading2, fontWeight: "700", fontSize: "1.4em", color: v("editor-heading", "#111") },
  { tag: t.heading3, fontWeight: "700", fontSize: "1.2em", color: v("editor-heading", "#111") },
  {
    tag: [t.heading4, t.heading5, t.heading6],
    fontWeight: "700",
    color: v("editor-heading", "#111"),
  },
  { tag: t.strong, fontWeight: "700" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strikethrough, textDecoration: "line-through" },
  { tag: [t.link, t.url], color: v("editor-link", "#2563eb"), textDecoration: "underline" },
  {
    tag: [t.monospace],
    fontFamily: v("editor-code-font", "ui-monospace, monospace"),
    backgroundColor: v("editor-code-bg", "rgba(0,0,0,0.05)"),
  },
  { tag: t.quote, color: v("editor-quote", "#666"), fontStyle: "italic" },
  { tag: t.list, color: v("editor-list-marker", "#999") },
  // Syntax punctuation (the `**`, `#`, `[`, `]`, backticks) — dimmed so the raw
  // markers recede when revealed; cursor-reveal hides them entirely when away.
  {
    tag: [t.processingInstruction, t.meta],
    color: v("editor-syntax-marker", "#b0b0b0"),
  },
]);

/** Token marks for the three custom inline tokens (simple styled marks; chips are #12). */
export const tokenMarksTheme = EditorView.baseTheme({
  ".cm-tnd-tag": {
    color: v("token-tag-fg", "#0a7d4f"),
    backgroundColor: v("token-tag-bg", "rgba(10,125,79,0.10)"),
    borderRadius: "3px",
    padding: "0 2px",
  },
  ".cm-tnd-mention": {
    color: v("token-mention-fg", "#2563eb"),
    backgroundColor: v("token-mention-bg", "rgba(37,99,235,0.10)"),
    borderRadius: "3px",
    padding: "0 2px",
  },
  ".cm-tnd-wikilink": {
    color: v("token-wikilink-fg", "#7c3aed"),
    textDecoration: "underline",
    textDecorationStyle: "dotted",
  },
  ".cm-tnd-frontmatter-fold": {
    color: v("frontmatter-fold-fg", "#888"),
    backgroundColor: v("frontmatter-fold-bg", "rgba(0,0,0,0.04)"),
    borderRadius: "4px",
    padding: "0 6px",
    fontStyle: "italic",
    cursor: "pointer",
  },
});

/** The full theme bundle the editor installs. */
export const editorTheme: Extension = [
  baseTheme,
  tokenMarksTheme,
  syntaxHighlighting(markdownHighlight),
];
