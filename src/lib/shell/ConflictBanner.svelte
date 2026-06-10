<script lang="ts">
  // ConflictBanner — shown when an external edit arrives while the buffer is
  // dirty (spec 0006 §External edits: "keep mine" / "use disk" / "show diff").
  //
  // Props:
  //   diskText     — the on-disk text as of the conflict event
  //   bufferText   — the current (dirty) editor buffer
  //   onKeepMine   — caller will write the buffer over disk
  //   onUseDisk    — caller will replace the buffer with diskText
  //   onDismiss    — dismiss without choosing (leaves conflict unresolved)

  import { diffLines } from "./conflict.js";

  interface Props {
    diskText: string;
    bufferText: string;
    onKeepMine: () => void;
    onUseDisk: () => void;
    onDismiss: () => void;
  }

  let { diskText, bufferText, onKeepMine, onUseDisk, onDismiss }: Props = $props();

  let showDiff = $state(false);

  const diffResult = $derived(showDiff ? diffLines(bufferText, diskText) : []);
</script>

<div class="conflict-banner" role="alert" aria-live="polite">
  <div class="conflict-banner__message">
    <span class="conflict-banner__icon" aria-hidden="true">⚠</span>
    <span class="conflict-banner__text">
      This file was changed on disk while you were editing.
    </span>
  </div>

  <div class="conflict-banner__actions">
    <button
      class="conflict-banner__btn conflict-banner__btn--primary"
      onclick={onKeepMine}
      title="Write your current buffer over the on-disk version"
    >
      Keep mine
    </button>
    <button
      class="conflict-banner__btn"
      onclick={onUseDisk}
      title="Replace your buffer with the on-disk version (your edits are backed up to session storage)"
    >
      Use disk
    </button>
    <button
      class="conflict-banner__btn"
      onclick={() => (showDiff = !showDiff)}
      aria-expanded={showDiff}
      aria-controls="conflict-diff-modal"
    >
      {showDiff ? "Hide diff" : "Show diff"}
    </button>
    <button
      class="conflict-banner__btn conflict-banner__btn--dismiss"
      onclick={onDismiss}
      aria-label="Dismiss conflict banner"
      title="Dismiss — conflict remains unresolved"
    >
      ✕
    </button>
  </div>
</div>

{#if showDiff}
  <!-- Diff modal — side-by-side line-level view -->
  <div
    id="conflict-diff-modal"
    class="conflict-diff-modal"
    role="dialog"
    aria-label="File conflict diff"
    aria-modal="true"
  >
    <div class="conflict-diff-modal__header">
      <span class="conflict-diff-modal__title">Changes</span>
      <span class="conflict-diff-modal__legend">
        <span class="conflict-diff-modal__legend-item conflict-diff-modal__legend-item--removed"
          >Your version</span
        >
        <span class="conflict-diff-modal__legend-item conflict-diff-modal__legend-item--added"
          >Disk version</span
        >
      </span>
      <button
        class="conflict-diff-modal__close"
        onclick={() => (showDiff = false)}
        aria-label="Close diff"
      >
        ✕
      </button>
    </div>

    <div class="conflict-diff-modal__body">
      {#if diffResult.length === 0}
        <div class="conflict-diff-modal__empty">No differences found.</div>
      {:else}
        <div class="conflict-diff-gutter-wrap">
          {#each diffResult as line, i (i)}
            <div class="conflict-diff-line conflict-diff-line--{line.kind}">
              <span class="conflict-diff-line__gutter-mine">
                {line.mineLine ?? ""}
              </span>
              <span class="conflict-diff-line__gutter-disk">
                {line.diskLine ?? ""}
              </span>
              <span class="conflict-diff-line__marker" aria-hidden="true">
                {#if line.kind === "added"}+{:else if line.kind === "removed"}-{:else}&nbsp;{/if}
              </span>
              <span class="conflict-diff-line__text">{line.text}</span>
            </div>
          {/each}
        </div>
      {/if}
    </div>

    <div class="conflict-diff-modal__footer">
      <button class="conflict-banner__btn conflict-banner__btn--primary" onclick={onKeepMine}>
        Keep mine
      </button>
      <button class="conflict-banner__btn" onclick={onUseDisk}> Use disk </button>
      <button
        class="conflict-banner__btn conflict-banner__btn--dismiss"
        onclick={() => (showDiff = false)}
      >
        Close
      </button>
    </div>
  </div>
  <!-- backdrop -->
  <div class="conflict-diff-backdrop" role="presentation" onclick={() => (showDiff = false)}></div>
{/if}

<style>
  /* ── Banner ─────────────────────────────────────────────────────────────────── */

  .conflict-banner {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 8px 14px;
    background: var(--tnd-conflict-bg, #fff8e1);
    border-bottom: 2px solid var(--tnd-conflict-border, #f59e0b);
    color: var(--tnd-conflict-text, #78350f);
    font-size: 13px;
    flex-shrink: 0;
    flex-wrap: wrap;
  }

  .conflict-banner__message {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }

  .conflict-banner__icon {
    font-size: 15px;
    flex-shrink: 0;
  }

  .conflict-banner__text {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .conflict-banner__actions {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-shrink: 0;
  }

  .conflict-banner__btn {
    background: transparent;
    border: 1px solid var(--tnd-conflict-border, #f59e0b);
    color: var(--tnd-conflict-text, #78350f);
    font-size: 12px;
    font-family: inherit;
    padding: 3px 10px;
    border-radius: 4px;
    cursor: pointer;
    white-space: nowrap;
  }

  .conflict-banner__btn:hover {
    background: var(--tnd-conflict-hover, rgba(245, 158, 11, 0.12));
  }

  .conflict-banner__btn--primary {
    background: var(--tnd-conflict-border, #f59e0b);
    color: #fff;
    font-weight: 600;
  }

  .conflict-banner__btn--primary:hover {
    opacity: 0.9;
  }

  .conflict-banner__btn--dismiss {
    border-color: transparent;
    padding: 3px 6px;
    font-size: 11px;
    opacity: 0.7;
  }

  .conflict-banner__btn--dismiss:hover {
    opacity: 1;
  }

  /* ── Diff modal ─────────────────────────────────────────────────────────────── */

  .conflict-diff-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.35);
    z-index: 299;
  }

  .conflict-diff-modal {
    position: fixed;
    top: 10vh;
    left: 50%;
    transform: translateX(-50%);
    width: min(860px, 94vw);
    max-height: 76vh;
    display: flex;
    flex-direction: column;
    background: var(--tnd-panel, #fff);
    border: 1px solid var(--tnd-line-strong, #ddd);
    border-radius: 8px;
    box-shadow: 0 8px 40px rgba(0, 0, 0, 0.22);
    z-index: 300;
    overflow: hidden;
    font-size: 13px;
  }

  .conflict-diff-modal__header {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 16px;
    background: var(--tnd-panel2, #f7f7f7);
    border-bottom: 1px solid var(--tnd-line, #eee);
    flex-shrink: 0;
  }

  .conflict-diff-modal__title {
    font-weight: 600;
    font-size: 13px;
    color: var(--tnd-text, #333);
    flex: 1;
  }

  .conflict-diff-modal__legend {
    display: flex;
    gap: 12px;
    font-size: 11px;
  }

  .conflict-diff-modal__legend-item {
    display: flex;
    align-items: center;
    gap: 4px;
  }

  .conflict-diff-modal__legend-item--removed::before {
    content: "−";
    color: #dc2626;
    font-weight: 700;
  }

  .conflict-diff-modal__legend-item--added::before {
    content: "+";
    color: #16a34a;
    font-weight: 700;
  }

  .conflict-diff-modal__close {
    background: transparent;
    border: none;
    font-size: 14px;
    cursor: pointer;
    color: var(--tnd-text-muted, #666);
    padding: 2px 6px;
    border-radius: 3px;
    line-height: 1;
  }

  .conflict-diff-modal__close:hover {
    background: var(--tnd-panel, #fff);
  }

  .conflict-diff-modal__body {
    flex: 1;
    overflow-y: auto;
    overflow-x: auto;
    padding: 0;
  }

  .conflict-diff-modal__empty {
    padding: 24px;
    text-align: center;
    color: var(--tnd-text-faint, #999);
  }

  .conflict-diff-gutter-wrap {
    font-family: ui-monospace, "Cascadia Code", "Fira Code", monospace;
    font-size: 12px;
    line-height: 1.55;
  }

  .conflict-diff-line {
    display: flex;
    align-items: baseline;
    min-width: 0;
  }

  .conflict-diff-line--unchanged {
    color: var(--tnd-text-muted, #555);
  }

  .conflict-diff-line--added {
    background: #f0fdf4;
    color: #166534;
  }

  .conflict-diff-line--removed {
    background: #fef2f2;
    color: #991b1b;
    text-decoration-line: line-through;
    text-decoration-color: #fca5a5;
  }

  .conflict-diff-line__gutter-mine,
  .conflict-diff-line__gutter-disk {
    flex-shrink: 0;
    width: 38px;
    text-align: right;
    padding: 0 8px;
    color: var(--tnd-text-faint, #bbb);
    font-size: 11px;
    user-select: none;
    border-right: 1px solid var(--tnd-line, #eee);
  }

  .conflict-diff-line__marker {
    flex-shrink: 0;
    width: 18px;
    text-align: center;
    padding: 0 2px;
    font-weight: 700;
    user-select: none;
  }

  .conflict-diff-line__text {
    flex: 1;
    padding: 0 8px;
    white-space: pre;
  }

  .conflict-diff-modal__footer {
    display: flex;
    gap: 8px;
    align-items: center;
    justify-content: flex-end;
    padding: 10px 16px;
    background: var(--tnd-panel2, #f7f7f7);
    border-top: 1px solid var(--tnd-line, #eee);
    flex-shrink: 0;
  }
</style>
