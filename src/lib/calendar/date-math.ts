// date-math.ts — pure calendar helpers (no DOM, no IPC).
// Spec: docs/spec/0008-calendar.md
//
// All functions operate on plain {year, month, day} triples or JS Date objects.
// Month is always 1-based (1 = January). Week starts on Monday (ISO 8601).

import type { CalDate, CalDatetime, CalValue } from "./types.js";

// ── ISO date parsing ──────────────────────────────────────────────────────────

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_DATETIME_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?([+-]\d{2}:\d{2}|Z)$/;
const RANGE_RE =
  /^(\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2})?(?:[+-]\d{2}:\d{2}|Z))?)\.\.(\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2})?(?:[+-]\d{2}:\d{2}|Z))?)$/;

/** Parse an ISO date string "YYYY-MM-DD" into a CalDate, or null if invalid. */
export function parseCalDate(s: string): CalDate | null {
  const m = ISO_DATE_RE.exec(s);
  if (!m) return null;
  return { kind: "date", year: +m[1], month: +m[2], day: +m[3] };
}

/** Parse an ISO datetime string into a CalDatetime (epoch in local zone). */
export function parseCalDatetime(s: string): CalDatetime | null {
  const m = ISO_DATETIME_RE.exec(s);
  if (!m) return null;
  // new Date() parses the offset and gives the correct epoch.
  const d = new Date(s);
  if (isNaN(d.getTime())) return null;
  return { kind: "datetime", epochMs: d.getTime() };
}

/**
 * Parse an arbitrary property value string into a CalValue.
 * Returns null when the string is not a recognized date/datetime/range.
 */
export function parseCalValue(s: string): CalValue | null {
  // Try range first (contains "..").
  const rangeMatch = RANGE_RE.exec(s);
  if (rangeMatch) {
    const startStr = rangeMatch[1];
    const endStr = rangeMatch[2];
    const startDate = parseCalDate(startStr);
    const endDate = parseCalDate(endStr);
    const startDt = parseCalDatetime(startStr);
    const endDt = parseCalDatetime(endStr);

    const start: CalDate | CalDatetime | null = startDate ?? startDt;
    const end: CalDate | CalDatetime | null = endDate ?? endDt;

    if (!start || !end) return null;

    const mixed = start.kind !== end.kind;
    // Validate: end must not be before start (for all-day ranges: compare as dates).
    if (!mixed) {
      if (start.kind === "date" && end.kind === "date") {
        if (calDateToEpoch(end) < calDateToEpoch(start)) {
          // Malformed: return as single point on start.
          return start;
        }
      } else if (start.kind === "datetime" && end.kind === "datetime") {
        if (end.epochMs < start.epochMs) {
          return start;
        }
      }
    }

    return { kind: "range", start, end, mixed };
  }

  const date = parseCalDate(s);
  if (date) return date;

  const dt = parseCalDatetime(s);
  if (dt) return dt;

  return null;
}

// ── CalDate ↔ epoch conversion ────────────────────────────────────────────────

/** Convert a CalDate to a midnight-local epoch (ms). */
export function calDateToEpoch(d: CalDate): number {
  return new Date(d.year, d.month - 1, d.day).getTime();
}

/** Get local midnight epoch for a given JS Date (strips time). */
export function toMidnight(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** Construct a CalDate from a JS Date (local). */
export function calDateFromDate(d: Date): CalDate {
  return { kind: "date", year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate() };
}

/** Construct a JS Date from a CalDate (midnight local). */
export function calDateToDate(d: CalDate): Date {
  return new Date(d.year, d.month - 1, d.day);
}

/** Compare two CalDates: -1 if a<b, 0 if equal, 1 if a>b. */
export function compareCalDates(a: CalDate, b: CalDate): number {
  const ae = calDateToEpoch(a);
  const be = calDateToEpoch(b);
  if (ae < be) return -1;
  if (ae > be) return 1;
  return 0;
}

/** Format a CalDate as "YYYY-MM-DD". */
export function formatCalDate(d: CalDate): string {
  const mm = String(d.month).padStart(2, "0");
  const dd = String(d.day).padStart(2, "0");
  return `${d.year}-${mm}-${dd}`;
}

/** Format a JS Date as "YYYY-MM-DD". */
export function formatDate(d: Date): string {
  return formatCalDate(calDateFromDate(d));
}

// ── Week helpers (ISO 8601 — week starts Monday) ───────────────────────────────

/** Return the Monday of the ISO week containing `d`. */
export function weekStart(d: Date): Date {
  const r = new Date(d);
  const dow = r.getDay(); // 0=Sun, 1=Mon, …, 6=Sat
  const delta = dow === 0 ? -6 : 1 - dow;
  r.setDate(r.getDate() + delta);
  r.setHours(0, 0, 0, 0);
  return r;
}

/** Return the Sunday (end of week, ISO) 6 days after the Monday from weekStart. */
export function weekEnd(weekStartDate: Date): Date {
  const r = new Date(weekStartDate);
  r.setDate(r.getDate() + 6);
  r.setHours(23, 59, 59, 999);
  return r;
}

/** Advance a date by N days (returns a new Date). */
export function addDays(d: Date, n: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

/** Advance a date by N months (returns a new Date). */
export function addMonths(d: Date, n: number): Date {
  const r = new Date(d);
  r.setMonth(r.getMonth() + n);
  return r;
}

// ── Month grid ────────────────────────────────────────────────────────────────

/**
 * Build the 6×7 (or 5×7) grid of dates for a month view.
 * Returns an array of CalDate rows. Each row is 7 days (Mon → Sun).
 * Includes leading/trailing days from adjacent months to fill complete weeks.
 */
export function monthGrid(year: number, month: number): CalDate[][] {
  // First day of the month.
  const first = new Date(year, month - 1, 1);
  // Start from Monday of the week containing the 1st.
  const gridStart = weekStart(first);

  const rows: CalDate[][] = [];
  let cur = new Date(gridStart);

  // Always produce at least 4 weeks; keep going until we've covered all days
  // of the month (up to 6 weeks max).
  while (true) {
    const row: CalDate[] = [];
    for (let i = 0; i < 7; i++) {
      row.push(calDateFromDate(cur));
      cur = addDays(cur, 1);
    }
    rows.push(row);
    // Stop when we've passed the last day of the month and completed the week.
    if (rows.length >= 4 && cur.getMonth() !== month - 1) break;
    if (rows.length >= 6) break;
  }

  return rows;
}

// ── Day labels ────────────────────────────────────────────────────────────────

/** Short weekday names starting Monday (ISO). */
export const WEEKDAY_SHORT = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** Full weekday names starting Monday (ISO). */
export const WEEKDAY_LONG = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
];

/** Return ISO weekday index 0-6 (0=Monday) for a JS Date. */
export function isoWeekday(d: Date): number {
  const dow = d.getDay(); // 0=Sun
  return dow === 0 ? 6 : dow - 1;
}

// ── "Today" helpers ───────────────────────────────────────────────────────────

/** True if the two CalDates are the same day. */
export function calDateEquals(a: CalDate, b: CalDate): boolean {
  return a.year === b.year && a.month === b.month && a.day === b.day;
}

/** True if a CalDate is today (local). */
export function isToday(d: CalDate): boolean {
  return calDateEquals(d, calDateFromDate(new Date()));
}

/** True if a CalDate is in the past (strictly before today). */
export function isPast(d: CalDate): boolean {
  return compareCalDates(d, calDateFromDate(new Date())) < 0;
}

// ── Range clamping ────────────────────────────────────────────────────────────

/**
 * Clamp a CalDate to [windowStart, windowEnd] inclusive.
 * Returns the clamped date.
 */
export function clampCalDate(d: CalDate, windowStart: CalDate, windowEnd: CalDate): CalDate {
  if (compareCalDates(d, windowStart) < 0) return windowStart;
  if (compareCalDates(d, windowEnd) > 0) return windowEnd;
  return d;
}

// ── RRULE minimal expansion ────────────────────────────────────────────────────

/** Parsed subset of an RRULE. */
export interface ParsedRRule {
  freq: "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";
  interval: number;
  count?: number;
  until?: CalDate;
  byDay?: string[]; // e.g. ["MO","WE","FR"]
  byMonthDay?: number[]; // e.g. [1, 15, -1]
  byMonth?: number[]; // 1-12
  unsupported: string[]; // keys that were present but not handled
}

const SUPPORTED_RRULE_KEYS = new Set([
  "FREQ",
  "INTERVAL",
  "COUNT",
  "UNTIL",
  "BYDAY",
  "BYMONTHDAY",
  "BYMONTH",
]);

const UNSUPPORTED_WARN_KEYS = new Set([
  "BYSETPOS",
  "BYWEEKNO",
  "BYYEARDAY",
  "BYHOUR",
  "BYMINUTE",
  "BYSECOND",
  "WKST",
  "RDATE",
  "EXDATE",
]);

/** Parse an RRULE string (with or without "RRULE:" prefix). Returns null on failure. */
export function parseRRule(rrule: string): ParsedRRule | null {
  const rule = rrule.startsWith("RRULE:") ? rrule.slice(6) : rrule;
  const parts = rule.split(";");
  const map: Record<string, string> = {};
  for (const part of parts) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    map[part.slice(0, eq).toUpperCase()] = part.slice(eq + 1);
  }

  const freq = map["FREQ"] as ParsedRRule["freq"] | undefined;
  if (!freq || !["DAILY", "WEEKLY", "MONTHLY", "YEARLY"].includes(freq)) return null;

  const unsupported: string[] = [];
  for (const key of Object.keys(map)) {
    if (!SUPPORTED_RRULE_KEYS.has(key)) {
      unsupported.push(key);
    }
  }
  for (const key of UNSUPPORTED_WARN_KEYS) {
    if (map[key] !== undefined && !unsupported.includes(key)) {
      unsupported.push(key);
    }
  }

  const interval = map["INTERVAL"] ? parseInt(map["INTERVAL"], 10) || 1 : 1;
  const count = map["COUNT"] ? parseInt(map["COUNT"], 10) : undefined;

  let until: CalDate | undefined;
  if (map["UNTIL"]) {
    // Support both "YYYYMMDD" (compact) and "YYYY-MM-DD" (dashed) forms.
    let untilStr = map["UNTIL"];
    if (/^\d{8}/.test(untilStr)) {
      // Convert compact form "20260630..." to "2026-06-30".
      untilStr = `${untilStr.slice(0, 4)}-${untilStr.slice(4, 6)}-${untilStr.slice(6, 8)}`;
    }
    const u = parseCalDate(untilStr.slice(0, 10));
    if (u) until = u;
  }

  const byDay = map["BYDAY"]
    ? map["BYDAY"]
        .split(",")
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean)
    : undefined;

  const byMonthDay = map["BYMONTHDAY"]
    ? map["BYMONTHDAY"]
        .split(",")
        .map((s) => parseInt(s.trim(), 10))
        .filter((n) => !isNaN(n))
    : undefined;

  const byMonth = map["BYMONTH"]
    ? map["BYMONTH"]
        .split(",")
        .map((s) => parseInt(s.trim(), 10))
        .filter((n) => !isNaN(n))
    : undefined;

  return { freq, interval, count, until, byDay, byMonthDay, byMonth, unsupported };
}

const WEEKDAY_ABBR = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"]; // JS getDay() order

/** True if the JS Date matches any of the BYDAY specs (simple names only, no positional). */
function matchesByDay(d: Date, byDay: string[]): boolean {
  const dow = WEEKDAY_ABBR[d.getDay()];
  // Support positional prefix like "1MO", "-1FR" — strip leading digits/sign.
  return byDay.some((spec) => {
    const plain = spec.replace(/^[-+]?\d+/, "");
    return plain === dow;
  });
}

/**
 * Expand an RRULE into occurrence dates within [windowStart, windowEnd].
 * dtstart is the entry's primary date value (a CalDate).
 * overrides is the map of original-date → replacement date or "skip".
 *
 * Returns an array of CalDate occurrences. The dtstart itself is included
 * as the first occurrence if it falls within the window (and is not skipped/moved).
 *
 * This is the *mock* TS implementation. Full fidelity: Rust engine (core::recurrence, #23).
 */
export function expandRRule(
  rrule: ParsedRRule,
  dtstart: CalDate,
  windowStart: CalDate,
  windowEnd: CalDate,
  overrides: Record<string, string> = {},
): CalDate[] {
  const results: CalDate[] = [];
  let current = calDateToDate(dtstart);
  const winStartEpoch = calDateToEpoch(windowStart);
  const winEndEpoch = calDateToEpoch(windowEnd);
  const untilEpoch = rrule.until ? calDateToEpoch(rrule.until) : Infinity;

  let occurrenceCount = 0;
  const maxIterations = 10000; // safety guard
  let iterations = 0;

  while (iterations++ < maxIterations) {
    const epoch = current.getTime();
    if (epoch > untilEpoch) break;
    if (rrule.count !== undefined && occurrenceCount >= rrule.count) break;

    // Check if this date is a valid occurrence for the rule.
    const cd = calDateFromDate(current);
    const key = formatCalDate(cd);

    // BYDAY filter.
    if (rrule.byDay && rrule.byDay.length > 0) {
      if (!matchesByDay(current, rrule.byDay)) {
        current = advanceByFreq(current, rrule, false);
        continue;
      }
    }

    // BYMONTH filter.
    if (rrule.byMonth && rrule.byMonth.length > 0) {
      if (!rrule.byMonth.includes(current.getMonth() + 1)) {
        current = advanceByFreq(current, rrule, false);
        continue;
      }
    }

    // BYMONTHDAY filter.
    if (rrule.byMonthDay && rrule.byMonthDay.length > 0) {
      const dom = current.getDate();
      const daysInMonth = new Date(current.getFullYear(), current.getMonth() + 1, 0).getDate();
      const match = rrule.byMonthDay.some((n) => {
        const actual = n < 0 ? daysInMonth + n + 1 : n;
        return dom === actual;
      });
      if (!match) {
        current = advanceByFreq(current, rrule, false);
        continue;
      }
    }

    occurrenceCount++;

    // Apply override.
    const override = overrides[key];
    if (override !== undefined) {
      if (override !== "skip") {
        // Moved occurrence.
        const moved = parseCalDate(override);
        if (moved) {
          const movedEpoch = calDateToEpoch(moved);
          if (movedEpoch >= winStartEpoch && movedEpoch <= winEndEpoch) {
            results.push(moved);
          }
        }
      }
      // "skip" → emit nothing
    } else {
      if (epoch >= winStartEpoch && epoch <= winEndEpoch) {
        results.push(cd);
      }
    }

    current = advanceByFreq(current, rrule, true);
  }

  return results;
}

/** Advance current date by one RRULE interval step. */
function advanceByFreq(d: Date, rrule: ParsedRRule, byInterval: boolean): Date {
  const n = byInterval ? rrule.interval : 1;
  const r = new Date(d);
  switch (rrule.freq) {
    case "DAILY":
      r.setDate(r.getDate() + n);
      break;
    case "WEEKLY":
      r.setDate(r.getDate() + (byInterval ? n * 7 : 1));
      break;
    case "MONTHLY":
      if (byInterval) {
        r.setMonth(r.getMonth() + n);
      } else {
        r.setDate(r.getDate() + 1);
      }
      break;
    case "YEARLY":
      if (byInterval) {
        r.setFullYear(r.getFullYear() + n);
      } else {
        r.setDate(r.getDate() + 1);
      }
      break;
  }
  return r;
}

// ── Hour helpers ──────────────────────────────────────────────────────────────

/** Extract the local hour (0-23) from a CalDatetime epoch. */
export function epochToLocalHour(epochMs: number): number {
  return new Date(epochMs).getHours();
}

/** Extract the local minute (0-59) from a CalDatetime epoch. */
export function epochToLocalMinute(epochMs: number): number {
  return new Date(epochMs).getMinutes();
}

/** Get the CalDate of a CalDatetime (local day). */
export function datetimeToCalDate(dt: CalDatetime): CalDate {
  return calDateFromDate(new Date(dt.epochMs));
}

// ── Range date-of-day helpers ─────────────────────────────────────────────────

/** Return the start CalDate of a CalValue (for grid placement). */
export function calValueStartDate(v: CalValue): CalDate {
  switch (v.kind) {
    case "date":
      return v;
    case "datetime":
      return datetimeToCalDate(v);
    case "range":
      return v.start.kind === "date" ? v.start : datetimeToCalDate(v.start as CalDatetime);
  }
}

/** Return the end CalDate of a CalValue (inclusive). */
export function calValueEndDate(v: CalValue): CalDate {
  switch (v.kind) {
    case "date":
      return v;
    case "datetime":
      return datetimeToCalDate(v);
    case "range": {
      if (v.mixed) return calValueStartDate(v); // treat mixed as single point
      return v.end.kind === "date" ? v.end : datetimeToCalDate(v.end as CalDatetime);
    }
  }
}

/** True when a CalValue is all-day (no time component). */
export function isAllDay(v: CalValue): boolean {
  if (v.kind === "date") return true;
  if (v.kind === "datetime") return false;
  return v.start.kind === "date" && v.end.kind === "date";
}

// ── +M overflow logic ─────────────────────────────────────────────────────────

/** Given a list of items for a cell and a max visible count, return [visible, overflowCount]. */
export function overflowSplit<T>(items: T[], maxVisible: number): [T[], number] {
  if (items.length <= maxVisible) return [items, 0];
  return [items.slice(0, maxVisible), items.length - maxVisible];
}
