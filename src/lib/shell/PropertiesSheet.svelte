<script lang="ts">
  // PropertiesSheet — slide-up bottom sheet wrapping PropertiesPanel for narrow
  // viewports (spec 0013: properties panel → bottom sheet on phones).

  import PropertiesPanel from "../panel/PropertiesPanel.svelte";
  import type { ChangeSpec } from "../panel/frontmatter-view.js";

  interface Props {
    open?: boolean;
    docText?: string;
    onEdit?: (change: ChangeSpec) => void;
    onClose?: () => void;
    groupPath?: string | null;
  }

  let { open = false, docText = "", onEdit, onClose, groupPath = null }: Props = $props();

  function handleBackdrop(e: MouseEvent): void {
    if (e.target === e.currentTarget) onClose?.();
  }

  function handleKeydown(e: KeyboardEvent): void {
    if (e.key === "Escape") onClose?.();
  }
</script>

<svelte:window onkeydown={open ? handleKeydown : undefined} />

{#if open}
  <!-- Backdrop -->
  <div class="props-sheet-backdrop" role="presentation" onclick={handleBackdrop}>
    <div class="props-sheet" role="dialog" aria-label="Properties" aria-modal="true">
      <!-- Drag handle -->
      <div class="props-sheet-handle-row" aria-hidden="true">
        <div class="props-sheet-handle"></div>
      </div>

      <!-- Header row -->
      <div class="props-sheet-header">
        <span class="props-sheet-title">Properties</span>
        <button class="props-sheet-close" onclick={onClose} aria-label="Close properties">
          <svg
            viewBox="0 0 20 20"
            width="16"
            height="16"
            fill="none"
            stroke="currentColor"
            stroke-width="1.8"
            stroke-linecap="round"
            aria-hidden="true"
          >
            <path d="M5 5l10 10M15 5L5 15" />
          </svg>
        </button>
      </div>

      <div class="props-sheet-body">
        <PropertiesPanel {docText} {onEdit} {groupPath} />
      </div>
    </div>
  </div>
{/if}

<style>
  .props-sheet-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.45);
    z-index: 3000;
    display: flex;
    align-items: flex-end;
  }

  .props-sheet {
    width: 100%;
    max-height: 80vh;
    background: var(--tnd-panel2);
    border-top-left-radius: max(16px, var(--tnd-radius));
    border-top-right-radius: max(16px, var(--tnd-radius));
    display: flex;
    flex-direction: column;
    overflow: hidden;
    box-shadow: var(--tnd-shadow, 0 -4px 24px rgba(0, 0, 0, 0.22));
  }

  /* Pull-handle row: centred above the header */
  .props-sheet-handle-row {
    display: flex;
    justify-content: center;
    padding: 10px 0 4px;
    flex-shrink: 0;
  }

  .props-sheet-handle {
    width: 36px;
    height: 4px;
    background: var(--tnd-line-strong);
    border-radius: 2px;
  }

  .props-sheet-header {
    display: flex;
    align-items: center;
    padding: 6px 16px 10px;
    border-bottom: 1px solid var(--tnd-line);
    flex-shrink: 0;
  }

  .props-sheet-title {
    flex: 1;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    color: var(--tnd-text-faint);
    font-family: var(--tnd-font-ui);
  }

  .props-sheet-close {
    background: none;
    border: none;
    color: var(--tnd-text-muted);
    cursor: pointer;
    padding: 4px;
    line-height: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: var(--tnd-radius);
  }

  .props-sheet-close:active {
    background: var(--tnd-panel);
  }

  .props-sheet-body {
    flex: 1;
    overflow-y: auto;
    min-height: 200px;
    max-height: calc(80vh - 80px);
    background: var(--tnd-panel);
  }
</style>
