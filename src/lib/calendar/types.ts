// Calendar types — shared across all calendar sub-views.
// Spec: docs/spec/0008-calendar.md

// ── Primary date property ─────────────────────────────────────────────────────
// TODO(#23): replace hard-coded constant with library settings lookup.
export const PRIMARY_DATE_PROP = "due" as const;

// ── View modes ────────────────────────────────────────────────────────────────

export type CalendarViewMode = "day" | "week" | "month" | "agenda";

// ── Parsed date/datetime/range value ─────────────────────────────────────────

/** An all-day date: no time component. */
export interface CalDate {
  kind: "date";
  year: number;
  month: number; // 1-12
  day: number; // 1-31
}

/** A datetime with local-zone resolution. */
export interface CalDatetime {
  kind: "datetime";
  /** Millisecond epoch, resolved to local zone. */
  epochMs: number;
}

/** A range. All-day when both endpoints are CalDate; timed when both CalDatetime.
 *  Mixed (one of each) is flagged but treated as a single-point on start. */
export interface CalRange {
  kind: "range";
  start: CalDate | CalDatetime;
  end: CalDate | CalDatetime;
  mixed: boolean; // true → malformed; treated as single point
}

export type CalValue = CalDate | CalDatetime | CalRange;

// ── Calendar item ─────────────────────────────────────────────────────────────

/** A single item as it appears on the calendar grid. */
export interface CalItem {
  /** Vault-relative entry id. */
  entryId: string;
  /** Display title. */
  title: string;
  /** Resolved value that drives placement. */
  value: CalValue;
  /** Group path — drives color band. */
  group: string;
  /** Group color (hex or named), if any. */
  groupColor?: string;
  /** Tag names present on the entry. */
  tags: string[];
  /**
   * For recurring entries: the specific occurrence date (ISO YYYY-MM-DD) that
   * this item represents. Absent for non-recurring items.
   */
  occurrenceKey?: string;
  /**
   * True when the item was produced by RRULE expansion (not the source date).
   * Used so drag-reschedule writes an override rather than moving the source.
   */
  isOccurrence: boolean;
}

// ── calendar_window IPC result ────────────────────────────────────────────────

/**
 * The result of the calendar_window command (issue #21).
 * Facade: defined here; mock expansion in ipc/mock.ts; real-stub in ipc/real.ts.
 * Full fidelity comes from the Rust recurrence engine (core::recurrence, #23).
 */
export interface CalendarWindowResult {
  items: CalItem[];
}
