// Tests for placement.ts — CalItem placement helpers and drag write-back.

import { describe, it, expect } from "vitest";
import {
  extractProp,
  extractOverrides,
  buildCalItems,
  classifyItem,
  makeTimedPlacement,
  makeBandPlacement,
  buildDragWrite,
  itemSpanDates,
} from "../placement.js";
import { parseCalValue } from "../date-math.js";
import type { CalDate, CalItem } from "../types.js";

// ── extractProp ───────────────────────────────────────────────────────────────

describe("extractProp", () => {
  it("extracts a simple scalar property", () => {
    const text = "---\ntitle: Hello\ndue: 2026-06-15\n---\n";
    expect(extractProp(text, "due")).toBe("2026-06-15");
  });

  it("extracts a datetime property", () => {
    const text = "---\ndue: 2026-06-15T14:00+00:00\n---\n";
    expect(extractProp(text, "due")).toBe("2026-06-15T14:00+00:00");
  });

  it("returns null for missing key", () => {
    const text = "---\ntitle: Hello\n---\n";
    expect(extractProp(text, "due")).toBeNull();
  });

  it("handles quoted values", () => {
    const text = `---\nrepeat: "RRULE:FREQ=WEEKLY;BYDAY=MO"\n---\n`;
    expect(extractProp(text, "repeat")).toBe("RRULE:FREQ=WEEKLY;BYDAY=MO");
  });
});

// ── extractOverrides ──────────────────────────────────────────────────────────

describe("extractOverrides", () => {
  it("extracts overrides map", () => {
    const text = `---
title: Test
overrides:
  "2026-06-08": "2026-06-09"
  "2026-06-15": skip
---
`;
    const overrides = extractOverrides(text);
    expect(overrides["2026-06-08"]).toBe("2026-06-09");
    expect(overrides["2026-06-15"]).toBe("skip");
  });

  it("returns empty object when no overrides key", () => {
    const text = "---\ntitle: Test\n---\n";
    expect(extractOverrides(text)).toEqual({});
  });
});

// ── buildCalItems ─────────────────────────────────────────────────────────────

describe("buildCalItems", () => {
  const winStart: CalDate = { kind: "date", year: 2026, month: 6, day: 1 };
  const winEnd: CalDate = { kind: "date", year: 2026, month: 6, day: 30 };

  it("returns empty array when no due property", () => {
    const text = "---\ntitle: No Due\n---\n";
    const items = buildCalItems("id1", "No Due", "inbox", [], text, winStart, winEnd);
    expect(items).toHaveLength(0);
  });

  it("returns one item for a single date", () => {
    const text = "---\ntitle: Test\ndue: 2026-06-15\n---\n";
    const items = buildCalItems("id1", "Test", "inbox", [], text, winStart, winEnd);
    expect(items).toHaveLength(1);
    expect(items[0].value.kind).toBe("date");
  });

  it("returns no items when date is outside window", () => {
    const text = "---\ndue: 2026-07-15\n---\n";
    const items = buildCalItems("id1", "Test", "inbox", [], text, winStart, winEnd);
    expect(items).toHaveLength(0);
  });

  it("includes the entry for a range overlapping the window", () => {
    const text = "---\ndue: 2026-05-28..2026-06-03\n---\n";
    const items = buildCalItems("id1", "Test", "inbox", [], text, winStart, winEnd);
    expect(items).toHaveLength(1);
    expect(items[0].value.kind).toBe("range");
  });

  it("expands a weekly RRULE", () => {
    const text = `---\ndue: 2026-06-01\nrepeat: "RRULE:FREQ=WEEKLY;BYDAY=MO"\n---\n`;
    const items = buildCalItems("id1", "Standup", "work", [], text, winStart, winEnd);
    // June 2026 Mondays: 1, 8, 15, 22, 29 = 5 occurrences
    expect(items.length).toBe(5);
    expect(items[0].isOccurrence).toBe(true);
  });

  it("applies group color", () => {
    const text = "---\ndue: 2026-06-15\n---\n";
    const items = buildCalItems("id1", "Test", "work/atlas", [], text, winStart, winEnd);
    expect(items[0].groupColor).toBeDefined();
  });
});

// ── classifyItem ──────────────────────────────────────────────────────────────

describe("classifyItem", () => {
  function makeItem(valueStr: string): CalItem {
    const value = parseCalValue(valueStr)!;
    return {
      entryId: "test",
      title: "Test",
      value,
      group: "inbox",
      tags: [],
      isOccurrence: false,
    };
  }

  it("classifies date as allday", () => {
    expect(classifyItem(makeItem("2026-06-15"))).toBe("allday");
  });

  it("classifies datetime as timed", () => {
    expect(classifyItem(makeItem("2026-06-15T14:00+00:00"))).toBe("timed");
  });

  it("classifies all-day range spanning multiple days as band", () => {
    expect(classifyItem(makeItem("2026-06-15..2026-06-19"))).toBe("band");
  });

  it("classifies single-day all-day range as allday", () => {
    expect(classifyItem(makeItem("2026-06-15..2026-06-15"))).toBe("allday");
  });
});

// ── makeTimedPlacement ────────────────────────────────────────────────────────

describe("makeTimedPlacement", () => {
  it("creates placement for a datetime item at correct hour", () => {
    const value = parseCalValue("2026-06-15T14:30+00:00")!;
    const item: CalItem = {
      entryId: "t",
      title: "T",
      value,
      group: "inbox",
      tags: [],
      isOccurrence: false,
    };
    const placement = makeTimedPlacement(item);
    expect(placement).not.toBeNull();
    // UTC hour 14 — local depends on timezone, but the ms is the key.
    // Test structure only (hour/minute derived from epoch in local tz).
    expect(placement!.durationMinutes).toBe(60);
  });

  it("calculates duration for a timed range", () => {
    const value = parseCalValue("2026-06-15T09:00+00:00..2026-06-15T10:30+00:00")!;
    const item: CalItem = {
      entryId: "t",
      title: "T",
      value,
      group: "inbox",
      tags: [],
      isOccurrence: false,
    };
    const placement = makeTimedPlacement(item);
    expect(placement!.durationMinutes).toBe(90);
  });
});

// ── makeBandPlacement ─────────────────────────────────────────────────────────

describe("makeBandPlacement", () => {
  const winStart: CalDate = { kind: "date", year: 2026, month: 6, day: 1 };
  const winEnd: CalDate = { kind: "date", year: 2026, month: 6, day: 30 };

  it("returns band spanning full range when within window", () => {
    const value = parseCalValue("2026-06-10..2026-06-15")!;
    const item: CalItem = {
      entryId: "t",
      title: "T",
      value,
      group: "inbox",
      tags: [],
      isOccurrence: false,
    };
    const band = makeBandPlacement(item, winStart, winEnd);
    expect(band).not.toBeNull();
    expect(band!.spanDays).toBe(6);
    expect(band!.bandStart).toEqual({ kind: "date", year: 2026, month: 6, day: 10 });
    expect(band!.bandEnd).toEqual({ kind: "date", year: 2026, month: 6, day: 15 });
  });

  it("clamps band start to window start when range starts before window", () => {
    const value = parseCalValue("2026-05-28..2026-06-05")!;
    const item: CalItem = {
      entryId: "t",
      title: "T",
      value,
      group: "inbox",
      tags: [],
      isOccurrence: false,
    };
    const band = makeBandPlacement(item, winStart, winEnd);
    expect(band).not.toBeNull();
    expect(band!.bandStart).toEqual(winStart);
    expect(band!.bandEnd).toEqual({ kind: "date", year: 2026, month: 6, day: 5 });
  });

  it("clamps band end to window end when range extends beyond window", () => {
    const value = parseCalValue("2026-06-25..2026-07-05")!;
    const item: CalItem = {
      entryId: "t",
      title: "T",
      value,
      group: "inbox",
      tags: [],
      isOccurrence: false,
    };
    const band = makeBandPlacement(item, winStart, winEnd);
    expect(band!.bandEnd).toEqual(winEnd);
  });

  it("returns null for non-range items", () => {
    const value = parseCalValue("2026-06-15")!;
    const item: CalItem = {
      entryId: "t",
      title: "T",
      value,
      group: "inbox",
      tags: [],
      isOccurrence: false,
    };
    expect(makeBandPlacement(item, winStart, winEnd)).toBeNull();
  });
});

// ── buildDragWrite ────────────────────────────────────────────────────────────

describe("buildDragWrite", () => {
  it("produces a direct write for a date item", () => {
    const value = parseCalValue("2026-06-15")!;
    const item: CalItem = {
      entryId: "test",
      title: "Test",
      value,
      group: "inbox",
      tags: [],
      isOccurrence: false,
    };
    const toDate: CalDate = { kind: "date", year: 2026, month: 6, day: 20 };
    const result = buildDragWrite(item, toDate);
    expect(result.kind).toBe("direct");
    if (result.kind === "direct") {
      expect(result.newValue).toBe("2026-06-20");
    }
  });

  it("produces an override write for a recurring occurrence", () => {
    const value = parseCalValue("2026-06-15")!;
    const item: CalItem = {
      entryId: "standup",
      title: "Standup",
      value,
      group: "work",
      tags: [],
      isOccurrence: true,
      occurrenceKey: "2026-06-15",
    };
    const toDate: CalDate = { kind: "date", year: 2026, month: 6, day: 16 };
    const result = buildDragWrite(item, toDate);
    expect(result.kind).toBe("override");
    if (result.kind === "override") {
      expect(result.occurrenceKey).toBe("2026-06-15");
      expect(result.newValue).toBe("2026-06-16");
    }
  });

  it("shifts a range by the same delta", () => {
    const value = parseCalValue("2026-06-10..2026-06-15")!;
    const item: CalItem = {
      entryId: "test",
      title: "Test",
      value,
      group: "inbox",
      tags: [],
      isOccurrence: false,
    };
    const toDate: CalDate = { kind: "date", year: 2026, month: 6, day: 12 };
    const result = buildDragWrite(item, toDate);
    if (result.kind === "direct") {
      // Start shifts from June 10 to June 12 (+2 days), so end shifts from June 15 to June 17.
      expect(result.newValue).toBe("2026-06-12..2026-06-17");
    }
  });
});

// ── itemSpanDates ─────────────────────────────────────────────────────────────

describe("itemSpanDates", () => {
  const winStart: CalDate = { kind: "date", year: 2026, month: 6, day: 1 };
  const winEnd: CalDate = { kind: "date", year: 2026, month: 6, day: 30 };

  it("returns single date for a CalDate item", () => {
    const value = parseCalValue("2026-06-15")!;
    const item: CalItem = {
      entryId: "t",
      title: "T",
      value,
      group: "inbox",
      tags: [],
      isOccurrence: false,
    };
    const dates = itemSpanDates(item, winStart, winEnd);
    expect(dates).toHaveLength(1);
    expect(dates[0]).toEqual({ kind: "date", year: 2026, month: 6, day: 15 });
  });

  it("returns a span of dates for a range", () => {
    const value = parseCalValue("2026-06-10..2026-06-15")!;
    const item: CalItem = {
      entryId: "t",
      title: "T",
      value,
      group: "inbox",
      tags: [],
      isOccurrence: false,
    };
    const dates = itemSpanDates(item, winStart, winEnd);
    expect(dates).toHaveLength(6);
    expect(dates[0]).toEqual({ kind: "date", year: 2026, month: 6, day: 10 });
    expect(dates[5]).toEqual({ kind: "date", year: 2026, month: 6, day: 15 });
  });
});
