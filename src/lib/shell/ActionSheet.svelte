<script lang="ts">
  // ActionSheet — long-press entry row context menu (spec 0013 §Touch translation:
  // context menus / right-click → long-press).
  //
  // Callers: EntryList row onlongpress → open this sheet with the entry's id/title.
  // Actions: Open (navigate to editor), Trash (placeholder callback — real trash
  //          IPC is issue #32; emits console.log per spec scope).

  interface Action {
    id: string;
    label: string;
    destructive?: boolean;
  }

  interface Props {
    open?: boolean;
    entryTitle?: string;
    entryId?: string | null;
    onClose?: () => void;
    /** Called when user taps "Open". */
    onOpen?: (entryId: string) => void;
    /** Called when user taps "Trash". Placeholder — real IPC is #32. */
    onTrash?: (entryId: string) => void;
  }

  let {
    open = false,
    entryTitle = "Entry",
    entryId = null,
    onClose,
    onOpen,
    onTrash,
  }: Props = $props();

  const actions: Action[] = [
    { id: "open", label: "Open" },
    { id: "trash", label: "Move to Trash", destructive: true },
  ];

  function run(actionId: string): void {
    if (!entryId) return;
    if (actionId === "open") {
      onOpen?.(entryId);
    } else if (actionId === "trash") {
      // Placeholder — real trash IPC is issue #32.
      console.log("[ActionSheet] trash entry:", entryId);
      onTrash?.(entryId);
    }
    onClose?.();
  }

  function handleBackdrop(e: MouseEvent): void {
    if (e.target === e.currentTarget) onClose?.();
  }

  function handleKeydown(e: KeyboardEvent): void {
    if (e.key === "Escape") onClose?.();
  }
</script>

<svelte:window onkeydown={open ? handleKeydown : undefined} />

{#if open}
  <div class="action-sheet-backdrop" role="presentation" onclick={handleBackdrop}>
    <div class="action-sheet" role="dialog" aria-label="Entry actions" aria-modal="true">
      <div class="action-sheet-header">
        <span class="action-sheet-title">{entryTitle}</span>
      </div>
      {#each actions as action (action.id)}
        <button
          class="action-sheet-btn"
          class:action-sheet-btn--destructive={action.destructive}
          onclick={() => run(action.id)}
        >
          {action.label}
        </button>
      {/each}
      <button class="action-sheet-btn action-sheet-btn--cancel" onclick={onClose}>Cancel</button>
    </div>
  </div>
{/if}

<style>
  .action-sheet-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.4);
    z-index: 4000;
    display: flex;
    align-items: flex-end;
    padding-bottom: env(safe-area-inset-bottom, 0px);
  }

  .action-sheet {
    width: 100%;
    background: var(--tnd-panel);
    border-top-left-radius: 16px;
    border-top-right-radius: 16px;
    overflow: hidden;
    box-shadow: 0 -4px 24px rgba(0, 0, 0, 0.18);
    padding-bottom: 8px;
  }

  .action-sheet-header {
    padding: 16px 16px 8px;
    border-bottom: 1px solid var(--tnd-line);
  }

  .action-sheet-title {
    font-size: 13px;
    font-weight: 600;
    color: var(--tnd-text-muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    display: block;
  }

  .action-sheet-btn {
    display: block;
    width: 100%;
    padding: 16px;
    text-align: center;
    font-size: 17px;
    font-family: inherit;
    font-weight: 400;
    background: none;
    border: none;
    border-bottom: 1px solid var(--tnd-line);
    color: var(--tnd-accent, #3e7a52);
    cursor: pointer;
  }

  .action-sheet-btn:last-child {
    border-bottom: none;
  }

  .action-sheet-btn:active {
    background: var(--tnd-panel2);
  }

  .action-sheet-btn--destructive {
    color: #c0392b;
  }

  .action-sheet-btn--cancel {
    font-weight: 600;
    color: var(--tnd-text);
    margin-top: 8px;
    border-top: 1px solid var(--tnd-line-strong);
  }
</style>
