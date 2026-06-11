// Tests for outline/TOC heading extraction (spec 0006 §Outline).

import { describe, it, expect } from "vitest";
import { extractHeadings } from "../outline.js";

describe("extractHeadings", () => {
  it("extracts ATX headings with levels and positions", () => {
    const doc = "# Title\n\nbody\n\n## Section\ntext\n### Sub";
    const h = extractHeadings(doc);
    expect(h.map((x) => [x.level, x.text])).toEqual([
      [1, "Title"],
      [2, "Section"],
      [3, "Sub"],
    ]);
    // pos points at the start of each heading line.
    expect(doc.slice(h[0].pos, h[0].pos + 7)).toBe("# Title");
    expect(doc.slice(h[1].pos, h[1].pos + 10)).toBe("## Section");
  });

  it("ignores '#' lines inside fenced code blocks", () => {
    const doc = "# Real\n\n```\n# not a heading\n```\n## After";
    expect(extractHeadings(doc).map((x) => x.text)).toEqual(["Real", "After"]);
  });

  it("ignores '#' inside leading frontmatter", () => {
    const doc = "---\ntitle: x\n# not a heading: y\n---\n# Body";
    expect(extractHeadings(doc).map((x) => x.text)).toEqual(["Body"]);
  });

  it("strips trailing closing hashes", () => {
    expect(extractHeadings("# Title #").map((x) => x.text)).toEqual(["Title"]);
  });

  it("returns an empty list when there are no headings", () => {
    expect(extractHeadings("just some text\nmore text")).toEqual([]);
  });

  it("does not treat '#tag' (no space) as a heading", () => {
    expect(extractHeadings("#tag is a tag, not a heading")).toEqual([]);
  });
});
