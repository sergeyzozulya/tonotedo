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

  // HOUR_HEIGHT: design uses HOUR_PX = 58px for the day view.
  const HOURS = Array.from({ length: 24 }, (_, i) => i);
  const HOUR_HEIGHT = 58; // px per hour (design: HOUR_PX = 58)

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
  <!-- All-day row: 56px label gutter + inline event bars -->
  <div class="day-allday-row">
    <span class="day-allday-label">all-day</span>
    <div class="day-allday-chips">
      {#each allDayItems as item (item.entryId + (item.occurrenceKey ?? ""))}
        <button
          class="cal-bar"
          class:cal-bar--selected={selectedItemId === item.entryId}
          class:cal-bar--past={isPast(date)}
          style={item.groupColor ? `--bar-color: ${item.groupColor}` : ""}
          onclick={() => onSelectItem(item)}
        >
          {item.title}
        </button>
      {/each}
    </div>
  </div>

  <!-- Timed column: scrollable, hour grid + positioned event blocks -->
  <div
    class="day-time-col"
    class:day-drop-target={dragOverActive}
    role="region"
    aria-label={`Day view for ${formatCalDate(date)}`}
    ondragover={onDragOver}
    ondragleave={onDragLeave}
    ondrop={(e) => onDrop(e)}
  >
    <!-- Hour rows: label (56px) + borderTop grid line -->
    {#each HOURS as h (h)}
      <div class="day-hour-row" style="top: {h * HOUR_HEIGHT}px; height: {HOUR_HEIGHT}px;">
        <div class="day-hour-label">{formatHour(h)}</div>
        <div class="day-hour-line"></div>
      </div>
    {/each}

    <!-- Timed event blocks: left 62px, right 18px per design -->
    {#each timedItems as item (item.entryId + (item.occurrenceKey ?? ""))}
      <button
        class="cal-block"
        class:cal-block--selected={selectedItemId === item.entryId}
        class:cal-block--past={isPast(date)}
        style="top: {timedTop(item) + 1}px; height: {Math.max(
          timedHeight(item) - 3,
          18,
        )}px;{item.groupColor ? ` --bar-color: ${item.groupColor}` : ''}"
        draggable="true"
        ondragstart={(e) => onDragStart(e, item)}
        onclick={() => onSelectItem(item)}
      >
        <span class="cal-block-title">{item.title}</span>
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

  /* ── All-day row ─────────────────────────────────────────────────────────────
     Design: flex row, minHeight 26, borderBottom line, alignItems center.
     Label 56px, 9.5px faint, right-aligned. */
  .day-allday-row {
    display: flex;
    align-items: center;
    border-bottom: 1px solid var(--tnd-line);
    min-height: 26px;
    flex-shrink: 0;
    background: var(--tnd-panel);
  }

  .day-allday-label {
    width: 56px;
    flex-shrink: 0;
    font-size: 9.5px;
    color: var(--tnd-text-faint);
    padding: 0 6px;
    text-align: right;
    font-family: var(--tnd-font-ui);
  }

  .day-allday-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 3px;
    padding: 3px 0;
  }

  /* ── Timed scroll area ────────────────────────────────────────────────────── */
  .day-time-col {
    position: relative;
    flex: 1;
    overflow-y: auto;
    min-height: 0;
    height: calc(24 * 58px);
  }

  .day-drop-target {
    background: var(--tnd-accent-soft);
  }

  /* Hour rows: absolute, full width, flex for label + line */
  .day-hour-row {
    position: absolute;
    left: 0;
    right: 0;
    display: flex;
    align-items: flex-start;
    pointer-events: none;
  }

  /* Design: label 56px, 10px faint, right-aligned, padding 2px 6px */
  .day-hour-label {
    width: 56px;
    flex-shrink: 0;
    font-size: 10px;
    color: var(--tnd-text-faint);
    padding: 2px 6px 0;
    text-align: right;
    box-sizing: border-box;
    font-family: var(--tnd-font-ui);
  }

  .day-hour-line {
    flex: 1;
    border-top: 1px solid var(--tnd-line);
    margin-top: 8px;
  }

  /* ── Timed event block ────────────────────────────────────────────────────────
     Design: position absolute, left 62px right 18px, panel2 bg, borderLeft 3px
     group-color, padding 3px 10px, title 12px fw700. */
  .cal-block {
    position: absolute;
    left: 62px;
    right: 18px;
    background: var(--tnd-panel2);
    border-left: 3px solid var(--bar-color, var(--tnd-accent-text));
    border-top: none;
    border-right: none;
    border-bottom: none;
    padding: 3px 10px;
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
    outline: 2px solid var(--tnd-accent);
    outline-offset: 1px;
  }

  .cal-block--past {
    opacity: 0.5;
  }

  .cal-block-title {
    display: block;
    font-size: 12px;
    font-weight: 700;
    color: var(--tnd-text);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  /* ── All-day bar ──────────────────────────────────────────────────────────── */
  .cal-bar {
    display: inline-flex;
    align-items: center;
    height: 17px;
    padding: 0 8px;
    margin: 1px 0;
    border-left: 2px solid var(--bar-color, var(--tnd-accent-text));
    background: var(--tnd-panel2);
    font-family: var(--tnd-font-ui);
    font-size: 11px;
    font-weight: 700;
    color: var(--tnd-text);
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
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
    opacity: 0.5;
  }
</style>
