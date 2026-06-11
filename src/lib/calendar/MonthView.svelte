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
  <!-- Weekday headers: MON TUE … SUN, right-aligned, faint, 10px uppercase -->
  <div class="month-header-row">
    {#each WEEKDAY_SHORT as day, i (day)}
      <div class="month-header-cell" class:month-header-cell--last={i === 6}>{day}</div>
    {/each}
  </div>

  <!-- Grid: flat 7-col CSS grid, auto-rows fill height -->
  <div class="month-grid">
    {#each grid as row, ri (ri)}
      {#each row as d, ci (ci)}
        {@const dayItems = itemsForDay(d)}
        {@const [visible, overflow] = overflowSplit(dayItems, MAX_VISIBLE)}
        {@const isActive = isCurrentMonth(d)}
        {@const today = isToday(d)}
        <div
          class="month-cell"
          class:month-cell--today={today}
          class:month-cell--other-month={!isActive}
          class:month-cell--drop={dropTarget === dayKey(d)}
          class:month-cell--last-col={ci === 6}
          role="gridcell"
          tabindex="0"
          aria-label={`${d.year}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}`}
          ondragover={(e) => onDragOver(e, d)}
          ondragleave={onDragLeave}
          ondrop={(e) => onDrop(e, d)}
        >
          <!-- Date number: top-right, badge style when today -->
          <div class="month-cell-date-row">
            <span class="month-cell-num" class:month-cell-num--today={today}>{d.day}</span>
          </div>

          <!-- Event bars -->
          <div class="month-cell-items">
            {#each visible as item (item.entryId + (item.occurrenceKey ?? ""))}
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
            {#if overflow > 0}
              <span class="month-overflow">+{overflow} more</span>
            {/if}
          </div>
        </div>
      {/each}
    {/each}
  </div>
</div>

<style>
  .month-view {
    display: flex;
    flex-direction: column;
    height: 100%;
    overflow: hidden;
  }

  /* ── Weekday header row ───────────────────────────────────────────────────────
     Design: 7-col grid, 10px uppercase fw700 letterSpacing 0.08em, faint,
     right-aligned per cell, borderBottom lineStrong. */
  .month-header-row {
    display: grid;
    grid-template-columns: repeat(7, 1fr);
    border-bottom: 1px solid var(--tnd-line-strong);
    background: var(--tnd-panel);
    flex-shrink: 0;
  }

  .month-header-cell {
    padding: 6px 8px;
    text-align: right;
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--tnd-text-faint);
    border-right: 1px solid var(--tnd-line);
    font-family: var(--tnd-font-ui);
  }

  .month-header-cell--last {
    border-right: none;
  }

  /* ── Grid: flex:1, 7-col × auto-rows filling height ──────────────────────── */
  .month-grid {
    flex: 1;
    display: grid;
    grid-template-columns: repeat(7, 1fr);
    grid-auto-rows: 1fr;
    min-height: 0;
    overflow: hidden;
  }

  /* ── Day cell ────────────────────────────────────────────────────────────────
     Design: padding 5px, gap 2px, borderRight line, borderBottom line.
     Today cell: accentSoft bg.  Other-month: faint/muted opacity. */
  .month-cell {
    border-right: 1px solid var(--tnd-line);
    border-bottom: 1px solid var(--tnd-line);
    padding: 5px;
    display: flex;
    flex-direction: column;
    gap: 2px;
    overflow: hidden;
    transition: background 0.08s;
  }

  .month-cell--last-col {
    border-right: none;
  }

  .month-cell--today {
    background: var(--tnd-accent-soft);
  }

  .month-cell--other-month {
    opacity: 0.4;
  }

  .month-cell--drop {
    background: var(--tnd-accent-soft) !important;
    outline: 1px solid var(--tnd-accent);
    outline-offset: -1px;
  }

  /* ── Date number: top-right ──────────────────────────────────────────────────
     Design: right-justified row; number 11.5px fw500 muted; today: accent
     background, 18×18 badge, white text fw700. */
  .month-cell-date-row {
    display: flex;
    justify-content: flex-end;
  }

  .month-cell-num {
    font-size: 11.5px;
    font-weight: 500;
    color: var(--tnd-text-muted);
    line-height: 1;
    min-width: 18px;
    height: 18px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0 2px;
    font-family: var(--tnd-font-ui);
  }

  /* Today badge: accent bg, white text, radius from --tnd-radius token.
     Mono/Editorial → 0px (square).  Soft/Fog → rounded. */
  .month-cell-num--today {
    background: var(--tnd-accent);
    color: #fff;
    font-weight: 700;
    border-radius: var(--tnd-radius);
  }

  /* ── Event bars ───────────────────────────────────────────────────────────────
     Design: height 15px (compact), padding 0 4px, borderLeft 2px group-color,
     bg panel2, font ui 10.5px, text overflow ellipsis.  No border-radius. */
  .month-cell-items {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-height: 0;
    overflow: hidden;
  }

  .cal-bar {
    display: flex;
    align-items: center;
    height: 15px;
    padding: 0 4px;
    border-left: 2px solid var(--bar-color, var(--tnd-accent-text));
    background: var(--tnd-panel2);
    font-family: var(--tnd-font-ui);
    font-size: 10.5px;
    font-weight: 500;
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
    outline-offset: 0;
  }

  .cal-bar--past {
    opacity: 0.45;
  }

  /* ── +N more overflow ────────────────────────────────────────────────────────
     Design: 10px faint. */
  .month-overflow {
    font-size: 10px;
    color: var(--tnd-text-faint);
    padding: 0 4px;
    cursor: default;
    font-family: var(--tnd-font-ui);
    white-space: nowrap;
  }
</style>
