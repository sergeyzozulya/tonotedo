<script lang="ts">
  // TrashView — list trashed items; restore or permanently purge them.
  // (spec 0002 §Lifecycle, spec 0003 §Operations, spec 0009 §trash view)
  //
  // Mounted in the "Browse" section of the Sidebar and rendered in the main
  // editor zone when selected, similar to TagBrowser.

  import { ipc } from "../ipc/index.js";
  import type { TrashManifest } from "../ipc/types.js";

  interface Props {
    /** Called after a successful restore so the caller can refresh. */
    onRestored?: () => void;
  }

  let { onRestored }: Props = $props();

  let items = $state<TrashManifest[]>([]);
  let loading = $state(false);
  let error = $state<string | null>(null);
  let confirmPurgeId = $state<string | null>(null);

  async function load(): Promise<void> {
    loading = true;
    error = null;
    const res = await ipc.trash_list();
    loading = false;
    if (res.ok) {
      items = res.value;
    } else {
      error = res.error.message;
    }
  }

  async function restore(trashId: string): Promise<void> {
    const res = await ipc.trash_restore(trashId);
    if (res.ok) {
      await load();
      onRestored?.();
    } else {
      error = res.error.message;
    }
  }

  async function purge(trashId: string): Promise<void> {
    const res = await ipc.trash_purge(trashId);
    confirmPurgeId = null;
    if (res.ok) {
      await load();
    } else {
      error = res.error.message;
    }
  }

  function formatDate(iso: string): string {
    try {
      return new Date(iso).toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
    } catch {
      return iso.slice(0, 16);
    }
  }

  $effect(() => {
    void load();
  });
</script>

<section class="trash-view" aria-label="Trash">
  <header class="trash-header">
    <span class="trash-title">Trash</span>
    {#if items.length > 0}
      <span class="trash-count">{items.length}</span>
    {/if}
  </header>

  {#if loading}
    <div class="trash-state">Loading…</div>
  {:else if error}
    <div class="trash-state trash-state--error">{error}</div>
  {:else if items.length === 0}
    <div class="trash-state trash-state--empty">Trash is empty</div>
  {:else}
    <ul class="trash-list" role="list">
      {#each items as item (item.trashId)}
        <li class="trash-item">
          <div class="trash-item-main">
            <span class="trash-item-kind" aria-label={item.kind}
              >{item.kind === "group" ? "📁" : "📄"}</span
            >
            <div class="trash-item-info">
              <span class="trash-item-path">{item.originalRelPath}</span>
              <span class="trash-item-date">{formatDate(item.trashedAt)}</span>
            </div>
          </div>
          <div class="trash-item-actions">
            {#if confirmPurgeId === item.trashId}
              <span class="trash-confirm-label">Delete permanently?</span>
              <button class="trash-btn trash-btn--danger" onclick={() => purge(item.trashId)}
                >Yes, delete</button
              >
              <button class="trash-btn" onclick={() => (confirmPurgeId = null)}>Cancel</button>
            {:else}
              <button
                class="trash-btn trash-btn--restore"
                onclick={() => restore(item.trashId)}
                title="Restore to original location">Restore</button
              >
              <button
                class="trash-btn trash-btn--purge"
                onclick={() => (confirmPurgeId = item.trashId)}
                title="Permanently delete">Delete</button
              >
            {/if}
          </div>
        </li>
      {/each}
    </ul>
  {/if}
</section>

<style>
  .trash-view {
    display: flex;
    flex-direction: column;
    height: 100%;
    overflow: hidden;
    background: var(--tnd-bg);
  }

  .trash-header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 12px 16px 10px;
    border-bottom: 1px solid var(--tnd-line);
    flex-shrink: 0;
  }

  .trash-title {
    font-size: 15px;
    font-weight: 700;
    color: var(--tnd-text);
    letter-spacing: -0.01em;
  }

  .trash-count {
    font-size: 11.5px;
    color: var(--tnd-text-faint);
    font-variant-numeric: tabular-nums;
    font-family: ui-monospace, monospace;
  }

  .trash-state {
    display: flex;
    align-items: center;
    justify-content: center;
    flex: 1;
    color: var(--tnd-text-faint);
    font-size: 13.5px;
    padding: 24px;
  }

  .trash-state--empty {
    color: var(--tnd-text-faint);
    font-style: italic;
  }

  .trash-state--error {
    color: var(--tnd-chip-red-fg, #c0392b);
    text-align: center;
  }

  .trash-list {
    list-style: none;
    margin: 0;
    padding: 0;
    flex: 1;
    overflow-y: auto;
    scrollbar-width: thin;
    scrollbar-color: var(--tnd-line-strong) transparent;
  }

  .trash-item {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 12px 16px;
    border-bottom: 1px solid var(--tnd-line);
    transition: background 0.08s;
  }

  .trash-item:hover {
    background: var(--tnd-panel2);
  }

  .trash-item-main {
    display: flex;
    align-items: flex-start;
    gap: 10px;
  }

  .trash-item-kind {
    font-size: 16px;
    flex-shrink: 0;
    margin-top: 1px;
  }

  .trash-item-info {
    display: flex;
    flex-direction: column;
    gap: 3px;
    min-width: 0;
    flex: 1;
  }

  .trash-item-path {
    font-size: 13px;
    font-weight: 500;
    color: var(--tnd-text);
    word-break: break-all;
    line-height: 1.3;
  }

  .trash-item-date {
    font-size: 11px;
    color: var(--tnd-text-faint);
  }

  .trash-item-actions {
    display: flex;
    align-items: center;
    gap: 7px;
    flex-wrap: wrap;
  }

  .trash-confirm-label {
    font-size: 12px;
    color: var(--tnd-text-muted);
  }

  .trash-btn {
    padding: 4px 10px;
    border-radius: 4px;
    border: 1px solid var(--tnd-line-strong);
    background: var(--tnd-panel);
    color: var(--tnd-text-muted);
    font-size: 12px;
    font-family: inherit;
    cursor: pointer;
    white-space: nowrap;
  }

  .trash-btn:hover {
    background: var(--tnd-panel2);
  }

  .trash-btn--restore {
    color: var(--tnd-accent-text, #3e7a52);
    border-color: var(--tnd-accent);
  }

  .trash-btn--restore:hover {
    background: var(--tnd-accent-soft);
  }

  .trash-btn--purge {
    color: var(--tnd-text-faint);
  }

  .trash-btn--danger {
    color: #c0392b;
    border-color: #c0392b;
  }

  .trash-btn--danger:hover {
    background: rgba(192, 57, 43, 0.08);
  }
</style>
