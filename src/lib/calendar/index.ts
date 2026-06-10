// Calendar module public exports (issue #21).
export { default as CalendarView } from "./CalendarView.svelte";
export type { CalItem, CalDate, CalendarViewMode, CalendarWindowResult } from "./types.js";
export { PRIMARY_DATE_PROP, primaryDateProp } from "./types.js";
export { parseCalValue, formatCalDate, calDateFromDate } from "./date-math.js";
