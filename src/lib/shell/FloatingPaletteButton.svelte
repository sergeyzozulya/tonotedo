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
  ⌘
</button>

<style>
  .fab {
    position: fixed;
    bottom: calc(env(safe-area-inset-bottom, 0px) + 20px);
    right: 20px;
    width: 52px;
    height: 52px;
    border-radius: 50%;
    background: var(--tnd-accent, #3e7a52);
    color: #fff;
    border: none;
    font-size: 22px;
    font-weight: 700;
    cursor: pointer;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.25);
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
