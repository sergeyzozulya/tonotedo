<script lang="ts">
  import { AppShell } from "./lib/shell/index.js";
  import BenchPage from "./lib/bench/BenchPage.svelte";

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
</script>

{#if isBench}
  <BenchPage />
{:else}
  <!-- Default + #/dev alias → AppShell (mock IPC in the browser) -->
  <AppShell />
{/if}
