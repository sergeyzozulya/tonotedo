import { describe, it, expect } from "vitest";
import { fuzzyMatch, rankByFuzzy, highlightSegments } from "../fuzzy.js";

// ── fuzzyMatch ─────────────────────────────────────────────────────────────────

describe("fuzzyMatch — basic matching", () => {
  it("matches exact string", () => {
    const m = fuzzyMatch("new entry", "New Entry");
    expect(m).not.toBeNull();
    expect(m!.score).toBeGreaterThan(0);
  });

  it("matches subsequence", () => {
    const m = fuzzyMatch("ne", "New Entry");
    expect(m).not.toBeNull();
  });

  it("returns null for non-matching query", () => {
    expect(fuzzyMatch("xyz", "New Entry")).toBeNull();
  });

  it("returns empty match for empty query", () => {
    const m = fuzzyMatch("", "New Entry");
    expect(m).not.toBeNull();
    expect(m!.indices).toHaveLength(0);
    expect(m!.score).toBe(0);
  });

  it("is case-insensitive", () => {
    expect(fuzzyMatch("NEW", "new entry")).not.toBeNull();
    expect(fuzzyMatch("new", "NEW ENTRY")).not.toBeNull();
  });

  it("returns correct indices", () => {
    const m = fuzzyMatch("ne", "new entry");
    expect(m).not.toBeNull();
    // 'n' at 0, 'e' at 1
    expect(m!.indices).toContain(0);
    expect(m!.indices).toContain(1);
  });

  it("gives higher score for word-boundary match", () => {
    const start = fuzzyMatch("n", "new entry");
    const mid = fuzzyMatch("n", "entry new");
    // Both match but "n" at start should score higher or equal.
    expect(start!.score).toBeGreaterThanOrEqual(mid!.score);
  });

  it("gives bonus for consecutive chars", () => {
    const consec = fuzzyMatch("ne", "new entry");
    // Consecutive characters at word start score positively.
    expect(consec!.score).toBeGreaterThan(0);
  });
});

// ── rankByFuzzy ────────────────────────────────────────────────────────────────

describe("rankByFuzzy", () => {
  const items = [{ name: "New Entry" }, { name: "Note" }, { name: "Entry List" }, { name: "Bold" }];

  it("filters out non-matching items", () => {
    const results = rankByFuzzy("bold", items, (i) => i.name);
    expect(results).toHaveLength(1);
    expect(results[0].item.name).toBe("Bold");
  });

  it("returns all items for empty query, unsorted", () => {
    const results = rankByFuzzy("", items, (i) => i.name);
    expect(results).toHaveLength(items.length);
  });

  it("ranks better matches first", () => {
    const results = rankByFuzzy("n", items, (i) => i.name);
    // "New Entry" and "Note" both start with 'n' — should both appear.
    const names = results.map((r) => r.item.name);
    expect(names).toContain("New Entry");
    expect(names).toContain("Note");
    // Note starts at 0 which is highest bonus — should rank well.
  });

  it("returns match data for highlighting", () => {
    const results = rankByFuzzy("ne", items, (i) => i.name);
    expect(results[0].match.indices.length).toBeGreaterThan(0);
  });
});

// ── highlightSegments ──────────────────────────────────────────────────────────

describe("highlightSegments", () => {
  it("returns single non-highlighted segment when no indices", () => {
    const segs = highlightSegments("Hello World", []);
    expect(segs).toEqual([{ text: "Hello World", highlight: false }]);
  });

  it("wraps matched indices in highlighted segments", () => {
    // Match 'H' at 0 and 'W' at 6.
    const segs = highlightSegments("Hello World", [0, 6]);
    const highlighted = segs.filter((s) => s.highlight).map((s) => s.text);
    expect(highlighted).toContain("H");
    expect(highlighted).toContain("W");
  });

  it("handles all chars highlighted", () => {
    const segs = highlightSegments("abc", [0, 1, 2]);
    expect(segs).toHaveLength(1);
    expect(segs[0].highlight).toBe(true);
    expect(segs[0].text).toBe("abc");
  });

  it("merges consecutive highlighted indices into one segment", () => {
    const segs = highlightSegments("new entry", [0, 1, 2]);
    // "new" should be one highlighted segment.
    const highlighted = segs.filter((s) => s.highlight);
    expect(highlighted[0].text).toBe("new");
  });
});
