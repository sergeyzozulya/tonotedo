<script lang="ts">
  import { invoke } from "@tauri-apps/api/core";
  import { listen } from "@tauri-apps/api/event";
  import { onMount } from "svelte";
  import { EditorState } from "@codemirror/state";
  import { EditorView, keymap } from "@codemirror/view";
  import { markdown } from "@codemirror/lang-markdown";

  const MARK = "SPIKE_WEB";

  let fsResult = $state<string>("");
  let safResult = $state<string>("");
  let persistedResult = $state<string>("");
  let lifecycleLog = $state<string[]>([]);
  let editorMark = $state<string>("");

  let editorEl: HTMLDivElement;
  let view: EditorView;

  // Probe (a) part 1 — std::fs fallback paths.
  async function runFsProbe() {
    const r = await invoke("spike_fs_probe");
    fsResult = JSON.stringify(r, null, 2);
    console.log(`${MARK} fs_probe`, fsResult);
  }

  // Probe (a) part 2 — SAF picker + read_dir + persist.
  async function runSafProbe() {
    const r = await invoke("spike_saf_pick_and_probe");
    safResult = JSON.stringify(r, null, 2);
    console.log(`${MARK} saf_probe`, safResult);
  }

  async function checkPersisted() {
    const r = await invoke("spike_saf_check_persisted");
    persistedResult = JSON.stringify(r, null, 2);
    console.log(`${MARK} saf_persisted`, persistedResult);
  }

  onMount(() => {
    // Probe (d) — CodeMirror 6 with a markdown doc.
    const doc = "# Spike note\n\n- [ ] edit me on the **touch** keyboard\n";
    const state = EditorState.create({
      doc,
      extensions: [markdown(), keymap.of([]), EditorView.lineWrapping],
    });
    view = new EditorView({ state, parent: editorEl });
    console.log(`${MARK} cm6_mounted len=${view.state.doc.length}`);

    // Programmatic edit + logged assertion.
    const before = view.state.doc.toString();
    view.dispatch({
      changes: { from: view.state.doc.length, insert: "\nPROGRAMMATIC EDIT OK\n" },
    });
    const after = view.state.doc.toString();
    const ok = after.includes("PROGRAMMATIC EDIT OK") && after.length > before.length;
    editorMark = ok ? "CM6 programmatic edit: PASS" : "CM6 programmatic edit: FAIL";
    console.log(`${MARK} cm6_edit ok=${ok} newLen=${after.length}`);

    // Probe (c) — receive lifecycle events emitted from Rust.
    const un = listen<string>("spike-lifecycle", (e) => {
      const line = `lifecycle: ${e.payload} @ ${new Date().toISOString()}`;
      lifecycleLog = [...lifecycleLog, line];
      console.log(`${MARK} ${line}`);
    });

    // Web-side visibility lifecycle (complements the Rust RunEvent path).
    const onVis = () => {
      const line = `visibility: ${document.visibilityState} @ ${new Date().toISOString()}`;
      lifecycleLog = [...lifecycleLog, line];
      console.log(`${MARK} ${line}`);
    };
    document.addEventListener("visibilitychange", onVis);

    return () => {
      un.then((f) => f());
      document.removeEventListener("visibilitychange", onVis);
      view?.destroy();
    };
  });
</script>

<main>
  <h1>ToNoteDo — Phase 0 Spike</h1>

  <section>
    <h2>(a) fs fallback paths</h2>
    <button onclick={runFsProbe}>Run std::fs probe</button>
    {#if fsResult}<pre>{fsResult}</pre>{/if}
  </section>

  <section>
    <h2>(a) SAF folder picker</h2>
    <button onclick={runSafProbe}>Pick folder + read_dir + persist</button>
    <button onclick={checkPersisted}>Check persisted permissions</button>
    {#if safResult}<pre>{safResult}</pre>{/if}
    {#if persistedResult}<pre>{persistedResult}</pre>{/if}
  </section>

  <section>
    <h2>(d) CodeMirror 6 editor</h2>
    <p data-testid="cm-mark">{editorMark}</p>
    <div bind:this={editorEl} class="editor"></div>
  </section>

  <section>
    <h2>(c) lifecycle events</h2>
    <ul>
      {#each lifecycleLog as line}<li>{line}</li>{/each}
    </ul>
  </section>
</main>

<style>
  main {
    font-family: sans-serif;
    padding: 1rem;
  }
  section {
    margin-bottom: 1.5rem;
  }
  pre {
    background: #f4f4f4;
    padding: 0.5rem;
    overflow-x: auto;
    font-size: 0.75rem;
  }
  .editor {
    border: 1px solid #ccc;
    min-height: 6rem;
  }
  button {
    margin-right: 0.5rem;
  }
</style>
