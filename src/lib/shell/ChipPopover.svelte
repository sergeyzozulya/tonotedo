<script lang="ts">
  // ChipPopover — tap-and-hold on a #tag or @mention chip shows a metadata card
  // (spec 0013 §Touch translation: hover → tap-and-hold).
  //
  // This is a pure display popover — no navigation. It re-uses the tag
  // description from the ChipMetaCache (spec 0004) passed in by the caller.

  import type { TagMeta, PersonMeta } from "../ipc/types.js";

  type ChipKind = "tag" | "mention";

  interface Props {
    open?: boolean;
    kind?: ChipKind;
    /** For tags: TagMeta (description, color, count, icon). */
    tagMeta?: TagMeta | null;
    /** For mentions: PersonMeta (displayName, description, count, avatarPath). */
    personMeta?: PersonMeta | null;
    /** Raw value (tag name or person slug) as fallback label. */
    value?: string;
    onClose?: () => void;
  }

  let {
    open = false,
    kind = "tag",
    tagMeta = null,
    personMeta = null,
    value = "",
    onClose,
  }: Props = $props();

  function handleBackdrop(e: MouseEvent): void {
    if (e.target === e.currentTarget) onClose?.();
  }

  function handleKeydown(e: KeyboardEvent): void {
    if (e.key === "Escape") onClose?.();
  }

  // Color swatch CSS (reuse chip color tokens from tags)
  const colorClass = $derived(
    kind === "tag" && tagMeta?.color ? `chip-color--${tagMeta.color}` : "",
  );

  const displayName = $derived(
    kind === "tag"
      ? tagMeta?.icon
        ? `${tagMeta.icon} #${tagMeta?.name ?? value}`
        : `#${tagMeta?.name ?? value}`
      : (personMeta?.displayName ?? `@${value}`),
  );

  const description = $derived(kind === "tag" ? tagMeta?.description : personMeta?.description);

  const count = $derived(kind === "tag" ? tagMeta?.count : personMeta?.count);
</script>

<svelte:window onkeydown={open ? handleKeydown : undefined} />

{#if open}
  <div class="chip-popover-backdrop" role="presentation" onclick={handleBackdrop}>
    <div class="chip-popover" role="dialog" aria-label="Chip details" aria-modal="true">
      <div class="chip-popover-header">
        <span class="chip-popover-name {colorClass}">{displayName}</span>
        <button class="chip-popover-close" onclick={onClose} aria-label="Close">×</button>
      </div>

      {#if description}
        <p class="chip-popover-desc">{description}</p>
      {:else}
        <p class="chip-popover-desc chip-popover-desc--empty">No description</p>
      {/if}

      {#if count !== undefined}
        <div class="chip-popover-count">
          {count}
          {count === 1 ? "entry" : "entries"}
        </div>
      {/if}
    </div>
  </div>
{/if}

<style>
  .chip-popover-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.35);
    z-index: 5000;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
  }

  .chip-popover {
    background: var(--tnd-panel);
    border: 1px solid var(--tnd-line-strong);
    border-radius: 12px;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.2);
    padding: 16px;
    min-width: 200px;
    max-width: 320px;
    width: 100%;
    font-family: ui-sans-serif, system-ui, sans-serif;
  }

  .chip-popover-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 8px;
  }

  .chip-popover-name {
    font-size: 15px;
    font-weight: 600;
    color: var(--tnd-text);
  }

  .chip-popover-close {
    background: none;
    border: none;
    font-size: 20px;
    color: var(--tnd-text-muted);
    cursor: pointer;
    padding: 0 2px;
    line-height: 1;
  }

  .chip-popover-desc {
    font-size: 13px;
    color: var(--tnd-text-muted);
    margin: 0 0 10px;
    line-height: 1.5;
  }

  .chip-popover-desc--empty {
    color: var(--tnd-text-faint);
    font-style: italic;
  }

  .chip-popover-count {
    font-size: 11px;
    color: var(--tnd-text-faint);
    border-top: 1px solid var(--tnd-line);
    padding-top: 8px;
    margin-top: 4px;
  }

  /* Color accent variants for tag chips */
  .chip-color--red {
    color: var(--tnd-chip-red-fg, #c0392b);
  }
  .chip-color--amber {
    color: var(--tnd-chip-amber-fg, #b7620a);
  }
  .chip-color--green {
    color: var(--tnd-chip-green-fg, #2e7d32);
  }
  .chip-color--teal {
    color: var(--tnd-chip-teal-fg, #00695c);
  }
  .chip-color--blue {
    color: var(--tnd-chip-blue-fg, #1565c0);
  }
  .chip-color--violet {
    color: var(--tnd-chip-violet-fg, #6a1b9a);
  }
  .chip-color--pink {
    color: var(--tnd-chip-pink-fg, #ad1457);
  }
  .chip-color--slate {
    color: var(--tnd-chip-slate-fg, #455a64);
  }
</style>
