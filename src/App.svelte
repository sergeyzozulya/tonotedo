<script lang="ts">
  import { invoke } from "@tauri-apps/api/core";
  import { onMount } from "svelte";

  let coreVersion = $state<string | null>(null);

  onMount(async () => {
    coreVersion = await invoke<string>("core_version");
  });
</script>

<main>
  <h1>ToNoteDo</h1>
  {#if coreVersion !== null}
    <p>Core version: {coreVersion}</p>
  {/if}
</main>

<style>
  main {
    font-family: sans-serif;
    padding: 2rem;
  }
</style>
