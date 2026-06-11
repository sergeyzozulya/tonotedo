<script lang="ts">
  // TagBrowser — main-zone view for browsing and managing the tag hierarchy
  // (spec 0004, issue #22).
  //
  // Features:
  //   • Hierarchy display: parent/child nesting via "/" in tag names.
  //   • Metadata: description shown on hover, color chip, icon.
  //   • Counts per tag.
  //   • Unmanaged/non-canonical flags (disallowed characters).
  //   • Actions: rename, merge, delete — calls ipc.rename_tag / merge_tag / delete_tag.
  //   • Expandable/collapsible parent nodes.

  import { ipc } from "../ipc/index.js";
  import { buildTagTree, flattenTagTree, isNonCanonical } from "./tag-utils.js";
  import type { TagNode } from "./tag-utils.js";
  import type { TagMeta } from "../ipc/types.js";

  interface Props {
    /** Called when a tag row is clicked (for future entry filtering). */
    onTagSelect?: (tagName: string) => void;
  }

  let { onTagSelect }: Props = $props();

  // ── Data loading ──────────────────────────────────────────────────────────────

  let tags = $state<TagMeta[]>([]);
  let loading = $state(false);
  let loadError = $state<string | null>(null);

  async function loadTags(): Promise<void> {
    loading = true;
    loadError = null;
    const result = await ipc.tag_index();
    loading = false;
    if (result.ok) {
      tags = result.value;
    } else {
      loadError = result.error.message;
    }
  }

  $effect(() => {
    loadTags();
    const unsub = ipc.on("index_changed", loadTags);
    return unsub;
  });

  // ── Tree ──────────────────────────────────────────────────────────────────────

  const tree = $derived(buildTagTree(tags));
  const flat = $derived(flattenTagTree(tree));

  // ── Collapsed state ───────────────────────────────────────────────────────────

  const collapsed = $state(new Map<string, boolean>());

  function isCollapsed(name: string): boolean {
    return collapsed.get(name) ?? false;
  }

  function toggleCollapsed(name: string): void {
    collapsed.set(name, !isCollapsed(name));
  }

  /** Returns true if this node should be rendered (no collapsed ancestor). */
  function isVisible(node: TagNode): boolean {
    const parts = node.name.split("/");
    for (let i = 1; i < parts.length; i++) {
      const ancestor = parts.slice(0, i).join("/");
      if (isCollapsed(ancestor)) return false;
    }
    return true;
  }

  // ── Actions ───────────────────────────────────────────────────────────────────

  let actionTarget = $state<string | null>(null);
  let actionMode = $state<"rename" | "merge" | "delete" | null>(null);
  let actionInput = $state("");
  let actionError = $state<string | null>(null);
  let actionBusy = $state(false);

  function openAction(mode: "rename" | "merge" | "delete", tagName: string): void {
    actionTarget = tagName;
    actionMode = mode;
    actionInput = mode === "rename" ? tagName : "";
    actionError = null;
  }

  function closeAction(): void {
    actionTarget = null;
    actionMode = null;
    actionInput = "";
    actionError = null;
  }

  async function commitAction(): Promise<void> {
    if (!actionTarget || !actionMode) return;
    actionBusy = true;
    actionError = null;

    let result: { ok: boolean; error?: { message: string } };
    if (actionMode === "rename") {
      if (!actionInput.trim()) {
        actionError = "New name is required.";
        actionBusy = false;
        return;
      }
      result = await ipc.rename_tag(actionTarget, actionInput.trim());
    } else if (actionMode === "merge") {
      if (!actionInput.trim()) {
        actionError = "Target tag is required.";
        actionBusy = false;
        return;
      }
      result = await ipc.merge_tag(actionTarget, actionInput.trim());
    } else {
      result = await ipc.delete_tag(actionTarget);
    }

    actionBusy = false;
    if (result.ok) {
      closeAction();
      await loadTags();
    } else {
      actionError = (result as { ok: false; error: { message: string } }).error.message;
    }
  }

  // ── Color helpers ─────────────────────────────────────────────────────────────

  function chipBg(color: string): string {
    const named = ["slate", "red", "amber", "green", "teal", "blue", "violet", "pink"];
    if (named.includes(color)) return `var(--tnd-chip-${color}-bg)`;
    return color;
  }

  function chipFg(color: string): string {
    const named = ["slate", "red", "amber", "green", "teal", "blue", "violet", "pink"];
    if (named.includes(color)) return `var(--tnd-chip-${color}-fg)`;
    return color;
  }
</script>

<div class="tag-browser">
  <header class="tb-header">
    <h2 class="tb-title">Tags</h2>
    <span class="tb-count">{tags.length} tags</span>
  </header>

  {#if loading}
    <div class="tb-status">Loading…</div>
  {:else if loadError}
    <div class="tb-status tb-status--error">{loadError}</div>
  {:else if flat.length === 0}
    <div class="tb-status">No tags yet.</div>
  {:else}
    <ul class="tb-list" role="tree">
      {#each flat as node (node.name)}
        {#if isVisible(node)}
          {@const hasChildren = node.children.length > 0}
          {@const open = hasChildren && !isCollapsed(node.name)}
          {@const nonCanon = isNonCanonical(node.name)}
          <li
            class="tb-row"
            class:tb-row--selected={actionTarget === node.name}
            role="treeitem"
            aria-selected={actionTarget === node.name}
            aria-expanded={hasChildren ? open : undefined}
            style="--depth: {node.depth};"
          >
            <!-- Chevron for parent nodes -->
            <span
              class="tb-chevron"
              class:tb-chevron--visible={hasChildren}
              onclick={() => hasChildren && toggleCollapsed(node.name)}
              role="button"
              tabindex={hasChildren ? 0 : -1}
              onkeydown={(e) => e.key === "Enter" && hasChildren && toggleCollapsed(node.name)}
              aria-label={open ? "Collapse" : "Expand"}
            >
              {#if hasChildren}
                {open ? "▾" : "▸"}
              {/if}
            </span>

            <!-- Color chip / icon -->
            {#if node.meta}
              <span
                class="tb-color-chip"
                style="background: {chipBg(node.meta.color)}; color: {chipFg(node.meta.color)};"
                title={node.meta.description ?? ""}
              >
                {node.meta.icon ?? "#"}
              </span>
            {:else}
              <span class="tb-color-chip tb-color-chip--synth" title="Synthesised parent">#</span>
            {/if}

            <!-- Label -->
            <button
              class="tb-label-btn"
              onclick={() => onTagSelect?.(node.name)}
              title={node.meta?.description ?? node.name}
            >
              {node.label}
              {#if node.synthesised}
                <span class="tb-badge tb-badge--synth" title="No metadata for this tag"
                  >virtual</span
                >
              {/if}
              {#if nonCanon}
                <span
                  class="tb-badge tb-badge--noncanon"
                  title="Tag contains non-canonical characters">!</span
                >
              {/if}
              {#if node.meta?.scopePath}
                <span
                  class="tb-badge tb-badge--scoped"
                  title="Scoped to group: {node.meta.scopePath}"
                  >scope:{node.meta.scopePath.split("/").at(-1)}</span
                >
              {/if}
            </button>

            <!-- Count -->
            {#if (node.meta?.count ?? 0) > 0}
              <span class="tb-count-badge">{node.meta!.count}</span>
            {/if}

            <!-- Action buttons -->
            <span class="tb-actions" role="group" aria-label="Actions for {node.name}">
              <button
                class="tb-action-btn"
                onclick={() => openAction("rename", node.name)}
                title="Rename"
                aria-label="Rename {node.name}"
              >
                ✏️
              </button>
              <button
                class="tb-action-btn"
                onclick={() => openAction("merge", node.name)}
                title="Merge into another tag"
                aria-label="Merge {node.name}"
              >
                ⇢
              </button>
              <button
                class="tb-action-btn tb-action-btn--delete"
                onclick={() => openAction("delete", node.name)}
                title="Delete tag metadata"
                aria-label="Delete {node.name}"
              >
                ✕
              </button>
            </span>
          </li>
        {/if}
      {/each}
    </ul>
  {/if}
</div>

<!-- Action popover / inline form -->
{#if actionMode && actionTarget}
  <div
    class="action-backdrop"
    role="presentation"
    onclick={(e) => e.target === e.currentTarget && closeAction()}
  >
    <div class="action-dialog" role="dialog" aria-modal="true">
      <header class="action-dialog-header">
        <span class="action-dialog-title">
          {#if actionMode === "rename"}Rename <code>{actionTarget}</code>{/if}
          {#if actionMode === "merge"}Merge <code>{actionTarget}</code> into…{/if}
          {#if actionMode === "delete"}Delete <code>{actionTarget}</code>?{/if}
        </span>
        <button class="dialog-close-btn" aria-label="Cancel" onclick={closeAction}>✕</button>
      </header>

      <div class="action-dialog-body">
        {#if actionMode === "rename"}
          <label class="al" for="action-input">New name</label>
          <input
            id="action-input"
            class="action-input"
            type="text"
            bind:value={actionInput}
            placeholder="new-tag-name"
            autocomplete="off"
            spellcheck={false}
          />
        {:else if actionMode === "merge"}
          <label class="al" for="action-input">Target tag</label>
          <input
            id="action-input"
            class="action-input"
            type="text"
            bind:value={actionInput}
            placeholder="existing-tag-name"
            autocomplete="off"
            spellcheck={false}
          />
          <p class="action-note">
            All entries tagged <code>{actionTarget}</code> will be retagged as the target.
          </p>
        {:else if actionMode === "delete"}
          <p class="action-note">
            The tag metadata will be removed. Entries that carry <code>{actionTarget}</code> will keep
            the string; it will reappear as "unmanaged" in the browser.
          </p>
        {/if}

        {#if actionError}
          <div class="action-error">{actionError}</div>
        {/if}
      </div>

      <footer class="action-dialog-footer">
        <button class="btn btn--secondary" onclick={closeAction}>Cancel</button>
        <button
          class="btn"
          class:btn--danger={actionMode === "delete"}
          class:btn--primary={actionMode !== "delete"}
          disabled={actionBusy}
          onclick={commitAction}
        >
          {#if actionBusy}Working…{:else if actionMode === "rename"}Rename{:else if actionMode === "merge"}Merge{:else}Delete{/if}
        </button>
      </footer>
    </div>
  </div>
{/if}

<style>
  .tag-browser {
    display: flex;
    flex-direction: column;
    height: 100%;
    background: var(--tnd-bg);
    overflow: hidden;
  }

  /* ── Header ──────────────────────────────────────────────────────────────── */

  .tb-header {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 20px 24px 14px;
    border-bottom: 1px solid var(--tnd-line);
    background: var(--tnd-panel);
    flex-shrink: 0;
  }

  .tb-title {
    font-size: 18px;
    font-weight: 700;
    color: var(--tnd-text);
    margin: 0;
  }

  .tb-count {
    font-size: 11px;
    color: var(--tnd-text-faint);
    font-variant-numeric: tabular-nums;
  }

  /* ── Status ──────────────────────────────────────────────────────────────── */

  .tb-status {
    padding: 24px;
    font-size: 13px;
    color: var(--tnd-text-faint);
  }

  .tb-status--error {
    color: var(--tnd-chip-red-fg);
  }

  /* ── Tag list ────────────────────────────────────────────────────────────── */

  .tb-list {
    list-style: none;
    margin: 0;
    padding: 8px 0;
    overflow-y: auto;
    flex: 1;
  }

  .tb-row {
    display: flex;
    align-items: center;
    gap: 6px;
    height: 32px;
    /* depth-based indent */
    padding: 0 12px 0 calc(12px + var(--depth, 0) * 18px);
    cursor: default;
    position: relative;
    color: var(--tnd-text-muted);
    font-size: 13px;
    transition: background 0.07s;
  }

  .tb-row:hover {
    background: var(--tnd-panel2);
  }

  .tb-row:hover .tb-actions {
    opacity: 1;
  }

  .tb-row--selected {
    background: var(--tnd-accent-soft);
  }

  /* Chevron */
  .tb-chevron {
    width: 12px;
    flex-shrink: 0;
    font-size: 10px;
    color: var(--tnd-text-faint);
    cursor: pointer;
    visibility: hidden;
    user-select: none;
    border: none;
    background: transparent;
    padding: 0;
    line-height: 1;
  }

  .tb-chevron--visible {
    visibility: visible;
  }

  /* Color chip */
  .tb-color-chip {
    width: 20px;
    height: 20px;
    border-radius: 4px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 11px;
    flex-shrink: 0;
    user-select: none;
    cursor: help;
  }

  .tb-color-chip--synth {
    background: var(--tnd-panel2);
    color: var(--tnd-text-faint);
  }

  /* Label button */
  .tb-label-btn {
    flex: 1;
    background: transparent;
    border: none;
    cursor: pointer;
    font-family: inherit;
    font-size: 13px;
    color: var(--tnd-text);
    font-weight: 500;
    text-align: left;
    padding: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    display: flex;
    align-items: center;
    gap: 5px;
  }

  .tb-label-btn:hover {
    color: var(--tnd-accent-text);
  }

  /* Badges */
  .tb-badge {
    font-size: 9px;
    font-weight: 700;
    letter-spacing: 0.04em;
    padding: 1px 4px;
    border-radius: 3px;
    text-transform: uppercase;
    flex-shrink: 0;
  }

  .tb-badge--synth {
    background: var(--tnd-panel2);
    color: var(--tnd-text-faint);
  }

  .tb-badge--noncanon {
    background: var(--tnd-chip-amber-bg);
    color: var(--tnd-chip-amber-fg);
  }

  .tb-badge--scoped {
    background: var(--tnd-chip-teal-bg, #e0f7f4);
    color: var(--tnd-chip-teal-fg, #147a6e);
  }

  /* Count */
  .tb-count-badge {
    font-size: 11px;
    color: var(--tnd-text-faint);
    font-variant-numeric: tabular-nums;
    flex-shrink: 0;
  }

  /* Actions */
  .tb-actions {
    display: flex;
    gap: 2px;
    opacity: 0;
    transition: opacity 0.1s;
    flex-shrink: 0;
  }

  .tb-action-btn {
    background: transparent;
    border: none;
    cursor: pointer;
    font-size: 11px;
    padding: 2px 5px;
    border-radius: 3px;
    color: var(--tnd-text-faint);
    font-family: inherit;
    line-height: 1;
    transition: background 0.07s;
  }

  .tb-action-btn:hover {
    background: var(--tnd-panel2);
    color: var(--tnd-text-muted);
  }

  .tb-action-btn--delete:hover {
    background: var(--tnd-chip-red-bg);
    color: var(--tnd-chip-red-fg);
  }

  /* ── Action dialog ───────────────────────────────────────────────────────── */

  .action-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.4);
    z-index: 500;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .action-dialog {
    background: var(--tnd-panel);
    border: 1px solid var(--tnd-line-strong);
    border-radius: 8px;
    box-shadow: var(--tnd-shadow);
    width: 360px;
    max-width: calc(100vw - 32px);
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .action-dialog-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 16px;
    border-bottom: 1px solid var(--tnd-line);
  }

  .action-dialog-title {
    font-size: 13.5px;
    font-weight: 600;
    color: var(--tnd-text);
  }

  .action-dialog-title code {
    font-family: ui-monospace, monospace;
    font-size: 12px;
    background: var(--tnd-panel2);
    padding: 1px 4px;
    border-radius: 3px;
  }

  .dialog-close-btn {
    background: transparent;
    border: none;
    cursor: pointer;
    color: var(--tnd-text-faint);
    font-size: 13px;
    padding: 2px 6px;
    border-radius: 3px;
    font-family: inherit;
  }

  .dialog-close-btn:hover {
    background: var(--tnd-panel2);
  }

  .action-dialog-body {
    padding: 14px 16px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .al {
    font-size: 11.5px;
    font-weight: 600;
    color: var(--tnd-text-muted);
    user-select: none;
  }

  .action-input {
    font-size: 13px;
    padding: 6px 8px;
    border: 1px solid var(--tnd-line-strong);
    border-radius: 4px;
    background: var(--tnd-bg);
    color: var(--tnd-text);
    font-family: inherit;
    outline: none;
  }

  .action-input:focus {
    border-color: var(--tnd-accent);
  }

  .action-note {
    font-size: 12px;
    color: var(--tnd-text-faint);
    margin: 0;
    line-height: 1.5;
  }

  .action-note code {
    font-family: ui-monospace, monospace;
    background: var(--tnd-panel2);
    padding: 1px 3px;
    border-radius: 2px;
  }

  .action-error {
    font-size: 12px;
    color: var(--tnd-chip-red-fg);
    background: var(--tnd-chip-red-bg);
    padding: 6px 8px;
    border-radius: 4px;
  }

  .action-dialog-footer {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    padding: 10px 16px 14px;
    border-top: 1px solid var(--tnd-line);
  }

  .btn {
    font-size: 13px;
    padding: 5px 14px;
    border-radius: 5px;
    cursor: pointer;
    font-family: inherit;
    font-weight: 600;
    border: 1px solid transparent;
    transition: background 0.08s;
  }

  .btn:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }

  .btn--secondary {
    background: transparent;
    border-color: var(--tnd-line-strong);
    color: var(--tnd-text-muted);
  }

  .btn--secondary:hover:not(:disabled) {
    background: var(--tnd-panel2);
  }

  .btn--primary {
    background: var(--tnd-accent);
    color: #fff;
    border-color: var(--tnd-accent);
  }

  .btn--primary:hover:not(:disabled) {
    opacity: 0.9;
  }

  .btn--danger {
    background: var(--tnd-chip-red-bg);
    color: var(--tnd-chip-red-fg);
    border-color: var(--tnd-chip-red-fg);
  }

  .btn--danger:hover:not(:disabled) {
    background: var(--tnd-chip-red-fg);
    color: #fff;
  }
</style>
