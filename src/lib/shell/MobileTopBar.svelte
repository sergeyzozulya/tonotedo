<script lang="ts">
  // MobileTopBar — consistent narrow app bar (spec 0013 §top app bar).
  // Shows: [back|hamburger] [title] [right actions: search, palette]
  // Pull-down gesture on this bar triggers the palette.

  import { pullDownStep, pullDownProgress, type PullDownState } from "./mobile-gestures.js";

  interface Props {
    title?: string;
    /** Show a back button instead of hamburger. */
    showBack?: boolean;
    onBack?: () => void;
    /** Show hamburger (for sidebar access). */
    showHamburger?: boolean;
    onHamburger?: () => void;
    /** Search action button. */
    onSearch?: () => void;
    /** Palette action button. */
    onPalette?: () => void;
  }

  let {
    title = "ToNoteDo",
    showBack = false,
    onBack,
    showHamburger = false,
    onHamburger,
    onSearch,
    onPalette,
  }: Props = $props();

  // ── Pull-down gesture ──────────────────────────────────────────────────────

  let pullState = $state<PullDownState>({ phase: "idle" });

  function onTouchStart(e: TouchEvent): void {
    const t = e.touches[0];
    pullState = pullDownStep(pullState, { type: "start", x: t.clientX, y: t.clientY });
  }

  function onTouchMove(e: TouchEvent): void {
    const t = e.touches[0];
    const next = pullDownStep(pullState, { type: "move", x: t.clientX, y: t.clientY });
    if (next.phase === "triggered" && pullState.phase !== "triggered") {
      onPalette?.();
    }
    pullState = next;
  }

  function onTouchEnd(): void {
    pullState = pullDownStep(pullState, { type: "end", x: 0, y: 0 });
  }

  const pullProgress = $derived(pullDownProgress(pullState));

  // Subtle visual indicator of pull progress
  const pullIndicatorOpacity = $derived(Math.min(1, pullProgress * 2));
</script>

<header class="mobile-topbar">
  <!-- Pull indicator -->
  {#if pullProgress > 0}
    <div class="mobile-topbar-pull-hint" style:opacity={pullIndicatorOpacity} aria-hidden="true">
      ↓ Release for palette
    </div>
  {/if}

  <!-- Touch-handler wrapper: separate from <header> to satisfy a11y rules -->
  <div
    class="mobile-topbar-inner"
    ontouchstart={onTouchStart}
    ontouchmove={onTouchMove}
    ontouchend={onTouchEnd}
    ontouchcancel={onTouchEnd}
    role="presentation"
  >
    <div class="mobile-topbar-left">
      {#if showBack}
        <button class="mobile-topbar-btn" aria-label="Back" onclick={onBack}>
          <span class="mobile-topbar-back-icon" aria-hidden="true">‹</span>
          Back
        </button>
      {:else if showHamburger}
        <button
          class="mobile-topbar-btn mobile-topbar-btn--icon"
          aria-label="Open sidebar"
          onclick={onHamburger}
        >
          ☰
        </button>
      {/if}
    </div>

    <span class="mobile-topbar-title">{title}</span>

    <div class="mobile-topbar-right">
      {#if onSearch}
        <button
          class="mobile-topbar-btn mobile-topbar-btn--icon"
          aria-label="Search"
          onclick={onSearch}
        >
          🔍
        </button>
      {/if}
      {#if onPalette}
        <button
          class="mobile-topbar-btn mobile-topbar-btn--icon"
          aria-label="Command palette"
          onclick={onPalette}
        >
          ⌘
        </button>
      {/if}
    </div>
  </div>
</header>

<style>
  .mobile-topbar {
    position: relative;
    height: 52px;
    flex-shrink: 0;
    background: var(--tnd-panel);
    border-bottom: 1px solid var(--tnd-line-strong);
    touch-action: pan-x; /* allow vertical swipe to be captured */
    user-select: none;
  }

  .mobile-topbar-inner {
    display: flex;
    align-items: center;
    height: 100%;
    padding: 0 8px;
    gap: 6px;
  }

  .mobile-topbar-left {
    display: flex;
    align-items: center;
    min-width: 64px;
  }

  .mobile-topbar-right {
    display: flex;
    align-items: center;
    gap: 4px;
    min-width: 64px;
    justify-content: flex-end;
  }

  .mobile-topbar-title {
    flex: 1;
    text-align: center;
    font-size: 16px;
    font-weight: 600;
    color: var(--tnd-text);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .mobile-topbar-btn {
    background: transparent;
    border: none;
    color: var(--tnd-accent, #3e7a52);
    font-size: 16px;
    font-family: inherit;
    font-weight: 500;
    padding: 8px 6px;
    cursor: pointer;
    border-radius: 6px;
    display: flex;
    align-items: center;
    gap: 2px;
    min-width: 44px;
    min-height: 44px;
    justify-content: center;
  }

  .mobile-topbar-btn:active {
    background: var(--tnd-accent-soft);
  }

  .mobile-topbar-btn--icon {
    font-size: 18px;
  }

  .mobile-topbar-back-icon {
    font-size: 22px;
    line-height: 1;
  }

  .mobile-topbar-pull-hint {
    position: absolute;
    top: 52px;
    left: 50%;
    transform: translateX(-50%);
    font-size: 11px;
    color: var(--tnd-text-faint);
    background: var(--tnd-panel2);
    border: 1px solid var(--tnd-line);
    border-radius: 4px;
    padding: 2px 8px;
    white-space: nowrap;
    pointer-events: none;
    z-index: 1;
  }
</style>
