// reschedule.ts — Helpers for drag-to-reschedule that preserve time components.
// Spec: docs/spec/0008-calendar.md §"Drag to reschedule"
//
// Rules:
//   • date value ("YYYY-MM-DD") → write new date as-is.
//   • datetime value ("YYYY-MM-DDTHH:MM±HH:MM") → keep the original time + offset,
//     replace only the date component.
//   • range value ("start..end") → shift both ends by the same delta in calendar days,
//     preserving any time components and the original duration.
//   • null / unrecognised → write new date as "YYYY-MM-DD" (plain date fallback).

import type { CalDate } from "./types.js";
import { parseCalValue, parseCalDate, formatCalDate } from "./date-math.js";

/**
 * Given the previous raw property value string and the target CalDate (new day),
 * return the updated property value string that should be written to disk.
 *
 * Handles date / datetime / range correctly per spec 0008 §Drag to reschedule.
 */
export function rescheduleValue(prevRaw: string | null, toDate: CalDate): string {
  if (!prevRaw) {
    return formatCalDate(toDate);
  }

  const prev = parseCalValue(prevRaw);
  if (!prev) {
    return formatCalDate(toDate);
  }

  if (prev.kind === "date") {
    // Plain date: just replace with the new date.
    return formatCalDate(toDate);
  }

  if (prev.kind === "datetime") {
    // Preserve the original time + offset; replace only the date.
    return replaceDate(prevRaw, toDate);
  }

  if (prev.kind === "range") {
    // Compute how many calendar days the start shifts.
    const prevStartStr = prevRaw.split("..")[0];
    const prevStartDate = parseCalDate(prevStartStr) ?? parseCalDateTimePart(prevStartStr);
    if (!prevStartDate) {
      return formatCalDate(toDate);
    }

    const deltaDays = calDateDeltaDays(prevStartDate, toDate);

    const parts = prevRaw.split("..");
    const startStr = parts[0];
    const endStr = parts[1] ?? parts[0];

    const newStart = shiftDatePart(startStr, deltaDays);
    const newEnd = shiftDatePart(endStr, deltaDays);

    return `${newStart}..${newEnd}`;
  }

  return formatCalDate(toDate);
}

/** Replace only the date portion of an ISO datetime string, keeping time + offset. */
function replaceDate(raw: string, toDate: CalDate): string {
  // "YYYY-MM-DDTHH:MM:SS±HH:MM" or "YYYY-MM-DDTHH:MM±HH:MM" etc.
  const tIdx = raw.indexOf("T");
  if (tIdx === -1) {
    return formatCalDate(toDate);
  }
  const timePart = raw.slice(tIdx); // e.g. "T14:00+02:00"
  return formatCalDate(toDate) + timePart;
}

/**
 * Extract the calendar-date part of a raw datetime string.
 * We read the date portion directly from the string (before the "T") rather
 * than converting via epochMs, which avoids local-timezone shifts.
 */
function parseCalDateTimePart(raw: string): CalDate | null {
  const tIdx = raw.indexOf("T");
  if (tIdx === -1) return null;
  return parseCalDate(raw.slice(0, tIdx));
}

/** Calendar-day delta from a to b (b.days - a.days, ignoring time). */
function calDateDeltaDays(a: CalDate, b: CalDate): number {
  const aMs = Date.UTC(a.year, a.month - 1, a.day);
  const bMs = Date.UTC(b.year, b.month - 1, b.day);
  return Math.round((bMs - aMs) / 86_400_000);
}

/**
 * Shift the date portion of a raw value string by `deltaDays`.
 * Preserves any time + offset suffix for datetime strings.
 */
function shiftDatePart(raw: string, deltaDays: number): string {
  if (deltaDays === 0) return raw;

  const tIdx = raw.indexOf("T");
  const datePart = tIdx === -1 ? raw : raw.slice(0, tIdx);
  const timeSuffix = tIdx === -1 ? "" : raw.slice(tIdx);

  const parsed = parseCalDate(datePart);
  if (!parsed) return raw;

  // Shift in UTC to avoid DST surprises.
  const shifted = new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day + deltaDays));
  const newDate: CalDate = {
    kind: "date",
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };

  return formatCalDate(newDate) + timeSuffix;
}
