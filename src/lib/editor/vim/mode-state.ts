// Vim-flavor modal engine — mode state (spec 0007 §Modal vs modeless).
//
// The vim-flavor preset enables a modal editor engine scoped to the `editor`
// zone. This module owns the *state* half of that engine: a CodeMirror
// StateField tracking the current mode, the effect to change it, and a small
// reactive notifier so the Svelte chrome can render a mode indicator.
//
// Modes implemented (spec/preset surface only — "vim-ish", not a full emulator):
//   normal  — motions + operators; the default when modal editing is active
//   insert  — ordinary text entry; the editor behaves like the default keymap
//   visual  — character-wise selection extension, for operators over a range
//
// Scope: this engine is installed *inside* the editor (a CM6 extension), so it
// is structurally incapable of leaking into the sidebar, palette, or any other
// zone — those never mount this extension.

import { StateField, StateEffect, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

export type VimMode = "normal" | "insert" | "visual";

/** Effect dispatched to switch the active mode. */
export const setVimMode = StateEffect.define<VimMode>();

/**
 * The mode StateField. Starts in `normal` — when the modal engine is installed
 * the buffer opens in normal mode, matching vim. Insert is entered explicitly
 * via i/a/o/etc.
 */
export const vimModeField = StateField.define<VimMode>({
  create() {
    return "normal";
  },
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(setVimMode)) value = e.value;
    }
    return value;
  },
});

/** Read the current mode from a view (defaults to normal if field absent). */
export function currentMode(view: EditorView): VimMode {
  return view.state.field(vimModeField, false) ?? "normal";
}

/** True when the modal engine is installed in this view. */
export function isModalActive(view: EditorView): boolean {
  return view.state.field(vimModeField, false) !== undefined;
}

// ── Reactive mode notifier ──────────────────────────────────────────────────
//
// The Svelte mode-indicator needs to react to mode changes without coupling to
// CM internals. An update listener pushes the latest mode into a per-view
// callback; the Editor component registers one callback and renders from it.

export type ModeListener = (mode: VimMode | null) => void;

const _listeners = new WeakMap<EditorView, ModeListener>();

/** Register the mode listener for a view. Returns an unregister function. */
export function registerModeListener(view: EditorView, fn: ModeListener): () => void {
  _listeners.set(view, fn);
  // Emit the current state immediately.
  fn(isModalActive(view) ? currentMode(view) : null);
  return () => {
    if (_listeners.get(view) === fn) _listeners.delete(view);
  };
}

/**
 * A small update listener that fires the registered callback whenever the mode
 * field changes — or whenever the field appears/disappears (engine toggled via
 * the compartment). Bundled into the modal extension so it is only present
 * while modal editing is active; on teardown the reconfigure transaction still
 * runs this once (the field is gone in the new state) and emits `null` so the
 * indicator hides.
 */
export const modeNotifier: Extension = EditorView.updateListener.of((u) => {
  const fn = _listeners.get(u.view);
  if (!fn) return;
  const before = u.startState.field(vimModeField, false);
  const after = u.state.field(vimModeField, false);
  if (before !== after) {
    fn(after === undefined ? null : after);
  }
});
