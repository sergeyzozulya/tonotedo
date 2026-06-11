<script lang="ts">
  // FloatingPaletteButton — persistent FAB for the command palette on narrow
  // viewports (spec 0013 §Touch translation: palette → persistent palette button).
  //
  // Shown only when narrow = true. Hidden when any overlay/sheet is open to avoid
  // z-index conflicts.

  interface Props {
    onTap?: () => void;
  }

  let { onTap }: Props = $props();
</script>

<button class="fab" aria-label="Open command palette" title="Command palette (⌘K)" onclick={onTap}>
  <!-- Plus icon matching design: accent FAB with + -->
  <svg
    viewBox="0 0 20 20"
    width="22"
    height="22"
    fill="none"
    stroke="#fff"
    stroke-width="2.2"
    stroke-linecap="round"
    aria-hidden="true"
  >
    <path d="M10 4v12M4 10h12" />
  </svg>
</button>

<style>
  .fab {
    position: fixed;
    bottom: calc(env(safe-area-inset-bottom, 0px) + 22px);
    right: 18px;
    width: 52px;
    height: 52px;
    border-radius: var(--tnd-radius, 16px);
    background: var(--tnd-accent);
    color: #fff;
    border: none;
    cursor: pointer;
    box-shadow:
      0 8px 20px var(--tnd-accent-soft, rgba(0, 0, 0, 0.18)),
      0 4px 10px rgba(0, 0, 0, 0.18);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1500;
    transition:
      transform 0.1s ease,
      box-shadow 0.1s ease;
  }

  .fab:active {
    transform: scale(0.93);
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.18);
  }
</style>
