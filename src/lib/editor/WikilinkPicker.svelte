<script lang="ts">
  // Ambiguous wikilink picker (spec 0006 §Wikilinks). A small popup anchored at
  // the clicked chip listing the path-qualified candidates; choosing one stores
  // the link path-qualified and navigates. Reuses autocomplete/list styling
  // (tokens only).

  import type { WikilinkCandidate } from "./wikilink-resolve.js";

  interface Props {
    /** Candidates to choose from (>1, else there would be no prompt). */
    candidates: WikilinkCandidate[];
    /** Anchor box (screen coords) of the clicked chip. */
    rect: { left: number; top: number; bottom: number };
    /** Chosen candidate → caller qualifies the link + navigates. */
    onPick: (candidate: WikilinkCandidate) => void;
    onClose: () => void;
  }

  let { candidates, rect, onPick, onClose }: Props = $props();

  let active = $state(0);

  function handleKeydown(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      active = (active + 1) % candidates.length;
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      active = (active - 1 + candidates.length) % candidates.length;
    } else if (e.key === "Enter") {
      e.preventDefault();
      onPick(candidates[active]);
    }
  }
</script>

<svelte:window onkeydown={handleKeydown} />

<!-- Backdrop catches outside clicks; transparent. -->
<div
  class="wl-backdrop"
  role="presentation"
  onmousedown={(e) => {
    if (e.target === e.currentTarget) onClose();
  }}
>
  <div
    class="wl-picker"
    role="listbox"
    aria-label="Resolve link"
    tabindex="-1"
    style="left: {rect.left}px; top: {rect.bottom + 4}px"
  >
    <div class="wl-head">Which one?</div>
    {#each candidates as c, i (c.target)}
      <button
        class="wl-item"
        class:wl-item--active={i === active}
        role="option"
        aria-selected={i === active}
        onmouseenter={() => (active = i)}
        onmousedown={(e) => {
          e.preventDefault();
          onPick(c);
        }}
      >
        <span class="wl-kind">{c.kind === "group" ? "▣" : "▤"}</span>
        <span class="wl-label">{c.label}</span>
        <span class="wl-path">{c.target}</span>
      </button>
    {/each}
  </div>
</div>

<style>
  .wl-backdrop {
    position: fixed;
    inset: 0;
    z-index: 3000;
  }
  .wl-picker {
    position: fixed;
    min-width: 220px;
    max-width: 360px;
    max-height: 280px;
    overflow-y: auto;
    background: var(--tnd-panel);
    border: 1px solid var(--tnd-line-strong);
    border-radius: var(--tnd-radius);
    box-shadow: var(--tnd-shadow, 0 6px 24px rgba(0, 0, 0, 0.18));
    padding: 4px;
    font-family: var(--tnd-font-ui);
  }
  .wl-head {
    padding: 4px 8px 6px;
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--tnd-text-muted);
  }
  .wl-item {
    display: flex;
    align-items: baseline;
    gap: 6px;
    width: 100%;
    text-align: left;
    background: none;
    border: none;
    padding: 5px 8px;
    border-radius: var(--tnd-radius);
    font: inherit;
    font-size: 13px;
    color: var(--tnd-text);
    cursor: pointer;
  }
  .wl-item--active {
    background: var(--tnd-accent-soft);
  }
  .wl-kind {
    color: var(--tnd-text-muted);
    flex-shrink: 0;
  }
  .wl-label {
    font-weight: 600;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .wl-path {
    margin-left: auto;
    color: var(--tnd-text-faint);
    font-size: 11px;
    font-family: var(--tnd-font-mono, ui-monospace, monospace);
    white-space: nowrap;
  }
</style>
