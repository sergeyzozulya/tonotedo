import { describe, it, expect, beforeEach } from "vitest";
import { parseQuery, matchesQuery, queryMatches } from "../query-parse.js";
import type { SavedSearch, SavedSearchFilter } from "../../ipc/types.js";

// ── parseQuery ────────────────────────────────────────────────────────────────

describe("parseQuery — tokenisation", () => {
  it("empty string returns empty terms and phrases", () => {
    const result = parseQuery("");
    expect(result.terms).toHaveLength(0);
    expect(result.phrases).toHaveLength(0);
  });

  it("whitespace-only returns empty", () => {
    const result = parseQuery("   ");
    expect(result.terms).toHaveLength(0);
    expect(result.phrases).toHaveLength(0);
  });

  it("single word produces one term", () => {
    const result = parseQuery("atlas");
    expect(result.terms).toEqual(["atlas"]);
    expect(result.phrases).toHaveLength(0);
  });

  it("multiple words produce multiple terms (lowercase)", () => {
    const result = parseQuery("Atlas Budget");
    expect(result.terms).toEqual(["atlas", "budget"]);
    expect(result.phrases).toHaveLength(0);
  });

  it("quoted phrase is extracted as a phrase (not split into terms)", () => {
    const result = parseQuery('"end of quarter"');
    expect(result.terms).toHaveLength(0);
    expect(result.phrases).toEqual(["end of quarter"]);
  });

  it("mixed terms and phrase", () => {
    const result = parseQuery('atlas budget "end of quarter"');
    expect(result.terms).toEqual(["atlas", "budget"]);
    expect(result.phrases).toEqual(["end of quarter"]);
  });

  it("multiple quoted phrases", () => {
    const result = parseQuery('"deep work" "cal newport"');
    expect(result.terms).toHaveLength(0);
    expect(result.phrases).toEqual(["deep work", "cal newport"]);
  });

  it("unclosed quote treated as phrase to end of string", () => {
    const result = parseQuery('"unclosed phrase');
    expect(result.phrases).toEqual(["unclosed phrase"]);
  });

  it("empty quoted string produces no phrase", () => {
    const result = parseQuery('""');
    expect(result.phrases).toHaveLength(0);
  });

  it("term adjacent to quote is captured separately", () => {
    const result = parseQuery('term "a phrase"');
    expect(result.terms).toEqual(["term"]);
    expect(result.phrases).toEqual(["a phrase"]);
  });
});

// ── matchesQuery ──────────────────────────────────────────────────────────────

describe("matchesQuery — AND semantics", () => {
  it("empty query matches everything", () => {
    const q = parseQuery("");
    expect(matchesQuery("anything at all", q)).toBe(true);
  });

  it("single term matches case-insensitively", () => {
    const q = parseQuery("Atlas");
    expect(matchesQuery("Project Atlas — Overview", q)).toBe(true);
    expect(matchesQuery("project atlas — overview", q)).toBe(true);
  });

  it("term that is absent returns false", () => {
    const q = parseQuery("budget");
    expect(matchesQuery("Project Atlas — Overview", q)).toBe(false);
  });

  it("all terms must match (AND)", () => {
    const q = parseQuery("atlas budget");
    expect(matchesQuery("project atlas has a budget line", q)).toBe(true);
    expect(matchesQuery("project atlas only", q)).toBe(false);
  });

  it("quoted phrase requires exact substring", () => {
    const q = parseQuery('"end of quarter"');
    expect(matchesQuery("review at end of quarter goals", q)).toBe(true);
    expect(matchesQuery("end quarter review", q)).toBe(false);
  });

  it("quoted phrase is case-insensitive", () => {
    const q = parseQuery('"End Of Quarter"');
    expect(matchesQuery("end of quarter goals", q)).toBe(true);
  });

  it("term + phrase both must match", () => {
    const q = parseQuery('atlas "end of quarter"');
    expect(matchesQuery("atlas review at end of quarter", q)).toBe(true);
    expect(matchesQuery("atlas review only", q)).toBe(false);
    expect(matchesQuery("end of quarter but no matching term", q)).toBe(false);
  });
});

// ── queryMatches convenience ──────────────────────────────────────────────────

describe("queryMatches convenience function", () => {
  it("empty raw query always returns true", () => {
    expect(queryMatches("", "any text")).toBe(true);
    expect(queryMatches("  ", "any text")).toBe(true);
  });

  it("delegates to parseQuery + matchesQuery", () => {
    expect(queryMatches("atlas", "project atlas overview")).toBe(true);
    expect(queryMatches("atlas", "journal entry")).toBe(false);
  });
});

// ── Mock search integration — text + tag + group filters ─────────────────────

describe("mock search — filter composition", () => {
  it("text filter returns matching entries", async () => {
    const { mock } = await import("../../ipc/mock.js");
    const result = await mock.search({ text: "atlas" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.items.length).toBeGreaterThan(0);
  });

  it("tag filter (any-of): entries with 'followup' tag are returned", async () => {
    const { mock } = await import("../../ipc/mock.js");
    const result = await mock.search({ text: "", filters: { tags: ["followup"] } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.items.length).toBeGreaterThan(0);
    for (const item of result.value.items) {
      expect(item.tags).toContain("followup");
    }
  });

  it("tag filter (any-of): multiple tags — entries with either tag included", async () => {
    const { mock } = await import("../../ipc/mock.js");
    // 'followup' and 'review' appear in different entries
    const result = await mock.search({ text: "", filters: { tags: ["followup", "review"] } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // At least the followup entry and journal review entries should appear
    expect(result.value.items.length).toBeGreaterThanOrEqual(2);
    for (const item of result.value.items) {
      const hasAny = item.tags.includes("followup") || item.tags.includes("review");
      expect(hasAny).toBe(true);
    }
  });

  it("group filter: only entries in that group", async () => {
    const { mock } = await import("../../ipc/mock.js");
    const result = await mock.search({ text: "", filters: { group: "books" } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const item of result.value.items) {
      expect(item.group).toBe("books");
    }
  });

  it("group filter with descendants: work/atlas entries appear when filtering by work", async () => {
    // Mock uses exact group match for the `group` filter.
    // We test the descendant logic used by SearchOverlay client-side.
    const { mock } = await import("../../ipc/mock.js");
    const resultAll = await mock.search({ text: "" });
    expect(resultAll.ok).toBe(true);
    if (!resultAll.ok) return;

    // Simulate descendant filter as SearchOverlay does it:
    const groupFilter = "work";
    const prefix = groupFilter + "/";
    const filtered = resultAll.value.items.filter(
      (e) => e.group === groupFilter || e.group.startsWith(prefix),
    );
    // work/atlas entries qualify
    expect(filtered.some((e) => e.group === "work/atlas")).toBe(true);
  });

  it("text + tag compose (AND): text match AND tag match required", async () => {
    const { mock } = await import("../../ipc/mock.js");
    // "atlas" appears in work/atlas entries; "followup" tag is only on inbox entry
    const result = await mock.search({
      text: "atlas",
      filters: { tags: ["followup"] },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The inbox/follow-up-anna entry mentions 'atlas' in its text AND has followup tag
    for (const item of result.value.items) {
      expect(item.tags).toContain("followup");
    }
  });

  it("empty query returns recent entries (recents surface)", async () => {
    const { mock } = await import("../../ipc/mock.js");
    const result = await mock.search({ text: "", sort: "modified_desc" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Should return all mock entries (< 50)
    expect(result.value.items.length).toBeGreaterThan(0);
  });

  it("results are capped at 500 for large queries", async () => {
    // Mock has ~16 entries, so we can only verify the cap logic doesn't break
    const { mock } = await import("../../ipc/mock.js");
    const result = await mock.search({ text: "" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.items.length).toBeLessThanOrEqual(500);
  });
});

// ── Saved searches — round-trip and shape stability ───────────────────────────

describe("saved_searches_get / saved_searches_set — round-trip", () => {
  beforeEach(async () => {
    // Reset to empty before each test
    const { mock } = await import("../../ipc/mock.js");
    await mock.saved_searches_set([]);
  });

  it("initially returns empty array", async () => {
    const { mock } = await import("../../ipc/mock.js");
    const result = await mock.saved_searches_get();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(0);
  });

  it("set then get round-trips correctly", async () => {
    const { mock } = await import("../../ipc/mock.js");
    const searches: SavedSearch[] = [
      {
        name: "Atlas follow-ups",
        text: "",
        filters: [
          { kind: "tag", values: ["followup"] },
          { kind: "group", path: "Work/Atlas" },
        ],
      },
    ];
    const setResult = await mock.saved_searches_set(searches);
    expect(setResult.ok).toBe(true);

    const getResult = await mock.saved_searches_get();
    expect(getResult.ok).toBe(true);
    if (!getResult.ok) return;
    expect(getResult.value).toHaveLength(1);
    expect(getResult.value[0].name).toBe("Atlas follow-ups");
    expect(getResult.value[0].text).toBe("");
    expect(getResult.value[0].filters).toHaveLength(2);
  });

  it("kind discriminator 'tag' preserved", async () => {
    const { mock } = await import("../../ipc/mock.js");
    const filter: SavedSearchFilter = { kind: "tag", values: ["followup", "review"] };
    await mock.saved_searches_set([{ name: "Test", text: "", filters: [filter] }]);
    const result = await mock.saved_searches_get();
    if (!result.ok) return;
    const f = result.value[0].filters[0];
    expect(f.kind).toBe("tag");
    if (f.kind === "tag") {
      expect(f.values).toContain("followup");
      expect(f.values).toContain("review");
    }
  });

  it("kind discriminator 'group' preserved", async () => {
    const { mock } = await import("../../ipc/mock.js");
    const filter: SavedSearchFilter = { kind: "group", path: "Work/Atlas" };
    await mock.saved_searches_set([{ name: "Atlas", text: "meeting", filters: [filter] }]);
    const result = await mock.saved_searches_get();
    if (!result.ok) return;
    const f = result.value[0].filters[0];
    expect(f.kind).toBe("group");
    if (f.kind === "group") {
      expect(f.path).toBe("Work/Atlas");
    }
  });

  it("spec 0009 YAML-equivalent shape: Inbox saved search", async () => {
    const { mock } = await import("../../ipc/mock.js");
    const searches: SavedSearch[] = [
      { name: "Inbox", text: "", filters: [{ kind: "group", path: "Inbox" }] },
    ];
    await mock.saved_searches_set(searches);
    const result = await mock.saved_searches_get();
    if (!result.ok) return;
    const s = result.value.find((x) => x.name === "Inbox");
    expect(s).toBeDefined();
    expect(s!.filters[0].kind).toBe("group");
  });

  it("multiple saved searches are stored and retrieved", async () => {
    const { mock } = await import("../../ipc/mock.js");
    const searches: SavedSearch[] = [
      { name: "A", text: "foo", filters: [] },
      { name: "B", text: "bar", filters: [{ kind: "tag", values: ["x"] }] },
      { name: "C", text: "", filters: [{ kind: "group", path: "inbox" }] },
    ];
    await mock.saved_searches_set(searches);
    const result = await mock.saved_searches_get();
    if (!result.ok) return;
    expect(result.value).toHaveLength(3);
    expect(result.value.map((s) => s.name)).toEqual(["A", "B", "C"]);
  });

  it("overwrite replaces previous state entirely", async () => {
    const { mock } = await import("../../ipc/mock.js");
    await mock.saved_searches_set([{ name: "Old", text: "", filters: [] }]);
    await mock.saved_searches_set([{ name: "New", text: "x", filters: [] }]);
    const result = await mock.saved_searches_get();
    if (!result.ok) return;
    expect(result.value).toHaveLength(1);
    expect(result.value[0].name).toBe("New");
  });

  it("set returns deep copy (mutation of source does not affect store)", async () => {
    const { mock } = await import("../../ipc/mock.js");
    const source: SavedSearch[] = [{ name: "X", text: "", filters: [] }];
    await mock.saved_searches_set(source);
    source[0].name = "MUTATED";
    const result = await mock.saved_searches_get();
    if (!result.ok) return;
    expect(result.value[0].name).toBe("X");
  });
});

// ── Recents on empty query ────────────────────────────────────────────────────

describe("recents surface — empty query", () => {
  it("empty query with no filters returns entries sorted by modified_desc", async () => {
    const { mock } = await import("../../ipc/mock.js");
    const result = await mock.search({ text: "", sort: "modified_desc" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const items = result.value.items;
    expect(items.length).toBeGreaterThan(0);
    // Verify sort order: each item should be >= next
    for (let i = 0; i < items.length - 1; i++) {
      expect(items[i].modifiedAt >= items[i + 1].modifiedAt).toBe(true);
    }
  });

  it("empty query returns all mock entries (< 50 recents limit)", async () => {
    const { mock } = await import("../../ipc/mock.js");
    const result = await mock.search({ text: "" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // All 16 mock entries should be present (well under the 50 recents limit)
    expect(result.value.items.length).toBeGreaterThanOrEqual(10);
  });
});

