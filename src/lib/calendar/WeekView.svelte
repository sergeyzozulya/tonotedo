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

  const HOURS = Array.from({ length: 24 }, (_, i) => i);
  const HOUR_HEIGHT = 52;

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
  <!-- Day header row -->
  <div class="week-header">
    <div class="week-time-gutter"></div>
    {#each weekDates as d, i (i)}
      <div class="week-day-header" class:week-day-header--today={isToday(d)}>
        <span class="week-day-name">{WEEKDAY_SHORT[i]}</span>
        <span class="week-day-num" class:week-day-num--today={isToday(d)}>{d.day}</span>
      </div>
    {/each}
  </div>

  <!-- All-day row -->
  <div class="week-allday-row">
    <div class="week-time-gutter week-time-gutter--label">All day</div>
    {#each weekDates as d, i (i)}
      {@const dayItems = allDayItemsForDate(d)}
      <div
        class="week-allday-cell"
        class:week-drop-target={dropTargetDay === i}
        role="gridcell"
        tabindex="0"
        ondragover={(e) => onDragOver(e, i)}
        ondragleave={onDragLeave}
        ondrop={(e) => onDrop(e, d)}
      >
        {#each dayItems as item (item.entryId + (item.occurrenceKey ?? ""))}
          <button
            class="cal-chip"
            class:cal-chip--selected={selectedItemId === item.entryId}
            class:cal-chip--past={isPast(d)}
            style={item.groupColor ? `--chip-color: ${item.groupColor}` : ""}
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

  <!-- Timed scroll area -->
  <div class="week-time-body">
    <!-- Hour labels -->
    <div class="week-time-gutter-col">
      {#each HOURS as h (h)}
        <div class="week-hour-label" style="height: {HOUR_HEIGHT}px;">{formatHour(h)}</div>
      {/each}
    </div>

    <!-- Day columns -->
    {#each weekDates as d, i (i)}
      {@const dayTimedItems = timedItemsForDate(d)}
      <div
        class="week-day-col"
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
            class="cal-chip cal-chip--timed"
            class:cal-chip--selected={selectedItemId === item.entryId}
            class:cal-chip--past={isPast(d)}
            style="
              top: {timedTop(item)}px;
              height: {timedHeight(item)}px;
              {item.groupColor ? `--chip-color: ${item.groupColor}` : ''}
            "
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
</div>

<style>
  .week-view {
    display: flex;
    flex-direction: column;
    height: 100%;
    overflow: hidden;
  }

  .week-header {
    display: flex;
    border-bottom: 1px solid var(--tnd-line-strong);
    background: var(--tnd-panel);
    flex-shrink: 0;
  }

  .week-time-gutter {
    width: 52px;
    flex-shrink: 0;
  }

  .week-time-gutter--label {
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 10px;
    color: var(--tnd-text-faint);
  }

  .week-day-header {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 6px 0 4px;
    border-left: 1px solid var(--tnd-line);
    gap: 2px;
    min-width: 0;
  }

  .week-day-header--today {
    background: var(--tnd-accent-soft);
  }

  .week-day-name {
    font-size: 10px;
    font-weight: 600;
    color: var(--tnd-text-faint);
    letter-spacing: 0.05em;
    text-transform: uppercase;
  }

  .week-day-num {
    font-size: 16px;
    font-weight: 400;
    color: var(--tnd-text-muted);
    line-height: 1;
  }

  .week-day-num--today {
    background: var(--tnd-accent);
    color: #fff;
    border-radius: 50%;
    width: 24px;
    height: 24px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 13px;
    font-weight: 600;
  }

  .week-allday-row {
    display: flex;
    border-bottom: 1px solid var(--tnd-line);
    min-height: 28px;
    flex-shrink: 0;
    background: var(--tnd-panel);
  }

  .week-allday-cell {
    flex: 1;
    border-left: 1px solid var(--tnd-line);
    padding: 3px 3px 2px;
    display: flex;
    flex-wrap: wrap;
    gap: 2px;
    align-items: flex-start;
    min-height: 28px;
  }

  .week-time-body {
    flex: 1;
    display: flex;
    overflow-y: auto;
    min-height: 0;
  }

  .week-time-gutter-col {
    width: 52px;
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
  }

  .week-hour-label {
    display: flex;
    align-items: flex-start;
    justify-content: flex-end;
    padding: 2px 5px 0 0;
    font-size: 9.5px;
    color: var(--tnd-text-faint);
    box-sizing: border-box;
  }

  .week-day-col {
    flex: 1;
    position: relative;
    border-left: 1px solid var(--tnd-line);
    min-width: 0;
  }

  .week-hour-slot {
    border-top: 1px solid var(--tnd-line);
    box-sizing: border-box;
  }

  .week-drop-target {
    background: var(--tnd-accent-soft) !important;
  }

  /* Chips */
  .cal-chip {
    display: inline-flex;
    align-items: center;
    padding: 1px 5px;
    border-radius: 3px;
    font-size: 11px;
    font-weight: 500;
    font-family: inherit;
    cursor: pointer;
    border: none;
    text-align: left;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    width: 100%;
    max-width: 100%;
    background: var(--chip-color, var(--tnd-accent-soft));
    color: var(--tnd-text);
    line-height: 1.4;
  }

  .cal-chip:hover {
    opacity: 0.82;
  }

  .cal-chip--selected {
    outline: 2px solid var(--tnd-accent);
    outline-offset: 1px;
  }

  .cal-chip--past {
    opacity: 0.48;
  }

  .cal-chip--timed {
    position: absolute;
    left: 2px;
    right: 2px;
    width: auto;
    max-width: none;
    border-radius: 4px;
    padding: 2px 5px;
    font-size: 10.5px;
  }
</style>
