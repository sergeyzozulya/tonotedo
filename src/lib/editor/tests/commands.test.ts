// Tests for editor formatting & block commands (spec 0006, 0007).
//
// DOM-free: StateCommands are run against an EditorState; we capture the
// dispatched transaction and assert on the resulting document + selection.

import { describe, it, expect } from "vitest";
import { EditorState, EditorSelection, type Transaction } from "@codemirror/state";

import { markdownExtension } from "../extensions/markdown.js";
import { toggleWrap, setHeading, cycleBlockLine, cycleBlockType } from "../commands.js";

function stateOf(doc: string, anchor: number, head = anchor): EditorState {
  return EditorState.create({
    doc,
    selection: EditorSelection.range(anchor, head),
    extensions: [markdownExtension],
  });
}

/** Run a StateCommand once; return the resulting doc + main selection, or null
 *  if the command returned false / dispatched nothing. */
function run(
  state: EditorState,
  cmd: (target: { state: EditorState; dispatch: (tr: Transaction) => void }) => boolean,
): { doc: string; from: number; to: number } | null {
  let next: EditorState | null = null;
  const handled = cmd({
    state,
    dispatch: (tr) => {
      next = tr.state;
    },
  });
  if (!handled || !next) return null;
  const s: EditorState = next;
  return {
    doc: s.doc.toString(),
    from: s.selection.main.from,
    to: s.selection.main.to,
  };
}

// ── Inline wrap toggles ────────────────────────────────────────────────────────

describe("toggleWrap — bold (**)", () => {
  const bold = toggleWrap("**");

  it("wraps a selection", () => {
    const r = run(stateOf("hello world", 0, 5), bold);
    expect(r?.doc).toBe("**hello** world");
  });

  it("is idempotent — wrapping bold text removes it (markers inside selection)", () => {
    // Selection covers the whole **hello**.
    const r = run(stateOf("**hello** world", 0, 9), bold);
    expect(r?.doc).toBe("hello world");
  });

  it("removes markers that sit just outside the selection", () => {
    // Selection covers only `hello`, markers are adjacent.
    const r = run(stateOf("**hello** world", 2, 7), bold);
    expect(r?.doc).toBe("hello world");
  });

  it("wraps the word at the cursor when selection is empty", () => {
    const r = run(stateOf("hello world", 2, 2), bold);
    expect(r?.doc).toBe("**hello** world");
  });

  it("inserts empty markers with cursor between when not on a word", () => {
    const r = run(stateOf("  ", 1, 1), bold); // cursor between two spaces, no word
    expect(r?.doc).toBe(" **** ");
    expect(r?.from).toBe(3);
    expect(r?.to).toBe(3);
  });
});

describe("toggleWrap — italic (*) and code (`)", () => {
  it("italic wraps and unwraps", () => {
    const wrapped = run(stateOf("word", 0, 4), toggleWrap("*"));
    expect(wrapped?.doc).toBe("*word*");
    const unwrapped = run(stateOf("*word*", 0, 6), toggleWrap("*"));
    expect(unwrapped?.doc).toBe("word");
  });

  it("code wraps and unwraps", () => {
    const wrapped = run(stateOf("x", 0, 1), toggleWrap("`"));
    expect(wrapped?.doc).toBe("`x`");
    const unwrapped = run(stateOf("`x`", 0, 3), toggleWrap("`"));
    expect(unwrapped?.doc).toBe("x");
  });

  it("italic toggle on text inside bold does not corrupt the bold markers", () => {
    // Selecting `word` inside `**word**` and toggling italic must not strip
    // one `*` from the double-bold and leave `*word*`.
    const r = run(stateOf("**word**", 2, 6), toggleWrap("*"));
    // Should add `*` around word (making it bold+italic), not remove a `*`.
    expect(r?.doc).toBe("***word***");
  });
});

// ── Heading ────────────────────────────────────────────────────────────────────

describe("setHeading", () => {
  it("adds a prefix to a plain line", () => {
    const r = run(stateOf("Title", 5, 5), setHeading(1));
    expect(r?.doc).toBe("# Title");
  });

  it("re-applying the same level toggles it off", () => {
    const r = run(stateOf("# Title", 7, 7), setHeading(1));
    expect(r?.doc).toBe("Title");
  });

  it("replaces a different heading level", () => {
    const r = run(stateOf("# Title", 7, 7), setHeading(3));
    expect(r?.doc).toBe("### Title");
  });

  it("operates on the line at the cursor in a multi-line doc", () => {
    const doc = "first\nsecond\nthird";
    const head = doc.indexOf("second") + 2;
    const r = run(stateOf(doc, head, head), setHeading(2));
    expect(r?.doc).toBe("first\n## second\nthird");
  });
});

// ── Block conversion cycle ──────────────────────────────────────────────────────

describe("cycleBlockLine", () => {
  it("paragraph → heading", () => {
    expect(cycleBlockLine("text")).toBe("# text");
  });
  it("heading → bullet list", () => {
    expect(cycleBlockLine("# text")).toBe("- text");
  });
  it("bullet list → paragraph", () => {
    expect(cycleBlockLine("- text")).toBe("text");
  });
  it("preserves list indentation when converting back to paragraph", () => {
    expect(cycleBlockLine("  - item")).toBe("  item");
  });
  it("cycles back to the start after three steps", () => {
    const a = cycleBlockLine("text");
    const b = cycleBlockLine(a);
    const c = cycleBlockLine(b);
    expect(c).toBe("text");
  });
});

describe("cycleBlockType (StateCommand)", () => {
  it("converts the line at the cursor", () => {
    const r = run(stateOf("hello", 5, 5), cycleBlockType);
    expect(r?.doc).toBe("# hello");
  });
});
