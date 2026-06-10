// placement.ts — calendar item placement helpers.
// Derives CalItem lists from raw IPC data and determines how items render
// in each view (all-day band vs timed slot, multi-day span, etc.).
// Spec: docs/spec/0008-calendar.md

import {
  parseCalValue,
  parseRRule,
  expandRRule,
  calValueStartDate,
  calValueEndDate,
  calDateToEpoch,
  calDateFromDate,
  formatCalDate,
  isAllDay,
} from "./date-math.js";
import type { CalDate, CalItem, CalValue } from "./types.js";
import { PRIMARY_DATE_PROP } from "./types.js";

// ── Frontmatter parser (lightweight, for placement layer) ─────────────────────

/** Extract a property value string from YAML-ish frontmatter text. Null if absent. */
export function extractProp(text: string, key: string): string | null {
  // Match "key: value" on its own line within the frontmatter block.
  const re = new RegExp(`^[ \\t]*${key}:[ \\t]*(.+)$`, "m");
  const m = re.exec(text);
  if (!m) return null;
  return m[1].trim().replace(/^['"]|['"]$/g, ""); // strip optional quotes
}

/**
 * Extract the `overrides` map from frontmatter text.
 * Looks for a block like:
 *   overrides:
 *     "2026-05-25": "2026-05-26"
 *     "2026-06-01": skip
 */
export function extractOverrides(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  // Find the overrides: block.
  const overridesStart = /^[ \t]*overrides:\s*$/m.exec(text);
  if (!overridesStart) return result;

  const startIdx = overridesStart.index + overridesStart[0].length;
  const remaining = text.slice(startIdx);

  // Split into lines and parse until we hit a non-indented line.
  const lines = remaining.split("\n");
  for (const line of lines) {
    if (!line.trim()) continue; // blank line
    if (!/^[ \t]/.test(line)) break; // non-indented = end of overrides block

    // Match: optional-quote + date-key + optional-quote + colon + space + optional-quote + value + optional-quote
    const m = /^[ \t]+["']?([\d-]+)["']?:[ \t]+["']?([^"'\n]+?)["']?\s*$/.exec(line);
    if (m) {
      const key = m[1].trim();
      const val = m[2].trim();
      if (key && val) result[key] = val;
    }
  }

  return result;
}

// ── Group color mapping (mock — real would come from _group.md) ───────────────

const GROUP_COLORS: Record<string, string> = {
  "work/atlas": "#4a90d9",
  journal: "#e8a050",
  books: "#6ab06a",
  inbox: "#9a70c8",
};

function groupColor(group: string): string | undefined {
  // Try exact match, then prefix match.
  if (GROUP_COLORS[group]) return GROUP_COLORS[group];
  for (const [k, v] of Object.entries(GROUP_COLORS)) {
    if (group.startsWith(k + "/")) return v;
  }
  return undefined;
}

// ── CalItem factory ───────────────────────────────────────────────────────────

/**
 * Build CalItems for a single entry within [windowStart, windowEnd].
 * Expands RRULE if present.
 * Returns [] when the entry has no primary date property.
 */
export function buildCalItems(
  entryId: string,
  title: string,
  group: string,
  tags: string[],
  docText: string,
  windowStart: CalDate,
  windowEnd: CalDate,
): CalItem[] {
  const rawDue = extractProp(docText, PRIMARY_DATE_PROP);
  if (!rawDue) return [];

  const value = parseCalValue(rawDue);
  if (!value) return [];

  const color = groupColor(group);
  const base: Omit<CalItem, "value" | "occurrenceKey" | "isOccurrence"> = {
    entryId,
    title,
    group,
    groupColor: color,
    tags,
  };

  // Check for RRULE.
  const rawRepeat = extractProp(docText, "repeat");
  if (rawRepeat) {
    const rrule = parseRRule(rawRepeat);
    if (rrule && rrule.unsupported.length === 0) {
      // Need a CalDate start for RRULE expansion.
      const dtstart = calValueStartDate(value);
      const overrides = extractOverrides(docText);

      const occurrences = expandRRule(rrule, dtstart, windowStart, windowEnd, overrides);
      return occurrences.map((occ): CalItem => {
        const occValue: CalValue = occ;
        return {
          ...base,
          value: occValue,
          occurrenceKey: formatCalDate(occ),
          isOccurrence: true,
        };
      });
    }
    // Unsupported RRULE → fall through to single-point rendering.
  }

  // Single item: check if it overlaps the window.
  const startDate = calValueStartDate(value);
  const endDate = calValueEndDate(value);
  const winStartEpoch = calDateToEpoch(windowStart);
  const winEndEpoch = calDateToEpoch(windowEnd);

  if (calDateToEpoch(endDate) < winStartEpoch || calDateToEpoch(startDate) > winEndEpoch) {
    return [];
  }

  return [{ ...base, value, occurrenceKey: undefined, isOccurrence: false }];
}

// ── View placement ────────────────────────────────────────────────────────────

/** A positioned item for day/week timed column (all-day items excluded here). */
export interface TimedPlacement {
  item: CalItem;
  /** Local hour (0-23) of start. */
  startHour: number;
  /** Local minute (0-59) of start. */
  startMinute: number;
  /** Duration in minutes. */
  durationMinutes: number;
}

/** A multi-day band spanning multiple cells in week/month view. */
export interface BandPlacement {
  item: CalItem;
  /** Inclusive start date clamped to view window. */
  bandStart: CalDate;
  /** Inclusive end date clamped to view window. */
  bandEnd: CalDate;
  /** Number of days spanned (>= 1). */
  spanDays: number;
}

/** An all-day single-day item for month/week cell. */
export interface AllDayPlacement {
  item: CalItem;
  date: CalDate;
}

/**
 * Classify a CalItem into placement categories for a given view cell/row.
 * Returns one of: "timed", "band", "allday", or "skip" (not in window).
 */
export type PlacementKind = "timed" | "band" | "allday" | "skip";

export function classifyItem(item: CalItem): PlacementKind {
  const v = item.value;
  if (v.kind === "datetime") return "timed";
  if (v.kind === "date") return "allday";
  if (v.kind === "range") {
    if (v.mixed) return "allday"; // treat mixed as single all-day point
    const startDate = calValueStartDate(v);
    const endDate = calValueEndDate(v);
    if (!isAllDay(v)) return "timed"; // timed range → treat as timed
    if (calDateToEpoch(endDate) > calDateToEpoch(startDate)) return "band";
    return "allday"; // same day range
  }
  return "skip";
}

/** Build timed placement for a single CalItem (must be kind="timed"). */
export function makeTimedPlacement(item: CalItem): TimedPlacement | null {
  const v = item.value;
  if (v.kind === "datetime") {
    const d = new Date(v.epochMs);
    return {
      item,
      startHour: d.getHours(),
      startMinute: d.getMinutes(),
      durationMinutes: 60, // default 1h; timed range would provide duration
    };
  }
  if (v.kind === "range" && v.start.kind === "datetime" && v.end.kind === "datetime") {
    const start = new Date(v.start.epochMs);
    const end = new Date(v.end.epochMs);
    const durationMs = Math.max(end.getTime() - start.getTime(), 30 * 60 * 1000);
    return {
      item,
      startHour: start.getHours(),
      startMinute: start.getMinutes(),
      durationMinutes: Math.round(durationMs / 60000),
    };
  }
  return null;
}

/** Build band placement for a range item clamped to the given window. */
export function makeBandPlacement(
  item: CalItem,
  windowStart: CalDate,
  windowEnd: CalDate,
): BandPlacement | null {
  const v = item.value;
  if (v.kind !== "range") return null;

  const rawStart = calValueStartDate(v);
  const rawEnd = calValueEndDate(v);

  const winStartEpoch = calDateToEpoch(windowStart);
  const winEndEpoch = calDateToEpoch(windowEnd);

  // Clamp to window.
  const clamped = (d: CalDate): CalDate => {
    const e = calDateToEpoch(d);
    if (e < winStartEpoch) return windowStart;
    if (e > winEndEpoch) return windowEnd;
    return d;
  };

  const bandStart = clamped(rawStart);
  const bandEnd = clamped(rawEnd);

  const span = Math.round((calDateToEpoch(bandEnd) - calDateToEpoch(bandStart)) / 86400000) + 1;

  return { item, bandStart, bandEnd, spanDays: span };
}

// ── Drag-to-reschedule write-back ─────────────────────────────────────────────

/**
 * Produce the new `due` value string for a drag operation.
 * - Non-recurring: replaces the `due` property directly.
 * - Recurring occurrence: must write an override (caller handles that via applyPanelEdit).
 *
 * `fromDate` — the original occurrence date (YYYY-MM-DD).
 * `toDate`   — the target date (YYYY-MM-DD).
 * `originalValue` — the current `due` property string.
 *
 * Returns { kind: "direct", newValue } or { kind: "override", occurrenceKey, newValue }.
 */
export type DragWriteResult =
  | { kind: "direct"; newValue: string }
  | { kind: "override"; occurrenceKey: string; newValue: string };

export function buildDragWrite(item: CalItem, toDate: CalDate): DragWriteResult {
  const toStr = formatCalDate(toDate);

  if (item.isOccurrence && item.occurrenceKey) {
    return { kind: "override", occurrenceKey: item.occurrenceKey, newValue: toStr };
  }

  // For date values: just the new date.
  const v = item.value;
  if (v.kind === "date") {
    return { kind: "direct", newValue: toStr };
  }

  // For datetime values: preserve the time, change the date.
  if (v.kind === "datetime") {
    const orig = new Date(v.epochMs);
    const newD = new Date(
      toDate.year,
      toDate.month - 1,
      toDate.day,
      orig.getHours(),
      orig.getMinutes(),
      orig.getSeconds(),
    );
    // Format as ISO datetime with local offset.
    const newStr = formatDatetimeWithOffset(newD);
    return { kind: "direct", newValue: newStr };
  }

  // Range: shift both endpoints by the same delta.
  if (v.kind === "range") {
    const startDate = calValueStartDate(v);
    const endDate = calValueEndDate(v);
    const deltaMs = calDateToEpoch(toDate) - calDateToEpoch(startDate);
    const deltaDays = Math.round(deltaMs / 86400000);

    const newStart = calDateFromDate(new Date(calDateToEpoch(startDate) + deltaDays * 86400000));
    const newEnd = calDateFromDate(new Date(calDateToEpoch(endDate) + deltaDays * 86400000));
    return {
      kind: "direct",
      newValue: `${formatCalDate(newStart)}..${formatCalDate(newEnd)}`,
    };
  }

  return { kind: "direct", newValue: toStr };
}

/** Format a JS Date as an ISO 8601 datetime with local UTC offset. */
function formatDatetimeWithOffset(d: Date): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  const year = d.getFullYear();
  const mo = pad(d.getMonth() + 1);
  const day = pad(d.getDate());
  const h = pad(d.getHours());
  const m = pad(d.getMinutes());
  const offsetMin = -d.getTimezoneOffset();
  const sign = offsetMin >= 0 ? "+" : "-";
  const absMin = Math.abs(offsetMin);
  const oh = pad(Math.floor(absMin / 60));
  const om = pad(absMin % 60);
  return `${year}-${mo}-${day}T${h}:${m}${sign}${oh}:${om}`;
}

/** Get all dates that an item spans (for multi-day bands in month view). */
export function itemSpanDates(item: CalItem, windowStart: CalDate, windowEnd: CalDate): CalDate[] {
  const start = calValueStartDate(item.value);
  const end = calValueEndDate(item.value);
  const winStartEpoch = calDateToEpoch(windowStart);
  const winEndEpoch = calDateToEpoch(windowEnd);

  const clampedStart = Math.max(calDateToEpoch(start), winStartEpoch);
  const clampedEnd = Math.min(calDateToEpoch(end), winEndEpoch);

  const dates: CalDate[] = [];
  let cur = clampedStart;
  while (cur <= clampedEnd) {
    dates.push(calDateFromDate(new Date(cur)));
    cur += 86400000;
  }
  return dates;
}
