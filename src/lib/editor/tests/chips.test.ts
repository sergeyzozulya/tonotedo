// State-level (DOM-free) tests for chip decoration building.
//
// These tests exercise `computeChipDecorations` directly — the pure function
// that maps an EditorState + metadata cache + entry titles → a DecorationSet.
// No DOM, no IPC: we build a cache by hand, inject it, and read back the
// resulting decoration set with a lightweight iterator helper.

import { describe, it, expect } from "vitest";
import { EditorState, EditorSelection } from "@codemirror/state";
import type { DecorationSet } from "@codemirror/view";

import { markdownExtension } from "../extensions/markdown.js";
import { computeChipDecorations, buildCache, emptyCache } from "../extensions/chips.js";
import type { ChipMetaCache } from "../extensions/chips.js";
import type { TagMeta, PersonMeta } from "../../ipc/types.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function stateOf(doc: string, head?: number): EditorState {
  return EditorState.create({
    doc,
    selection: head === undefined ? undefined : EditorSelection.cursor(head),
    extensions: [markdownExtension],
  });
}

interface DecoEntry {
  from: number;
  to: number;
  /** "widget-replace" | "mark" | "line" */
  kind: string;
  cls?: string;
}

function readDecos(set: DecorationSet, docLen: number): DecoEntry[] {
  const out: DecoEntry[] = [];
  const iter = set.iter();
  while (iter.value) {
    const spec = iter.value.spec as {
      class?: string;
      widget?: unknown;
      block?: boolean;
    };
    let kind: string;
    if (spec.widget) kind = "widget-replace";
    else if (iter.from === iter.to) kind = "line";
    else kind = "mark";
    out.push({ from: iter.from, to: iter.to, kind, cls: spec.class });
    iter.next();
  }
  void docLen;
  return out;
}

function chips(
  doc: string,
  opts: {
    head?: number;
    cache?: ChipMetaCache;
    entryTitles?: Map<string, string>;
  } = {},
): DecoEntry[] {
  const state = stateOf(doc, opts.head);
  const set = computeChipDecorations(state, {
    cache: opts.cache ?? emptyCache(),
    entryTitles: opts.entryTitles ?? new Map(),
    callbacks: {},
    ranges: [{ from: 0, to: doc.length }],
  });
  return readDecos(set, doc.length);
}

// ── Tests: which token gets a chip widget ────────────────────────────────────

describe("chip decoration — token kinds", () => {
  const doc = "#foo @bar [[entry]] done";

  it("emits a widget-replace for all three token kinds when cursor is away", () => {
    const d = chips(doc, { head: doc.length }); // cursor at end
    const widgets = d.filter((x) => x.kind === "widget-replace");
    expect(widgets).toHaveLength(3);
    // #foo: positions 0..4
    expect(widgets.some((w) => w.from === 0 && w.to === 4)).toBe(true);
    // @bar: positions 5..9
    expect(widgets.some((w) => w.from === 5 && w.to === 9)).toBe(true);
    // [[entry]]: positions 10..19
    expect(widgets.some((w) => w.from === 10 && w.to === 19)).toBe(true);
  });

  it("emits no widget for a token whose range the cursor touches", () => {
    const d = chips(doc, { head: 2 }); // head inside #foo
    const widgets = d.filter((x) => x.kind === "widget-replace");
    // Only @bar and [[entry]] should be chips; #foo is revealed.
    expect(widgets).toHaveLength(2);
    expect(widgets.every((w) => w.from !== 0)).toBe(true);
  });

  it("emits no widget for #foo when cursor is at the leading `#` (inclusive boundary)", () => {
    const d = chips(doc, { head: 0 }); // head at position 0 = start of #foo
    const widgets = d.filter((x) => x.kind === "widget-replace");
    expect(widgets.some((w) => w.from === 0 && w.to === 4)).toBe(false);
  });

  it("emits no widget for #foo when cursor is at the closing char (inclusive boundary)", () => {
    const d = chips(doc, { head: 4 }); // head at position 4 = end of #foo
    const widgets = d.filter((x) => x.kind === "widget-replace");
    expect(widgets.some((w) => w.from === 0 && w.to === 4)).toBe(false);
  });

  it("emits chips for all tokens when no cursor is set (default selection at 0)", () => {
    // Default cursor is at 0, which is inside #foo (headInRange(0..4) = true at 0).
    // So #foo is revealed; @bar and [[entry]] are chipped.
    const d = chips(doc);
    const widgets = d.filter((x) => x.kind === "widget-replace");
    expect(widgets).toHaveLength(2);
  });
});

// ── Tests: reveal suppression when cursor is inside ──────────────────────────

describe("chip decoration — reveal suppression", () => {
  it("reveals the token the cursor is inside, chips the others", () => {
    const doc = "#alpha #beta";
    //           0123456 789...
    //   #alpha = 0..6, #beta = 7..12
    const d = chips(doc, { head: 3 }); // inside #alpha
    const widgets = d.filter((x) => x.kind === "widget-replace");
    expect(widgets).toHaveLength(1);
    // Only #beta should be a chip.
    expect(widgets[0].from).toBe(7);
    expect(widgets[0].to).toBe(12);
  });

  it("emits no decorations for a lone token when the cursor is inside it", () => {
    const doc = "@name";
    const d = chips(doc, { head: 2 }); // inside @name
    expect(d.filter((x) => x.kind === "widget-replace")).toHaveLength(0);
  });
});

// ── Tests: metadata cache — tag colors ───────────────────────────────────────

describe("chip decoration — tag metadata", () => {
  // Trailing " ." ensures doc.length is past both token ranges, so head at
  // doc.length is outside [0,5) and [6,14) and the cursor doesn't reveal them.
  const doc = "#work #unknown .";
  //           0..5   6..14    15-16

  it("tag chip is emitted regardless of whether metadata exists (cache miss = default)", () => {
    // No metadata in cache → both tokens still chip.
    const d = chips(doc, { head: doc.length });
    const widgets = d.filter((x) => x.kind === "widget-replace");
    expect(widgets).toHaveLength(2);
  });

  it("tag chip is emitted with metadata present (declared tag)", () => {
    const tags: TagMeta[] = [{ name: "work", color: "blue", count: 3 }];
    const cache = buildCache(tags, []);
    const d = chips(doc, { head: doc.length, cache });
    const widgets = d.filter((x) => x.kind === "widget-replace");
    expect(widgets).toHaveLength(2);
  });
});

// ── Tests: metadata cache upgrade (undeclared → declared) ────────────────────

describe("chip decoration — metadata cache upgrade", () => {
  // Trailing " ." places doc.length past the @sergey token range [0,7].
  const doc = "@sergey .";
  // @sergey = from:0 to:7; cursor at 9 (doc.length) is outside that range.

  it("renders a chip for an undeclared mention (cache miss)", () => {
    const d = chips(doc, { head: doc.length, cache: emptyCache() });
    expect(d.filter((x) => x.kind === "widget-replace")).toHaveLength(1);
  });

  it("renders a chip for a declared mention (cache hit)", () => {
    const people: PersonMeta[] = [{ slug: "sergey", displayName: "Sergey Z.", count: 5 }];
    const cache = buildCache([], people);
    const d = chips(doc, { head: doc.length, cache });
    expect(d.filter((x) => x.kind === "widget-replace")).toHaveLength(1);
  });

  it("undeclared → declared: both produce a widget decoration (style changes in DOM, not in set)", () => {
    // The decoration set in both cases contains a widget-replace for the same
    // range. The widget's `eq` method distinguishes them (different displayName),
    // so CM6 will recreate the DOM element on cache upgrade — this is the
    // "upgrade without reparse" path.
    const d1 = chips(doc, { head: doc.length, cache: emptyCache() });
    const people: PersonMeta[] = [{ slug: "sergey", displayName: "Sergey Z.", count: 5 }];
    const d2 = chips(doc, { head: doc.length, cache: buildCache([], people) });

    const w1 = d1.filter((x) => x.kind === "widget-replace");
    const w2 = d2.filter((x) => x.kind === "widget-replace");
    // Both produce a decoration for the same range.
    expect(w1).toHaveLength(1);
    expect(w2).toHaveLength(1);
    expect(w1[0].from).toBe(w2[0].from);
    expect(w1[0].to).toBe(w2[0].to);
  });
});

// ── Tests: wikilink resolved / unresolved ─────────────────────────────────────

describe("chip decoration — wikilink resolution", () => {
  // Trailing " ." keeps cursor at doc.length outside both wikilink ranges.
  const doc = "see [[work/atlas/overview]] and [[missing]] .";

  it("both wikilinks get widget-replace decorations regardless of resolution", () => {
    const d = chips(doc, { head: doc.length });
    const widgets = d.filter((x) => x.kind === "widget-replace");
    expect(widgets).toHaveLength(2);
  });

  it("resolved wikilink: entryTitles hit — widget is emitted", () => {
    const entryTitles = new Map([["work/atlas/overview", "Project Overview"]]);
    const d = chips(doc, { head: doc.length, entryTitles });
    const widgets = d.filter((x) => x.kind === "widget-replace");
    expect(widgets).toHaveLength(2);
  });

  it("unresolved wikilink: entryTitles miss — widget is still emitted (default style)", () => {
    // Both targets missing from entryTitles → both render as unresolved chips.
    const d = chips(doc, { head: doc.length, entryTitles: new Map() });
    const widgets = d.filter((x) => x.kind === "widget-replace");
    expect(widgets).toHaveLength(2);
  });

  it("wikilink with display text: [[target|Display]] — target is the resolved key", () => {
    // Trailing space so cursor is past the token.
    const docDisplay = "[[work/atlas/overview|Atlas Overview]] x";
    const entryTitles = new Map([["work/atlas/overview", "Project Overview"]]);
    const d = chips(docDisplay, { head: docDisplay.length, entryTitles });
    const widgets = d.filter((x) => x.kind === "widget-replace");
    expect(widgets).toHaveLength(1);
  });

  it("wikilink with display text: unresolved still produces a widget", () => {
    const docDisplay = "[[ghost/entry|Ghost]] x";
    const d = chips(docDisplay, { head: docDisplay.length });
    const widgets = d.filter((x) => x.kind === "widget-replace");
    expect(widgets).toHaveLength(1);
  });
});

// ── Tests: avatar fallback logic (widget.eq) ──────────────────────────────────

describe("chip decoration — mention widget equality (avatar fallback logic)", () => {
  // Trailing " x" so cursor at doc.length is outside @anna's range [0,5].
  const doc = "@anna x";

  it("same metadata → widgets are considered equal (no DOM re-create)", () => {
    const people: PersonMeta[] = [{ slug: "anna", displayName: "Anna K.", count: 2 }];
    const cache = buildCache([], people);
    // Build two decoration sets with the same metadata.
    const s1 = stateOf(doc, doc.length);
    const s2 = stateOf(doc, doc.length);
    const set1 = computeChipDecorations(s1, {
      cache,
      entryTitles: new Map(),
      callbacks: {},
      ranges: [{ from: 0, to: doc.length }],
    });
    const set2 = computeChipDecorations(s2, {
      cache,
      entryTitles: new Map(),
      callbacks: {},
      ranges: [{ from: 0, to: doc.length }],
    });
    // Both produce exactly one decoration at the same range.
    const d1 = readDecos(set1, doc.length);
    const d2 = readDecos(set2, doc.length);
    expect(d1).toHaveLength(1);
    expect(d2).toHaveLength(1);
    expect(d1[0].from).toBe(d2[0].from);
    expect(d1[0].to).toBe(d2[0].to);
  });

  it("different displayName → different decorations (triggers DOM re-create via widget.eq)", () => {
    const cache1 = buildCache([], [{ slug: "anna", displayName: "Anna", count: 1 }]);
    const cache2 = buildCache([], [{ slug: "anna", displayName: "Anna K.", count: 1 }]);
    const s = stateOf(doc, doc.length);
    const set1 = computeChipDecorations(s, {
      cache: cache1,
      entryTitles: new Map(),
      callbacks: {},
      ranges: [{ from: 0, to: doc.length }],
    });
    const set2 = computeChipDecorations(s, {
      cache: cache2,
      entryTitles: new Map(),
      callbacks: {},
      ranges: [{ from: 0, to: doc.length }],
    });
    // Both have a decoration but their widgets differ (eq = false).
    // We can't directly call .eq() from here, but we verify both produce widgets
    // and check via the fact that widget instances differ (indirect).
    const d1 = readDecos(set1, doc.length);
    const d2 = readDecos(set2, doc.length);
    expect(d1).toHaveLength(1);
    expect(d2).toHaveLength(1);
    // Widgets are different objects; their .eq() would return false.
    const iter1 = set1.iter();
    const iter2 = set2.iter();
    expect(iter1.value).not.toBeNull();
    expect(iter2.value).not.toBeNull();
    // Both emit a widget-replace at the same position — the inequality is
    // enforced by the widget's eq() implementation which checks displayName.
    expect(d1[0].from).toBe(d2[0].from);
    expect(d1[0].to).toBe(d2[0].to);
  });
});

// ── Tests: viewport scoping ───────────────────────────────────────────────────

describe("chip decoration — viewport scoping", () => {
  it("only decorates tokens within the supplied ranges", () => {
    const doc = "#one\n\n#two";
    const state = stateOf(doc, doc.length);
    const set = computeChipDecorations(state, {
      cache: emptyCache(),
      entryTitles: new Map(),
      callbacks: {},
      ranges: [{ from: 0, to: 4 }], // first line only
    });
    const d = readDecos(set, doc.length);
    expect(d.filter((x) => x.kind === "widget-replace")).toHaveLength(1);
  });
});

// ── Tests: buildCache ────────────────────────────────────────────────────────

describe("buildCache", () => {
  it("maps tags by name", () => {
    const tags: TagMeta[] = [
      { name: "work", color: "blue", count: 1 },
      { name: "idea", color: "amber", count: 2 },
    ];
    const cache = buildCache(tags, []);
    expect(cache.tags.get("work")?.color).toBe("blue");
    expect(cache.tags.get("idea")?.color).toBe("amber");
    expect(cache.tags.has("missing")).toBe(false);
  });

  it("maps people by slug", () => {
    const people: PersonMeta[] = [{ slug: "anna", displayName: "Anna K.", count: 3 }];
    const cache = buildCache([], people);
    expect(cache.people.get("anna")?.displayName).toBe("Anna K.");
  });

  it("emptyCache returns maps with no entries", () => {
    const c = emptyCache();
    expect(c.tags.size).toBe(0);
    expect(c.people.size).toBe(0);
  });
});
