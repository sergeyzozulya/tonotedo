<script lang="ts">
  // Entry list pane (spec 0002, issue #18).
  //
  // Shows entries for the selected group: title, preview snippet, tag chips,
  // updated-at time.  Archived entries are excluded per spec 0002.
  //
  // Design reference: TNDEntryList in docs/design.html:
  //   - Panel width 336px, header 48px with group name + sort label.
  //   - "preview" variant: title 14.5px bold, 2-line preview text, meta row
  //     (due + tags + avatars).
  //   - Active entry: left-border 3px accent + accent-soft background.

  import type { EntrySummary } from "../ipc/types.js";
  import { startLongPress } from "./mobile-gestures.js";

  interface Props {
    /** Display name of the selected group (shown in the header). */
    groupName: string;
    /** Entries to display (already filtered + sorted by parent). */
    entries: EntrySummary[];
    /** Entry id currently open in the editor, if any. */
    selectedId: string | null;
    /** Loading state. */
    loading: boolean;
    /** Error message, if any. */
    error: string | null;
    /** Called when the user selects an entry. */
    onEntrySelect: (id: string) => void;
    /** Called when the user long-presses an entry row (touch). */
    onLongPress?: (id: string, title: string) => void;
  }

  let { groupName, entries, selectedId, loading, error, onEntrySelect, onLongPress }: Props =
    $props();

  // ── Helpers ────────────────────────────────────────────────────────────────────

  function formatDate(iso: string): string {
    try {
      const d = new Date(iso);
      const now = new Date();
      const diffMs = now.getTime() - d.getTime();
      const diffDays = Math.floor(diffMs / 86400000);
      if (diffDays === 0) return "Today";
      if (diffDays === 1) return "Yesterday";
      if (diffDays < 7) return `${diffDays}d ago`;
      // Same year: "Jun 12"; different year: "Jun 12, 2025"
      const opts: Intl.DateTimeFormatOptions =
        d.getFullYear() === now.getFullYear()
          ? { month: "short", day: "numeric" }
          : { month: "short", day: "numeric", year: "numeric" };
      return d.toLocaleDateString(undefined, opts);
    } catch {
      return iso.slice(0, 10);
    }
  }

  // Long-press handling for touch (spec 0013).
  function handlePointerDown(e: PointerEvent, entry: EntrySummary): void {
    if (!onLongPress || e.pointerType !== "touch") return;
    const handle = startLongPress(() => onLongPress!(entry.id, entry.title || entry.id));
    const el = e.currentTarget as HTMLElement;
    const up = () => {
      handle.cancel();
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
    };
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  }

  /** Trim to max 120 chars, at a word boundary. */
  function snippet(title: string, text: string | undefined): string {
    if (!text) return "";
    // Strip frontmatter
    const body = text.replace(/^---[\s\S]*?---\s*/m, "");
    // Strip headings and markdown syntax
    const plain = body
      .replace(/^#{1,6}\s+.+$/gm, "")
      .replace(/[*_`[\]]/g, "")
      .replace(/\n+/g, " ")
      .trim();
    // Exclude the title itself from the snippet
    const titleless = plain.startsWith(title) ? plain.slice(title.length).trim() : plain;
    if (titleless.length <= 120) return titleless;
    const cut = titleless.slice(0, 120);
    const lastSpace = cut.lastIndexOf(" ");
    return (lastSpace > 60 ? cut.slice(0, lastSpace) : cut) + "…";
  }
</script>

<section class="entry-list" data-focus-zone="entry-list" aria-label="Entries">
  <!-- Header -->
  <header class="entry-list-header">
    <div class="entry-list-header-left">
      <span class="entry-list-title">{groupName || "All entries"}</span>
      <span class="entry-list-count">{entries.length}</span>
    </div>
    <div class="entry-list-header-right">
      <span class="entry-list-sort-label">Updated</span>
      <span class="entry-list-sort-icon" aria-hidden="true">▾</span>
    </div>
  </header>

  <!-- Body -->
  <div class="entry-list-body">
    {#if loading}
      <div class="entry-list-state">Loading…</div>
    {:else if error}
      <div class="entry-list-state entry-list-state--error">{error}</div>
    {:else if entries.length === 0}
      <div class="entry-list-state">No entries</div>
    {:else}
      <ul class="entry-list-items" role="listbox" aria-label="Entries in {groupName}">
        {#each entries as entry (entry.id)}
          {@const selected = entry.id === selectedId}
          <li
            class="entry-item"
            class:entry-item--selected={selected}
            role="option"
            aria-selected={selected}
            tabindex="0"
            onclick={() => onEntrySelect(entry.id)}
            onkeydown={(e) => (e.key === "Enter" || e.key === " ") && onEntrySelect(entry.id)}
            onpointerdown={(e) => handlePointerDown(e, entry)}
          >
            {#if selected}
              <span class="entry-item-accent-bar" aria-hidden="true"></span>
            {/if}
            <!-- Title + date -->
            <div class="entry-item-top">
              <span class="entry-item-title">{entry.title || entry.id}</span>
              <span class="entry-item-date">{formatDate(entry.modifiedAt)}</span>
            </div>
            <!-- Snippet -->
            <div class="entry-item-snippet">{snippet(entry.title, undefined)}</div>
            <!-- Meta: tags -->
            {#if entry.tags.length > 0}
              <div class="entry-item-meta">
                {#each entry.tags.slice(0, 3) as tag (tag)}
                  <span class="entry-item-tag">#{tag}</span>
                {/each}
                {#if entry.tags.length > 3}
                  <span class="entry-item-tag entry-item-tag--more">+{entry.tags.length - 3}</span>
                {/if}
              </div>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
  </div>
</section>

<style>
  .entry-list {
    width: var(--tnd-entry-list-width, 300px);
    flex-shrink: 0;
    border-right: 1px solid var(--tnd-line);
    background: var(--tnd-panel);
    display: flex;
    flex-direction: column;
    height: 100%;
    overflow: hidden;
  }

  /* Header */
  .entry-list-header {
    height: 44px;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 14px;
    border-bottom: 1px solid var(--tnd-line);
    gap: 8px;
  }

  .entry-list-header-left {
    display: flex;
    align-items: baseline;
    gap: 7px;
    min-width: 0;
  }

  .entry-list-title {
    font-size: 14px;
    font-weight: 700;
    color: var(--tnd-text);
    letter-spacing: -0.01em;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .entry-list-count {
    font-size: 11.5px;
    color: var(--tnd-text-faint);
    font-variant-numeric: tabular-nums;
    font-family: ui-monospace, monospace;
    flex-shrink: 0;
  }

  .entry-list-header-right {
    display: flex;
    align-items: center;
    gap: 5px;
    flex-shrink: 0;
    color: var(--tnd-text-faint);
    font-size: 11.5px;
  }

  .entry-list-sort-label {
    cursor: pointer;
  }

  .entry-list-sort-icon {
    font-size: 10px;
  }

  /* Body scroll region */
  .entry-list-body {
    flex: 1;
    overflow-y: auto;
    overflow-x: hidden;
    scrollbar-width: thin;
    scrollbar-color: var(--tnd-line-strong) transparent;
  }

  /* Empty / loading / error states */
  .entry-list-state {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 120px;
    color: var(--tnd-text-faint);
    font-size: 13px;
  }

  .entry-list-state--error {
    color: var(--tnd-chip-red-fg);
    padding: 0 14px;
    text-align: center;
  }

  /* Item list */
  .entry-list-items {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  /* Individual entry item */
  .entry-item {
    position: relative;
    padding: 12px 14px;
    border-bottom: 1px solid var(--tnd-line);
    cursor: pointer;
    transition: background 0.08s;
    outline: none;
  }

  .entry-item:hover {
    background: var(--tnd-panel2);
  }

  .entry-item:focus-visible {
    outline: 2px solid var(--tnd-accent);
    outline-offset: -2px;
  }

  .entry-item--selected {
    background: var(--tnd-accent-soft);
  }

  .entry-item--selected:hover {
    background: var(--tnd-accent-soft);
  }

  /* Active left bar */
  .entry-item-accent-bar {
    position: absolute;
    left: 0;
    top: 8px;
    bottom: 8px;
    width: 3px;
    border-radius: 0 2px 2px 0;
    background: var(--tnd-accent);
  }

  /* Title + date row */
  .entry-item-top {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: 10px;
    margin-bottom: 4px;
  }

  .entry-item-title {
    font-size: 14px;
    font-weight: 600;
    color: var(--tnd-text);
    letter-spacing: -0.01em;
    line-height: 1.25;
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .entry-item--selected .entry-item-title {
    color: var(--tnd-text);
  }

  .entry-item-date {
    font-size: 11px;
    font-weight: 500;
    color: var(--tnd-text-faint);
    white-space: nowrap;
    flex-shrink: 0;
  }

  /* Preview snippet */
  .entry-item-snippet {
    font-size: 12.5px;
    color: var(--tnd-text-muted);
    line-height: 1.45;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
    min-height: 0;
    margin-bottom: 7px;
  }

  /* Meta row (tags) */
  .entry-item-meta {
    display: flex;
    flex-wrap: wrap;
    gap: 5px;
    margin-top: 2px;
  }

  .entry-item-tag {
    font-size: 11px;
    color: var(--tnd-accent-text);
    background: var(--tnd-accent-soft);
    border-radius: 3px;
    padding: 1px 5px;
    font-weight: 500;
    white-space: nowrap;
  }

  .entry-item-tag--more {
    color: var(--tnd-text-faint);
    background: var(--tnd-panel2);
  }

  /* ── Responsive: on narrow viewports, entry list is a full screen ─────────── */
  @media (max-width: 699px) {
    .entry-list {
      width: 100%;
      flex: 1;
      border-right: none;
    }
  }
</style>
