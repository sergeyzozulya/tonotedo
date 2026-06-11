// Tests for reschedule.ts — drag-to-reschedule value helpers.
// Spec: docs/spec/0008-calendar.md §"Drag to reschedule"

import { describe, it, expect } from "vitest";
import { rescheduleValue } from "../reschedule.js";
import type { CalDate } from "../types.js";

const toCalDate = (y: number, m: number, d: number): CalDate => ({
  kind: "date",
  year: y,
  month: m,
  day: d,
});

// ── date value ────────────────────────────────────────────────────────────────

describe("rescheduleValue — date", () => {
  it("replaces a plain date with the new date", () => {
    expect(rescheduleValue("2026-06-10", toCalDate(2026, 6, 15))).toBe("2026-06-15");
  });

  it("handles month/year boundary", () => {
    expect(rescheduleValue("2026-12-31", toCalDate(2027, 1, 1))).toBe("2027-01-01");
  });
});

// ── datetime value ────────────────────────────────────────────────────────────

describe("rescheduleValue — datetime", () => {
  it("preserves the time + offset when the date moves", () => {
    const result = rescheduleValue("2026-06-10T14:00+02:00", toCalDate(2026, 6, 15));
    expect(result).toBe("2026-06-15T14:00+02:00");
  });

  it("preserves the time + Z offset", () => {
    const result = rescheduleValue("2026-06-10T09:30:00Z", toCalDate(2026, 7, 1));
    expect(result).toBe("2026-07-01T09:30:00Z");
  });

  it("preserves the time + negative offset", () => {
    const result = rescheduleValue("2026-06-10T23:00-05:00", toCalDate(2026, 6, 11));
    expect(result).toBe("2026-06-11T23:00-05:00");
  });

  it("does not lose seconds in the time portion", () => {
    const result = rescheduleValue("2026-06-10T08:15:30+00:00", toCalDate(2026, 6, 20));
    expect(result).toBe("2026-06-20T08:15:30+00:00");
  });
});

// ── range value ───────────────────────────────────────────────────────────────

describe("rescheduleValue — range", () => {
  it("shifts an all-day range by the same delta", () => {
    // Original: June 10–14 (5 days). Drag start to June 15 → shift by +5 days.
    const result = rescheduleValue("2026-06-10..2026-06-14", toCalDate(2026, 6, 15));
    expect(result).toBe("2026-06-15..2026-06-19");
  });

  it("shifts a timed range preserving time components", () => {
    // Original: June 10T09:00+00:00..June 10T10:30+00:00 (1.5h).
    // Drag to June 15 → shift start by +5 days, end also by +5 days.
    const result = rescheduleValue(
      "2026-06-10T09:00+00:00..2026-06-10T10:30+00:00",
      toCalDate(2026, 6, 15),
    );
    expect(result).toBe("2026-06-15T09:00+00:00..2026-06-15T10:30+00:00");
  });

  it("shifts a multi-day timed range preserving duration and times", () => {
    // Overnight: June 10T22:00+00:00..June 11T06:00+00:00.
    // Drag start to June 20 → shift by +10 days.
    const result = rescheduleValue(
      "2026-06-10T22:00+00:00..2026-06-11T06:00+00:00",
      toCalDate(2026, 6, 20),
    );
    expect(result).toBe("2026-06-20T22:00+00:00..2026-06-21T06:00+00:00");
  });

  it("handles a range that wraps a month boundary", () => {
    // June 29..July 2 → drag start to July 1 → shift +2 days → July 1..July 4
    const result = rescheduleValue("2026-06-29..2026-07-02", toCalDate(2026, 7, 1));
    expect(result).toBe("2026-07-01..2026-07-04");
  });

  it("handles a zero-delta drag (same day)", () => {
    const result = rescheduleValue("2026-06-10..2026-06-12", toCalDate(2026, 6, 10));
    expect(result).toBe("2026-06-10..2026-06-12");
  });
});

// ── null / unrecognised ───────────────────────────────────────────────────────

describe("rescheduleValue — null / unrecognised", () => {
  it("returns plain date when prevRaw is null", () => {
    expect(rescheduleValue(null, toCalDate(2026, 6, 15))).toBe("2026-06-15");
  });

  it("returns plain date when prevRaw is not a date", () => {
    expect(rescheduleValue("not-a-date", toCalDate(2026, 6, 15))).toBe("2026-06-15");
  });
});
