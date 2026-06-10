<script lang="ts">
  // MonthView — month grid with multi-day bands, all-day chips, +M overflow.
  // Spec: docs/spec/0008-calendar.md

  import type { CalItem, CalDate } from "./types.js";
  import {
    monthGrid,
    calDateEquals,
    isToday,
    isPast,
    calDateToEpoch,
    WEEKDAY_SHORT,
    datetimeToCalDate,
    overflowSplit,
  } from "./date-math.js";

  const MAX_VISIBLE = 3;

  interface Props {
    year: number;
    month: number; // 1-12
    items: CalItem[];
    selectedItemId: string | null;
    onSelectItem: (item: CalItem) => void;
    onDropItem: (item: CalItem, toDate: CalDate) => void;
  }

  let { year, month, items, selectedItemId, onSelectItem, onDropItem }: Props = $props();

  const grid = $derived(monthGrid(year, month));

  function itemsForDay(date: CalDate): CalItem[] {
    const dateE = calDateToEpoch(date);
    return items.filter((item) => {
      const v = item.value;
      if (v.kind === "date") return calDateEquals(v, date);
      if (v.kind === "datetime") return calDateEquals(datetimeToCalDate(v), date);
      if (v.kind === "range") {
        const startD =
          v.start.kind === "date"
            ? v.start
            : datetimeToCalDate(v.start as { kind: "datetime"; epochMs: number });
        const endD =
          v.end.kind === "date"
            ? v.end
            : datetimeToCalDate(v.end as { kind: "datetime"; epochMs: number });
        return dateE >= calDateToEpoch(startD) && dateE <= calDateToEpoch(endD);
      }
      return false;
    });
  }

  let dropTarget = $state<string | null>(null); // "year-month-day" key

  function dayKey(d: CalDate): string {
    return `${d.year}-${d.month}-${d.day}`;
  }

  function onDragStart(e: DragEvent, item: CalItem): void {
    e.dataTransfer?.setData("text/plain", item.entryId);
    if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
  }

  function onDragOver(e: DragEvent, d: CalDate): void {
    e.preventDefault();
    dropTarget = dayKey(d);
  }

  function onDragLeave(): void {
    dropTarget = null;
  }

  function onDrop(e: DragEvent, d: CalDate): void {
    e.preventDefault();
    dropTarget = null;
    const id = e.dataTransfer?.getData("text/plain");
    if (!id) return;
    const dragged = items.find((it) => it.entryId === id);
    if (dragged) onDropItem(dragged, d);
  }

  function isCurrentMonth(d: CalDate): boolean {
    return d.month === month;
  }
</script>

<div class="month-view">
  <!-- Weekday headers -->
  <div class="month-header-row">
    {#each WEEKDAY_SHORT as day (day)}
      <div class="month-header-cell">{day}</div>
    {/each}
  </div>

  <!-- Grid rows -->
  {#each grid as row, ri (ri)}
    <div class="month-row">
      {#each row as d, ci (ci)}
        {@const dayItems = itemsForDay(d)}
        {@const [visible, overflow] = overflowSplit(dayItems, MAX_VISIBLE)}
        {@const isActive = isCurrentMonth(d)}
        <div
          class="month-cell"
          class:month-cell--today={isToday(d)}
          class:month-cell--other-month={!isActive}
          class:month-cell--drop={dropTarget === dayKey(d)}
          role="gridcell"
          tabindex="0"
          aria-label={`${d.year}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}`}
          ondragover={(e) => onDragOver(e, d)}
          ondragleave={onDragLeave}
          ondrop={(e) => onDrop(e, d)}
        >
          <span class="month-cell-num" class:month-cell-num--today={isToday(d)}>{d.day}</span>

          <div class="month-cell-items">
            {#each visible as item (item.entryId + (item.occurrenceKey ?? ""))}
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
            {#if overflow > 0}
              <span class="month-overflow">+{overflow} more</span>
            {/if}
          </div>
        </div>
      {/each}
    </div>
  {/each}
</div>

<style>
  .month-view {
    display: flex;
    flex-direction: column;
    height: 100%;
    overflow: hidden;
  }

  .month-header-row {
    display: grid;
    grid-template-columns: repeat(7, 1fr);
    border-bottom: 1px solid var(--tnd-line-strong);
    background: var(--tnd-panel);
    flex-shrink: 0;
  }

  .month-header-cell {
    padding: 6px 0;
    text-align: center;
    font-size: 10.5px;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--tnd-text-faint);
  }

  .month-row {
    display: grid;
    grid-template-columns: repeat(7, 1fr);
    flex: 1;
    min-height: 0;
  }

  .month-cell {
    border-right: 1px solid var(--tnd-line);
    border-bottom: 1px solid var(--tnd-line);
    padding: 4px 5px;
    min-height: 72px;
    display: flex;
    flex-direction: column;
    gap: 2px;
    overflow: hidden;
    transition: background 0.08s;
  }

  .month-cell:last-child {
    border-right: none;
  }

  .month-cell--today {
    background: var(--tnd-sel);
  }

  .month-cell--other-month {
    opacity: 0.45;
  }

  .month-cell--drop {
    background: var(--tnd-accent-soft) !important;
  }

  .month-cell-num {
    font-size: 11.5px;
    font-weight: 500;
    color: var(--tnd-text-muted);
    line-height: 1;
    margin-bottom: 2px;
    align-self: flex-start;
  }

  .month-cell-num--today {
    background: var(--tnd-accent);
    color: #fff;
    border-radius: 50%;
    width: 20px;
    height: 20px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 11px;
    font-weight: 700;
  }

  .month-cell-items {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-height: 0;
    overflow: hidden;
  }

  .month-overflow {
    font-size: 10px;
    color: var(--tnd-text-faint);
    padding: 0 2px;
    cursor: default;
  }

  /* Chips */
  .cal-chip {
    display: flex;
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
    background: var(--chip-color, var(--tnd-accent-soft));
    color: var(--tnd-text);
    line-height: 1.5;
    transition: opacity 0.1s;
  }

  .cal-chip:hover {
    opacity: 0.8;
  }

  .cal-chip--selected {
    outline: 2px solid var(--tnd-accent);
    outline-offset: 1px;
  }

  .cal-chip--past {
    opacity: 0.48;
  }
</style>
