// Editor-scoped search panel (spec 0006, spec 0007 §Editor, brief item b).
//
// This extension provides the in-editor find panel (@codemirror/search), scoped
// to this editor instance and styled with --tnd-* tokens so it does not look
// foreign. It does NOT bind the formatting / block-manipulation commands: the
// keymap engine (0007) is the single owner of those bindings (editor.bold,
// editor.move-block-up, …), dispatching into the focused editor via the
// active-view registry. Binding them here as well would double-fire (the global
// keydown listener sits on an ancestor and the event bubbles up from CM).
//
// `searchKeymap` is included so the panel's own controls work (find next/prev,
// close) while its input is focused; its Mod-f → openSearchPanel duplicates the
// global editor.find handler harmlessly (openSearchPanel is idempotent).

import { keymap, EditorView } from "@codemirror/view";
import { Prec, type Extension } from "@codemirror/state";
import { search, searchKeymap, highlightSelectionMatches } from "@codemirror/search";

/** Themed search panel: maps the @codemirror/search panel chrome to --tnd-*. */
const searchPanelTheme = EditorView.baseTheme({
  ".cm-panels": {
    backgroundColor: "var(--tnd-panel, #fff)",
    color: "var(--tnd-text, #1a1a1a)",
    borderColor: "var(--tnd-line, #e3e3e3)",
  },
  ".cm-panels.cm-panels-top": {
    borderBottom: "1px solid var(--tnd-line, #e3e3e3)",
  },
  ".cm-panel.cm-search": {
    padding: "6px 10px",
    fontFamily: "var(--tnd-font-ui, ui-sans-serif, system-ui, sans-serif)",
    fontSize: "13px",
  },
  ".cm-panel.cm-search input, .cm-panel.cm-search button, .cm-panel.cm-search label": {
    fontFamily: "inherit",
    fontSize: "inherit",
  },
  ".cm-panel.cm-search input[type=text]": {
    backgroundColor: "var(--tnd-bg, #fff)",
    color: "var(--tnd-text, #1a1a1a)",
    border: "1px solid var(--tnd-line, #e3e3e3)",
    borderRadius: "var(--tnd-radius, 6px)",
    padding: "3px 6px",
  },
  ".cm-panel.cm-search button": {
    backgroundColor: "var(--tnd-panel2, #f4f4f4)",
    color: "var(--tnd-text, #1a1a1a)",
    border: "1px solid var(--tnd-line, #e3e3e3)",
    borderRadius: "var(--tnd-radius, 6px)",
    cursor: "pointer",
  },
  ".cm-panel.cm-search button[name=close]": {
    color: "var(--tnd-text-muted, #666)",
  },
  ".cm-searchMatch": {
    backgroundColor: "var(--tnd-accent-soft, rgba(100,149,237,0.2))",
  },
  ".cm-searchMatch-selected": {
    backgroundColor: "var(--tnd-accent, #6495ed)",
    color: "var(--tnd-accent-text, #fff)",
  },
});

/** In-editor find: the search state, selection-match highlight, panel keys, theme. */
export const editorKeymap: Extension = [
  search({ top: true }),
  highlightSelectionMatches(),
  Prec.high(keymap.of(searchKeymap)),
  searchPanelTheme,
];
