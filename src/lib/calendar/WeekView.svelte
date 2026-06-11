<script lang="ts">
  // WeekView — 7-column week grid with all-day bands + timed slots.
  // Spec: docs/spec/0008-calendar.md

  import type { CalItem, CalDate } from "./types.js";
  import {
    addDays,
    calDateFromDate,
    calDateEquals,
    isToday,
    isPast,
    WEEKDAY_SHORT,
    calDateToEpoch,
    datetimeToCalDate,
    epochToLocalHour,
    epochToLocalMinute,
  } from "./date-math.js";

  interface Props {
    weekStartDate: Date; // Monday of the displayed week
    items: CalItem[];
    selectedItemId: string | null;
    onSelectItem: (item: CalItem) => void;
    onDropItem: (item: CalItem, toDate: CalDate) => void;
  }

  let { weekStartDate, items, selectedItemId, onSelectItem, onDropItem }: Props = $props();

  // The 7 dates of this week (Mon → Sun).
  const weekDates = $derived(
    Array.from({ length: 7 }, (_, i) => calDateFromDate(addDays(weekStartDate, i))),
  );

  // Items per day for all-day rendering.
  function allDayItemsForDate(date: CalDate): CalItem[] {
    return items.filter((item) => {
      const v = item.value;
      if (v.kind === "date") return calDateEquals(v, date);
      if (v.kind === "range" && !v.mixed) {
        const startE = calDateToEpoch(
          v.start.kind === "date"
            ? v.start
            : datetimeToCalDate(v.start as { kind: "datetime"; epochMs: number }),
        );
        const endE = calDateToEpoch(
          v.end.kind === "date"
            ? v.end
            : datetimeToCalDate(v.end as { kind: "datetime"; epochMs: number }),
        );
        const dateE = calDateToEpoch(date);
        return dateE >= startE && dateE <= endE;
      }
      return false;
    });
  }

  // Timed items for a given date.
  function timedItemsForDate(date: CalDate): CalItem[] {
    return items.filter((item) => {
      const v = item.value;
      if (v.kind === "datetime") return calDateEquals(datetimeToCalDate(v), date);
      if (v.kind === "range" && v.start.kind === "datetime") {
        return calDateEquals(
          datetimeToCalDate(v.start as { kind: "datetime"; epochMs: number }),
          date,
        );
      }
      return false;
    });
  }

  // HOUR_HEIGHT: design uses HOUR_PX * 0.62 for week view = 58 * 0.62 ≈ 36px.
  const HOURS = Array.from({ length: 24 }, (_, i) => i);
  const HOUR_HEIGHT = 36; // px per hour (design: HOUR_PX=58 × 0.62)

  function timedTop(item: CalItem): number {
    const v = item.value;
    if (v.kind === "datetime") {
      return (
        epochToLocalHour(v.epochMs) * HOUR_HEIGHT +
        (epochToLocalMinute(v.epochMs) / 60) * HOUR_HEIGHT
      );
    }
    if (v.kind === "range" && v.start.kind === "datetime") {
      const ep = (v.start as { kind: "datetime"; epochMs: number }).epochMs;
      return epochToLocalHour(ep) * HOUR_HEIGHT + (epochToLocalMinute(ep) / 60) * HOUR_HEIGHT;
    }
    return 0;
  }

  function timedHeight(item: CalItem): number {
    const v = item.value;
    if (v.kind === "range" && v.start.kind === "datetime" && v.end.kind === "datetime") {
      const dur = Math.max(
        ((v.end as { epochMs: number }).epochMs - (v.start as { epochMs: number }).epochMs) / 60000,
        30,
      );
      return (dur / 60) * HOUR_HEIGHT;
    }
    return HOUR_HEIGHT;
  }

  let dropTargetDay = $state<number | null>(null); // index 0-6

  function onDragStart(e: DragEvent, item: CalItem): void {
    e.dataTransfer?.setData("text/plain", item.entryId + "|" + (item.occurrenceKey ?? ""));
    if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
  }

  function onDragOver(e: DragEvent, dayIdx: number): void {
    e.preventDefault();
    dropTargetDay = dayIdx;
  }

  function onDragLeave(): void {
    dropTargetDay = null;
  }

  function onDrop(e: DragEvent, date: CalDate): void {
    e.preventDefault();
    dropTargetDay = null;
    const raw = e.dataTransfer?.getData("text/plain") ?? "";
    const [id] = raw.split("|");
    const dragged = items.find((it) => it.entryId === id);
    if (dragged) onDropItem(dragged, date);
  }

  function formatHour(h: number): string {
    if (h === 0) return "12a";
    if (h < 12) return `${h}a`;
    if (h === 12) return "12p";
    return `${h - 12}p`;
  }
</script>

<div class="week-view">
  <!-- Day header: 46px gutter + 7 col grid
       Design: day abbrev 10px fw700 letterSpacing 0.06em faint uppercase,
       day number 17px fw700 text (today: accentText), today col accentSoft bg. -->
  <div class="week-header">
    <div class="week-gutter"></div>
    {#each weekDates as d, i (i)}
      <div
        class="week-day-header"
        class:week-day-header--today={isToday(d)}
        class:week-day-header--last={i === 6}
      >
        <span class="week-day-name">{WEEKDAY_SHORT[i]}</span>
        <span class="week-day-num" class:week-day-num--today={isToday(d)}>{d.day}</span>
      </div>
    {/each}
  </div>

  <!-- All-day row: "all-day" label gutter (9px faint), per-day event bars -->
  <div class="week-allday-row">
    <div class="week-gutter week-gutter--label">all-day</div>
    {#each weekDates as d, i (i)}
      {@const dayItems = allDayItemsForDate(d)}
      <div
        class="week-allday-cell"
        class:week-allday-cell--last={i === 6}
        class:week-drop-target={dropTargetDay === i}
        role="gridcell"
        tabindex="0"
        ondragover={(e) => onDragOver(e, i)}
        ondragleave={onDragLeave}
        ondrop={(e) => onDrop(e, d)}
      >
        {#each dayItems as item (item.entryId + (item.occurrenceKey ?? ""))}
          <button
            class="cal-bar"
            class:cal-bar--selected={selectedItemId === item.entryId}
            class:cal-bar--past={isPast(d)}
            style={item.groupColor ? `--bar-color: ${item.groupColor}` : ""}
            draggable="true"
            ondragstart={(e) => onDragStart(e, item)}
            onclick={() => onSelectItem(item)}
          >
            {item.title}
          </button>
        {/each}
      </div>
    {/each}
  </div>

  <!-- Timed scroll area: gutter col + 7 day cols with hour-slot lines -->
  <div class="week-time-body">
    <!-- Hour gutter: 46px, right-aligned labels 9.5px faint -->
    <div class="week-gutter-col">
      {#each HOURS as h (h)}
        <div class="week-hour-label" style="height: {HOUR_HEIGHT}px;">{formatHour(h)}</div>
      {/each}
    </div>

    <!-- Day columns -->
    {#each weekDates as d, i (i)}
      {@const dayTimedItems = timedItemsForDate(d)}
      <div
        class="week-day-col"
        class:week-day-col--today={isToday(d)}
        class:week-day-col--last={i === 6}
        class:week-drop-target={dropTargetDay === i}
        role="gridcell"
        tabindex="0"
        ondragover={(e) => onDragOver(e, i)}
        ondragleave={onDragLeave}
        ondrop={(e) => onDrop(e, d)}
      >
        {#each HOURS as h (h)}
          <div class="week-hour-slot" style="height: {HOUR_HEIGHT}px;"></div>
        {/each}
        {#each dayTimedItems as item (item.entryId + (item.occurrenceKey ?? ""))}
          <button
            class="cal-block"
            class:cal-block--selected={selectedItemId === item.entryId}
            class:cal-block--past={isPast(d)}
            style="top: {timedTop(item) + 1}px; height: {Math.max(
              timedHeight(item) - 2,
              14,
            )}px;{item.groupColor ? ` --bar-color: ${item.groupColor}` : ''}"
            draggable="true"
            ondragstart={(e) => onDragStart(e, item)}
            onclick={() => onSelectItem(item)}
          >
            <span class="cal-block-title">{item.title}</span>
          </button>
        {/each}
      </div>
    {/each}
  </div>
</div>

<style>
  .week-view {
    display: flex;
    flex-direction: column;
    height: 100%;
    overflow: hidden;
  }

  /* ── Day header: 46px gutter + 7 cols ────────────────────────────────────── */
  .week-header {
    display: grid;
    grid-template-columns: 46px repeat(7, 1fr);
    border-bottom: 1px solid var(--tnd-line-strong);
    background: var(--tnd-panel);
    flex-shrink: 0;
  }

  /* Shared 46px gutter (time column) */
  .week-gutter {
    width: 46px;
    flex-shrink: 0;
    border-right: 1px solid var(--tnd-line);
  }

  .week-gutter--label {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    padding-right: 4px;
    font-size: 9px;
    color: var(--tnd-text-faint);
    font-family: var(--tnd-font-ui);
  }

  .week-day-header {
    padding: 6px 8px;
    border-right: 1px solid var(--tnd-line);
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .week-day-header--today {
    background: var(--tnd-accent-soft);
  }

  .week-day-header--last {
    border-right: none;
  }

  /* Design: day abbrev 10px fw700 letterSpacing 0.06em uppercase faint */
  .week-day-name {
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--tnd-text-faint);
    font-family: var(--tnd-font-ui);
  }

  /* Design: day number 17px fw700; today: accentText color */
  .week-day-num {
    font-size: 17px;
    font-weight: 700;
    color: var(--tnd-text-muted);
    line-height: 1;
    font-family: var(--tnd-font-ui);
  }

  .week-day-num--today {
    color: var(--tnd-accent-text);
  }

  /* ── All-day row ─────────────────────────────────────────────────────────── */
  .week-allday-row {
    display: grid;
    grid-template-columns: 46px repeat(7, 1fr);
    border-bottom: 1px solid var(--tnd-line);
    min-height: 22px;
    flex-shrink: 0;
    background: var(--tnd-panel);
  }

  .week-allday-cell {
    border-right: 1px solid var(--tnd-line);
    padding: 2px 3px;
    display: flex;
    flex-wrap: wrap;
    gap: 2px;
    align-items: flex-start;
    min-height: 22px;
  }

  .week-allday-cell--last {
    border-right: none;
  }

  /* ── Timed body: grid for scrollable area ────────────────────────────────── */
  .week-time-body {
    flex: 1;
    display: grid;
    grid-template-columns: 46px repeat(7, 1fr);
    overflow-y: auto;
    min-height: 0;
  }

  .week-gutter-col {
    display: flex;
    flex-direction: column;
    border-right: 1px solid var(--tnd-line);
  }

  /* Design: hour labels 9.5px faint, right-aligned, padding 2px 4px */
  .week-hour-label {
    display: flex;
    align-items: flex-start;
    justify-content: flex-end;
    padding: 2px 4px 0;
    font-size: 9.5px;
    color: var(--tnd-text-faint);
    box-sizing: border-box;
    font-family: var(--tnd-font-ui);
  }

  .week-day-col {
    position: relative;
    border-right: 1px solid var(--tnd-line);
    min-width: 0;
  }

  .week-day-col--today {
    background: var(--tnd-accent-soft);
    opacity: 0.96;
  }

  .week-day-col--last {
    border-right: none;
  }

  .week-hour-slot {
    border-top: 1px solid var(--tnd-line);
    box-sizing: border-box;
  }

  .week-drop-target {
    background: var(--tnd-accent-soft) !important;
  }

  /* ── All-day event bar (same pattern as month bars) ──────────────────────── */
  .cal-bar {
    display: flex;
    align-items: center;
    height: 17px;
    padding: 0 4px;
    border-left: 2px solid var(--bar-color, var(--tnd-accent-text));
    background: var(--tnd-panel2);
    font-family: var(--tnd-font-ui);
    font-size: 10.5px;
    font-weight: 700;
    color: var(--tnd-text);
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    width: 100%;
    text-align: left;
    border-top: none;
    border-right: none;
    border-bottom: none;
    cursor: pointer;
    border-radius: 0;
    transition: opacity 0.1s;
  }

  .cal-bar:hover {
    opacity: 0.8;
  }

  .cal-bar--selected {
    outline: 1px solid var(--tnd-accent);
  }

  .cal-bar--past {
    opacity: 0.45;
  }

  /* ── Timed event block ───────────────────────────────────────────────────────
     Design: position absolute, left 2px right 2px, panel2 bg, borderLeft 2px
     group-color, padding 1px 4px, title 9.5px fw700 text. */
  .cal-block {
    position: absolute;
    left: 2px;
    right: 2px;
    background: var(--tnd-panel2);
    border-left: 2px solid var(--bar-color, var(--tnd-accent-text));
    border-top: none;
    border-right: none;
    border-bottom: none;
    padding: 1px 4px;
    overflow: hidden;
    font-family: var(--tnd-font-ui);
    cursor: pointer;
    text-align: left;
    border-radius: 0;
    transition: opacity 0.1s;
  }

  .cal-block:hover {
    opacity: 0.82;
  }

  .cal-block--selected {
    outline: 1px solid var(--tnd-accent);
  }

  .cal-block--past {
    opacity: 0.45;
  }

  .cal-block-title {
    display: block;
    font-size: 9.5px;
    font-weight: 700;
    color: var(--tnd-text);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
</style>
