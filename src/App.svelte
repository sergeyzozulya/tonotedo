<script lang="ts">
  import { AppShell } from "./lib/shell/index.js";
  import BenchPage from "./lib/bench/BenchPage.svelte";
  import Palette from "./lib/commands/Palette.svelte";
  import Cheatsheet from "./lib/commands/Cheatsheet.svelte";
  import {
    keymapAction,
    setPaletteOpener,
    setCheatsheetOpener,
    seedCommands,
  } from "./lib/commands/index.js";

  // ── Hash-based routing ───────────────────────────────────────────────────────
  // Default route (including #/dev alias): AppShell against the mock IPC.
  // #/bench: BenchPage (untouched).
  //
  // DevPage is retired into AppShell per issue #18.

  let hash = $state(window.location.hash);

  $effect(() => {
    function onHashChange() {
      hash = window.location.hash;
    }
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  });

  const isBench = $derived(hash === "#/bench");

  // ── Command system wiring (issue #19 integration) ────────────────────────────
  // Seeded commands carry their own handlers; this wires the overlays + keymap.

  let paletteOpen = $state(false);
  let sheetOpen = $state(false);

  seedCommands();
  setPaletteOpener(() => (paletteOpen = true));
  setCheatsheetOpener(() => (sheetOpen = true));
</script>

<div class="app-root" use:keymapAction>
  {#if isBench}
    <BenchPage />
  {:else}
    <!-- Default + #/dev alias → AppShell (mock IPC in the browser) -->
    <AppShell />
  {/if}

  <Palette bind:open={paletteOpen} />
  <Cheatsheet bind:open={sheetOpen} />
</div>

<style>
  .app-root {
    display: contents;
  }
</style>
