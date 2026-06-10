import { describe, it, expect } from "vitest";
import { EditorState, EditorSelection } from "@codemirror/state";

import {
  detectFrontmatter,
  computeFrontmatterDecorations,
} from "../extensions/frontmatter-fold.js";

function stateOf(doc: string, head?: number): EditorState {
  return EditorState.create({
    doc,
    selection: head === undefined ? undefined : EditorSelection.cursor(head),
  });
}

function foldRanges(doc: string, head?: number): Array<{ from: number; to: number }> {
  const set = computeFrontmatterDecorations(stateOf(doc, head));
  const out: Array<{ from: number; to: number }> = [];
  const iter = set.iter();
  while (iter.value) {
    out.push({ from: iter.from, to: iter.to });
    iter.next();
  }
  return out;
}

describe("detectFrontmatter", () => {
  it("detects a closed YAML block at the document start", () => {
    const doc = "---\ntitle: x\ntags: [a]\n---\n\nbody";
    const r = detectFrontmatter(stateOf(doc));
    expect(r).not.toBeNull();
    expect(r!.from).toBe(0);
    // closing fence is line 4 ("---"), its `.to` is the offset before its newline.
    expect(doc.slice(r!.from, r!.to)).toBe("---\ntitle: x\ntags: [a]\n---");
  });

  it("returns null when there is no frontmatter", () => {
    expect(detectFrontmatter(stateOf("# heading\n\nbody"))).toBeNull();
  });

  it("returns null for an unclosed opening fence (it is a thematic break)", () => {
    expect(detectFrontmatter(stateOf("---\ntitle: x\nbody with no close"))).toBeNull();
  });

  it("detects an empty frontmatter block (no body lines)", () => {
    const doc = "---\n---\nbody";
    const r = detectFrontmatter(stateOf(doc));
    expect(r).not.toBeNull();
    expect(doc.slice(r!.from, r!.to)).toBe("---\n---");
  });

  it("does not treat a fence in the middle of the document as frontmatter", () => {
    expect(detectFrontmatter(stateOf("text first\n---\nyaml?\n---"))).toBeNull();
  });

  it("ignores trailing whitespace on the fence line", () => {
    const doc = "---  \nk: v\n---  \nbody";
    expect(detectFrontmatter(stateOf(doc))).not.toBeNull();
  });
});

describe("computeFrontmatterDecorations", () => {
  const doc = "---\ntitle: x\n---\n\nbody";

  it("folds the block with one replace decoration when the cursor is outside", () => {
    const ranges = foldRanges(doc, doc.length); // cursor in body
    expect(ranges).toEqual([{ from: 0, to: doc.indexOf("\n\nbody") }]);
  });

  it("reveals raw (no fold) when the cursor is inside the block", () => {
    expect(foldRanges(doc, 5)).toEqual([]); // cursor inside "title: x"
  });

  it("produces no decoration when there is no frontmatter", () => {
    expect(foldRanges("# just a heading\n\nbody", 0)).toEqual([]);
  });

  it("produces no decoration for an unclosed fence", () => {
    expect(foldRanges("---\ntitle: x\nno close", 0)).toEqual([]);
  });
});
