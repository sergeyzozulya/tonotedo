<script lang="ts">
  // SearchOverlay — cmd+p search surface (spec 0009).
  //
  // Distinct from the command palette (cmd+k): this overlay finds entries.
  // Same shell pattern (backdrop + centred modal), different visual identity.
  //
  // Features:
  //   • Plain-text query: multiple terms AND, quoted phrases exact.
  //   • TAG chip (multi-select, any-of) and GROUP chip (single path, includes
  //     descendants) above the search box.
  //   • Live results, ~80 ms debounce.
  //   • Empty query = recents (top 50 by modified_desc, cap 500 total).
  //   • Result item: title, group breadcrumb, snippet with highlight, tag chips,
  //     age.
  //   • Save search: persists name + text + chip state to _searches.md via ipc.
  //   • Selecting a result calls `onSelectEntry(id)`.
  //
  // Usage:
  //   import SearchOverlay from '$lib/search/SearchOverlay.svelte';
  //   // bind open with openSearch():
  //   let overlay: { openSearch(): void } | undefined;
  //   <SearchOverlay bind:this={overlay} {onSelectEntry} />
  //   overlay?.openSearch();

  import { ipc } from "../ipc/index.js";
  import { savedSearchesStore } from "./saved-searches-store.js";
  import { parseQuery, matchesQuery } from "./query-parse.js";
  import type { EntrySummary, TagMeta, GroupMeta, SavedSearchFilter } from "../ipc/types.js";

  // ── Props ─────────────────────────────────────────────────────────────────────

  interface Props {
    /** Called when the user selects a result entry. */
    onSelectEntry?: (id: string) => void;
  }

  let { onSelectEntry }: Props = $props();

  // ── Open/close state ──────────────────────────────────────────────────────────

  let open = $state(false);

  /** Expose to parent so AppShell / sidebar can open the overlay. */
  export function openSearch(): void {
    open = true;
    // Reset to blank state each open
    queryText = "";
    activeTagFilters = [];
    activeGroupFilter = null;
    saveNameInput = "";
    savingMode = false;
    focusedIndex = 0;
    void runSearch();
    void loadMeta();
  }

  function close(): void {
    open = false;
  }

  // ── Metadata for chip dropdowns ───────────────────────────────────────────────

  let allTags = $state<TagMeta[]>([]);
  let allGroups = $state<GroupMeta[]>([]);

  async function loadMeta(): Promise<void> {
    const [tagsRes, groupsRes] = await Promise.all([ipc.tag_index(), ipc.list_groups()]);
    if (tagsRes.ok) allTags = tagsRes.value;
    if (groupsRes.ok) allGroups = groupsRes.value;
  }

  // ── Filter chip state ─────────────────────────────────────────────────────────

  let activeTagFilters = $state<string[]>([]);
  let activeGroupFilter = $state<string | null>(null);

  let tagDropdownOpen = $state(false);
  let groupDropdownOpen = $state(false);

  function toggleTag(tag: string): void {
    if (activeTagFilters.includes(tag)) {
      activeTagFilters = activeTagFilters.filter((t) => t !== tag);
    } else {
      activeTagFilters = [...activeTagFilters, tag];
    }
    scheduleSearch();
  }

  function setGroupFilter(path: string | null): void {
    activeGroupFilter = path;
    groupDropdownOpen = false;
    scheduleSearch();
  }

  function removeTagFilter(tag: string): void {
    activeTagFilters = activeTagFilters.filter((t) => t !== tag);
    scheduleSearch();
  }

  function clearGroupFilter(): void {
    activeGroupFilter = null;
    scheduleSearch();
  }

  // ── Query input + debounce ────────────────────────────────────────────────────

  let queryText = $state("");
  let searchTimer: ReturnType<typeof setTimeout> | undefined;

  function onInput(): void {
    scheduleSearch();
  }

  function scheduleSearch(): void {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => void runSearch(), 80);
  }

  // ── Results ───────────────────────────────────────────────────────────────────

  let results = $state<EntrySummary[]>([]);
  let searching = $state(false);
  let focusedIndex = $state(0);

  const RECENTS_LIMIT = 50;
  const RESULTS_CAP = 500;

  async function runSearch(): Promise<void> {
    searching = true;
    try {
      const filters: { tags?: string[]; group?: string } = {};
      if (activeTagFilters.length > 0) filters.tags = activeTagFilters;
      if (activeGroupFilter) filters.group = activeGroupFilter;

      const res = await ipc.search({
        text: queryText.trim(),
        filters: Object.keys(filters).length > 0 ? filters : undefined,
        sort: queryText.trim() ? "relevance" : "modified_desc",
      });

      if (res.ok) {
        let items = res.value.items;

        // Client-side: apply group descendant filter (mock search does exact
        // match; we extend to include descendants by prefix).
        if (activeGroupFilter) {
          const prefix = activeGroupFilter + "/";
          items = items.filter((e) => e.group === activeGroupFilter || e.group.startsWith(prefix));
        }

        // Client-side: AND text query using the parser (mock IPC does simple
        // includes; we enhance with phrase support).
        if (queryText.trim()) {
          const parsed = parseQuery(queryText);
          items = items.filter((e) => matchesQuery(e.title + " " + e.group, parsed));
        }

        // Cap
        if (items.length > RESULTS_CAP) items = items.slice(0, RESULTS_CAP);

        // For recents (empty query), limit to top 50
        if (!queryText.trim() && activeTagFilters.length === 0 && !activeGroupFilter) {
          items = items.slice(0, RECENTS_LIMIT);
        }

        results = items;
        focusedIndex = 0;
      }
    } finally {
      searching = false;
    }
  }

  // ── Keyboard navigation ───────────────────────────────────────────────────────

  function onKeydown(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      if (tagDropdownOpen || groupDropdownOpen) {
        tagDropdownOpen = false;
        groupDropdownOpen = false;
      } else {
        close();
      }
      e.preventDefault();
      return;
    }
    if (e.key === "ArrowDown") {
      focusedIndex = Math.min(focusedIndex + 1, results.length - 1);
      e.preventDefault();
    } else if (e.key === "ArrowUp") {
      focusedIndex = Math.max(focusedIndex - 1, 0);
      e.preventDefault();
    } else if (e.key === "Enter") {
      if (results[focusedIndex]) {
        selectResult(results[focusedIndex].id);
      }
      e.preventDefault();
    }
  }

  function selectResult(id: string): void {
    close();
    onSelectEntry?.(id);
  }

  // ── Snippet extraction ────────────────────────────────────────────────────────

  /**
   * Extract a short snippet from the entry title/group that contains a
   * query term, with the matched portion wrapped in a highlight marker.
   * Returns plain title as fallback (no markup in this plain-text impl).
   */
  function getSnippet(
    entry: EntrySummary,
    query: string,
  ): { pre: string; hit: string; post: string } | null {
    const q = query.trim().toLowerCase();
    if (!q) return null;
    const haystack = entry.title.toLowerCase();
    const idx = haystack.indexOf(q);
    if (idx < 0) return null;
    return {
      pre: entry.title.slice(0, idx),
      hit: entry.title.slice(idx, idx + q.length),
      post: entry.title.slice(idx + q.length),
    };
  }

  // ── Age formatting ────────────────────────────────────────────────────────────

  function formatAge(iso: string): string {
    const ms = Date.now() - new Date(iso).getTime();
    const mins = Math.floor(ms / 60000);
    if (mins < 60) return `${mins}m`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h`;
    const days = Math.floor(hrs / 24);
    if (days < 30) return `${days}d`;
    const months = Math.floor(days / 30);
    return `${months}mo`;
  }

  // ── Save search ───────────────────────────────────────────────────────────────

  let savingMode = $state(false);
  let saveNameInput = $state("");

  async function commitSave(): Promise<void> {
    const name = saveNameInput.trim();
    if (!name) return;

    const filters: SavedSearchFilter[] = [];
    if (activeTagFilters.length > 0) {
      filters.push({ kind: "tag", values: [...activeTagFilters] });
    }
    if (activeGroupFilter) {
      filters.push({ kind: "group", path: activeGroupFilter });
    }

    await savedSearchesStore.save(name, queryText, filters);
    savingMode = false;
    saveNameInput = "";
  }

  // ── Restore saved search ──────────────────────────────────────────────────────

  export function restoreSavedSearch(s: { text: string; filters: SavedSearchFilter[] }): void {
    open = true;
    queryText = s.text;
    activeTagFilters = [];
    activeGroupFilter = null;

    for (const f of s.filters) {
      if (f.kind === "tag") activeTagFilters = [...f.values];
      else if (f.kind === "group") activeGroupFilter = f.path;
    }

    void runSearch();
    void loadMeta();
  }

  // Input element ref for auto-focus
  let inputEl = $state<HTMLInputElement | undefined>();

  $effect(() => {
    if (open && inputEl) {
      inputEl.focus();
    }
  });
</script>

{#if open}
  <!-- Backdrop -->
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="search-backdrop" onclick={close}></div>

  <!-- Modal -->
  <div
    class="search-modal"
    role="dialog"
    aria-modal="true"
    aria-label="Search entries"
    tabindex="-1"
    onkeydown={onKeydown}
  >
    <!-- Header: chips + input row -->
    <div class="search-header">
      <!-- Chip bar -->
      <div class="search-chips">
        <!-- TAG chip -->
        <div class="chip-wrapper">
          <button
            class="filter-chip"
            class:filter-chip--active={activeTagFilters.length > 0}
            onclick={() => {
              tagDropdownOpen = !tagDropdownOpen;
              groupDropdownOpen = false;
            }}
            aria-haspopup="listbox"
            aria-expanded={tagDropdownOpen}
          >
            <span class="chip-icon">#</span>
            {#if activeTagFilters.length > 0}
              {activeTagFilters.join(", ")}
            {:else}
              Tag
            {/if}
            <span class="chip-chevron">▾</span>
          </button>

          {#if tagDropdownOpen}
            <div class="chip-dropdown" role="listbox" aria-label="Filter by tag">
              {#each allTags as tag (tag.name)}
                <button
                  class="chip-option"
                  class:chip-option--selected={activeTagFilters.includes(tag.name)}
                  role="option"
                  aria-selected={activeTagFilters.includes(tag.name)}
                  onclick={() => toggleTag(tag.name)}
                >
                  <span class="chip-option-dot" style="background: var(--tnd-chip-{tag.color}-fg);"
                  ></span>
                  {tag.name}
                  <span class="chip-option-count">{tag.count}</span>
                </button>
              {/each}
              {#if allTags.length === 0}
                <span class="chip-option chip-option--empty">No tags</span>
              {/if}
            </div>
          {/if}
        </div>

        <!-- Active tag chips (dismissible) -->
        {#each activeTagFilters as tag (tag)}
          <span class="active-chip">
            #{tag}
            <button
              class="active-chip-remove"
              aria-label="Remove tag filter {tag}"
              onclick={() => removeTagFilter(tag)}>×</button
            >
          </span>
        {/each}

        <!-- GROUP chip -->
        <div class="chip-wrapper">
          <button
            class="filter-chip"
            class:filter-chip--active={activeGroupFilter !== null}
            onclick={() => {
              groupDropdownOpen = !groupDropdownOpen;
              tagDropdownOpen = false;
            }}
            aria-haspopup="listbox"
            aria-expanded={groupDropdownOpen}
          >
            <span class="chip-icon">⊞</span>
            {#if activeGroupFilter}
              {activeGroupFilter}
            {:else}
              Group
            {/if}
            <span class="chip-chevron">▾</span>
          </button>

          {#if groupDropdownOpen}
            <div class="chip-dropdown" role="listbox" aria-label="Filter by group">
              <button
                class="chip-option"
                class:chip-option--selected={activeGroupFilter === null}
                role="option"
                aria-selected={activeGroupFilter === null}
                onclick={() => setGroupFilter(null)}
              >
                All groups
              </button>
              {#each allGroups as group (group.path)}
                <button
                  class="chip-option"
                  class:chip-option--selected={activeGroupFilter === group.path}
                  role="option"
                  aria-selected={activeGroupFilter === group.path}
                  onclick={() => setGroupFilter(group.path)}
                >
                  {group.path}
                  <span class="chip-option-count">{group.count}</span>
                </button>
              {/each}
            </div>
          {/if}
        </div>

        {#if activeGroupFilter}
          <span class="active-chip">
            ⊞ {activeGroupFilter}
            <button
              class="active-chip-remove"
              aria-label="Remove group filter"
              onclick={clearGroupFilter}>×</button
            >
          </span>
        {/if}
      </div>

      <!-- Search input -->
      <div class="search-input-row">
        <span class="search-icon" aria-hidden="true">⌕</span>
        <input
          bind:this={inputEl}
          class="search-input"
          type="search"
          placeholder="Search entries…"
          autocomplete="off"
          spellcheck="false"
          bind:value={queryText}
          oninput={onInput}
        />
        {#if searching}
          <span class="search-spinner" aria-label="Searching…">…</span>
        {/if}
        <kbd class="search-esc-hint">esc</kbd>
      </div>
    </div>

    <!-- Results list -->
    <div class="search-results" role="listbox" aria-label="Search results">
      {#if results.length === 0 && !searching}
        <div class="search-empty">
          {#if queryText.trim() || activeTagFilters.length > 0 || activeGroupFilter}
            No entries match your search.
          {:else}
            Start typing to search, or browse recent entries above.
          {/if}
        </div>
      {:else}
        {#each results as entry, i (entry.id)}
          {@const snippet = getSnippet(entry, queryText)}
          <button
            class="result-item"
            class:result-item--focused={i === focusedIndex}
            role="option"
            aria-selected={i === focusedIndex}
            onclick={() => selectResult(entry.id)}
            onmouseenter={() => (focusedIndex = i)}
          >
            <div class="result-main">
              <span class="result-title">
                {#if snippet}
                  {snippet.pre}<mark class="result-highlight">{snippet.hit}</mark>{snippet.post}
                {:else}
                  {entry.title}
                {/if}
              </span>
              <span class="result-age">{formatAge(entry.modifiedAt)}</span>
            </div>
            <div class="result-meta">
              <span class="result-group">{entry.group}</span>
              {#each entry.tags.slice(0, 4) as tag (tag)}
                <span class="result-tag">#{tag}</span>
              {/each}
            </div>
          </button>
        {/each}
      {/if}
    </div>

    <!-- Footer: result count + save search -->
    <div class="search-footer">
      <span class="search-count">
        {#if results.length > 0}
          {results.length}{results.length >= RESULTS_CAP ? "+" : ""} result{results.length === 1
            ? ""
            : "s"}
        {:else if !queryText.trim() && activeTagFilters.length === 0 && !activeGroupFilter}
          Recent entries
        {:else}
          No results
        {/if}
      </span>

      {#if savingMode}
        <span class="save-form">
          <input
            class="save-name-input"
            type="text"
            placeholder="Search name…"
            bind:value={saveNameInput}
            onkeydown={(e) => {
              if (e.key === "Enter") {
                void commitSave();
                e.preventDefault();
              }
              if (e.key === "Escape") {
                savingMode = false;
                e.stopPropagation();
              }
            }}
          />
          <button class="save-btn save-btn--confirm" onclick={() => void commitSave()}>Save</button>
          <button class="save-btn" onclick={() => (savingMode = false)}>Cancel</button>
        </span>
      {:else}
        <button
          class="save-btn"
          title="Save this search to the sidebar"
          onclick={() => {
            savingMode = true;
            saveNameInput = queryText.trim() || "My search";
          }}
        >
          Save search
        </button>
      {/if}
    </div>
  </div>
{/if}

<style>
  /* ── Backdrop ────────────────────────────────────────────────────────────── */

  .search-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.38);
    z-index: 400;
    /* Visually distinct from the palette backdrop — slightly lighter */
  }

  /* ── Modal ───────────────────────────────────────────────────────────────── */

  .search-modal {
    position: fixed;
    top: 14vh;
    left: 50%;
    transform: translateX(-50%);
    width: min(660px, 94vw);
    max-height: 72vh;
    display: flex;
    flex-direction: column;
    background: var(--tnd-panel);
    border: 1px solid var(--tnd-line-strong);
    border-radius: 10px;
    box-shadow:
      var(--tnd-shadow),
      0 20px 60px rgba(0, 0, 0, 0.2);
    z-index: 401;
    overflow: hidden;
    /* Distinct from palette: broader, warmer border-radius */
  }

  /* ── Header ──────────────────────────────────────────────────────────────── */

  .search-header {
    padding: 12px 14px 8px;
    border-bottom: 1px solid var(--tnd-line);
    flex-shrink: 0;
  }

  /* ── Chip bar ────────────────────────────────────────────────────────────── */

  .search-chips {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    margin-bottom: 8px;
  }

  .chip-wrapper {
    position: relative;
  }

  .filter-chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 3px 9px 3px 8px;
    border: 1px solid var(--tnd-line-strong);
    border-radius: 20px;
    background: var(--tnd-panel2);
    color: var(--tnd-text-muted);
    font-size: 12px;
    font-family: inherit;
    cursor: pointer;
    transition:
      background 0.1s,
      border-color 0.1s;
  }

  .filter-chip:hover {
    background: var(--tnd-sel);
    border-color: var(--tnd-accent);
    color: var(--tnd-accent-text);
  }

  .filter-chip--active {
    background: var(--tnd-accent-soft);
    border-color: var(--tnd-accent);
    color: var(--tnd-accent-text);
    font-weight: 600;
  }

  .chip-icon {
    font-size: 11px;
    opacity: 0.7;
  }

  .chip-chevron {
    font-size: 9px;
    opacity: 0.6;
    margin-left: 2px;
  }

  /* Active chip pill (dismissible) */
  .active-chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 2px 6px 2px 8px;
    border-radius: 20px;
    background: var(--tnd-accent-soft);
    color: var(--tnd-accent-text);
    font-size: 12px;
    font-weight: 600;
    border: 1px solid var(--tnd-accent);
  }

  .active-chip-remove {
    background: none;
    border: none;
    padding: 0 1px;
    cursor: pointer;
    font-size: 13px;
    line-height: 1;
    color: var(--tnd-accent-text);
    opacity: 0.7;
    font-family: inherit;
  }

  .active-chip-remove:hover {
    opacity: 1;
  }

  /* Dropdown panel */
  .chip-dropdown {
    position: absolute;
    top: calc(100% + 4px);
    left: 0;
    min-width: 200px;
    max-height: 220px;
    overflow-y: auto;
    background: var(--tnd-panel);
    border: 1px solid var(--tnd-line-strong);
    border-radius: 7px;
    box-shadow: var(--tnd-shadow);
    z-index: 410;
    padding: 4px;
    scrollbar-width: thin;
  }

  .chip-option {
    display: flex;
    align-items: center;
    gap: 7px;
    width: 100%;
    padding: 5px 9px;
    border: none;
    background: none;
    color: var(--tnd-text-muted);
    font-size: 12.5px;
    font-family: inherit;
    cursor: pointer;
    border-radius: 5px;
    text-align: left;
  }

  .chip-option:hover {
    background: var(--tnd-panel2);
    color: var(--tnd-text);
  }

  .chip-option--selected {
    background: var(--tnd-accent-soft);
    color: var(--tnd-accent-text);
    font-weight: 600;
  }

  .chip-option--empty {
    color: var(--tnd-text-faint);
    font-style: italic;
    cursor: default;
  }

  .chip-option--empty:hover {
    background: none;
  }

  .chip-option-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
  }

  .chip-option-count {
    margin-left: auto;
    font-size: 11px;
    color: var(--tnd-text-faint);
    font-variant-numeric: tabular-nums;
  }

  /* ── Search input ────────────────────────────────────────────────────────── */

  .search-input-row {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .search-icon {
    font-size: 16px;
    color: var(--tnd-text-faint);
    flex-shrink: 0;
  }

  .search-input {
    flex: 1;
    border: none;
    outline: none;
    background: transparent;
    color: var(--tnd-text);
    font-size: 15px;
    font-family: inherit;
    padding: 4px 0;
    min-width: 0;
  }

  .search-input::placeholder {
    color: var(--tnd-text-faint);
  }

  /* Remove browser-default search cancel button */
  .search-input::-webkit-search-cancel-button {
    display: none;
  }

  .search-spinner {
    font-size: 13px;
    color: var(--tnd-text-faint);
    animation: pulse 0.8s ease-in-out infinite;
    flex-shrink: 0;
  }

  @keyframes pulse {
    0%,
    100% {
      opacity: 0.4;
    }
    50% {
      opacity: 1;
    }
  }

  .search-esc-hint {
    font-size: 10.5px;
    color: var(--tnd-text-faint);
    font-family: ui-monospace, monospace;
    flex-shrink: 0;
  }

  /* ── Results ─────────────────────────────────────────────────────────────── */

  .search-results {
    flex: 1;
    overflow-y: auto;
    scrollbar-width: thin;
    padding: 4px;
    min-height: 0;
  }

  .search-empty {
    padding: 24px 18px;
    color: var(--tnd-text-faint);
    font-size: 13.5px;
    text-align: center;
  }

  .result-item {
    display: flex;
    flex-direction: column;
    gap: 3px;
    width: 100%;
    padding: 8px 12px;
    border: none;
    background: none;
    color: var(--tnd-text);
    font-family: inherit;
    text-align: left;
    cursor: pointer;
    border-radius: 6px;
    transition: background 0.07s;
  }

  .result-item:hover,
  .result-item--focused {
    background: var(--tnd-panel2);
  }

  .result-item--focused {
    background: var(--tnd-sel);
  }

  .result-main {
    display: flex;
    align-items: baseline;
    gap: 8px;
  }

  .result-title {
    flex: 1;
    font-size: 13.5px;
    font-weight: 600;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    color: var(--tnd-text);
  }

  .result-highlight {
    background: var(--tnd-accent-soft);
    color: var(--tnd-accent-text);
    border-radius: 2px;
    font-style: normal;
  }

  .result-age {
    font-size: 11px;
    color: var(--tnd-text-faint);
    font-variant-numeric: tabular-nums;
    flex-shrink: 0;
  }

  .result-meta {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
  }

  .result-group {
    font-size: 11.5px;
    color: var(--tnd-text-faint);
    font-weight: 400;
  }

  .result-tag {
    font-size: 11px;
    color: var(--tnd-text-faint);
    background: var(--tnd-panel2);
    padding: 1px 5px;
    border-radius: 3px;
  }

  /* ── Footer ──────────────────────────────────────────────────────────────── */

  .search-footer {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 7px 14px;
    border-top: 1px solid var(--tnd-line);
    background: var(--tnd-panel2);
  }

  .search-count {
    font-size: 11.5px;
    color: var(--tnd-text-faint);
  }

  .save-btn {
    font-size: 12px;
    color: var(--tnd-accent-text);
    background: none;
    border: none;
    cursor: pointer;
    font-family: inherit;
    padding: 3px 8px;
    border-radius: 4px;
    transition: background 0.1s;
  }

  .save-btn:hover {
    background: var(--tnd-accent-soft);
  }

  .save-btn--confirm {
    font-weight: 600;
  }

  .save-form {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .save-name-input {
    border: 1px solid var(--tnd-line-strong);
    border-radius: 5px;
    padding: 3px 8px;
    font-size: 12px;
    font-family: inherit;
    background: var(--tnd-panel);
    color: var(--tnd-text);
    outline: none;
    width: 160px;
  }

  .save-name-input:focus {
    border-color: var(--tnd-accent);
  }
</style>
