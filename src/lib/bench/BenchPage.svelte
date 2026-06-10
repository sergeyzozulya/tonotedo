<script lang="ts">
  // BenchPage: hash route #/bench — 10k-word typing benchmark.
  //
  // Part 1 of the issue #16 exit gate (spec 0006 §Performance budgets):
  //   - Generates a deterministic ~10k-word markdown doc on mount
  //   - Mounts the FULL production editor (all extensions, mock IPC)
  //   - On "Run benchmark": executes 300 scripted keystrokes at realistic
  //     positions, measuring per-keystroke input-to-paint latency via
  //     performance.now() around dispatch + double-rAF (transaction → next frame)
  //   - Reports p50 / p95 / max, open-time, and switch-time
  //   - Results shown on-page, console.table'd, and downloadable as JSON
  //
  // Budgets (spec 0006 + 0013):
  //   typing p95 < 16 ms  (60 fps)
  //   open  < 100 ms
  //   switch < 50 ms  (entry-switch approximated by doc swap)
  //
  // NOTE: These are REAL paint-round-trip measurements, not vitest proxies.
  // Run on desktop (pnpm dev → /#/bench), then again on a mid-range phone.

  import { onMount } from "svelte";
  import { EditorState, type ChangeSpec } from "@codemirror/state";
  import { EditorView } from "@codemirror/view";

  import { baseSetup, markdownExtension } from "../editor/extensions/markdown.js";
  import { cursorReveal } from "../editor/extensions/cursor-reveal.js";
  import { frontmatterFold } from "../editor/extensions/frontmatter-fold.js";
  import { chips } from "../editor/extensions/chips.js";
  import { editorTheme } from "../editor/theme.js";
  import { blocksPlugin, blocksTheme, pasteDropHandlers } from "../editor/extensions/blocks.js";
  import { autocomplete } from "../editor/extensions/autocomplete.js";
  import { ipc } from "../ipc/index.js";

  import { generateBenchDoc, percentiles, wordCount } from "./doc-gen.js";

  // ── Doc generation ────────────────────────────────────────────────────────────

  const BENCH_SEED = 0xdeadbeef;
  const benchDoc = generateBenchDoc(BENCH_SEED, 10000);
  const docWords = wordCount(benchDoc);
  const docChars = benchDoc.length;

  // A second (distinct) doc for switch-time measurement.
  const benchDoc2 = generateBenchDoc(BENCH_SEED + 1, 1000);

  // ── State ─────────────────────────────────────────────────────────────────────

  type RunStatus = "idle" | "running" | "done" | "error";

  let status = $state<RunStatus>("idle");
  let openMs = $state<number | null>(null);
  let switchMs = $state<number | null>(null);
  let typingStats = $state<{ p50: number; p95: number; max: number } | null>(null);
  let errorMsg = $state<string | null>(null);
  let keystrokeSamples = $state<number[]>([]);

  // ── Editor mount ──────────────────────────────────────────────────────────────

  let hostEl: HTMLDivElement;
  let view: EditorView | undefined;

  // Captured at mount; reused by switch-time measurement so the same extension
  // set is present in both states (EditorState does not expose its config).
  const editorExtensions = [
    frontmatterFold,
    chips({ ipc }),
    cursorReveal,
    blocksPlugin(ipc, {}),
    pasteDropHandlers(ipc, () => ""),
    autocomplete({ ipc }),
    markdownExtension,
    baseSetup,
    editorTheme,
    blocksTheme,
  ];

  /**
   * Wait for two animation frames to pass — this covers the full
   * "transaction dispatch → layout → paint" cycle that CM6 uses.
   */
  function afterTwoPaints(): Promise<void> {
    return new Promise((resolve) => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => resolve());
      });
    });
  }

  /**
   * Wait for a single animation frame. Used for open-time measurement where
   * we just need the first render to complete.
   */
  function afterOnePaint(): Promise<void> {
    return new Promise((resolve) => requestAnimationFrame(() => resolve()));
  }

  onMount(() => {
    // Measure open-time: from EditorView construction to first rAF callback.
    const t0 = performance.now();

    view = new EditorView({
      parent: hostEl,
      state: EditorState.create({
        doc: benchDoc,
        extensions: [
          frontmatterFold,
          chips({ ipc }),
          cursorReveal,
          blocksPlugin(ipc, {}),
          pasteDropHandlers(ipc, () => ""),
          autocomplete({ ipc }),
          markdownExtension,
          baseSetup,
          editorTheme,
          blocksTheme,
        ],
      }),
    });

    void afterOnePaint().then(() => {
      openMs = performance.now() - t0;
    });

    return () => view?.destroy();
  });

  // ── Benchmark runner ──────────────────────────────────────────────────────────

  /**
   * Compute 300 keystroke positions spread across the document at realistic
   * positions: middle of document body, inside paragraphs, near heading edges.
   *
   * Positions are deterministic (no Math.random).
   */
  function keystrokePositions(docLen: number): number[] {
    const positions: number[] = [];
    // Evenly space 300 positions across [docLen/4, docLen*3/4] (middle half).
    const lo = Math.floor(docLen / 4);
    const hi = Math.floor((docLen * 3) / 4);
    const span = hi - lo;
    for (let i = 0; i < 300; i++) {
      // Pseudo-random spread: triangle wave so we get coverage near headings too.
      const t = i / 300;
      const phase = (t * 7 + 0.13) % 1; // 7 cycles across the range
      positions.push(lo + Math.floor(phase * span));
    }
    return positions;
  }

  async function runBenchmark(): Promise<void> {
    if (!view || status === "running") return;

    status = "running";
    errorMsg = null;
    typingStats = null;
    switchMs = null;
    keystrokeSamples = [];

    try {
      const docLen = view.state.doc.length;
      const positions = keystrokePositions(docLen);
      const durations: number[] = [];

      // ── Typing latency: 300 scripted insertions ───────────────────────────────
      for (const pos of positions) {
        const t0 = performance.now();

        // Clamp position to current doc length (doc grows with each insertion).
        const safePos = Math.min(pos, view.state.doc.length);
        view.dispatch({
          changes: { from: safePos, to: safePos, insert: "a" } satisfies ChangeSpec,
          selection: { anchor: safePos + 1 },
        } satisfies Parameters<typeof view.dispatch>[0]);

        // Wait for two frames (transaction → update → layout → paint).
        await afterTwoPaints();

        durations.push(performance.now() - t0);
      }

      keystrokeSamples = durations;
      typingStats = percentiles(durations);

      // ── Switch time: swap the entire doc ─────────────────────────────────────
      const t1 = performance.now();
      view.setState(
        EditorState.create({
          doc: benchDoc2,
          extensions: editorExtensions,
        }),
      );
      await afterTwoPaints();
      switchMs = performance.now() - t1;

      status = "done";

      // ── Console output ────────────────────────────────────────────────────────
      const report = buildReport();
      console.log("[bench] #16 10k-word typing benchmark results:");
      console.table({
        "open (ms)": { value: openMs?.toFixed(2) },
        "switch (ms)": { value: switchMs?.toFixed(2) },
        "p50 typing (ms)": { value: typingStats.p50.toFixed(2) },
        "p95 typing (ms)": { value: typingStats.p95.toFixed(2) },
        "max typing (ms)": { value: typingStats.max.toFixed(2) },
      });
      console.log("[bench] full report (JSON):", JSON.stringify(report, null, 2));
    } catch (e) {
      status = "error";
      errorMsg = String(e);
    }
  }

  // ── Report / download ─────────────────────────────────────────────────────────

  interface BenchReport {
    meta: {
      date: string;
      userAgent: string;
      docWords: number;
      docChars: number;
      keystrokes: number;
      seed: number;
    };
    timings: {
      openMs: number | null;
      switchMs: number | null;
      typing: { p50: number; p95: number; max: number } | null;
    };
    budgets: {
      "typing p95 < 16ms": boolean | null;
      "open < 100ms": boolean | null;
      "switch < 50ms": boolean | null;
    };
    samples: number[];
  }

  function buildReport(): BenchReport {
    return {
      meta: {
        date: new Date().toISOString(),
        userAgent: typeof navigator !== "undefined" ? navigator.userAgent : "unknown",
        docWords,
        docChars,
        keystrokes: keystrokeSamples.length,
        seed: BENCH_SEED,
      },
      timings: {
        openMs,
        switchMs,
        typing: typingStats,
      },
      budgets: {
        "typing p95 < 16ms": typingStats ? typingStats.p95 < 16 : null,
        "open < 100ms": openMs !== null ? openMs < 100 : null,
        "switch < 50ms": switchMs !== null ? switchMs < 50 : null,
      },
      samples: keystrokeSamples,
    };
  }

  function downloadReport(): void {
    const report = buildReport();
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `bench-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // ── Budget pass/fail helpers ──────────────────────────────────────────────────

  function passStr(pass: boolean | null): string {
    if (pass === null) return "—";
    return pass ? "PASS" : "FAIL";
  }

  function passClass(pass: boolean | null): string {
    if (pass === null) return "neutral";
    return pass ? "pass" : "fail";
  }
</script>

<div class="bench">
  <header class="bench-header">
    <h1>Typing benchmark — 10k words</h1>
    <small>
      Doc: {docWords} words / {docChars} chars · seed 0x{BENCH_SEED.toString(16)} ·
      <a href="#/">home</a>
    </small>
  </header>

  <div class="bench-controls">
    <button onclick={runBenchmark} disabled={status === "running"}>
      {status === "running" ? "Running…" : "Run benchmark"}
    </button>

    {#if status === "done"}
      <button onclick={downloadReport}>Download JSON</button>
    {/if}
  </div>

  {#if status === "error"}
    <p class="error">Error: {errorMsg}</p>
  {/if}

  {#if openMs !== null}
    <section class="bench-results">
      <h2>Results</h2>
      <table>
        <thead>
          <tr>
            <th>Metric</th>
            <th>Measured (ms)</th>
            <th>Budget</th>
            <th>Pass/Fail</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Open time</td>
            <td>{openMs.toFixed(2)}</td>
            <td>&lt; 100 ms</td>
            <td class={passClass(openMs < 100)}>{passStr(openMs < 100)}</td>
          </tr>
          {#if switchMs !== null}
            <tr>
              <td>Switch time</td>
              <td>{switchMs.toFixed(2)}</td>
              <td>&lt; 50 ms</td>
              <td class={passClass(switchMs < 50)}>{passStr(switchMs < 50)}</td>
            </tr>
          {/if}
          {#if typingStats}
            <tr>
              <td>Typing p50</td>
              <td>{typingStats.p50.toFixed(2)}</td>
              <td>—</td>
              <td class="neutral">—</td>
            </tr>
            <tr>
              <td>Typing p95</td>
              <td>{typingStats.p95.toFixed(2)}</td>
              <td>&lt; 16 ms</td>
              <td class={passClass(typingStats.p95 < 16)}>{passStr(typingStats.p95 < 16)}</td>
            </tr>
            <tr>
              <td>Typing max</td>
              <td>{typingStats.max.toFixed(2)}</td>
              <td>—</td>
              <td class="neutral">—</td>
            </tr>
          {/if}
        </tbody>
      </table>
    </section>
  {/if}

  <div class="bench-editor-label">
    <span>Live editor (full production stack, {docWords} words loaded)</span>
  </div>
  <div class="bench-editor" bind:this={hostEl}></div>
</div>

<style>
  .bench {
    display: flex;
    flex-direction: column;
    height: 100vh;
    font-family: ui-sans-serif, system-ui, sans-serif;
    font-size: 14px;
  }

  .bench-header {
    padding: 0.5rem 1rem;
    border-bottom: 1px solid rgba(0, 0, 0, 0.1);
  }

  .bench-header h1 {
    margin: 0 0 0.2rem;
    font-size: 1rem;
  }

  .bench-header small {
    color: #666;
  }

  .bench-header a {
    color: inherit;
    opacity: 0.5;
  }

  .bench-controls {
    padding: 0.5rem 1rem;
    display: flex;
    gap: 0.5rem;
  }

  .bench-controls button {
    padding: 0.3rem 0.8rem;
    border: 1px solid rgba(0, 0, 0, 0.2);
    border-radius: 4px;
    background: #f5f5f5;
    cursor: pointer;
    font-size: 13px;
  }

  .bench-controls button:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .error {
    margin: 0.5rem 1rem;
    color: #c00;
    font-size: 13px;
  }

  .bench-results {
    padding: 0.5rem 1rem;
    border-bottom: 1px solid rgba(0, 0, 0, 0.07);
  }

  .bench-results h2 {
    margin: 0 0 0.5rem;
    font-size: 0.9rem;
    font-weight: 600;
  }

  .bench-results table {
    border-collapse: collapse;
    font-size: 13px;
  }

  .bench-results th,
  .bench-results td {
    padding: 3px 12px 3px 0;
    text-align: left;
    white-space: nowrap;
  }

  .bench-results th {
    font-weight: 600;
    color: #555;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.03em;
  }

  .pass {
    color: #186218;
    font-weight: 600;
  }

  .fail {
    color: #c00;
    font-weight: 600;
  }

  .neutral {
    color: #888;
  }

  .bench-editor-label {
    padding: 0.3rem 1rem;
    background: rgba(0, 0, 0, 0.03);
    font-size: 11px;
    color: #888;
    border-top: 1px solid rgba(0, 0, 0, 0.07);
  }

  .bench-editor {
    flex: 1;
    min-height: 0;
    overflow: auto;
    border-top: 1px solid rgba(0, 0, 0, 0.07);
  }

  .bench-editor :global(.cm-editor) {
    height: 100%;
    min-height: 400px;
  }
</style>
