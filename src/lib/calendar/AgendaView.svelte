<script lang="ts">
  // AgendaView — flat chronological list of upcoming items, grouped by date.
  // Spec: docs/spec/0008-calendar.md

  import type { CalItem, CalDate } from "./types.js";
  import {
    calValueStartDate,
    calDateToEpoch,
    formatCalDate,
    isToday,
    isPast,
    calDateFromDate,
  } from "./date-math.js";

  interface Props {
    items: CalItem[];
    selectedItemId: string | null;
    onSelectItem: (item: CalItem) => void;
    onDropItem: (item: CalItem, toDate: CalDate) => void;
  }

  let { items, selectedItemId, onSelectItem }: Props = $props();

  // Sort items by their start date ascending.
  const sorted = $derived(
    [...items].sort((a, b) => {
      const ae = calDateToEpoch(calValueStartDate(a.value));
      const be = calDateToEpoch(calValueStartDate(b.value));
      return ae - be;
    }),
  );

  // Group items by date label.
  interface DateGroup {
    label: string;
    date: CalDate;
    items: CalItem[];
  }

  const groups = $derived((): DateGroup[] => {
    const result: DateGroup[] = [];
    const seen: Record<string, number> = {};
    for (const item of sorted) {
      const d = calValueStartDate(item.value);
      const key = formatCalDate(d);
      if (seen[key] === undefined) {
        seen[key] = result.length;
        result.push({ label: formatAgendaDate(d), date: d, items: [] });
      }
      result[seen[key]].items.push(item);
    }
    return result;
  });

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

  const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  function formatAgendaDate(d: CalDate): string {
    const jsDate = new Date(d.year, d.month - 1, d.day);
    const dow = DAY_NAMES[jsDate.getDay()];
    const mon = MONTH_NAMES[d.month - 1];
    if (isToday(d)) return `Today — ${dow}, ${mon} ${d.day}`;
    return `${dow}, ${mon} ${d.day}, ${d.year}`;
  }

  function formatTime(item: CalItem): string {
    const v = item.value;
    if (v.kind === "datetime") {
      const d = new Date(v.epochMs);
      const h = d.getHours();
      const m = d.getMinutes();
      const ampm = h < 12 ? "AM" : "PM";
      const hour = h % 12 || 12;
      const min = String(m).padStart(2, "0");
      return `${hour}:${min} ${ampm}`;
    }
    if (v.kind === "range") {
      const sd = calValueStartDate(v);
      // Just show start..end date span.
      const end =
        v.end.kind === "date"
          ? v.end
          : calDateFromDate(new Date((v.end as { epochMs: number }).epochMs));
      if (formatCalDate(sd) !== formatCalDate(end)) {
        return `${MONTH_NAMES[sd.month - 1].slice(0, 3)} ${sd.day} – ${MONTH_NAMES[end.month - 1].slice(0, 3)} ${end.day}`;
      }
    }
    return "All day";
  }
</script>

<div class="agenda-view">
  {#if groups().length === 0}
    <div class="agenda-empty">No entries in this range.</div>
  {:else}
    {#each groups() as group (group.label)}
      <div class="agenda-date-group">
        <!-- Date heading: uppercase fw700, today accentText, past muted -->
        <div
          class="agenda-date-label"
          class:agenda-date-label--today={isToday(group.date)}
          class:agenda-date-label--past={isPast(group.date)}
        >
          {group.label}
        </div>

        <!-- Items list -->
        <div class="agenda-items">
          {#each group.items as item (item.entryId + (item.occurrenceKey ?? ""))}
            <button
              class="agenda-item"
              class:agenda-item--selected={selectedItemId === item.entryId}
              class:agenda-item--past={isPast(group.date)}
              style={item.groupColor ? `--bar-color: ${item.groupColor}` : ""}
              onclick={() => onSelectItem(item)}
            >
              <!-- Time: 72px tabular, faint -->
              <span class="agenda-item-time">{formatTime(item)}</span>

              <!-- Title: flex 1, fw500 -->
              <span class="agenda-item-title">{item.title}</span>

              <!-- Tags -->
              {#if item.tags.length > 0}
                <span class="agenda-item-tags">
                  {#each item.tags.slice(0, 3) as tag (tag)}
                    <span class="agenda-tag">#{tag}</span>
                  {/each}
                </span>
              {/if}
            </button>
          {/each}
        </div>
      </div>
    {/each}
  {/if}
</div>

<style>
  .agenda-view {
    height: 100%;
    overflow-y: auto;
    padding: 8px 0;
    background: var(--tnd-bg);
  }

  .agenda-empty {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 120px;
    color: var(--tnd-text-faint);
    font-size: 13px;
    font-family: var(--tnd-font-ui);
  }

  /* ── Date group ──────────────────────────────────────────────────────────── */
  .agenda-date-group {
    margin-bottom: 4px;
  }

  /* Design: 11px fw700 letterSpacing 0.06em uppercase muted, padding 10px 18px 4px,
     borderBottom line.  Today → accentText.  Past → opacity 0.6. */
  .agenda-date-label {
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--tnd-text-muted);
    padding: 10px 18px 4px;
    border-bottom: 1px solid var(--tnd-line);
    font-family: var(--tnd-font-ui);
  }

  .agenda-date-label--today {
    color: var(--tnd-accent-text);
  }

  .agenda-date-label--past {
    opacity: 0.6;
  }

  /* ── Items ───────────────────────────────────────────────────────────────── */
  .agenda-items {
    display: flex;
    flex-direction: column;
    gap: 0;
  }

  /* Design: flex baseline, gap 12, padding 7px 18px, borderLeft 3px groupColor,
     hover panel2, selected accentSoft + accent border. */
  .agenda-item {
    display: flex;
    align-items: baseline;
    gap: 12px;
    padding: 7px 18px;
    background: none;
    border: none;
    border-left: 3px solid var(--bar-color, var(--tnd-line-strong));
    text-align: left;
    cursor: pointer;
    font-family: var(--tnd-font-ui);
    transition: background 0.08s;
    width: 100%;
    min-width: 0;
    border-radius: 0;
  }

  .agenda-item:hover {
    background: var(--tnd-panel2);
  }

  .agenda-item--selected {
    background: var(--tnd-accent-soft);
    border-left-color: var(--tnd-accent);
  }

  .agenda-item--past {
    opacity: 0.55;
  }

  /* Design: time 72px, 11px faint tabular-nums */
  .agenda-item-time {
    font-size: 11px;
    color: var(--tnd-text-faint);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
    width: 72px;
    flex-shrink: 0;
    font-family: var(--tnd-font-ui);
  }

  /* Design: title flex 1, 13px text fw500 ellipsis */
  .agenda-item-title {
    flex: 1;
    font-size: 13px;
    color: var(--tnd-text);
    font-weight: 500;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .agenda-item-tags {
    display: flex;
    gap: 4px;
    flex-shrink: 0;
  }

  .agenda-tag {
    font-size: 10px;
    color: var(--tnd-text-faint);
    white-space: nowrap;
    font-family: var(--tnd-font-ui);
  }

  /* ── Per-theme tag variations (mirrors EntryList pattern) ────────────────── */

  /* Mono → bracket: mono font, accentText color */
  :global([data-tnd-theme="mono"]) .agenda-tag {
    font-family: var(--tnd-font-mono);
    color: var(--tnd-accent-text);
  }

  /* Editorial → caps: UPPERCASE, mono, hairline underline */
  :global([data-tnd-theme="editorial"]) .agenda-tag {
    font-family: var(--tnd-font-mono);
    color: var(--tnd-text);
    font-size: 9px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    border-bottom: 1px solid var(--tnd-line-strong);
    padding-bottom: 1px;
  }

  /* Fog + Soft → pill chips */
  :global([data-tnd-theme="fog"]) .agenda-tag,
  :global([data-tnd-theme="soft"]) .agenda-tag {
    background: var(--tnd-panel2);
    color: var(--tnd-text-muted);
    border: 1px solid var(--tnd-line);
    border-radius: var(--tnd-tag-radius);
    padding: 1px 6px;
  }
</style>
