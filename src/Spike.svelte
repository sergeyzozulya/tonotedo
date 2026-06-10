<script lang="ts">
  // Phase 0 iOS spike view (GitHub issue #1). Runs probes (b), (c), (d) on mount.
  import { invoke } from "@tauri-apps/api/core";
  import { listen, type UnlistenFn } from "@tauri-apps/api/event";
  import { onMount, onDestroy } from "svelte";
  import { EditorState, Transaction } from "@codemirror/state";
  import { EditorView } from "@codemirror/view";
  import { markdown } from "@codemirror/lang-markdown";

  interface FsProbeReport {
    documents_dir: string;
    walked_paths: string[];
    bytes_written: number;
    bytes_read: number;
    round_trip_ok: boolean;
    rename_ok: boolean;
    outside_read_blocked: boolean | null;
    outside_read_detail: string;
    errors: string[];
  }

  let fsReport = $state<FsProbeReport | null>(null);
  let fsError = $state<string | null>(null);
  let lifecycleLog = $state<string[]>([]);
  let editorResult = $state<string>("pending");
  let editorEl: HTMLDivElement;
  let view: EditorView | undefined;
  let unlisten: UnlistenFn | undefined;

  onMount(async () => {
    // Probe (b): filesystem.
    try {
      const r = await invoke<FsProbeReport>("spike_fs_probe");
      fsReport = r;
      const summary = `fs round_trip=${r.round_trip_ok} rename=${r.rename_ok} walked=${r.walked_paths.length} outside_blocked=${r.outside_read_blocked} errors=${r.errors.length}`;
      console.log("SPIKE_FS_PROBE " + JSON.stringify(r));
      await invoke("spike_log", { msg: summary });
    } catch (e) {
      fsError = String(e);
      console.log("SPIKE_FS_PROBE_ERROR " + fsError);
      await invoke("spike_log", { msg: "fs_probe_error " + fsError });
    }

    // Probe (c): lifecycle events from Rust.
    unlisten = await listen<string>("spike://lifecycle", (ev) => {
      const line = `${new Date().toISOString()} ${ev.payload}`;
      lifecycleLog = [...lifecycleLog, line];
      console.log("SPIKE_LIFECYCLE_FRONTEND " + line);
    });
    // Webview-level fallback for foreground/background (WKWebView visibility).
    document.addEventListener("visibilitychange", () => {
      const line = `${new Date().toISOString()} webview:${document.visibilityState}`;
      lifecycleLog = [...lifecycleLog, line];
      console.log("SPIKE_LIFECYCLE_FRONTEND " + line);
      invoke("spike_log", { msg: "webview:" + document.visibilityState });
    });

    // Probe (d): CodeMirror 6 editor + programmatic edit.
    const startDoc = "# Spike note\n\nType here on the simulator.\n";
    const state = EditorState.create({
      doc: startDoc,
      extensions: [markdown(), EditorView.lineWrapping],
    });
    view = new EditorView({ state, parent: editorEl });
    const before = view.state.doc.toString();
    const insert = "\n- programmatic edit ✅\n";
    view.dispatch({
      changes: { from: view.state.doc.length, insert },
      annotations: Transaction.userEvent.of("spike.programmatic"),
    });
    const after = view.state.doc.toString();
    const ok = after === before + insert && after.length > before.length;
    editorResult = ok ? "pass" : "fail";
    const editorMsg = `editor result=${editorResult} before_len=${before.length} after_len=${after.length}`;
    console.log("SPIKE_EDITOR " + editorMsg);
    await invoke("spike_log", { msg: editorMsg });
  });

  onDestroy(() => {
    unlisten?.();
    view?.destroy();
  });
</script>

<section>
  <h2>Phase 0 iOS spike (#1)</h2>

  <h3>(b) Filesystem probe</h3>
  {#if fsError}
    <pre class="err">ERROR: {fsError}</pre>
  {:else if fsReport}
    <p>docs dir: <code>{fsReport.documents_dir}</code></p>
    <p>
      round-trip: {fsReport.round_trip_ok ? "OK" : "FAIL"} ({fsReport.bytes_written}→{fsReport.bytes_read}B),
      rename: {fsReport.rename_ok ? "OK" : "FAIL"}, walked: {fsReport.walked_paths.length} paths
    </p>
    <p>outside-sandbox read blocked: {String(fsReport.outside_read_blocked)}</p>
    <p class="muted">{fsReport.outside_read_detail}</p>
    {#if fsReport.errors.length}
      <pre class="err">{fsReport.errors.join("\n")}</pre>
    {/if}
  {:else}
    <p>running…</p>
  {/if}

  <h3>(c) Lifecycle log</h3>
  <pre>{lifecycleLog.length
      ? lifecycleLog.join("\n")
      : "(no events yet — background/foreground the app)"}</pre>

  <h3>(d) CodeMirror editor — programmatic edit: {editorResult}</h3>
  <div class="cm" bind:this={editorEl}></div>
</section>

<style>
  section {
    font-family: sans-serif;
    padding: 1rem;
  }
  code {
    word-break: break-all;
  }
  pre {
    white-space: pre-wrap;
    word-break: break-all;
    background: #f4f4f4;
    padding: 0.5rem;
    font-size: 0.8rem;
  }
  .err {
    background: #fdd;
  }
  .muted {
    color: #666;
    font-size: 0.8rem;
  }
  .cm {
    border: 1px solid #ccc;
    min-height: 8rem;
  }
</style>
