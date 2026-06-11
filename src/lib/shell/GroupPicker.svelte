<script lang="ts">
  // GroupPicker — modal group-picker dialog used by "Move to…" in the entry
  // action sheet and the group context menu.  Reuses the palette/list look:
  // a search input + filtered list of group rows.
  //
  // Props:
  //   groups      — flat list of GroupMeta from list_groups()
  //   title       — heading text (e.g. "Move entry to…")
  //   onPick      — called with the selected group path (or "" for root)
  //   onClose     — called when the user dismisses without picking

  import type { GroupMeta } from "../ipc/types.js";
  import { fuzzyMatch } from "../commands/index.js";

  interface Props {
    groups: GroupMeta[];
    title?: string;
    onPick: (path: string) => void;
    onClose: () => void;
  }

  let { groups, title = "Move to…", onPick, onClose }: Props = $props();

  let query = $state("");
  let selectedIndex = $state(0);
  let inputEl = $state<HTMLInputElement | null>(null);

  $effect(() => {
    requestAnimationFrame(() => inputEl?.focus());
  });

  // Build display list: "Library root" first, then filtered groups.
  const displayList = $derived.by(() => {
    const q = query.trim().toLowerCase();
    const all: Array<{ path: string; name: string; display: string }> = [
      { path: "", name: "Library root", display: "Library root" },
      ...groups.map((g) => ({
        path: g.path,
        name: g.name,
        display: g.path,
      })),
    ];
    if (!q) return all;
    return all.filter(
      (g) =>
        g.display.toLowerCase().includes(q) ||
        g.name.toLowerCase().includes(q) ||
        fuzzyMatch(q, g.display) !== null,
    );
  });

  function onQueryInput(e: Event): void {
    query = (e.target as HTMLInputElement).value;
    selectedIndex = 0;
  }

  function pick(path: string): void {
    onPick(path);
    onClose();
  }

  function handleKeydown(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      e.stopPropagation();
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      selectedIndex = Math.min(selectedIndex + 1, displayList.length - 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      selectedIndex = Math.max(selectedIndex - 1, 0);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const item = displayList[selectedIndex];
      if (item) pick(item.path);
    }
  }
</script>

<svelte:window onkeydown={handleKeydown} />

<div
  class="gp-backdrop"
  role="presentation"
  onclick={onClose}
  onkeydown={(e) => e.key === "Escape" && onClose()}
>
  <div
    class="gp-dialog"
    role="dialog"
    aria-label={title}
    aria-modal="true"
    tabindex="-1"
    onclick={(e) => e.stopPropagation()}
    onkeydown={(e) => e.stopPropagation()}
  >
    <div class="gp-header">
      <span class="gp-title">{title}</span>
    </div>
    <div class="gp-search">
      <input
        bind:this={inputEl}
        class="gp-input"
        type="text"
        placeholder="Filter groups…"
        aria-label="Filter groups"
        value={query}
        oninput={onQueryInput}
      />
    </div>
    <div class="gp-list" role="listbox" aria-label="Groups">
      {#each displayList as item, i (item.path)}
        <button
          class="gp-item"
          class:gp-item--selected={i === selectedIndex}
          role="option"
          aria-selected={i === selectedIndex}
          onclick={() => pick(item.path)}
          onmouseenter={() => (selectedIndex = i)}
        >
          {#if item.path === ""}
            <span class="gp-item-root">Library root</span>
          {:else}
            <span class="gp-item-path">{item.path}</span>
          {/if}
        </button>
      {:else}
        <div class="gp-empty">No groups found</div>
      {/each}
    </div>
  </div>
</div>

<style>
  .gp-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.5);
    z-index: 5000;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
  }

  .gp-dialog {
    background: var(--tnd-panel);
    border: 1px solid var(--tnd-line-strong);
    border-radius: var(--tnd-radius, 8px);
    box-shadow: var(--tnd-shadow, 0 8px 32px rgba(0, 0, 0, 0.2));
    width: min(420px, 100%);
    display: flex;
    flex-direction: column;
    overflow: hidden;
    max-height: 60vh;
  }

  .gp-header {
    padding: 14px 16px 10px;
    border-bottom: 1px solid var(--tnd-line);
    flex-shrink: 0;
  }

  .gp-title {
    font-size: 13px;
    font-weight: 700;
    color: var(--tnd-text);
    letter-spacing: -0.01em;
  }

  .gp-search {
    padding: 8px 12px;
    border-bottom: 1px solid var(--tnd-line);
    flex-shrink: 0;
  }

  .gp-input {
    width: 100%;
    height: 30px;
    background: var(--tnd-panel2);
    border: 1px solid var(--tnd-line-strong);
    border-radius: var(--tnd-radius, 5px);
    color: var(--tnd-text);
    font-size: 13px;
    font-family: inherit;
    padding: 0 10px;
    outline: none;
    box-sizing: border-box;
  }

  .gp-input:focus {
    border-color: var(--tnd-accent);
    box-shadow: 0 0 0 2px var(--tnd-accent-soft);
  }

  .gp-list {
    flex: 1;
    overflow-y: auto;
    padding: 4px 0;
    scrollbar-width: thin;
    scrollbar-color: var(--tnd-line-strong) transparent;
  }

  .gp-item {
    display: block;
    width: 100%;
    padding: 8px 16px;
    text-align: left;
    background: none;
    border: none;
    cursor: pointer;
    font-family: inherit;
    font-size: 13px;
    color: var(--tnd-text-muted);
  }

  .gp-item:hover,
  .gp-item--selected {
    background: var(--tnd-accent-soft);
    color: var(--tnd-accent-text);
  }

  .gp-item-root {
    color: var(--tnd-text-faint);
    font-style: italic;
  }

  .gp-item--selected .gp-item-root {
    color: inherit;
    font-style: normal;
  }

  .gp-item-path {
    font-family: ui-monospace, monospace;
    font-size: 12px;
  }

  .gp-empty {
    padding: 16px;
    text-align: center;
    color: var(--tnd-text-faint);
    font-size: 13px;
  }
</style>
