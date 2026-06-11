// Vim motion correctness on a sample document (spec 0007, "vim-ish").
//
// Pure offset arithmetic — no DOM. The sample doc exercises word boundaries,
// punctuation, blank lines, and document edges.

import { describe, it, expect } from "vitest";
import { EditorState } from "@codemirror/state";

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
} from "../motions.js";

// Sample document. Offsets:
//   line 1: "hello world"      (0..10, newline at 11)
//   line 2: "foo.bar baz"      (12..22, newline at 23)
//   line 3: ""                 (24, blank)
//   line 4: "last line"        (25..33)
const DOC = "hello world\nfoo.bar baz\n\nlast line";

function st(doc = DOC): EditorState {
  return EditorState.create({ doc });
}

function offset(line: number, col: number): number {
  const s = st();
  return s.doc.line(line).from + col;
}

describe("h / l — char left/right (line-bounded)", () => {
  it("moves left within the line", () => {
    expect(moveCharLeft(st(), offset(1, 5))).toBe(offset(1, 4));
  });
  it("does not cross to the previous line", () => {
    expect(moveCharLeft(st(), offset(2, 0))).toBe(offset(2, 0));
  });
  it("moves right within the line", () => {
    expect(moveCharRight(st(), offset(1, 0))).toBe(offset(1, 1));
  });
  it("stops on the last character of the line (normal-mode rest position)", () => {
    // "hello world" — last char index is 10.
    expect(moveCharRight(st(), offset(1, 10))).toBe(offset(1, 10));
  });
  it("stays put on a blank line", () => {
    expect(moveCharRight(st(), offset(3, 0))).toBe(offset(3, 0));
  });
});

describe("j / k — line down/up preserving column", () => {
  it("moves down keeping the column", () => {
    expect(moveLineDown(st(), offset(1, 3))).toBe(offset(2, 3));
  });
  it("clamps the column on a shorter (blank) target line", () => {
    expect(moveLineDown(st(), offset(2, 5))).toBe(offset(3, 0));
  });
  it("moves up keeping the column", () => {
    expect(moveLineUp(st(), offset(2, 2))).toBe(offset(1, 2));
  });
  it("does not move above the first line", () => {
    expect(moveLineUp(st(), offset(1, 4))).toBe(offset(1, 4));
  });
});

describe("0 / $ — line start/end", () => {
  it("0 goes to line start", () => {
    expect(moveLineStart(st(), offset(2, 4))).toBe(offset(2, 0));
  });
  it("$ goes to the last char of the line", () => {
    expect(moveLineEnd(st(), offset(1, 0))).toBe(offset(1, 10));
  });
});

describe("gg / G — document edges", () => {
  it("gg goes to offset 0", () => {
    expect(moveDocStart()).toBe(0);
  });
  it("G goes to the start of the last line", () => {
    expect(moveDocEnd(st())).toBe(offset(4, 0));
  });
});

describe("w / b / e — word motions", () => {
  it("w moves to the start of the next word", () => {
    // "hello world": from 0 → start of "world" (col 6).
    expect(moveWordForward(st(), offset(1, 0))).toBe(offset(1, 6));
  });
  it("w treats punctuation as its own word", () => {
    // "foo.bar baz": from start of "foo" (col 0) → "." (col 3).
    expect(moveWordForward(st(), offset(2, 0))).toBe(offset(2, 3));
  });
  it("b moves back to the start of the previous word", () => {
    // From start of "world" (col 6) → start of "hello" (col 0).
    expect(moveWordBackward(st(), offset(1, 6))).toBe(offset(1, 0));
  });
  it("e moves to the end of the next word", () => {
    // From col 0 of "hello world" → end of "hello" (col 4).
    expect(moveWordEnd(st(), offset(1, 0))).toBe(offset(1, 4));
  });
  it("e from a word-end advances to the next word's end", () => {
    // From end of "hello" (col 4) → end of "world" (col 10).
    expect(moveWordEnd(st(), offset(1, 4))).toBe(offset(1, 10));
  });
});
