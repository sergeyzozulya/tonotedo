<script lang="ts">
  // DayView — single-day calendar column with timed slots + all-day band.
  // Spec: docs/spec/0008-calendar.md

  import type { CalItem } from "./types.js";
  import {
    formatCalDate,
    isPast,
    epochToLocalHour,
    epochToLocalMinute,
    datetimeToCalDate,
    calDateEquals,
  } from "./date-math.js";
  import type { CalDate } from "./types.js";

  interface Props {
    date: CalDate;
    items: CalItem[];
    selectedItemId: string | null;
    onSelectItem: (item: CalItem) => void;
    onDropItem: (item: CalItem, toDate: CalDate) => void;
  }

  let { date, items, selectedItemId, onSelectItem, onDropItem }: Props = $props();

  // Separate all-day from timed items for this date.
  const allDayItems = $derived(
    items.filter((item) => {
      const v = item.value;
      return v.kind === "date" || (v.kind === "range" && v.start.kind === "date");
    }),
  );

  const timedItems = $derived(
    items.filter((item) => {
      const v = item.value;
      if (v.kind === "datetime") {
        return calDateEquals(datetimeToCalDate(v), date);
      }
      if (v.kind === "range" && v.start.kind === "datetime") {
        return calDateEquals(
          datetimeToCalDate(v.start as { kind: "datetime"; epochMs: number }),
          date,
        );
      }
      return false;
    }),
  );

  const HOURS = Array.from({ length: 24 }, (_, i) => i);
  const HOUR_HEIGHT = 60; // px per hour

  function timedTop(item: CalItem): number {
    const v = item.value;
    if (v.kind === "datetime") {
      return epochToLocalHour(v.epochMs) * HOUR_HEIGHT + epochToLocalMinute(v.epochMs);
    }
    if (v.kind === "range" && v.start.kind === "datetime") {
      const ep = (v.start as { kind: "datetime"; epochMs: number }).epochMs;
      return epochToLocalHour(ep) * HOUR_HEIGHT + epochToLocalMinute(ep);
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
    return HOUR_HEIGHT; // 1h default
  }

  let dragOverActive = $state(false);

  function onDragStart(e: DragEvent, item: CalItem): void {
    e.dataTransfer?.setData("text/plain", item.entryId);
    if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
  }

  function onDragOver(e: DragEvent): void {
    e.preventDefault();
    dragOverActive = true;
  }

  function onDragLeave(): void {
    dragOverActive = false;
  }

  function onDrop(e: DragEvent, item?: CalItem): void {
    e.preventDefault();
    dragOverActive = false;
    const id = e.dataTransfer?.getData("text/plain");
    if (!id) return;
    const dragged = item ?? items.find((it) => it.entryId === id);
    if (dragged) onDropItem(dragged, date);
  }

  function formatHour(h: number): string {
    if (h === 0) return "12 AM";
    if (h < 12) return `${h} AM`;
    if (h === 12) return "12 PM";
    return `${h - 12} PM`;
  }
</script>

<div class="day-view">
  <!-- All-day row -->
  {#if allDayItems.length > 0}
    <div class="day-allday-row">
      <div class="day-allday-label">All day</div>
      <div class="day-allday-chips">
        {#each allDayItems as item (item.entryId + (item.occurrenceKey ?? ""))}
          <button
            class="cal-chip"
            class:cal-chip--selected={selectedItemId === item.entryId}
            class:cal-chip--past={isPast(date)}
            style={item.groupColor ? `--chip-color: ${item.groupColor}` : ""}
            onclick={() => onSelectItem(item)}
          >
            {item.title}
          </button>
        {/each}
      </div>
    </div>
  {/if}

  <!-- Timed column -->
  <div
    class="day-time-col"
    class:day-drop-target={dragOverActive}
    role="region"
    aria-label={`Day view for ${formatCalDate(date)}`}
    ondragover={onDragOver}
    ondragleave={onDragLeave}
    ondrop={(e) => onDrop(e)}
  >
    <!-- Hour labels + grid lines -->
    {#each HOURS as h (h)}
      <div class="day-hour-row" style="top: {h * HOUR_HEIGHT}px; height: {HOUR_HEIGHT}px;">
        <div class="day-hour-label">{formatHour(h)}</div>
        <div class="day-hour-line"></div>
      </div>
    {/each}

    <!-- Timed event chips -->
    {#each timedItems as item (item.entryId + (item.occurrenceKey ?? ""))}
      <button
        class="cal-chip cal-chip--timed"
        class:cal-chip--selected={selectedItemId === item.entryId}
        class:cal-chip--past={isPast(date)}
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
</div>

<style>
  .day-view {
    display: flex;
    flex-direction: column;
    height: 100%;
    overflow: hidden;
  }

  .day-allday-row {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    padding: 6px 8px;
    border-bottom: 1px solid var(--tnd-line);
    background: var(--tnd-panel);
    flex-shrink: 0;
  }

  .day-allday-label {
    font-size: 10.5px;
    color: var(--tnd-text-faint);
    padding-top: 2px;
    white-space: nowrap;
    width: 44px;
    flex-shrink: 0;
  }

  .day-allday-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }

  .day-time-col {
    position: relative;
    flex: 1;
    overflow-y: auto;
    min-height: 0;
    height: calc(24 * 60px);
  }

  .day-drop-target {
    background: var(--tnd-accent-soft);
  }

  .day-hour-row {
    position: absolute;
    left: 0;
    right: 0;
    display: flex;
    align-items: flex-start;
    pointer-events: none;
  }

  .day-hour-label {
    width: 52px;
    flex-shrink: 0;
    font-size: 10.5px;
    color: var(--tnd-text-faint);
    padding: 2px 6px 0;
    text-align: right;
  }

  .day-hour-line {
    flex: 1;
    border-top: 1px solid var(--tnd-line);
    margin-top: 8px;
  }

  /* Calendar chips */
  .cal-chip {
    display: inline-flex;
    align-items: center;
    padding: 2px 7px;
    border-radius: 3px;
    font-size: 11.5px;
    font-weight: 500;
    font-family: inherit;
    cursor: pointer;
    border: none;
    text-align: left;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 200px;
    background: var(--chip-color, var(--tnd-accent-soft));
    color: var(--tnd-text);
    transition: opacity 0.1s;
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
    opacity: 0.5;
  }

  .cal-chip--timed {
    position: absolute;
    left: 56px;
    right: 8px;
    max-width: none;
    border-radius: 4px;
    padding: 3px 7px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
</style>
