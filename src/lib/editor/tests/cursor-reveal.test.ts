import { describe, it, expect } from "vitest";
import { EditorState, EditorSelection } from "@codemirror/state";
import type { DecorationSet } from "@codemirror/view";

import { markdownExtension } from "../extensions/markdown.js";
import { computeRevealDecorations } from "../extensions/cursor-reveal.js";

// State-level (DOM-free) tests for the reveal computation. We build an
// EditorState, place the selection, run the pure computation over the whole doc
// as the "viewport", and read back the decoration ranges and their classes.

interface DecoInfo {
  from: number;
  to: number;
  /** "line" | "replace" | "mark" plus the class if any. */
  kind: string;
  cls?: string;
}

function stateOf(doc: string, head?: number): EditorState {
  return EditorState.create({
    doc,
    selection: head === undefined ? undefined : EditorSelection.cursor(head),
    extensions: [markdownExtension],
  });
}

function readDecos(set: DecorationSet, docLen: number): DecoInfo[] {
  const out: DecoInfo[] = [];
  const iter = set.iter();
  while (iter.value) {
    const spec = iter.value.spec as { class?: string; widget?: unknown };
    // Distinguish line (from===to at line start, has a class) / replace (no
    // class, hides text) / mark (has a token class, non-empty range).
    let kind: string;
    if (iter.from === iter.to) kind = "line";
    else if (spec.class) kind = "mark";
    else kind = "replace";
    out.push({ from: iter.from, to: iter.to, kind, cls: spec.class });
    iter.next();
  }
  void docLen;
  return out;
}

function decos(doc: string, head?: number): DecoInfo[] {
  const state = stateOf(doc, head);
  return readDecos(computeRevealDecorations(state, [{ from: 0, to: doc.length }]), doc.length);
}

describe("cursor-reveal — headings (line-level)", () => {
  const doc = "# Title\n\nbody";

  it("hides the `# ` marker and adds a heading line deco when cursor is elsewhere", () => {
    const d = decos(doc, doc.length); // cursor in body
    expect(d.some((x) => x.kind === "line" && x.cls?.includes("cm-tnd-h1"))).toBe(true);
    // The `# ` (positions 0..2) is replaced.
    expect(d.some((x) => x.kind === "replace" && x.from === 0 && x.to === 2)).toBe(true);
  });

  it("reveals raw (no decorations) when the cursor is on the heading line", () => {
    const d = decos(doc, 3); // cursor inside "# Title"
    expect(d.some((x) => x.kind === "line")).toBe(false);
    expect(d.some((x) => x.kind === "replace")).toBe(false);
  });
});

describe("cursor-reveal — emphasis (range-level)", () => {
  const doc = "a *em* b"; // EmphasisMark at 2..3 and 5..6

  it("hides emphasis marks when the head is outside the token", () => {
    const d = decos(doc, 0);
    const replaces = d.filter((x) => x.kind === "replace");
    expect(replaces).toContainEqual({ from: 2, to: 3, kind: "replace", cls: undefined });
    expect(replaces).toContainEqual({ from: 5, to: 6, kind: "replace", cls: undefined });
  });

  it("reveals emphasis marks when the head is inside the token", () => {
    const d = decos(doc, 4); // inside "em"
    expect(d.filter((x) => x.kind === "replace")).toEqual([]);
  });
});

describe("cursor-reveal — custom tokens (range-level)", () => {
  // "x #tag @me [[wl]] y" → #tag[2,6] @me[7,10] [[wl]][11,17]
  const doc = "x #tag @me [[wl]] y";

  it("marks all three tokens when the head touches none of them", () => {
    const d = decos(doc, 0);
    const marks = d.filter((x) => x.kind === "mark");
    expect(marks).toContainEqual({ from: 2, to: 6, kind: "mark", cls: "cm-tnd-tag" });
    expect(marks).toContainEqual({ from: 7, to: 10, kind: "mark", cls: "cm-tnd-mention" });
    expect(marks).toContainEqual({ from: 11, to: 17, kind: "mark", cls: "cm-tnd-wikilink" });
  });

  it("reveals only the token whose range the head touches", () => {
    const d = decos(doc, 4); // head inside #tag
    const marks = d.filter((x) => x.kind === "mark");
    expect(marks.some((m) => m.cls === "cm-tnd-tag")).toBe(false); // revealed
    expect(marks.some((m) => m.cls === "cm-tnd-mention")).toBe(true); // still marked
    expect(marks.some((m) => m.cls === "cm-tnd-wikilink")).toBe(true);
  });

  it("head at the exact token edge reveals it (touch = inclusive)", () => {
    const d = decos(doc, 2); // head at the leading `#`
    expect(d.some((m) => m.kind === "mark" && m.cls === "cm-tnd-tag")).toBe(false);
  });
});

describe("cursor-reveal — viewport scoping", () => {
  it("only decorates tokens within the supplied ranges", () => {
    const doc = "#one\n\n#two";
    const state = stateOf(doc, doc.length); // head at end → nothing revealed
    // Restrict the viewport to the first line only.
    const set = computeRevealDecorations(state, [{ from: 0, to: 4 }]);
    const out = readDecos(set, doc.length);
    const marks = out.filter((x) => x.kind === "mark");
    expect(marks).toHaveLength(1);
    expect(marks[0]).toMatchObject({ from: 0, to: 4, cls: "cm-tnd-tag" });
  });
});
