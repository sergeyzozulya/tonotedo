<script lang="ts">
  // ActionSheet — long-press entry row context menu (spec 0013 §Touch translation:
  // context menus / right-click → long-press).
  //
  // Actions: Open, Archive/Unarchive, Duplicate, Move to…, Move to Trash.

  interface Props {
    open?: boolean;
    entryTitle?: string;
    entryId?: string | null;
    /** True when the entry is currently archived. */
    entryArchived?: boolean;
    onClose?: () => void;
    /** Called when user taps "Open". */
    onOpen?: (entryId: string) => void;
    /** Called when user taps "Trash". */
    onTrash?: (entryId: string) => void;
    /** Called when user taps "Archive" or "Unarchive". */
    onArchive?: (entryId: string, archive: boolean) => void;
    /** Called when user taps "Duplicate". */
    onDuplicate?: (entryId: string) => void;
    /** Called when user taps "Move to…". */
    onMoveTo?: (entryId: string) => void;
  }

  let {
    open = false,
    entryTitle = "Entry",
    entryId = null,
    entryArchived = false,
    onClose,
    onOpen,
    onTrash,
    onArchive,
    onDuplicate,
    onMoveTo,
  }: Props = $props();

  function run(actionId: string): void {
    if (!entryId) return;
    if (actionId === "open") {
      onOpen?.(entryId);
    } else if (actionId === "archive") {
      onArchive?.(entryId, !entryArchived);
    } else if (actionId === "duplicate") {
      onDuplicate?.(entryId);
    } else if (actionId === "moveto") {
      onMoveTo?.(entryId);
    } else if (actionId === "trash") {
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
      <!-- Drag handle -->
      <div class="action-sheet-handle-row" aria-hidden="true">
        <div class="action-sheet-handle"></div>
      </div>

      <!-- Title row -->
      <div class="action-sheet-header">
        <span class="action-sheet-title">{entryTitle}</span>
      </div>

      <!-- Action rows -->
      <button class="action-sheet-row" onclick={() => run("open")}>Open</button>
      <button class="action-sheet-row" onclick={() => run("archive")}>
        {entryArchived ? "Unarchive" : "Archive"}
      </button>
      <button class="action-sheet-row" onclick={() => run("duplicate")}>Duplicate</button>
      <button class="action-sheet-row" onclick={() => run("moveto")}>Move to…</button>
      <button class="action-sheet-row action-sheet-row--destructive" onclick={() => run("trash")}>
        Move to Trash
      </button>

      <!-- Cancel (visually separated) -->
      <div class="action-sheet-cancel-gap" aria-hidden="true"></div>
      <button class="action-sheet-row action-sheet-row--cancel" onclick={onClose}>Cancel</button>
    </div>
  </div>
{/if}

<style>
  .action-sheet-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.45);
    z-index: 4000;
    display: flex;
    align-items: flex-end;
    padding-bottom: env(safe-area-inset-bottom, 0px);
  }

  .action-sheet {
    width: 100%;
    background: var(--tnd-panel2);
    border-top-left-radius: max(16px, var(--tnd-radius));
    border-top-right-radius: max(16px, var(--tnd-radius));
    overflow: hidden;
    box-shadow: var(--tnd-shadow, 0 -4px 24px rgba(0, 0, 0, 0.22));
    padding-bottom: 8px;
    font-family: var(--tnd-font-ui);
  }

  /* Pull-handle */
  .action-sheet-handle-row {
    display: flex;
    justify-content: center;
    padding: 10px 0 4px;
  }

  .action-sheet-handle {
    width: 36px;
    height: 4px;
    background: var(--tnd-line-strong);
    border-radius: 2px;
  }

  .action-sheet-header {
    padding: 4px 18px 12px;
    border-bottom: 1px solid var(--tnd-line);
  }

  .action-sheet-title {
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    color: var(--tnd-text-faint);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    display: block;
    font-family: var(--tnd-font-ui);
  }

  /* Individual action rows */
  .action-sheet-row {
    display: block;
    width: 100%;
    padding: 15px 18px;
    text-align: left;
    font-size: 15px;
    font-family: var(--tnd-font-ui);
    font-weight: 500;
    background: var(--tnd-panel);
    border: none;
    border-bottom: 1px solid var(--tnd-line);
    color: var(--tnd-accent-text);
    cursor: pointer;
  }

  .action-sheet-row:first-of-type {
    margin-top: 8px;
    border-top: 1px solid var(--tnd-line);
  }

  .action-sheet-row:active {
    background: var(--tnd-panel2);
  }

  .action-sheet-row--destructive {
    color: var(--tnd-chip-red-fg, #c0392b);
  }

  /* Cancel row — visual gap + stronger weight */
  .action-sheet-cancel-gap {
    height: 8px;
    background: var(--tnd-panel2);
    border-top: 1px solid var(--tnd-line);
  }

  .action-sheet-row--cancel {
    font-weight: 700;
    color: var(--tnd-text-muted);
    border-bottom: none;
    border-top: none;
    margin-top: 0;
  }
</style>
