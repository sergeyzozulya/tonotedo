// Vim-flavor modal engine — keymap & dispatch (spec 0007 §Modal vs modeless).
//
// A high-precedence keydown handler that, *in normal/visual mode only*,
// interprets keystrokes as motions and operators. In insert mode the handler is
// inert except for Esc (→ normal), so ordinary typing flows to the editor's
// default keymap exactly as in the non-modal editor.
//
// Two-key sequences (gg, dd, yy) are handled with a tiny pending-key buffer that
// resets on any non-continuing key or after a short timeout.
//
// This is "vim-ish" (0007 non-goal: not a full vim emulator): counts, registers
// beyond the unnamed one, ex-commands, and the full operator-grammar are out of
// scope.

import { EditorSelection } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { undo, redo } from "@codemirror/commands";
import { Prec, type Extension } from "@codemirror/state";

import { setVimMode, vimModeField, type VimMode } from "./mode-state.js";
import {
  moveCharLeft,
  moveCharRight,
  moveLineDown,
  moveLineUp,
  moveLineStart,
  moveLineEnd,
  moveDocStart,
  moveDocEnd,
  moveWordForward,
  moveWordBackward,
  moveWordEnd,
} from "./motions.js";
import { deleteCharUnderCursor, deleteLine, yankLine, paste } from "./operators.js";

type Motion = (state: EditorView["state"], pos: number) => number;

function mode(view: EditorView): VimMode {
  return view.state.field(vimModeField, false) ?? "normal";
}

function setMode(view: EditorView, m: VimMode): void {
  view.dispatch({ effects: setVimMode.of(m) });
}

/**
 * Apply a motion to the main cursor. In visual mode the anchor is preserved so
 * the selection extends; in normal mode the cursor jumps.
 */
function applyMotion(view: EditorView, motion: Motion): boolean {
  const sel = view.state.selection.main;
  const head = motion(view.state, sel.head);
  const anchor = mode(view) === "visual" ? sel.anchor : head;
  view.dispatch({
    selection: EditorSelection.range(anchor, head),
    scrollIntoView: true,
  });
  return true;
}

// ── Pending-key buffer for two-key sequences (gg, dd, yy) ────────────────────

interface Pending {
  key: string;
  at: number;
}
const _pending = new WeakMap<EditorView, Pending | null>();
const SEQUENCE_TIMEOUT_MS = 900;

function takePending(view: EditorView, key: string): boolean {
  const p = _pending.get(view);
  _pending.set(view, null);
  if (!p) return false;
  if (p.key !== key) return false;
  if (Date.now() - p.at > SEQUENCE_TIMEOUT_MS) return false;
  return true;
}

function setPending(view: EditorView, key: string): void {
  _pending.set(view, { key, at: Date.now() });
}

// ── Insert-mode entries ──────────────────────────────────────────────────────

function enterInsert(
  view: EditorView,
  place: (s: typeof view.state, pos: number) => number,
): boolean {
  const pos = view.state.selection.main.head;
  view.dispatch({
    selection: EditorSelection.cursor(place(view.state, pos)),
    effects: setVimMode.of("insert"),
  });
  return true;
}

function openLineBelow(view: EditorView): boolean {
  const pos = view.state.selection.main.head;
  const line = view.state.doc.lineAt(pos);
  view.dispatch({
    changes: { from: line.to, insert: "\n" },
    selection: EditorSelection.cursor(line.to + 1),
    effects: setVimMode.of("insert"),
  });
  return true;
}

function openLineAbove(view: EditorView): boolean {
  const pos = view.state.selection.main.head;
  const line = view.state.doc.lineAt(pos);
  view.dispatch({
    changes: { from: line.from, insert: "\n" },
    selection: EditorSelection.cursor(line.from),
    effects: setVimMode.of("insert"),
  });
  return true;
}

// ── Key table for normal/visual mode ─────────────────────────────────────────
//
// Returns true when the key was handled (and should be swallowed). Each handler
// runs only while in normal or visual mode; the top-level guard enforces that.

function handleNormalKey(view: EditorView, key: string): boolean {
  switch (key) {
    // Motions
    case "h":
      return applyMotion(view, moveCharLeft);
    case "l":
      return applyMotion(view, moveCharRight);
    case "j":
      return applyMotion(view, moveLineDown);
    case "k":
      return applyMotion(view, moveLineUp);
    case "w":
      return applyMotion(view, moveWordForward);
    case "b":
      return applyMotion(view, moveWordBackward);
    case "e":
      return applyMotion(view, moveWordEnd);
    case "0":
      return applyMotion(view, moveLineStart);
    case "$":
      return applyMotion(view, moveLineEnd);
    case "G":
      return applyMotion(view, (s) => moveDocEnd(s));
    case "g": {
      if (takePending(view, "g")) return applyMotion(view, () => moveDocStart());
      setPending(view, "g");
      return true;
    }

    // Insert-mode entries
    case "i":
      return enterInsert(view, (_s, pos) => pos);
    case "a":
      return enterInsert(view, (s, pos) => {
        const line = s.doc.lineAt(pos);
        return Math.min(line.to, pos + 1);
      });
    case "I":
      return enterInsert(view, (s, pos) => s.doc.lineAt(pos).from);
    case "A":
      return enterInsert(view, (s, pos) => s.doc.lineAt(pos).to);
    case "o":
      return openLineBelow(view);
    case "O":
      return openLineAbove(view);

    // Operators
    case "x":
      return deleteCharUnderCursor(view);
    case "p":
      return paste(view);
    case "d": {
      if (takePending(view, "d")) return deleteLine(view);
      setPending(view, "d");
      return true;
    }
    case "y": {
      if (takePending(view, "y")) {
        yankLine(view);
        if (mode(view) === "visual") setMode(view, "normal");
        return true;
      }
      setPending(view, "y");
      return true;
    }

    // Undo / redo
    case "u":
      return undo(view);

    // Visual mode
    case "v": {
      if (mode(view) === "visual") {
        setMode(view, "normal");
      } else {
        setMode(view, "visual");
      }
      return true;
    }

    default:
      return false;
  }
}

// ── The modal extension ──────────────────────────────────────────────────────

/**
 * The vim modal keymap. Highest precedence so it intercepts before the default
 * editor keymap — but only when in normal/visual mode. Esc always returns to
 * normal (and collapses any selection).
 */
const modalKeymap = keymap.of([
  {
    key: "Escape",
    run: (view) => {
      _pending.set(view, null);
      if (mode(view) === "insert" || mode(view) === "visual") {
        const head = view.state.selection.main.head;
        view.dispatch({
          selection: EditorSelection.cursor(head),
          effects: setVimMode.of("normal"),
        });
        return true;
      }
      // Already in normal mode — collapse selection, swallow so Esc is inert.
      view.dispatch({ selection: EditorSelection.cursor(view.state.selection.main.head) });
      return true;
    },
  },
  {
    key: "Mod-r",
    run: (view) => {
      if (mode(view) === "insert") return false;
      return redo(view);
    },
  },
]);

/**
 * A keydown handler at the DOM layer for the single-character normal-mode keys.
 * Using a DOM handler (rather than dozens of keymap entries) lets us guard on
 * the current mode cleanly and own the pending-sequence buffer. It only acts in
 * normal/visual mode; in insert mode it returns without preventing default so
 * the character is typed normally.
 */
const modalKeyHandler = EditorView.domEventHandlers({
  keydown(event, view) {
    const m = mode(view);
    if (m === "insert") return false;
    // Ignore modified keys (let Mod-* shortcuts and the keymap above run); we
    // only interpret bare printable keys plus Shift for capitals.
    if (event.metaKey || event.ctrlKey || event.altKey) return false;
    // Bare modifier presses produce keys like "Shift" — ignore.
    if (event.key.length !== 1) return false;
    const handled = handleNormalKey(view, event.key);
    if (handled) {
      event.preventDefault();
      return true;
    }
    // Unhandled printable key in normal mode: swallow it so stray characters do
    // not get typed into the buffer (vim ignores them).
    event.preventDefault();
    return true;
  },
});

/**
 * The full modal editor extension. Compose into the editor behind a Compartment
 * so it can be toggled live when the preset changes. Includes the mode field,
 * the keymap, the DOM handler, and the mode notifier.
 */
export function modalExtension(notifier: Extension): Extension {
  return [vimModeField, Prec.highest(modalKeymap), Prec.highest(modalKeyHandler), notifier];
}
