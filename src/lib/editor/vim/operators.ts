// Vim-flavor modal engine — operators & register (spec 0007, "vim-ish").
//
// Operators: x (delete char), dd (delete line), yy (yank line), p (paste).
// A single unnamed register holds yanked/deleted text. Line-wise yanks are
// tagged so `p` pastes them on a new line below, matching vim.
//
// These are CM6 commands ((view) => boolean): they read the current selection's
// main cursor, dispatch a transaction, and return true when they handled the
// key. Kept here (not in keymap.ts) so the register and line/char logic are
// unit-testable against a view.

import { EditorSelection } from "@codemirror/state";
import { type EditorView } from "@codemirror/view";

// ── Unnamed register ─────────────────────────────────────────────────────────

interface Register {
  text: string;
  linewise: boolean;
}

let _register: Register = { text: "", linewise: false };

/** Test/utility access to the register. */
export function getRegister(): Register {
  return { ..._register };
}

export function setRegister(text: string, linewise: boolean): void {
  _register = { text, linewise };
}

// ── x — delete character under cursor ────────────────────────────────────────

export function deleteCharUnderCursor(view: EditorView): boolean {
  const { state } = view;
  const pos = state.selection.main.head;
  const line = state.doc.lineAt(pos);
  if (pos >= line.to) return true; // empty line / at newline: nothing to delete
  const deleted = state.doc.sliceString(pos, pos + 1);
  setRegister(deleted, false);
  view.dispatch({
    changes: { from: pos, to: pos + 1 },
    // Cursor stays on the same column, clamped to the new last char of the line.
    selection: EditorSelection.cursor(Math.min(pos, Math.max(line.from, line.to - 2))),
  });
  return true;
}

// ── dd — delete current line (linewise) ──────────────────────────────────────

export function deleteLine(view: EditorView): boolean {
  const { state } = view;
  const pos = state.selection.main.head;
  const line = state.doc.lineAt(pos);
  // Linewise register content includes a trailing newline.
  setRegister(line.text + "\n", true);
  // Delete the line plus its trailing newline; if it is the last line, swallow
  // the preceding newline instead so we don't leave a stray blank line.
  let from = line.from;
  let to = Math.min(state.doc.length, line.to + 1);
  if (line.number === state.doc.lines && line.from > 0) {
    from = line.from - 1;
    to = line.to;
  }
  view.dispatch({
    changes: { from, to },
    // CM maps the selection through the change; landing at `from` puts the
    // cursor at the start of whatever line now occupies this position.
    selection: EditorSelection.cursor(from),
  });
  return true;
}

// ── yy — yank current line (linewise) ────────────────────────────────────────

export function yankLine(view: EditorView): boolean {
  const { state } = view;
  const pos = state.selection.main.head;
  const line = state.doc.lineAt(pos);
  setRegister(line.text + "\n", true);
  return true;
}

// ── p — paste after cursor / below line ──────────────────────────────────────

export function paste(view: EditorView): boolean {
  const reg = _register;
  if (!reg.text) return true;
  const { state } = view;
  const pos = state.selection.main.head;

  if (reg.linewise) {
    // Insert the yanked block on a fresh line below the current one; cursor
    // lands at the start of the pasted block.
    const line = state.doc.lineAt(pos);
    const insertAt = line.to;
    const block = "\n" + reg.text.replace(/\n$/, "");
    view.dispatch({
      changes: { from: insertAt, insert: block },
      selection: EditorSelection.cursor(insertAt + 1),
    });
    return true;
  }

  // Charwise: insert after the cursor (vim's p); cursor lands on the last
  // inserted character.
  const line = state.doc.lineAt(pos);
  const insertAt = Math.min(line.to, pos + 1);
  view.dispatch({
    changes: { from: insertAt, insert: reg.text },
    selection: EditorSelection.cursor(insertAt + reg.text.length - 1),
  });
  return true;
}
