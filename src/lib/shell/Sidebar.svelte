<script lang="ts">
  // Sidebar — group tree navigation (spec 0003, issue #18) + People section
  // (spec 0005, issue #22) + Tags browser row.
  //
  // Renders:
  //   • A "GROUPS" section heading.
  //   • The collapsible group tree derived from ipc.list_groups().
  //   • A People section (PeopleSection component).
  //   • A Tags row that opens the tag browser.
  //   • A sync-status footer row.
  //
  // Selection: emits onGroupSelect(path) when the user clicks a group row.
  // Collapsed state is pure UI state (not persisted per spec).
  //
  // Design reference: TNDSidebar in docs/design.html — sidebar width 246px,
  // row height 30px (balanced density), active left-border accent 3px,
  // count in faint monospace, section labels uppercase 10.5px.

  import type { GroupNode } from "./group-tree.js";
  import { savedSearchesStore } from "../search/saved-searches-store.js";
  import type { SavedSearch } from "../search/saved-searches-store.js";
  import type { PersonMeta } from "../ipc/types.js";
  import PeopleSection from "../people/PeopleSection.svelte";
  import { ipc } from "../ipc/index.js";

  interface Props {
    /** Root-level tree nodes (already sorted + aggregated). */
    tree: GroupNode[];
    /** Currently selected group path (or null for "all"). */
    selectedPath: string | null;
    /** Called when the user selects a group. */
    onGroupSelect: (path: string | null) => void;
    /** Called when the Search nav row is clicked. */
    onOpenSearch?: () => void;
    /** Called when a saved search is selected. */
    onSelectSavedSearch?: (s: SavedSearch) => void;
    /** People list from people_index() for the People section. */
    people?: PersonMeta[];
    /** Currently selected person slug (for People section). */
    selectedPersonSlug?: string | null;
    /** Called when a person row is clicked in the People section. */
    onPersonSelect?: (slug: string) => void;
    /** Called when the Tags row is clicked. */
    onTagsOpen?: () => void;
    /** Whether the Tags browser is currently open (for active highlight). */
    tagsOpen?: boolean;
    /** Called when the user clicks the Calendar nav row. */
    onCalendarOpen?: () => void;
    /** True when the calendar zone is active. */
    calendarActive?: boolean;
    /** Called when the Trash row is clicked. */
    onTrashOpen?: () => void;
    /** True when the Trash view is active. */
    trashOpen?: boolean;
    /** Called after a group is created/renamed/moved so parent can refresh. */
    onGroupsChanged?: () => void;
  }

  let {
    tree,
    selectedPath,
    onGroupSelect,
    onOpenSearch,
    onSelectSavedSearch,
    people = [],
    selectedPersonSlug = null,
    onPersonSelect,
    onTagsOpen,
    tagsOpen = false,
    onCalendarOpen,
    calendarActive = false,
    onTrashOpen,
    trashOpen = false,
    onGroupsChanged,
  }: Props = $props();

  // ── Per-node collapsed state ──────────────────────────────────────────────────
  // Start with top-level nodes open; children collapsed.
  const collapsed = $state(new Map<string, boolean>());

  function isCollapsed(path: string): boolean {
    return collapsed.get(path) ?? false;
  }

  function toggleCollapsed(path: string, e: MouseEvent): void {
    e.stopPropagation();
    collapsed.set(path, !isCollapsed(path));
  }

  function selectGroup(path: string, hasChildren: boolean): void {
    // Clicking the chevron only toggles; clicking the label selects + toggles.
    onGroupSelect(path);
    if (hasChildren) {
      collapsed.set(path, !isCollapsed(path));
    }
  }

  // ── "+ new group" affordance ──────────────────────────────────────────────

  let newGroupParent = $state<string | null>(null);
  let newGroupName = $state("");
  let newGroupError = $state<string | null>(null);

  function startNewGroup(parentPath: string | null): void {
    newGroupParent = parentPath ?? "";
    newGroupName = "";
    newGroupError = null;
  }

  function cancelNewGroup(): void {
    newGroupParent = null;
    newGroupName = "";
    newGroupError = null;
  }

  async function commitNewGroup(): Promise<void> {
    const name = newGroupName.trim();
    if (!name) {
      cancelNewGroup();
      return;
    }
    const path = newGroupParent ? `${newGroupParent}/${name}` : name;
    const res = await ipc.create_group(path);
    if (res.ok) {
      cancelNewGroup();
      onGroupsChanged?.();
    } else {
      newGroupError = res.error.message;
    }
  }

  function handleNewGroupKeydown(e: KeyboardEvent): void {
    if (e.key === "Enter") {
      void commitNewGroup();
    } else if (e.key === "Escape") {
      cancelNewGroup();
    }
  }

  // ── Group overflow menu (rename / trash) ──────────────────────────────────

  let groupMenuPath = $state<string | null>(null);
  let renameGroupPath = $state<string | null>(null);
  let renameGroupValue = $state("");
  let renameGroupError = $state<string | null>(null);

  function openGroupMenu(path: string, e: MouseEvent): void {
    e.stopPropagation();
    groupMenuPath = groupMenuPath === path ? null : path;
  }

  function closeGroupMenu(): void {
    groupMenuPath = null;
  }

  function startRename(path: string): void {
    renameGroupPath = path;
    renameGroupValue = path.split("/").at(-1) ?? path;
    renameGroupError = null;
    groupMenuPath = null;
  }

  function cancelRename(): void {
    renameGroupPath = null;
    renameGroupValue = "";
    renameGroupError = null;
  }

  async function commitRename(): Promise<void> {
    const newName = renameGroupValue.trim();
    if (!newName || !renameGroupPath) {
      cancelRename();
      return;
    }
    if (newName === (renameGroupPath.split("/").at(-1) ?? renameGroupPath)) {
      cancelRename();
      return;
    }
    const res = await ipc.rename_group(renameGroupPath, newName);
    if (res.ok) {
      cancelRename();
      onGroupsChanged?.();
    } else {
      renameGroupError = res.error.message;
    }
  }

  function handleRenameKeydown(e: KeyboardEvent): void {
    if (e.key === "Enter") {
      void commitRename();
    } else if (e.key === "Escape") {
      cancelRename();
    }
  }

  async function trashGroup(path: string): Promise<void> {
    groupMenuPath = null;
    const res = await ipc.trash_group(path);
    if (res.ok) {
      onGroupsChanged?.();
    } else {
      console.error("[sidebar] trash_group failed:", res.error.message);
    }
  }
</script>

<nav class="sidebar" data-focus-zone="sidebar" aria-label="Group navigation">
  <!-- Fixed nav rows (Calendar / Search) -->
  <div class="sidebar-fixed">
    <div
      class="sidebar-row sidebar-row--nav"
      class:sidebar-row--selected={calendarActive}
      role="button"
      tabindex="0"
      onclick={onCalendarOpen}
      onkeydown={(e) => (e.key === "Enter" || e.key === " ") && onCalendarOpen?.()}
    >
      {#if calendarActive}
        <span class="sidebar-row-accent-bar" aria-hidden="true"></span>
      {/if}
      <span class="sidebar-row-icon">📅</span>
      <span class="sidebar-row-label">Calendar</span>
      <kbd class="sidebar-row-hint">⌘⌥M</kbd>
    </div>
    <div
      class="sidebar-row sidebar-row--nav"
      role="button"
      tabindex="0"
      onclick={onOpenSearch}
      onkeydown={(e) => (e.key === "Enter" || e.key === " ") && onOpenSearch?.()}
    >
      <span class="sidebar-row-icon">🔍</span>
      <span class="sidebar-row-label">Search</span>
      <kbd class="sidebar-row-hint">⌘P</kbd>
    </div>
  </div>

  <!-- Groups section -->
  <div class="sidebar-section-label-row">
    <span class="sidebar-section-label">Groups</span>
    <button
      class="sidebar-new-group-btn"
      title="New root group"
      aria-label="New root group"
      onclick={() => startNewGroup(null)}>+</button
    >
  </div>

  <div class="sidebar-tree" role="tree">
    {#each tree as node (node.path)}
      {@render treeNode(node, 0)}
    {/each}
  </div>

  <!-- Inline new-group input (root level) -->
  {#if newGroupParent === ""}
    <div class="sidebar-new-group-row">
      <input
        class="sidebar-new-group-input"
        type="text"
        placeholder="Group name…"
        aria-label="New group name"
        bind:value={newGroupName}
        onkeydown={handleNewGroupKeydown}
        onblur={cancelNewGroup}
        autofocus
      />
      {#if newGroupError}
        <span class="sidebar-new-group-error" title={newGroupError}>!</span>
      {/if}
    </div>
  {/if}

  <!-- Saved searches (spec 0009) -->
  <div class="sidebar-section-label">Saved</div>
  {#if savedSearchesStore.searches.length === 0}
    <div class="sidebar-row sidebar-row--placeholder" aria-disabled="true">
      <span class="sidebar-row-label sidebar-row-label--faint">No saved searches</span>
    </div>
  {:else}
    {#each savedSearchesStore.searches as s (s.name)}
      <div
        class="sidebar-row sidebar-row--saved"
        role="button"
        tabindex="0"
        onclick={() => onSelectSavedSearch?.(s)}
        onkeydown={(e) => (e.key === "Enter" || e.key === " ") && onSelectSavedSearch?.(s)}
      >
        <span class="sidebar-row-icon">⌕</span>
        <span class="sidebar-row-label">{s.name}</span>
      </div>
    {/each}
  {/if}

  <!-- Tags / Trash rows under Browse -->
  <div class="sidebar-section-label">Browse</div>
  <div
    class="sidebar-row sidebar-row--nav"
    class:sidebar-row--selected={tagsOpen}
    role="button"
    tabindex="0"
    onclick={() => onTagsOpen?.()}
    onkeydown={(e) => (e.key === "Enter" || e.key === " ") && onTagsOpen?.()}
  >
    {#if tagsOpen}
      <span class="sidebar-row-accent-bar" aria-hidden="true"></span>
    {/if}
    <span class="sidebar-row-icon">🏷️</span>
    <span class="sidebar-row-label">Tags</span>
  </div>
  <!-- Trash row (spec 0009 §trash view) -->
  <div
    class="sidebar-row sidebar-row--nav"
    class:sidebar-row--selected={trashOpen}
    role="button"
    tabindex="0"
    onclick={() => onTrashOpen?.()}
    onkeydown={(e) => (e.key === "Enter" || e.key === " ") && onTrashOpen?.()}
  >
    {#if trashOpen}
      <span class="sidebar-row-accent-bar" aria-hidden="true"></span>
    {/if}
    <span class="sidebar-row-icon">🗑️</span>
    <span class="sidebar-row-label">Trash</span>
  </div>

  <!-- People section (issue #22) -->
  <PeopleSection
    {people}
    selectedSlug={selectedPersonSlug}
    onPersonSelect={(slug) => onPersonSelect?.(slug)}
  />

  <!-- Footer -->
  <footer class="sidebar-footer">
    <span class="sidebar-footer-dot"></span>
    <span>Local · synced</span>
  </footer>
</nav>

{#snippet treeNode(node: GroupNode, depth: number)}
  {@const selected = node.path === selectedPath}
  {@const hasChildren = node.children.length > 0}
  {@const open = hasChildren && !isCollapsed(node.path)}
  {@const menuOpen = groupMenuPath === node.path}
  {@const isRenaming = renameGroupPath === node.path}
  {@const isAddingChild = newGroupParent === node.path}

  {#if isRenaming}
    <!-- Inline rename input -->
    <div class="sidebar-new-group-row" style="--depth: {depth};">
      <input
        class="sidebar-new-group-input"
        type="text"
        aria-label="Rename group"
        bind:value={renameGroupValue}
        onkeydown={handleRenameKeydown}
        onblur={cancelRename}
        autofocus
      />
      {#if renameGroupError}
        <span class="sidebar-new-group-error" title={renameGroupError}>!</span>
      {/if}
    </div>
  {:else}
    <div
      class="sidebar-row"
      class:sidebar-row--selected={selected}
      role="treeitem"
      aria-selected={selected}
      aria-expanded={hasChildren ? open : undefined}
      tabindex="0"
      style="--depth: {depth};"
      onclick={() => selectGroup(node.path, hasChildren)}
      onkeydown={(e) => (e.key === "Enter" || e.key === " ") && selectGroup(node.path, hasChildren)}
    >
      {#if selected}
        <span class="sidebar-row-accent-bar" aria-hidden="true"></span>
      {/if}
      <span
        class="sidebar-row-chevron"
        class:sidebar-row-chevron--visible={hasChildren}
        onclick={(e) => hasChildren && toggleCollapsed(node.path, e)}
        aria-hidden="true"
      >
        {#if hasChildren}
          {open ? "▾" : "▸"}
        {/if}
      </span>
      {#if node.color}
        <span class="sidebar-row-color-dot" style="background: {node.color};" aria-hidden="true"
        ></span>
      {/if}
      <span class="sidebar-row-label">{node.name}</span>
      {#if node.count > 0}
        <span class="sidebar-row-count">{node.count}</span>
      {/if}
      <!-- Overflow menu trigger (visible on hover) -->
      <button
        class="sidebar-row-overflow"
        aria-label="Group actions for {node.name}"
        aria-expanded={menuOpen}
        title="Group actions"
        onclick={(e) => openGroupMenu(node.path, e)}>⋯</button
      >
    </div>

    <!-- Group overflow dropdown -->
    {#if menuOpen}
      <div class="group-menu-backdrop" onclick={closeGroupMenu} role="presentation"></div>
      <div class="group-menu" style="--depth: {depth};">
        <button class="group-menu-item" onclick={() => startNewGroup(node.path)}
          >New subgroup</button
        >
        <button class="group-menu-item" onclick={() => startRename(node.path)}>Rename</button>
        <button
          class="group-menu-item group-menu-item--danger"
          onclick={() => trashGroup(node.path)}>Move to Trash</button
        >
      </div>
    {/if}
  {/if}

  {#if open}
    {#each node.children as child (child.path)}
      {@render treeNode(child, depth + 1)}
    {/each}
  {/if}

  <!-- Inline new-child-group input -->
  {#if isAddingChild}
    <div class="sidebar-new-group-row" style="--depth: {depth + 1};">
      <input
        class="sidebar-new-group-input"
        type="text"
        placeholder="Group name…"
        aria-label="New subgroup name"
        bind:value={newGroupName}
        onkeydown={handleNewGroupKeydown}
        onblur={cancelNewGroup}
        autofocus
      />
      {#if newGroupError}
        <span class="sidebar-new-group-error" title={newGroupError}>!</span>
      {/if}
    </div>
  {/if}
{/snippet}

<style>
  .sidebar {
    width: var(--tnd-sidebar-width, 246px);
    flex-shrink: 0;
    border-right: 1px solid var(--tnd-line-strong);
    background: var(--tnd-panel);
    display: flex;
    flex-direction: column;
    overflow: hidden;
    height: 100%;
  }

  .sidebar-fixed {
    padding-top: 6px;
  }

  /* Section labels */
  .sidebar-section-label {
    padding: 14px 13px 5px;
    font-size: 10.5px;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--tnd-text-faint);
    user-select: none;
  }

  /* Tree area */
  .sidebar-tree {
    flex: 1;
    overflow-y: auto;
    overflow-x: hidden;
    padding-bottom: 8px;
    scrollbar-width: none;
  }

  .sidebar-tree::-webkit-scrollbar {
    display: none;
  }

  /* Shared row styles */
  .sidebar-row {
    display: flex;
    align-items: center;
    gap: 7px;
    height: 30px;
    /* depth-based indent: 13px base + 16px per level */
    padding: 0 13px 0 calc(13px + var(--depth, 0) * 16px);
    cursor: pointer;
    position: relative;
    color: var(--tnd-text-muted);
    font-size: 13px;
    font-weight: 500;
    transition: background 0.08s;
    user-select: none;
    outline: none;
    border-radius: 0;
  }

  .sidebar-row:hover {
    background: var(--tnd-panel2);
  }

  .sidebar-row:focus-visible {
    outline: 2px solid var(--tnd-accent);
    outline-offset: -2px;
  }

  .sidebar-row--selected {
    background: var(--tnd-accent-soft);
    color: var(--tnd-accent-text);
    font-weight: 700;
  }

  .sidebar-row--nav {
    gap: 8px;
    font-size: 13px;
  }

  .sidebar-row--placeholder {
    cursor: default;
  }

  .sidebar-row--placeholder:hover {
    background: transparent;
  }

  .sidebar-row--saved {
    gap: 8px;
    font-size: 13px;
  }

  /* Active-indicator left bar */
  .sidebar-row-accent-bar {
    position: absolute;
    left: 0;
    top: 5px;
    bottom: 5px;
    width: 3px;
    border-radius: 0 2px 2px 0;
    background: var(--tnd-accent);
  }

  /* Chevron */
  .sidebar-row-chevron {
    width: 11px;
    flex-shrink: 0;
    font-size: 10px;
    color: var(--tnd-text-faint);
    visibility: hidden;
  }

  .sidebar-row-chevron--visible {
    visibility: visible;
  }

  /* Color dot */
  .sidebar-row-color-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    flex-shrink: 0;
  }

  /* Icon (nav rows) */
  .sidebar-row-icon {
    width: 16px;
    text-align: center;
    font-size: 13px;
    flex-shrink: 0;
  }

  /* Label */
  .sidebar-row-label {
    flex: 1;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  /* Count */
  .sidebar-row-count {
    font-size: 11px;
    color: var(--tnd-text-faint);
    font-variant-numeric: tabular-nums;
    flex-shrink: 0;
  }

  /* Hint badge (keyboard shortcut) */
  .sidebar-row-hint {
    font-size: 10.5px;
    color: var(--tnd-text-faint);
    font-family: ui-monospace, monospace;
    flex-shrink: 0;
  }

  /* ── Section label row (with + button) ────────────────────────────────────── */

  .sidebar-section-label-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 14px 13px 5px;
  }

  .sidebar-section-label-row .sidebar-section-label {
    padding: 0;
  }

  .sidebar-new-group-btn {
    width: 18px;
    height: 18px;
    background: none;
    border: 1px solid var(--tnd-line-strong);
    border-radius: 3px;
    color: var(--tnd-text-faint);
    font-size: 14px;
    line-height: 1;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    padding: 0;
    font-family: inherit;
  }

  .sidebar-new-group-btn:hover {
    background: var(--tnd-panel2);
    color: var(--tnd-text);
  }

  /* ── Inline new-group input row ─────────────────────────────────────────── */

  .sidebar-new-group-row {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 4px calc(13px + var(--depth, 0) * 16px);
    height: 30px;
  }

  .sidebar-new-group-input {
    flex: 1;
    height: 22px;
    background: var(--tnd-panel2);
    border: 1px solid var(--tnd-accent);
    border-radius: 3px;
    color: var(--tnd-text);
    font-size: 12.5px;
    font-family: inherit;
    padding: 0 6px;
    outline: none;
    min-width: 0;
  }

  .sidebar-new-group-input:focus {
    border-color: var(--tnd-accent);
    box-shadow: 0 0 0 2px var(--tnd-accent-soft);
  }

  .sidebar-new-group-error {
    color: #c0392b;
    font-size: 12px;
    font-weight: 700;
    flex-shrink: 0;
    cursor: help;
  }

  /* ── Overflow button on group rows ─────────────────────────────────────── */

  .sidebar-row-overflow {
    display: none;
    align-items: center;
    justify-content: center;
    width: 18px;
    height: 18px;
    flex-shrink: 0;
    background: none;
    border: none;
    color: var(--tnd-text-faint);
    font-size: 13px;
    cursor: pointer;
    border-radius: 3px;
    padding: 0;
    font-family: inherit;
    line-height: 1;
  }

  .sidebar-row:hover .sidebar-row-overflow,
  .sidebar-row:focus-within .sidebar-row-overflow {
    display: flex;
  }

  .sidebar-row-overflow:hover {
    background: var(--tnd-panel2);
    color: var(--tnd-text);
  }

  /* ── Group overflow dropdown ────────────────────────────────────────────── */

  .group-menu-backdrop {
    position: fixed;
    inset: 0;
    z-index: 299;
  }

  .group-menu {
    position: relative;
    z-index: 300;
    margin-left: calc(13px + var(--depth, 0) * 16px + 18px);
    background: var(--tnd-panel);
    border: 1px solid var(--tnd-line-strong);
    border-radius: 5px;
    box-shadow: var(--tnd-shadow, 0 4px 12px rgba(0, 0, 0, 0.15));
    overflow: hidden;
    min-width: 140px;
  }

  .group-menu-item {
    display: block;
    width: 100%;
    padding: 9px 12px;
    text-align: left;
    background: none;
    border: none;
    border-bottom: 1px solid var(--tnd-line);
    color: var(--tnd-text-muted);
    font-size: 12.5px;
    font-family: inherit;
    cursor: pointer;
  }

  .group-menu-item:last-child {
    border-bottom: none;
  }

  .group-menu-item:hover {
    background: var(--tnd-panel2);
    color: var(--tnd-text);
  }

  .group-menu-item--danger {
    color: #c0392b;
  }

  .group-menu-item--danger:hover {
    background: rgba(192, 57, 43, 0.06);
    color: #c0392b;
  }

  /* Footer */
  .sidebar-footer {
    flex-shrink: 0;
    padding: 8px 13px;
    border-top: 1px solid var(--tnd-line);
    display: flex;
    align-items: center;
    gap: 7px;
    color: var(--tnd-text-faint);
    font-size: 11px;
  }

  .sidebar-footer-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--tnd-accent);
    flex-shrink: 0;
  }

  /* ── Responsive: sidebar slides over on narrow viewports ──────────────────── */
  @media (max-width: 699px) {
    .sidebar {
      position: fixed;
      left: 0;
      top: 0;
      bottom: 0;
      z-index: 200;
      transform: translateX(-100%);
      transition: transform 0.22s cubic-bezier(0.2, 0.8, 0.3, 1);
      width: min(300px, 88vw);
      border-right: 1px solid var(--tnd-line-strong);
      box-shadow: var(--tnd-shadow);
    }

    /* .sidebar-open class toggled by AppShell on narrow viewports */
    :global(.sidebar-open) .sidebar {
      transform: translateX(0);
    }
  }
</style>
