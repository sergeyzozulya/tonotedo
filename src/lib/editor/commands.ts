// Editor formatting & block commands (spec 0006 §Block model, spec 0007 §Editor).
//
// These are CM6 commands `(view) => boolean` plus the pure state-level helpers
// they are built on, so the behavior is unit-testable without a DOM. The command
// registry (0007) and the mobile accessory bar dispatch into these via the
// active-view registry (see active-view.ts).
//
// Formatting toggles are idempotent: applying bold to already-bold text removes
// the markers. Heading commands set/replace the leading `#` prefix on the
// current line; applying the same level again removes it (toggle).

import { EditorSelection, type ChangeSpec, type StateCommand } from "@codemirror/state";
import { type Command, EditorView } from "@codemirror/view";
import { moveLineUp, moveLineDown, indentMore, indentLess } from "@codemirror/commands";

// ── Inline wrap toggles (bold / italic / code) ────────────────────────────────

/**
 * Toggle a symmetric inline marker (`**`, `*`, `` ` ``) around the primary
 * selection. With an empty selection, the word at the cursor is used; if there
 * is no word, the markers are inserted with the cursor placed between them.
 *
 * Idempotent: if the target span is already wrapped in the marker, the marker is
 * removed instead of added.
 */
export function toggleWrap(marker: string): StateCommand {
  return ({ state, dispatch }) => {
    const range = state.selection.main;
    const doc = state.doc;

    // Resolve the span to wrap: selection if present, else word-at-cursor.
    let from = range.from;
    let to = range.to;
    if (from === to) {
      const word = wordAt(doc.toString(), from);
      from = word.from;
      to = word.to;
    }

    const mLen = marker.length;
    const inner = doc.sliceString(from, to);

    // Already wrapped *inside* the selection (e.g. selection covers `**word**`)?
    if (inner.length >= 2 * mLen && inner.startsWith(marker) && inner.endsWith(marker)) {
      const unwrapped = inner.slice(mLen, inner.length - mLen);
      dispatch(
        state.update({
          changes: { from, to, insert: unwrapped },
          selection: EditorSelection.range(from, from + unwrapped.length),
          scrollIntoView: true,
        }),
      );
      return true;
    }

    // Already wrapped *around* the span (markers sit just outside)?
    // Guard: the character just outside the marker must not be the same marker
    // character to avoid partially stripping a longer sequence (e.g. `*`-toggle
    // on `word` inside `**word**` would otherwise see `*…*` and strip one `*`
    // from the double-bold, corrupting the document).
    const outerBefore = doc.sliceString(Math.max(0, from - mLen - 1), from - mLen);
    const outerAfter = doc.sliceString(to + mLen, Math.min(doc.length, to + mLen + 1));
    const before = doc.sliceString(Math.max(0, from - mLen), from);
    const after = doc.sliceString(to, Math.min(doc.length, to + mLen));
    if (
      before === marker &&
      after === marker &&
      outerBefore !== marker[0] &&
      outerAfter !== marker[marker.length - 1]
    ) {
      dispatch(
        state.update({
          changes: [
            { from: from - mLen, to: from },
            { from: to, to: to + mLen },
          ],
          selection: EditorSelection.range(from - mLen, to - mLen),
          scrollIntoView: true,
        }),
      );
      return true;
    }

    // Not wrapped — add the markers.
    const changes: ChangeSpec = [
      { from, insert: marker },
      { from: to, insert: marker },
    ];
    dispatch(
      state.update({
        changes,
        selection: EditorSelection.range(from + mLen, to + mLen),
        scrollIntoView: true,
      }),
    );
    return true;
  };
}

/** The word boundaries around offset `pos` in `text` (markdown-ish word chars). */
function wordAt(text: string, pos: number): { from: number; to: number } {
  const isWord = (ch: string) => /[\p{L}\p{N}_-]/u.test(ch);
  let from = pos;
  let to = pos;
  while (from > 0 && isWord(text[from - 1])) from -= 1;
  while (to < text.length && isWord(text[to])) to += 1;
  return { from, to };
}

export const toggleBold: Command = wrapCommand("**");
export const toggleItalic: Command = wrapCommand("*");
export const toggleCode: Command = wrapCommand("`");

/** Adapt a StateCommand wrap toggle into a view Command. */
function wrapCommand(marker: string): Command {
  const cmd = toggleWrap(marker);
  return (view: EditorView) => cmd(view);
}

// ── Heading prefix (set / toggle) ─────────────────────────────────────────────

/** Match a leading ATX heading prefix on a line: `#`..`######` + one space. */
const HEADING_RE = /^(#{1,6})\s+/;

/**
 * Set the current line's heading level. Re-applying the same level removes the
 * prefix (toggle to paragraph). Operates on the line containing the primary
 * selection head; blockquote/list markers are left untouched (the prefix is only
 * applied to the raw line start, matching the live-inline model).
 */
export function setHeading(level: 1 | 2 | 3 | 4 | 5 | 6): StateCommand {
  return ({ state, dispatch }) => {
    const line = state.doc.lineAt(state.selection.main.head);
    const text = line.text;
    const existing = HEADING_RE.exec(text);
    const desired = "#".repeat(level) + " ";

    let changes: ChangeSpec;
    let headDelta: number;
    if (existing && existing[1].length === level) {
      // Same level → remove the prefix (toggle off).
      changes = { from: line.from, to: line.from + existing[0].length, insert: "" };
      headDelta = -existing[0].length;
    } else if (existing) {
      // Different heading level → replace the prefix.
      changes = { from: line.from, to: line.from + existing[0].length, insert: desired };
      headDelta = desired.length - existing[0].length;
    } else {
      // No prefix → add it.
      changes = { from: line.from, insert: desired };
      headDelta = desired.length;
    }

    const head = Math.max(line.from, state.selection.main.head + headDelta);
    dispatch(
      state.update({
        changes,
        selection: EditorSelection.cursor(head),
        scrollIntoView: true,
      }),
    );
    return true;
  };
}

export const heading1: Command = (view) => setHeading(1)(view);
export const heading2: Command = (view) => setHeading(2)(view);
export const heading3: Command = (view) => setHeading(3)(view);

// ── Block conversion: paragraph → heading → list → paragraph ──────────────────

const BULLET_RE = /^(\s*)([-*+])\s+/;

/**
 * Cycle the current line's block type: paragraph → heading (H1) → bullet list →
 * paragraph. A pure step over a single line's text, exported for testing.
 * Returns the new line text.
 */
export function cycleBlockLine(text: string): string {
  const heading = HEADING_RE.exec(text);
  const bullet = BULLET_RE.exec(text);
  if (heading) {
    // heading → bullet list (keep the heading's text as the item)
    return "- " + text.slice(heading[0].length);
  }
  if (bullet) {
    // bullet → paragraph (strip the marker, keep indentation)
    return bullet[1] + text.slice(bullet[0].length);
  }
  // paragraph → heading
  return "# " + text;
}

/** Cycle the block type of the line at the primary selection head. */
export const cycleBlockType: StateCommand = ({ state, dispatch }) => {
  const line = state.doc.lineAt(state.selection.main.head);
  const next = cycleBlockLine(line.text);
  if (next === line.text) return false;
  const delta = next.length - line.text.length;
  const head = Math.max(line.from, state.selection.main.head + delta);
  dispatch(
    state.update({
      changes: { from: line.from, to: line.to, insert: next },
      selection: EditorSelection.cursor(head),
      scrollIntoView: true,
    }),
  );
  return true;
};

// ── Block move / indent (re-exported from @codemirror/commands) ───────────────

export const moveBlockUp: Command = moveLineUp;
export const moveBlockDown: Command = moveLineDown;
export const indentBlock: Command = indentMore;
export const outdentBlock: Command = indentLess;
