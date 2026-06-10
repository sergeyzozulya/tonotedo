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
  import type { PersonMeta } from "../ipc/types.js";
  import PeopleSection from "../people/PeopleSection.svelte";

  interface Props {
    /** Root-level tree nodes (already sorted + aggregated). */
    tree: GroupNode[];
    /** Currently selected group path (or null for "all"). */
    selectedPath: string | null;
    /** Called when the user selects a group. */
    onGroupSelect: (path: string | null) => void;
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
  }

  let {
    tree,
    selectedPath,
    onGroupSelect,
    people = [],
    selectedPersonSlug = null,
    onPersonSelect,
    onTagsOpen,
    tagsOpen = false,
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
</script>

<nav class="sidebar" data-focus-zone="sidebar" aria-label="Group navigation">
  <!-- Fixed nav rows (Calendar / Search — placeholders, no route yet) -->
  <div class="sidebar-fixed">
    <div class="sidebar-row sidebar-row--nav" role="button" tabindex="0">
      <span class="sidebar-row-icon">📅</span>
      <span class="sidebar-row-label">Calendar</span>
      <kbd class="sidebar-row-hint">⌘⌥M</kbd>
    </div>
    <div class="sidebar-row sidebar-row--nav" role="button" tabindex="0">
      <span class="sidebar-row-icon">🔍</span>
      <span class="sidebar-row-label">Search</span>
      <kbd class="sidebar-row-hint">⌘P</kbd>
    </div>
  </div>

  <!-- Groups section -->
  <div class="sidebar-section-label">Groups</div>

  <div class="sidebar-tree" role="tree">
    {#each tree as node (node.path)}
      {@render treeNode(node, 0)}
    {/each}
  </div>

  <!-- Tags row (opens TagBrowser in main zone) -->
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
  </div>
  {#if open}
    {#each node.children as child (child.path)}
      {@render treeNode(child, depth + 1)}
    {/each}
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
