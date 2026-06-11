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
        <button
          class="mobile-topbar-btn mobile-topbar-btn--back"
          aria-label="Back"
          onclick={onBack}
        >
          <!-- chevron left (matches design ‹ back affordance) -->
          <svg
            viewBox="0 0 20 20"
            width="16"
            height="16"
            fill="none"
            stroke="currentColor"
            stroke-width="1.8"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path d="M12.5 5l-5 5 5 5" />
          </svg>
          <span class="mobile-topbar-back-label">Back</span>
        </button>
      {:else if showHamburger}
        <button
          class="mobile-topbar-btn mobile-topbar-btn--icon"
          aria-label="Open sidebar"
          onclick={onHamburger}
        >
          <!-- three-line hamburger -->
          <svg
            viewBox="0 0 20 20"
            width="18"
            height="18"
            fill="none"
            stroke="currentColor"
            stroke-width="1.7"
            stroke-linecap="round"
            aria-hidden="true"
          >
            <path d="M3 5h14M3 10h14M3 15h14" />
          </svg>
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
          <!-- search icon -->
          <svg
            viewBox="0 0 20 20"
            width="17"
            height="17"
            fill="none"
            stroke="currentColor"
            stroke-width="1.7"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <circle cx="9" cy="9" r="5.5" />
            <path d="M13.5 13.5l3.5 3.5" />
          </svg>
        </button>
      {/if}
      {#if onPalette}
        <button
          class="mobile-topbar-btn mobile-topbar-btn--icon"
          aria-label="Command palette"
          onclick={onPalette}
        >
          <!-- spark / command icon -->
          <svg
            viewBox="0 0 20 20"
            width="17"
            height="17"
            fill="none"
            stroke="currentColor"
            stroke-width="1.7"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path d="M10 2.5l1.6 4.9 4.9 1.6-4.9 1.6L10 15.5l-1.6-4.9-4.9-1.6 4.9-1.6z" />
          </svg>
        </button>
      {/if}
    </div>
  </div>
</header>

<style>
  .mobile-topbar {
    position: relative;
    height: 46px;
    flex-shrink: 0;
    background: var(--tnd-panel);
    border-bottom: 1px solid var(--tnd-line);
    touch-action: pan-x;
    user-select: none;
    font-family: var(--tnd-font-ui);
  }

  .mobile-topbar-inner {
    display: flex;
    align-items: center;
    height: 100%;
    padding: 0 14px;
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
    gap: 2px;
    min-width: 64px;
    justify-content: flex-end;
  }

  .mobile-topbar-title {
    flex: 1;
    text-align: center;
    font-size: 14px;
    font-weight: 700;
    color: var(--tnd-text);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    letter-spacing: var(--tnd-label-spacing, 0);
    text-transform: var(--tnd-label-transform, none);
    font-family: var(--tnd-font-ui);
  }

  /* Back/hamburger/icon buttons */
  .mobile-topbar-btn {
    background: transparent;
    border: none;
    color: var(--tnd-accent-text);
    font-size: 14px;
    font-family: var(--tnd-font-ui);
    font-weight: 600;
    padding: 6px 4px;
    cursor: pointer;
    border-radius: var(--tnd-radius);
    display: flex;
    align-items: center;
    gap: 3px;
    min-width: 44px;
    min-height: 44px;
    justify-content: center;
  }

  .mobile-topbar-btn:active {
    background: var(--tnd-accent-soft);
  }

  .mobile-topbar-btn--icon {
    color: var(--tnd-text-muted);
    min-width: 36px;
  }

  .mobile-topbar-btn--icon:active {
    color: var(--tnd-accent-text);
  }

  /* Back button: accent-colored label + chevron matching design */
  .mobile-topbar-btn--back {
    color: var(--tnd-accent-text);
    gap: 2px;
  }

  .mobile-topbar-back-label {
    font-size: 14px;
    font-weight: 600;
    line-height: 1;
  }

  .mobile-topbar-pull-hint {
    position: absolute;
    top: 46px;
    left: 50%;
    transform: translateX(-50%);
    font-size: 10.5px;
    color: var(--tnd-text-faint);
    background: var(--tnd-panel2);
    border: 1px solid var(--tnd-line);
    border-radius: var(--tnd-radius);
    padding: 2px 10px;
    white-space: nowrap;
    pointer-events: none;
    z-index: 1;
    font-family: var(--tnd-font-mono);
    letter-spacing: 0.02em;
  }
</style>
