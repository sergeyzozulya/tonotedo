<script lang="ts">
  // CalendarView — main calendar container orchestrating day/week/month/agenda.
  // Spec: docs/spec/0008-calendar.md, issue #21.
  //
  // Props:
  //   group        — optional group filter (from sidebar selection)
  //   onSelectEntry — callback when user clicks an item (opens docked side panel)

  import { ipc } from "../ipc/index.js";
  import type { CalendarWindowItem } from "../ipc/types.js";
  import type { CalItem, CalDate, CalendarViewMode } from "./types.js";
  import { primaryDateProp } from "./types.js";
  import {
    parseCalValue,
    calDateFromDate,
    formatCalDate,
    weekStart,
    addDays,
    addMonths,
  } from "./date-math.js";
  import DayView from "./DayView.svelte";
  import WeekView from "./WeekView.svelte";
  import MonthView from "./MonthView.svelte";
  import AgendaView from "./AgendaView.svelte";
  import { applyPanelEdit, parseFrontmatter } from "../panel/frontmatter-view.js";
  import type { ChangeSpec } from "../panel/frontmatter-view.js";

  interface Props {
    /** Currently selected sidebar group filter, or null for "all". */
    group?: string | null;
    /** Called when an entry is selected — parent should open the properties panel. */
    onSelectEntry?: (entryId: string) => void;
    /** Called when a drag-to-reschedule writes a ChangeSpec back to the document. */
    onApplyEdit?: (entryId: string, change: ChangeSpec) => void;
  }

  let { group = null, onSelectEntry, onApplyEdit }: Props = $props();

  // ── View state ────────────────────────────────────────────────────────────────

  let viewMode = $state<CalendarViewMode>("month");
  // "anchor" date — the current day/week/month being viewed.
  let anchorDate = $state<Date>(new Date());

  // ── Navigation ────────────────────────────────────────────────────────────────

  function goToday(): void {
    anchorDate = new Date();
  }

  function goPrev(): void {
    switch (viewMode) {
      case "day":
        anchorDate = addDays(anchorDate, -1);
        break;
      case "week":
        anchorDate = addDays(anchorDate, -7);
        break;
      case "month":
        anchorDate = addMonths(anchorDate, -1);
        break;
      case "agenda":
        anchorDate = addDays(anchorDate, -14);
        break;
    }
  }

  function goNext(): void {
    switch (viewMode) {
      case "day":
        anchorDate = addDays(anchorDate, 1);
        break;
      case "week":
        anchorDate = addDays(anchorDate, 7);
        break;
      case "month":
        anchorDate = addMonths(anchorDate, 1);
        break;
      case "agenda":
        anchorDate = addDays(anchorDate, 14);
        break;
    }
  }

  // Keyboard nav per spec 0008.
  function onKeyDown(e: KeyboardEvent): void {
    switch (e.key) {
      case "ArrowLeft":
        goPrev();
        e.preventDefault();
        break;
      case "ArrowRight":
        goNext();
        e.preventDefault();
        break;
      case "PageUp":
        switch (viewMode) {
          case "day":
            anchorDate = addDays(anchorDate, -7);
            break;
          default:
            goPrev();
        }
        e.preventDefault();
        break;
      case "PageDown":
        switch (viewMode) {
          case "day":
            anchorDate = addDays(anchorDate, 7);
            break;
          default:
            goNext();
        }
        e.preventDefault();
        break;
      case "t":
        goToday();
        e.preventDefault();
        break;
    }
  }

  // ── Window range derived from view + anchor ───────────────────────────────────

  const windowRange = $derived((): { from: CalDate; to: CalDate } => {
    switch (viewMode) {
      case "day": {
        const d = calDateFromDate(anchorDate);
        return { from: d, to: d };
      }
      case "week": {
        const ws = weekStart(anchorDate);
        return {
          from: calDateFromDate(ws),
          to: calDateFromDate(addDays(ws, 6)),
        };
      }
      case "month": {
        // Fetch the month + a buffer so month grid leading/trailing days also populate.
        const y = anchorDate.getFullYear();
        const m = anchorDate.getMonth() + 1;
        const firstDay = new Date(y, m - 1, 1);
        const lastDay = new Date(y, m, 0);
        return {
          from: calDateFromDate(addDays(weekStart(firstDay), 0)),
          to: calDateFromDate(addDays(lastDay, 6)),
        };
      }
      case "agenda": {
        const from = calDateFromDate(anchorDate);
        return { from, to: calDateFromDate(addDays(anchorDate, 28)) };
      }
    }
  });

  // ── Data loading ──────────────────────────────────────────────────────────────

  let items = $state<CalItem[]>([]);
  let loading = $state(false);
  let loadError = $state<string | null>(null);

  async function loadWindow(): Promise<void> {
    const { from, to } = windowRange();
    loading = true;
    loadError = null;
    const result = await ipc.calendar_window(
      formatCalDate(from),
      formatCalDate(to),
      group ?? undefined,
    );
    loading = false;
    if (result.ok) {
      items = result.value.items.map(calItemFromWire);
    } else {
      loadError = result.error.message;
      items = [];
    }
  }

  function calItemFromWire(wire: CalendarWindowItem): CalItem {
    const value = parseCalValue(wire.dateValue) ?? calDateFromDate(new Date());
    return {
      entryId: wire.entryId,
      title: wire.title,
      value,
      group: wire.group,
      groupColor: wire.groupColor,
      tags: wire.tags,
      occurrenceKey: wire.occurrenceKey,
      isOccurrence: wire.isOccurrence,
    };
  }

  // Re-load whenever range or group filter changes.
  $effect(() => {
    const { from, to } = windowRange();
    void from;
    void to;
    void group; // reactive deps
    loadWindow();
  });

  // Re-load on index_changed events (drag write-backs, external edits).
  $effect(() => {
    const unsub = ipc.on("index_changed", () => {
      loadWindow();
    });
    return unsub;
  });

  // ── Item selection ────────────────────────────────────────────────────────────

  let selectedItemId = $state<string | null>(null);

  function onSelectItem(item: CalItem): void {
    selectedItemId = item.entryId;
    onSelectEntry?.(item.entryId);
  }

  // ── Drag-to-reschedule ────────────────────────────────────────────────────────

  async function onDropItem(item: CalItem, toDate: CalDate): Promise<void> {
    // Read current entry text.
    const readResult = await ipc.read_entry(item.entryId);
    if (!readResult.ok) return;

    const { text, selfToken } = readResult.value;
    const model = parseFrontmatter(text);

    let newText = text;

    if (item.isOccurrence && item.occurrenceKey) {
      // Write an override: add/update the overrides map.
      newText = applyOccurrenceOverride(text, item.occurrenceKey, formatCalDate(toDate));
    } else {
      // Direct reschedule: update the primary date property.
      const dateProp = primaryDateProp();
      const newDateStr = formatCalDate(toDate);
      const dueRow = model.rows.find((r) => r.key === dateProp);
      let change: ChangeSpec | null = null;

      if (dueRow) {
        change = applyPanelEdit(text, model, {
          kind: "set-scalar",
          key: dateProp,
          value: newDateStr,
        });
      } else {
        change = applyPanelEdit(text, model, { kind: "add", key: dateProp, value: newDateStr });
      }

      if (change) {
        newText = text.slice(0, change.from) + change.insert + text.slice(change.to);
        onApplyEdit?.(item.entryId, change);
      }
    }

    if (newText !== text) {
      await ipc.write_entry(item.entryId, newText, selfToken);
    }
  }

  /**
   * Splice an override entry into the `overrides:` YAML map.
   * If the map doesn't exist, create it before the closing fence.
   */
  function applyOccurrenceOverride(text: string, occurrenceKey: string, newDate: string): string {
    const existingOverridesRe = /^([ \t]*overrides:\s*\n(?:[ \t]+.*\n?)*)/m;
    const match = existingOverridesRe.exec(text);

    if (match) {
      // Insert or replace the key line inside the existing overrides block.
      const block = match[0];
      const keyRe = new RegExp(`^([ \t]+)(["']?)${occurrenceKey}\\2:.*$`, "m");
      if (keyRe.test(block)) {
        // Replace existing.
        const newBlock = block.replace(keyRe, `$1"${occurrenceKey}": "${newDate}"`);
        return text.slice(0, match.index) + newBlock + text.slice(match.index + match[0].length);
      } else {
        // Append new key inside the block.
        const indent = "  ";
        const newLine = `${indent}"${occurrenceKey}": "${newDate}"\n`;
        const insertAt = match.index + match[0].length;
        return text.slice(0, insertAt) + newLine + text.slice(insertAt);
      }
    } else {
      // No overrides block — insert before closing ---.
      const fenceRe = /^---\s*$/m;
      let fenceCount = 0;
      let closingFenceIdx = -1;
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (fenceRe.test(lines[i])) {
          fenceCount++;
          if (fenceCount === 2) {
            closingFenceIdx = lines.slice(0, i).join("\n").length + (i > 0 ? 1 : 0);
            break;
          }
        }
      }
      if (closingFenceIdx === -1) return text;
      const overridesBlock = `overrides:\n  "${occurrenceKey}": "${newDate}"\n`;
      return text.slice(0, closingFenceIdx) + overridesBlock + text.slice(closingFenceIdx);
    }
  }

  // ── Title label ───────────────────────────────────────────────────────────────

  const MONTH_NAMES = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ];

  const titleLabel = $derived((): string => {
    switch (viewMode) {
      case "day": {
        const d = calDateFromDate(anchorDate);
        return `${MONTH_NAMES[d.month - 1]} ${d.day}, ${d.year}`;
      }
      case "week": {
        const ws = weekStart(anchorDate);
        const we = addDays(ws, 6);
        const wsD = calDateFromDate(ws);
        const weD = calDateFromDate(we);
        if (wsD.month === weD.month) {
          return `${MONTH_NAMES[wsD.month - 1]} ${wsD.day}–${weD.day}, ${wsD.year}`;
        }
        return `${MONTH_NAMES[wsD.month - 1]} ${wsD.day} – ${MONTH_NAMES[weD.month - 1]} ${weD.day}, ${weD.year}`;
      }
      case "month": {
        const d = anchorDate;
        return `${MONTH_NAMES[d.getMonth()]} ${d.getFullYear()}`;
      }
      case "agenda":
        return "Agenda";
    }
  });

  // Segmented view switcher options (matches design: Month/Week/Day + Agenda).
  const VIEW_OPTIONS: { key: CalendarViewMode; label: string }[] = [
    { key: "month", label: "Month" },
    { key: "week", label: "Week" },
    { key: "day", label: "Day" },
    { key: "agenda", label: "Agenda" },
  ];
</script>

<svelte:window onkeydown={onKeyDown} />

<div class="calendar-view">
  <!-- Toolbar — mirrors CalToolbar from screens-cal.jsx exactly -->
  <div class="cal-toolbar">
    <div class="cal-toolbar-left">
      <!-- Segmented control: view switcher -->
      <span class="cal-seg">
        {#each VIEW_OPTIONS as opt (opt.key)}
          <button
            class="cal-seg-btn"
            class:cal-seg-btn--active={viewMode === opt.key}
            onclick={() => {
              viewMode = opt.key;
            }}>{opt.label}</button
          >
        {/each}
      </span>

      <!-- Prev / title / Next nav -->
      <span class="cal-nav">
        <button class="cal-nav-arrow" aria-label="Previous" onclick={goPrev}>‹</button>
        <span class="cal-nav-title">{titleLabel()}</span>
        <button class="cal-nav-arrow" aria-label="Next" onclick={goNext}>›</button>
      </span>
    </div>

    <div class="cal-toolbar-right">
      <button class="cal-today-btn" onclick={goToday}>Today</button>
    </div>
  </div>

  <!-- Loading / error state -->
  {#if loading}
    <div class="cal-status">Loading…</div>
  {:else if loadError}
    <div class="cal-status cal-status--error">{loadError}</div>
  {/if}

  <!-- View area -->
  <div class="cal-body">
    {#if viewMode === "day"}
      {@const d = calDateFromDate(anchorDate)}
      <DayView date={d} {items} {selectedItemId} {onSelectItem} {onDropItem} />
    {:else if viewMode === "week"}
      <WeekView
        weekStartDate={weekStart(anchorDate)}
        {items}
        {selectedItemId}
        {onSelectItem}
        {onDropItem}
      />
    {:else if viewMode === "month"}
      <MonthView
        year={anchorDate.getFullYear()}
        month={anchorDate.getMonth() + 1}
        {items}
        {selectedItemId}
        {onSelectItem}
        {onDropItem}
      />
    {:else}
      <AgendaView {items} {selectedItemId} {onSelectItem} {onDropItem} />
    {/if}
  </div>
</div>

<style>
  .calendar-view {
    display: flex;
    flex-direction: column;
    height: 100%;
    background: var(--tnd-bg);
    overflow: hidden;
  }

  /* ── Toolbar ─────────────────────────────────────────────────────────────────
     Design: height 44px, padding 0 18px, space-between, border-bottom line.
     Left: segmented-control + nav group.  Right: Today button. */
  .cal-toolbar {
    height: 44px;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 18px;
    border-bottom: 1px solid var(--tnd-line);
    background: var(--tnd-panel);
    gap: 14px;
  }

  .cal-toolbar-left {
    display: flex;
    align-items: center;
    gap: 14px;
  }

  .cal-toolbar-right {
    display: flex;
    align-items: center;
  }

  /* ── Segmented control (view switcher) ───────────────────────────────────────
     Design: outline box using lineStrong, segments separated by lineStrong.
     Active segment: accent bg + white text.  Inactive: transparent + muted. */
  .cal-seg {
    display: inline-flex;
    border: 1px solid var(--tnd-line-strong);
  }

  .cal-seg-btn {
    padding: 4px 12px;
    font-family: var(--tnd-font-ui);
    font-size: 12px;
    font-weight: 700;
    color: var(--tnd-text-muted);
    background: transparent;
    border: none;
    border-right: 1px solid var(--tnd-line-strong);
    cursor: pointer;
    letter-spacing: var(--tnd-label-spacing);
    text-transform: var(--tnd-label-transform);
    line-height: 1;
    transition:
      background 0.08s,
      color 0.08s;
    white-space: nowrap;
  }

  .cal-seg-btn:last-child {
    border-right: none;
  }

  .cal-seg-btn--active {
    background: var(--tnd-accent);
    color: #fff;
  }

  .cal-seg-btn:not(.cal-seg-btn--active):hover {
    background: var(--tnd-panel2);
  }

  /* ── Nav group (‹ title ›) ───────────────────────────────────────────────────
     Design: arrows in muted, title in text at 13px fw700 letterSpacing 0.02em. */
  .cal-nav {
    display: flex;
    align-items: center;
    gap: 10px;
    font-family: var(--tnd-font-ui);
    color: var(--tnd-text-muted);
  }

  .cal-nav-arrow {
    background: none;
    border: none;
    cursor: pointer;
    font-size: 18px;
    line-height: 1;
    color: var(--tnd-text-muted);
    padding: 0 2px;
    font-family: inherit;
  }

  .cal-nav-arrow:hover {
    color: var(--tnd-text);
  }

  .cal-nav-title {
    font-size: 13px;
    font-weight: 700;
    color: var(--tnd-text);
    letter-spacing: 0.02em;
    white-space: nowrap;
  }

  /* ── Today button ────────────────────────────────────────────────────────────
     Design: padding 3px 10px, border lineStrong, text fw700. */
  .cal-today-btn {
    padding: 3px 10px;
    border: 1px solid var(--tnd-line-strong);
    background: transparent;
    color: var(--tnd-text);
    font-size: 12px;
    font-weight: 700;
    font-family: var(--tnd-font-ui);
    letter-spacing: var(--tnd-label-spacing);
    text-transform: var(--tnd-label-transform);
    cursor: pointer;
    border-radius: var(--tnd-radius);
    white-space: nowrap;
    transition: background 0.08s;
  }

  .cal-today-btn:hover {
    background: var(--tnd-panel2);
  }

  /* ── Status bar ──────────────────────────────────────────────────────────── */
  .cal-status {
    padding: 3px 18px;
    font-size: 11px;
    color: var(--tnd-text-faint);
    background: var(--tnd-panel);
    border-bottom: 1px solid var(--tnd-line);
    flex-shrink: 0;
    font-family: var(--tnd-font-ui);
  }

  .cal-status--error {
    color: var(--tnd-chip-red-fg);
  }

  /* ── Body ────────────────────────────────────────────────────────────────── */
  .cal-body {
    flex: 1;
    min-height: 0;
    overflow: hidden;
  }
</style>
