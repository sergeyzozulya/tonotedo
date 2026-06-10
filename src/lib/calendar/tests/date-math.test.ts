// Tests for date-math.ts — pure calendar helpers.

import { describe, it, expect } from "vitest";
import {
  parseCalDate,
  parseCalDatetime,
  parseCalValue,
  calDateToEpoch,
  calDateFromDate,
  calDateToDate,
  compareCalDates,
  formatCalDate,
  weekStart,
  addDays,
  addMonths,
  monthGrid,
  isoWeekday,
  calDateEquals,
  clampCalDate,
  parseRRule,
  expandRRule,
  overflowSplit,
  calValueStartDate,
  calValueEndDate,
  isAllDay,
} from "../date-math.js";
import type { CalDate, CalDatetime } from "../types.js";

// ── parseCalDate ──────────────────────────────────────────────────────────────

describe("parseCalDate", () => {
  it("parses a valid date string", () => {
    expect(parseCalDate("2026-06-15")).toEqual({ kind: "date", year: 2026, month: 6, day: 15 });
  });

  it("returns null for invalid date strings", () => {
    expect(parseCalDate("2026-6-15")).toBeNull();
    expect(parseCalDate("not-a-date")).toBeNull();
    expect(parseCalDate("2026-06-15T14:00+00:00")).toBeNull(); // datetime, not date
  });
});

// ── parseCalDatetime ──────────────────────────────────────────────────────────

describe("parseCalDatetime", () => {
  it("parses an ISO datetime with offset", () => {
    const dt = parseCalDatetime("2026-06-15T14:00+00:00");
    expect(dt).not.toBeNull();
    expect(dt!.kind).toBe("datetime");
    // epoch should be 2026-06-15T14:00 UTC
    expect(dt!.epochMs).toBe(new Date("2026-06-15T14:00+00:00").getTime());
  });

  it("parses an ISO datetime with Z suffix", () => {
    const dt = parseCalDatetime("2026-06-15T09:30:00Z");
    expect(dt).not.toBeNull();
    expect(dt!.epochMs).toBe(new Date("2026-06-15T09:30:00Z").getTime());
  });

  it("returns null for plain date strings", () => {
    expect(parseCalDatetime("2026-06-15")).toBeNull();
  });

  it("returns null for bare datetime without offset", () => {
    expect(parseCalDatetime("2026-06-15T14:00")).toBeNull();
  });
});

// ── parseCalValue ─────────────────────────────────────────────────────────────

describe("parseCalValue", () => {
  it("parses a date", () => {
    const v = parseCalValue("2026-06-15");
    expect(v?.kind).toBe("date");
  });

  it("parses a datetime", () => {
    const v = parseCalValue("2026-06-15T14:00+00:00");
    expect(v?.kind).toBe("datetime");
  });

  it("parses an all-day range", () => {
    const v = parseCalValue("2026-06-15..2026-06-19");
    expect(v?.kind).toBe("range");
    if (v?.kind === "range") {
      expect(v.start.kind).toBe("date");
      expect(v.end.kind).toBe("date");
      expect(v.mixed).toBe(false);
    }
  });

  it("parses a timed range", () => {
    const v = parseCalValue("2026-06-15T09:00+00:00..2026-06-15T10:30+00:00");
    expect(v?.kind).toBe("range");
    if (v?.kind === "range") {
      expect(v.start.kind).toBe("datetime");
      expect(v.end.kind).toBe("datetime");
    }
  });

  it("returns a single point for malformed range (end before start)", () => {
    const v = parseCalValue("2026-06-20..2026-06-10");
    // Should return the start as a single point.
    expect(v?.kind).toBe("date");
    if (v?.kind === "date") expect(v.day).toBe(20);
  });

  it("returns null for non-date strings", () => {
    expect(parseCalValue("hello world")).toBeNull();
    expect(parseCalValue("")).toBeNull();
  });
});

// ── calDateToEpoch / calDateFromDate ──────────────────────────────────────────

describe("calDateToEpoch / calDateFromDate", () => {
  it("round-trips a CalDate through epoch", () => {
    const d: CalDate = { kind: "date", year: 2026, month: 6, day: 15 };
    const epoch = calDateToEpoch(d);
    const back = calDateFromDate(new Date(epoch));
    expect(back).toEqual(d);
  });

  it("produces midnight-local epoch", () => {
    const d: CalDate = { kind: "date", year: 2026, month: 1, day: 1 };
    const epoch = calDateToEpoch(d);
    const jsDate = new Date(epoch);
    expect(jsDate.getHours()).toBe(0);
    expect(jsDate.getMinutes()).toBe(0);
  });
});

// ── compareCalDates ───────────────────────────────────────────────────────────

describe("compareCalDates", () => {
  const d1: CalDate = { kind: "date", year: 2026, month: 1, day: 1 };
  const d2: CalDate = { kind: "date", year: 2026, month: 6, day: 15 };
  const d3: CalDate = { kind: "date", year: 2026, month: 1, day: 1 };

  it("returns -1 when a < b", () => expect(compareCalDates(d1, d2)).toBe(-1));
  it("returns 1 when a > b", () => expect(compareCalDates(d2, d1)).toBe(1));
  it("returns 0 when equal", () => expect(compareCalDates(d1, d3)).toBe(0));
});

// ── formatCalDate ─────────────────────────────────────────────────────────────

describe("formatCalDate", () => {
  it("formats a date with zero-padding", () => {
    expect(formatCalDate({ kind: "date", year: 2026, month: 3, day: 5 })).toBe("2026-03-05");
  });

  it("formats a date in December", () => {
    expect(formatCalDate({ kind: "date", year: 2026, month: 12, day: 31 })).toBe("2026-12-31");
  });
});

// ── weekStart ─────────────────────────────────────────────────────────────────

describe("weekStart", () => {
  it("returns Monday for a Wednesday input", () => {
    const wed = new Date(2026, 5, 10); // June 10 = Wednesday
    const mon = weekStart(wed);
    expect(mon.getDay()).toBe(1); // Monday
    expect(mon.getDate()).toBe(8);
  });

  it("returns Monday for a Monday input", () => {
    const mon = new Date(2026, 5, 8); // June 8 = Monday
    expect(weekStart(mon).getDate()).toBe(8);
  });

  it("returns the preceding Monday for a Sunday input", () => {
    const sun = new Date(2026, 5, 14); // June 14 = Sunday
    const ws = weekStart(sun);
    expect(ws.getDay()).toBe(1);
    expect(ws.getDate()).toBe(8);
  });
});

// ── addDays / addMonths ───────────────────────────────────────────────────────

describe("addDays", () => {
  it("adds positive days", () => {
    const d = new Date(2026, 5, 10);
    expect(addDays(d, 5).getDate()).toBe(15);
  });
  it("adds negative days (subtract)", () => {
    const d = new Date(2026, 5, 10);
    expect(addDays(d, -3).getDate()).toBe(7);
  });
  it("does not mutate input", () => {
    const d = new Date(2026, 5, 10);
    addDays(d, 5);
    expect(d.getDate()).toBe(10);
  });
});

describe("addMonths", () => {
  it("advances by one month", () => {
    const d = new Date(2026, 5, 10); // June
    expect(addMonths(d, 1).getMonth()).toBe(6); // July
  });
  it("wraps year at December → January", () => {
    const d = new Date(2026, 11, 15); // December
    const r = addMonths(d, 1);
    expect(r.getMonth()).toBe(0); // January
    expect(r.getFullYear()).toBe(2027);
  });
});

// ── monthGrid ─────────────────────────────────────────────────────────────────

describe("monthGrid", () => {
  it("generates a grid with rows of 7 dates", () => {
    const grid = monthGrid(2026, 6); // June 2026
    for (const row of grid) {
      expect(row).toHaveLength(7);
    }
  });

  it("starts each row on Monday (ISO)", () => {
    const grid = monthGrid(2026, 6);
    for (const row of grid) {
      const firstDate = calDateToDate(row[0]);
      expect(firstDate.getDay()).toBe(1); // 1 = Monday
    }
  });

  it("includes June 1 in the grid", () => {
    const grid = monthGrid(2026, 6);
    const flat = grid.flat();
    expect(flat.some((d) => d.year === 2026 && d.month === 6 && d.day === 1)).toBe(true);
  });

  it("includes the last day of the month", () => {
    const grid = monthGrid(2026, 6); // June has 30 days
    const flat = grid.flat();
    expect(flat.some((d) => d.year === 2026 && d.month === 6 && d.day === 30)).toBe(true);
  });

  it("produces at most 6 rows", () => {
    const grid = monthGrid(2026, 6);
    expect(grid.length).toBeLessThanOrEqual(6);
    expect(grid.length).toBeGreaterThanOrEqual(4);
  });

  it("includes leading days from previous month when month does not start on Monday", () => {
    // June 2026 starts on Monday, so no leading days needed.
    const grid = monthGrid(2026, 7); // July 2026 — starts on Wednesday
    const firstCell = grid[0][0];
    // First cell should be the Monday before July 1.
    expect(firstCell.month).toBe(6); // June (leading days)
    expect(firstCell.day).toBe(29); // June 29, 2026 is Monday
  });
});

// ── isoWeekday ────────────────────────────────────────────────────────────────

describe("isoWeekday", () => {
  it("returns 0 for Monday", () => {
    const mon = new Date(2026, 5, 8); // June 8 = Monday
    expect(isoWeekday(mon)).toBe(0);
  });
  it("returns 6 for Sunday", () => {
    const sun = new Date(2026, 5, 14); // June 14 = Sunday
    expect(isoWeekday(sun)).toBe(6);
  });
});

// ── calDateEquals / isToday / isPast ──────────────────────────────────────────

describe("calDateEquals", () => {
  it("returns true for same date", () => {
    const a: CalDate = { kind: "date", year: 2026, month: 6, day: 11 };
    const b: CalDate = { kind: "date", year: 2026, month: 6, day: 11 };
    expect(calDateEquals(a, b)).toBe(true);
  });
  it("returns false for different dates", () => {
    const a: CalDate = { kind: "date", year: 2026, month: 6, day: 11 };
    const b: CalDate = { kind: "date", year: 2026, month: 6, day: 12 };
    expect(calDateEquals(a, b)).toBe(false);
  });
});

// ── clampCalDate ──────────────────────────────────────────────────────────────

describe("clampCalDate", () => {
  const ws: CalDate = { kind: "date", year: 2026, month: 6, day: 1 };
  const we: CalDate = { kind: "date", year: 2026, month: 6, day: 30 };

  it("returns the date unchanged when within range", () => {
    const d: CalDate = { kind: "date", year: 2026, month: 6, day: 15 };
    expect(clampCalDate(d, ws, we)).toEqual(d);
  });
  it("clamps to window start when before", () => {
    const d: CalDate = { kind: "date", year: 2026, month: 5, day: 30 };
    expect(clampCalDate(d, ws, we)).toEqual(ws);
  });
  it("clamps to window end when after", () => {
    const d: CalDate = { kind: "date", year: 2026, month: 7, day: 1 };
    expect(clampCalDate(d, ws, we)).toEqual(we);
  });
});

// ── parseRRule ────────────────────────────────────────────────────────────────

describe("parseRRule", () => {
  it("parses a simple weekly rule", () => {
    const r = parseRRule("RRULE:FREQ=WEEKLY;BYDAY=MO");
    expect(r).not.toBeNull();
    expect(r!.freq).toBe("WEEKLY");
    expect(r!.byDay).toEqual(["MO"]);
    expect(r!.interval).toBe(1);
  });

  it("parses COUNT", () => {
    const r = parseRRule("RRULE:FREQ=DAILY;COUNT=10");
    expect(r!.count).toBe(10);
  });

  it("parses UNTIL", () => {
    const r = parseRRule("RRULE:FREQ=WEEKLY;UNTIL=20260630T000000Z");
    expect(r!.until).toEqual({ kind: "date", year: 2026, month: 6, day: 30 });
  });

  it("parses INTERVAL", () => {
    const r = parseRRule("RRULE:FREQ=WEEKLY;INTERVAL=2");
    expect(r!.interval).toBe(2);
  });

  it("records unsupported keys", () => {
    const r = parseRRule("RRULE:FREQ=WEEKLY;BYSETPOS=1");
    expect(r!.unsupported).toContain("BYSETPOS");
  });

  it("returns null for unknown FREQ", () => {
    expect(parseRRule("RRULE:FREQ=HOURLY")).toBeNull();
    expect(parseRRule("RRULE:FREQ=MINUTELY")).toBeNull();
  });

  it("works without RRULE: prefix", () => {
    const r = parseRRule("FREQ=DAILY;COUNT=5");
    expect(r!.freq).toBe("DAILY");
    expect(r!.count).toBe(5);
  });
});

// ── expandRRule ───────────────────────────────────────────────────────────────

describe("expandRRule", () => {
  const winStart: CalDate = { kind: "date", year: 2026, month: 6, day: 1 };
  const winEnd: CalDate = { kind: "date", year: 2026, month: 6, day: 30 };

  it("expands a daily rule within window", () => {
    const rrule = parseRRule("RRULE:FREQ=DAILY;COUNT=5")!;
    const dtstart: CalDate = { kind: "date", year: 2026, month: 6, day: 10 };
    const results = expandRRule(rrule, dtstart, winStart, winEnd);
    expect(results).toHaveLength(5);
    expect(results[0]).toEqual({ kind: "date", year: 2026, month: 6, day: 10 });
    expect(results[4]).toEqual({ kind: "date", year: 2026, month: 6, day: 14 });
  });

  it("respects COUNT — stops after N occurrences", () => {
    const rrule = parseRRule("RRULE:FREQ=DAILY;COUNT=3")!;
    const dtstart: CalDate = { kind: "date", year: 2026, month: 6, day: 1 };
    const results = expandRRule(rrule, dtstart, winStart, winEnd);
    expect(results).toHaveLength(3);
  });

  it("respects UNTIL — stops at the limit date", () => {
    const rrule = parseRRule("RRULE:FREQ=DAILY;UNTIL=20260605T000000Z")!;
    const dtstart: CalDate = { kind: "date", year: 2026, month: 6, day: 1 };
    const results = expandRRule(rrule, dtstart, winStart, winEnd);
    // Should include June 1–5 only.
    expect(results.length).toBeLessThanOrEqual(5);
    for (const r of results) {
      expect(calDateToEpoch(r)).toBeLessThanOrEqual(
        calDateToEpoch({ kind: "date", year: 2026, month: 6, day: 5 }),
      );
    }
  });

  it("expands a weekly BYDAY=MO rule", () => {
    const rrule = parseRRule("RRULE:FREQ=WEEKLY;BYDAY=MO")!;
    // First Monday of June 2026 = June 8 (June 1 is a Monday too).
    const dtstart: CalDate = { kind: "date", year: 2026, month: 6, day: 1 };
    const results = expandRRule(rrule, dtstart, winStart, winEnd);
    // June 2026 Mondays: 1, 8, 15, 22, 29
    expect(results.length).toBe(5);
    for (const r of results) {
      const jsD = calDateToDate(r);
      expect(jsD.getDay()).toBe(1); // Monday
    }
  });

  it("applies 'skip' override", () => {
    const rrule = parseRRule("RRULE:FREQ=WEEKLY;BYDAY=MO")!;
    const dtstart: CalDate = { kind: "date", year: 2026, month: 6, day: 1 };
    const overrides: Record<string, string> = { "2026-06-08": "skip" };
    const results = expandRRule(rrule, dtstart, winStart, winEnd, overrides);
    // June 8 should be missing.
    expect(results.some((r) => r.day === 8 && r.month === 6)).toBe(false);
    // Other Mondays still present.
    expect(results.some((r) => r.day === 15 && r.month === 6)).toBe(true);
  });

  it("applies move override", () => {
    const rrule = parseRRule("RRULE:FREQ=WEEKLY;BYDAY=MO")!;
    const dtstart: CalDate = { kind: "date", year: 2026, month: 6, day: 1 };
    const overrides: Record<string, string> = { "2026-06-08": "2026-06-09" };
    const results = expandRRule(rrule, dtstart, winStart, winEnd, overrides);
    // June 8 replaced by June 9.
    expect(results.some((r) => r.day === 8)).toBe(false);
    expect(results.some((r) => r.day === 9 && r.month === 6)).toBe(true);
  });

  it("only returns occurrences within the window", () => {
    const rrule = parseRRule("RRULE:FREQ=DAILY")!;
    const dtstart: CalDate = { kind: "date", year: 2026, month: 5, day: 25 };
    const results = expandRRule(rrule, dtstart, winStart, winEnd);
    for (const r of results) {
      expect(calDateToEpoch(r)).toBeGreaterThanOrEqual(calDateToEpoch(winStart));
      expect(calDateToEpoch(r)).toBeLessThanOrEqual(calDateToEpoch(winEnd));
    }
  });
});

// ── overflowSplit ─────────────────────────────────────────────────────────────

describe("overflowSplit", () => {
  it("returns all items and 0 overflow when within limit", () => {
    const [vis, ov] = overflowSplit([1, 2, 3], 5);
    expect(vis).toEqual([1, 2, 3]);
    expect(ov).toBe(0);
  });

  it("splits correctly at the limit", () => {
    const [vis, ov] = overflowSplit([1, 2, 3, 4, 5], 3);
    expect(vis).toEqual([1, 2, 3]);
    expect(ov).toBe(2);
  });

  it("handles empty array", () => {
    const [vis, ov] = overflowSplit([], 3);
    expect(vis).toEqual([]);
    expect(ov).toBe(0);
  });
});

// ── calValueStartDate / calValueEndDate ───────────────────────────────────────

describe("calValueStartDate", () => {
  it("returns the date for a CalDate", () => {
    const d: CalDate = { kind: "date", year: 2026, month: 6, day: 15 };
    expect(calValueStartDate(d)).toEqual(d);
  });

  it("returns the day of a CalDatetime", () => {
    const dt: CalDatetime = {
      kind: "datetime",
      epochMs: new Date("2026-06-15T14:00+00:00").getTime(),
    };
    const result = calValueStartDate(dt);
    expect(result.year).toBe(2026);
    expect(result.month).toBe(6);
  });

  it("returns start of a range", () => {
    const v = parseCalValue("2026-06-15..2026-06-19")!;
    const start = calValueStartDate(v);
    expect(start).toEqual({ kind: "date", year: 2026, month: 6, day: 15 });
  });
});

describe("calValueEndDate", () => {
  it("returns the end of an all-day range", () => {
    const v = parseCalValue("2026-06-15..2026-06-19")!;
    const end = calValueEndDate(v);
    expect(end).toEqual({ kind: "date", year: 2026, month: 6, day: 19 });
  });

  it("returns the same date for a single CalDate", () => {
    const d: CalDate = { kind: "date", year: 2026, month: 6, day: 15 };
    expect(calValueEndDate(d)).toEqual(d);
  });
});

// ── isAllDay ──────────────────────────────────────────────────────────────────

describe("isAllDay", () => {
  it("returns true for CalDate", () => {
    expect(isAllDay({ kind: "date", year: 2026, month: 6, day: 15 })).toBe(true);
  });
  it("returns false for CalDatetime", () => {
    expect(isAllDay({ kind: "datetime", epochMs: 0 })).toBe(false);
  });
  it("returns true for all-day range", () => {
    const v = parseCalValue("2026-06-15..2026-06-19")!;
    expect(isAllDay(v)).toBe(true);
  });
  it("returns false for timed range", () => {
    const v = parseCalValue("2026-06-15T09:00+00:00..2026-06-15T10:30+00:00")!;
    expect(isAllDay(v)).toBe(false);
  });
});
