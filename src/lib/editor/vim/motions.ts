// Vim-flavor modal engine — motions (spec 0007, "vim-ish").
//
// Pure offset arithmetic over a CodeMirror EditorState, kept free of view/DOM
// concerns so it is directly unit-testable. The command wrappers in keymap.ts
// turn these into cursor moves / selection extensions.
//
// Implemented motions: h j k l, w b e, 0 $, gg G.
//
// Word semantics follow vim's "word" (sequences of "word characters"
// [A-Za-z0-9_] OR sequences of other non-blank punctuation), separated by
// whitespace — a deliberately simplified, single-class-aware approximation that
// matches everyday prose editing. This is "vim-ish", not bit-exact vim.

import { type EditorState } from "@codemirror/state";

/** Character class for word motions. */
type CharClass = "word" | "punct" | "space";

function classify(ch: string): CharClass {
  if (/\s/.test(ch)) return "space";
  if (/[A-Za-z0-9_]/.test(ch)) return "word";
  return "punct";
}

/** Clamp an offset into the document range. */
function clamp(state: EditorState, pos: number): number {
  return Math.max(0, Math.min(pos, state.doc.length));
}

// ── h / l — character left / right (line-bounded, like vim) ──────────────────

export function moveCharLeft(state: EditorState, pos: number): number {
  const line = state.doc.lineAt(pos);
  return Math.max(line.from, pos - 1);
}

export function moveCharRight(state: EditorState, pos: number): number {
  const line = state.doc.lineAt(pos);
  // In normal mode the cursor rests *on* a character, so the last legal column
  // is the last character (line.to - 1), not the newline. Empty line → stay.
  const last = Math.max(line.from, line.to - 1);
  return Math.min(last, pos + 1);
}

// ── j / k — line down / up, preserving column where possible ─────────────────

export function moveLineDown(state: EditorState, pos: number): number {
  const line = state.doc.lineAt(pos);
  if (line.number >= state.doc.lines) return pos;
  const col = pos - line.from;
  const next = state.doc.line(line.number + 1);
  return Math.min(next.from + col, Math.max(next.from, next.to - 1));
}

export function moveLineUp(state: EditorState, pos: number): number {
  const line = state.doc.lineAt(pos);
  if (line.number <= 1) return pos;
  const col = pos - line.from;
  const prev = state.doc.line(line.number - 1);
  return Math.min(prev.from + col, Math.max(prev.from, prev.to - 1));
}

// ── 0 / $ — line start / end ─────────────────────────────────────────────────

export function moveLineStart(state: EditorState, pos: number): number {
  return state.doc.lineAt(pos).from;
}

export function moveLineEnd(state: EditorState, pos: number): number {
  const line = state.doc.lineAt(pos);
  return Math.max(line.from, line.to - 1);
}

// ── gg / G — document start / last line ──────────────────────────────────────

export function moveDocStart(): number {
  return 0;
}

export function moveDocEnd(state: EditorState): number {
  // Vim's G lands on the first non-blank-ish position of the last line; we use
  // the start of the last line, which is the common, predictable behavior.
  return state.doc.line(state.doc.lines).from;
}

// ── w / b / e — word motions ─────────────────────────────────────────────────

/** Forward to the start of the next word. */
export function moveWordForward(state: EditorState, pos: number): number {
  const text = state.doc.toString();
  const n = text.length;
  let i = pos;
  if (i >= n) return n;
  const startClass = classify(text[i]);
  // Skip the rest of the current run (word or punct), unless on whitespace.
  if (startClass !== "space") {
    while (i < n && classify(text[i]) === startClass) i++;
  }
  // Skip whitespace to land on the next word's first char.
  while (i < n && classify(text[i]) === "space") i++;
  return clamp(state, i);
}

/** Backward to the start of the current/previous word. */
export function moveWordBackward(state: EditorState, pos: number): number {
  const text = state.doc.toString();
  let i = pos;
  if (i <= 0) return 0;
  i--; // step left first
  // Skip whitespace.
  while (i > 0 && classify(text[i]) === "space") i--;
  if (i <= 0) return 0;
  // Walk back to the start of this run.
  const runClass = classify(text[i]);
  while (i > 0 && classify(text[i - 1]) === runClass) i--;
  return clamp(state, i);
}

/** Forward to the end of the current/next word. */
export function moveWordEnd(state: EditorState, pos: number): number {
  const text = state.doc.toString();
  const n = text.length;
  let i = pos;
  if (i >= n - 1) return Math.max(0, n - 1);
  i++; // step right first (vim e always advances at least one)
  // Skip whitespace.
  while (i < n && classify(text[i]) === "space") i++;
  if (i >= n) return Math.max(0, n - 1);
  // Walk to the end of this run.
  const runClass = classify(text[i]);
  while (i < n - 1 && classify(text[i + 1]) === runClass) i++;
  return clamp(state, i);
}
