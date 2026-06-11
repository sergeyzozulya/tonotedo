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
      <!-- Handle + header -->
      <div class="props-sheet-header">
        <div class="props-sheet-handle" aria-hidden="true"></div>
        <span class="props-sheet-title">Properties</span>
        <button class="props-sheet-close" onclick={onClose} aria-label="Close properties">×</button>
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
    background: rgba(0, 0, 0, 0.4);
    z-index: 3000;
    display: flex;
    align-items: flex-end;
  }

  .props-sheet {
    width: 100%;
    max-height: 80vh;
    background: var(--tnd-panel);
    border-top-left-radius: 16px;
    border-top-right-radius: 16px;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    box-shadow: 0 -4px 24px rgba(0, 0, 0, 0.18);
  }

  .props-sheet-header {
    display: flex;
    align-items: center;
    padding: 10px 14px 8px;
    border-bottom: 1px solid var(--tnd-line);
    flex-shrink: 0;
    position: relative;
  }

  .props-sheet-handle {
    position: absolute;
    top: 6px;
    left: 50%;
    transform: translateX(-50%);
    width: 36px;
    height: 4px;
    background: var(--tnd-line-strong);
    border-radius: 2px;
  }

  .props-sheet-title {
    font-size: 14px;
    font-weight: 600;
    color: var(--tnd-text);
    flex: 1;
    margin-top: 8px;
  }

  .props-sheet-close {
    background: none;
    border: none;
    font-size: 20px;
    color: var(--tnd-text-muted);
    cursor: pointer;
    padding: 0 4px;
    line-height: 1;
    margin-top: 8px;
  }

  .props-sheet-body {
    flex: 1;
    overflow-y: auto;
    /* PropertiesPanel manages its own height internally */
    min-height: 200px;
    max-height: calc(80vh - 56px);
  }
</style>
