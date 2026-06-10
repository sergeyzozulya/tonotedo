// Proxy benchmarks for the 10k-word document (issue #16, spec 0006).
//
// These are CI-runnable HEADLESS proxies, not the 0006/0013 paint budget.
// They exercise the computationally heavy parts of the editor stack in a
// DOM-free vitest environment:
//
//   1. EditorState.create with all extensions  — parse + initial state build
//   2. EditorState.update (transaction apply)  — per-keystroke state transition
//   3. computeRevealDecorations                — cursor-reveal decoration pass
//   4. computeChipDecorations                  — chip decoration pass
//   5. detectFrontmatter                       — frontmatter region detection
//
// Thresholds are set with ≥ 3× headroom against measured p95 on a 2024 M2 Mac
// running vitest in Node.js (last measured 2026-06-11):
//
//   measured p95          threshold (headroom)
//   ──────────────────    ──────────────────────────────────────────────────
//   state.create  6.97ms  < 25ms   (3.6×)
//   tx apply      0.007ms < 4ms    (max observed 0.33ms, ~12× on max)
//   reveal decos  0.09ms  < 8ms    (~90×)
//   chip decos    0.09ms  < 8ms    (~90×)
//   frontmatter   0.002ms < 2ms    (1000× — pure line scan)
//   combined      0.12ms  < 8ms    (~66×)
//
// Note: Node.js JIT timings are typically faster than browser/Tauri at cold
// start but warm up faster. The generous ceilings absorb both flakiness and
// environment differences. If a threshold trips in CI, investigate the
// regression — don't just raise the number.
//
// If these assertions start flaking, the 3× multiplier should absorb noise.
// If they fail hard, that indicates a regression worth investigating.
//
// What these DO NOT cover:
//   - Actual paint latency (needs a real browser + rAF)
//   - ViewPlugin overhead (needs EditorView + DOM)
//   - Mobile performance (run /#/bench on a physical device)
//
// For true pass/fail against the spec budget, run:
//   pnpm dev → open http://localhost:1420/#/bench → click "Run benchmark"

import { describe, it, expect } from "vitest";
import { EditorState, EditorSelection } from "@codemirror/state";

import { markdownExtension } from "../extensions/markdown.js";
import { baseSetup } from "../extensions/markdown.js";
import { computeRevealDecorations } from "../extensions/cursor-reveal.js";
import { computeChipDecorations, emptyCache } from "../extensions/chips.js";
import { detectFrontmatter } from "../extensions/frontmatter-fold.js";
import { generateBenchDoc, wordCount, percentiles } from "../../bench/doc-gen.js";

// ── Shared fixture ─────────────────────────────────────────────────────────────

const BENCH_SEED = 0xdeadbeef;

// Generated once per test run (not per test) — keeps suite fast.
const BENCH_DOC = generateBenchDoc(BENCH_SEED, 10000);
const BENCH_WORDS = wordCount(BENCH_DOC);
const FULL_RANGE = [{ from: 0, to: BENCH_DOC.length }] as const;

function stateOf(doc: string, head = 0): EditorState {
  return EditorState.create({
    doc,
    selection: EditorSelection.cursor(head),
    extensions: [markdownExtension, baseSetup],
  });
}

// ── 1. Doc generation — determinism & target size ─────────────────────────────

describe("doc-gen determinism", () => {
  it("generates ≥ 9500 words", () => {
    expect(BENCH_WORDS).toBeGreaterThanOrEqual(9500);
  });

  it("is deterministic: same seed produces identical output", () => {
    const a = generateBenchDoc(BENCH_SEED, 10000);
    const b = generateBenchDoc(BENCH_SEED, 10000);
    expect(a).toBe(b);
  });

  it("different seeds produce different documents", () => {
    const a = generateBenchDoc(BENCH_SEED, 10000);
    const b = generateBenchDoc(BENCH_SEED + 1, 10000);
    expect(a).not.toBe(b);
  });

  it("contains frontmatter block", () => {
    expect(BENCH_DOC.startsWith("---\n")).toBe(true);
    // Find closing fence
    const second = BENCH_DOC.indexOf("\n---", 4);
    expect(second).toBeGreaterThan(4);
  });

  it("contains at least 80 inline tokens (#tag/@mention/[[wikilink]])", () => {
    const tags = (BENCH_DOC.match(/#[a-z][a-z0-9/_-]*/g) ?? []).length;
    const mentions = (BENCH_DOC.match(/@[a-z][a-z0-9_-]*/g) ?? []).length;
    const wikilinks = (BENCH_DOC.match(/\[\[/g) ?? []).length;
    expect(tags + mentions + wikilinks).toBeGreaterThanOrEqual(80);
  });

  it("contains at least one code fence", () => {
    expect(BENCH_DOC).toMatch(/```[a-z]+/);
  });

  it("contains h1, h2, h3 headings", () => {
    expect(BENCH_DOC).toMatch(/^# /m);
    expect(BENCH_DOC).toMatch(/^## /m);
    expect(BENCH_DOC).toMatch(/^### /m);
  });

  it("contains task list items", () => {
    expect(BENCH_DOC).toMatch(/^- \[[x ]\]/m);
  });
});

// ── 2. percentiles helper ─────────────────────────────────────────────────────

describe("percentiles helper", () => {
  it("returns 0s for empty input", () => {
    expect(percentiles([])).toEqual({ p50: 0, p95: 0, max: 0 });
  });

  it("single element: p50 = p95 = max", () => {
    const r = percentiles([42]);
    expect(r.p50).toBe(42);
    expect(r.p95).toBe(42);
    expect(r.max).toBe(42);
  });

  it("p95 < max for diverse inputs", () => {
    const data = Array.from({ length: 100 }, (_, i) => i + 1); // 1..100
    const r = percentiles(data);
    expect(r.p50).toBe(50);
    expect(r.p95).toBe(95);
    expect(r.max).toBe(100);
  });

  it("handles unsorted input", () => {
    const r = percentiles([100, 1, 50, 25, 75]);
    expect(r.p50).toBe(50);
    expect(r.max).toBe(100);
  });
});

// ── 3. EditorState.create on 10k doc ─────────────────────────────────────────

describe("proxy benchmark — EditorState.create (10k-word doc)", () => {
  it("parse + state build completes in < 25ms p95 over 10 cold samples", () => {
    const samples: number[] = [];
    for (let i = 0; i < 10; i++) {
      const t0 = performance.now();
      stateOf(BENCH_DOC);
      samples.push(performance.now() - t0);
    }
    const { p95, max } = percentiles(samples);
    // Generous ceiling: 25ms p95. Real p95 on M2 is ~8ms.
    expect(p95).toBeLessThan(25);
    // Smoke: at least one sample must have run
    expect(samples.length).toBe(10);
    // Log for diagnostic reference
    console.log(`[bench proxy] state.create p95=${p95.toFixed(2)}ms max=${max.toFixed(2)}ms`);
  });
});

// ── 4. EditorState.update (transaction apply) ─────────────────────────────────

describe("proxy benchmark — transaction apply (300 insertions, 10k-word doc)", () => {
  it("p95 apply time < 4ms over 300 insertions", () => {
    let state = stateOf(BENCH_DOC);
    const docLen = state.doc.length;
    const durations: number[] = [];

    // Same deterministic keystroke positions as the browser bench.
    const lo = Math.floor(docLen / 4);
    const hi = Math.floor((docLen * 3) / 4);
    const span = hi - lo;

    for (let i = 0; i < 300; i++) {
      const t = i / 300;
      const phase = (t * 7 + 0.13) % 1;
      // Position relative to current doc length (grows by 1 per iteration).
      const basePos = lo + Math.floor(phase * span);
      const pos = Math.min(basePos, state.doc.length);

      const t0 = performance.now();
      const tx = state.update({
        changes: { from: pos, to: pos, insert: "a" },
        selection: EditorSelection.cursor(pos + 1),
      });
      durations.push(performance.now() - t0);

      state = tx.state;
    }

    const { p50, p95, max } = percentiles(durations);
    // Ceiling: 4ms p95. Real p95 on M2 is ~0.4ms (10× headroom).
    expect(p95).toBeLessThan(4);
    console.log(
      `[bench proxy] tx apply p50=${p50.toFixed(3)}ms p95=${p95.toFixed(3)}ms max=${max.toFixed(3)}ms (n=300)`,
    );
  });
});

// ── 5. computeRevealDecorations on 10k doc ────────────────────────────────────

describe("proxy benchmark — computeRevealDecorations (10k-word doc)", () => {
  it("decoration pass completes in < 8ms p95 over 30 samples", () => {
    const state = stateOf(BENCH_DOC, Math.floor(BENCH_DOC.length / 2));
    const durations: number[] = [];

    for (let i = 0; i < 30; i++) {
      const t0 = performance.now();
      computeRevealDecorations(state, FULL_RANGE);
      durations.push(performance.now() - t0);
    }

    const { p50, p95, max } = percentiles(durations);
    // Ceiling: 8ms p95. Real p95 on M2 is ~1ms (8× headroom).
    expect(p95).toBeLessThan(8);
    console.log(
      `[bench proxy] revealDecos p50=${p50.toFixed(3)}ms p95=${p95.toFixed(3)}ms max=${max.toFixed(3)}ms`,
    );
  });
});

// ── 6. computeChipDecorations on 10k doc ─────────────────────────────────────

describe("proxy benchmark — computeChipDecorations (10k-word doc)", () => {
  it("decoration pass completes in < 8ms p95 over 30 samples", () => {
    const state = stateOf(BENCH_DOC, Math.floor(BENCH_DOC.length / 2));
    const cache = emptyCache();
    const entryTitles = new Map<string, string>();
    const durations: number[] = [];

    for (let i = 0; i < 30; i++) {
      const t0 = performance.now();
      computeChipDecorations(state, {
        cache,
        entryTitles,
        callbacks: {},
        ranges: FULL_RANGE,
      });
      durations.push(performance.now() - t0);
    }

    const { p50, p95, max } = percentiles(durations);
    // Ceiling: 8ms p95. Real p95 on M2 is ~1ms (8× headroom).
    expect(p95).toBeLessThan(8);
    console.log(
      `[bench proxy] chipDecos p50=${p50.toFixed(3)}ms p95=${p95.toFixed(3)}ms max=${max.toFixed(3)}ms`,
    );
  });
});

// ── 7. detectFrontmatter on 10k doc ──────────────────────────────────────────

describe("proxy benchmark — detectFrontmatter (10k-word doc)", () => {
  it("frontmatter detection completes in < 2ms p95 over 100 samples", () => {
    const state = stateOf(BENCH_DOC);
    const durations: number[] = [];

    for (let i = 0; i < 100; i++) {
      const t0 = performance.now();
      detectFrontmatter(state);
      durations.push(performance.now() - t0);
    }

    const { p95, max } = percentiles(durations);
    // Very generous: 2ms. Real p95 on M2 < 0.05ms (40× headroom).
    expect(p95).toBeLessThan(2);
    console.log(`[bench proxy] detectFrontmatter p95=${p95.toFixed(4)}ms max=${max.toFixed(4)}ms`);
  });
});

// ── 8. Combined (apply + reveal + chips) — one full "keystroke" simulation ────

describe("proxy benchmark — combined apply+reveal+chips per keystroke (10k-word doc)", () => {
  it("p95 combined < 8ms over 300 keystrokes (proxy for 0006 < 16ms paint budget)", () => {
    let state = stateOf(BENCH_DOC);
    const docLen = state.doc.length;
    const cache = emptyCache();
    const entryTitles = new Map<string, string>();
    const durations: number[] = [];

    const lo = Math.floor(docLen / 4);
    const hi = Math.floor((docLen * 3) / 4);
    const span = hi - lo;

    for (let i = 0; i < 300; i++) {
      const t = i / 300;
      const phase = (t * 7 + 0.13) % 1;
      const basePos = lo + Math.floor(phase * span);
      const pos = Math.min(basePos, state.doc.length);

      const t0 = performance.now();

      // 1. Apply the transaction
      const tx = state.update({
        changes: { from: pos, to: pos, insert: "a" },
        selection: EditorSelection.cursor(pos + 1),
      });
      state = tx.state;

      // 2. Recompute decorations over visible viewport (simulated: full doc)
      computeRevealDecorations(state, FULL_RANGE);
      computeChipDecorations(state, {
        cache,
        entryTitles,
        callbacks: {},
        ranges: FULL_RANGE,
      });

      durations.push(performance.now() - t0);
    }

    const { p50, p95, max } = percentiles(durations);
    // Combined proxy p95 < 8ms = half the 16ms paint budget.
    // Real remaining budget (Svelte reactivity, DOM update, layout, rAF) is
    // accounted for by this headroom. Paint numbers come from /#/bench.
    expect(p95).toBeLessThan(8);
    console.log(
      `[bench proxy] combined p50=${p50.toFixed(3)}ms p95=${p95.toFixed(3)}ms max=${max.toFixed(3)}ms (n=300)`,
    );
  });
});
