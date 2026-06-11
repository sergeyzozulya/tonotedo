// Active-editor registry — the bridge between the command system (0007) and the
// focused CodeMirror instance.
//
// The command registry handlers (and the mobile accessory bar) are intent-only:
// they cannot reach into a Svelte component's CM6 EditorView directly. The
// Editor component registers its view here on focus and clears it on
// destroy/blur; command handlers call `runEditorCommand` to dispatch a CM6
// command into whichever editor is currently focused.

import type { EditorView } from "@codemirror/view";
import type { Command } from "@codemirror/view";

let active: EditorView | null = null;

/** Register `view` as the focused editor. Called by Editor.svelte on focus. */
export function setActiveEditorView(view: EditorView): void {
  active = view;
}

/** Clear the active view if it is `view` (idempotent on destroy/blur). */
export function clearActiveEditorView(view: EditorView): void {
  if (active === view) active = null;
}

/** The currently focused editor view, if any. */
export function getActiveEditorView(): EditorView | null {
  return active;
}

/**
 * Dispatch a CM6 command into the active editor, refocusing it first so the
 * edit lands and the caret stays visible (the accessory bar / palette steal
 * focus on click). Returns false when there is no active editor.
 */
export function runEditorCommand(cmd: Command): boolean {
  if (!active) return false;
  active.focus();
  return cmd(active);
}
