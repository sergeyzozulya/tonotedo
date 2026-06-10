// Deterministic 10k-word markdown document generator for the typing benchmark
// (issue #16, spec 0006 §Performance budgets).
//
// "Deterministic" means: given the same seed, the output is always identical.
// We use a simple LCG PRNG (no Math.random) so the doc is reproducible across
// runs, machines, and environments (vitest / browser / phone).
//
// Structure of the generated document:
//   - YAML frontmatter (title, tags, date)
//   - 20 sections, each with a heading (h1–h3) + body paragraphs
//   - Body paragraphs mix plain prose, *emphasis*, **strong**, `inline code`,
//     [links](url), task lists, code fences, and inline tokens
//   - ~100 inline tokens total (#tags, @mentions, [[wikilinks]])
//
// The "~10 000 words" budget counts space-separated tokens, not CM6 chars.
// This generator targets ≥ 9 500 words so a slightly varying word list stays
// above the spec floor.

// ── LCG PRNG ──────────────────────────────────────────────────────────────────

/** Mulberry32 — simple, fast, seedable. Returns floats in [0, 1). */
function makePrng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s += 0x6d2b79f5;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 0x100000000;
  };
}

// ── Word & phrase banks ────────────────────────────────────────────────────────

const NOUNS = [
  "system",
  "index",
  "layer",
  "module",
  "pipeline",
  "buffer",
  "token",
  "document",
  "editor",
  "search",
  "vault",
  "entry",
  "node",
  "graph",
  "cache",
  "schema",
  "filter",
  "cursor",
  "state",
  "event",
  "queue",
  "stream",
  "range",
  "span",
  "block",
  "chunk",
  "patch",
  "delta",
  "commit",
  "branch",
  "merge",
  "conflict",
  "resolver",
  "handler",
  "context",
  "scope",
  "closure",
  "trait",
  "struct",
  "enum",
  "variant",
  "payload",
  "message",
  "signal",
  "channel",
  "thread",
  "process",
  "runtime",
  "scheduler",
  "allocator",
];

const VERBS = [
  "processes",
  "indexes",
  "scans",
  "parses",
  "emits",
  "handles",
  "resolves",
  "merges",
  "filters",
  "renders",
  "computes",
  "updates",
  "dispatches",
  "transforms",
  "validates",
  "serializes",
  "deserializes",
  "schedules",
  "allocates",
  "traverses",
  "iterates",
  "applies",
  "rebuilds",
  "recomputes",
  "measures",
];

const ADJECTIVES = [
  "deterministic",
  "incremental",
  "efficient",
  "immutable",
  "atomic",
  "concurrent",
  "lazy",
  "eager",
  "bounded",
  "structural",
  "semantic",
  "syntactic",
  "lexical",
  "virtual",
  "persistent",
  "transient",
  "stable",
  "volatile",
  "opaque",
  "transparent",
  "granular",
  "coarse",
  "fine-grained",
  "composable",
  "extensible",
];

const CONJUNCTIONS = ["and", "but", "while", "although", "because", "when", "since", "unless"];

const TAGS = [
  "#project/atlas",
  "#engineering",
  "#architecture",
  "#strategy",
  "#planning",
  "#followup",
  "#review",
  "#design",
  "#performance",
  "#testing",
  "#refactor",
  "#infra",
];

const MENTIONS = [
  "@anna",
  "@bob",
  "@carol",
  "@david",
  "@sergey",
  "@alex",
  "@priya",
  "@lee",
  "@tom",
  "@sam",
];

const WIKILINKS = [
  "[[work/atlas/project-overview]]",
  "[[work/atlas/meeting-2026-05|kickoff meeting]]",
  "[[work/atlas/tech-decisions]]",
  "[[work/atlas/roadmap|Q3 roadmap]]",
  "[[books/deep-work|Deep Work]]",
  "[[books/thinking-fast-and-slow]]",
  "[[inbox/ideas-backlog]]",
  "[[inbox/follow-up-anna|follow-up]]",
  "[[journal/2026-05-20]]",
  "[[inbox/weekly-template|weekly template]]",
];

const HEADING_WORDS = [
  "Architecture",
  "Design",
  "Implementation",
  "Overview",
  "Context",
  "Decisions",
  "Tradeoffs",
  "Analysis",
  "Notes",
  "Review",
  "Planning",
  "Backlog",
  "Summary",
  "Details",
  "Approach",
  "Strategy",
  "Goals",
  "Outcomes",
  "References",
  "Appendix",
];

// ── Generator ─────────────────────────────────────────────────────────────────

function pick<T>(arr: readonly T[], rng: () => number): T {
  return arr[Math.floor(rng() * arr.length)];
}

function sentence(rng: () => number, extraTokens?: string): string {
  const adj = pick(ADJECTIVES, rng);
  const noun = pick(NOUNS, rng);
  const verb = pick(VERBS, rng);
  const noun2 = pick(NOUNS, rng);
  const conj = pick(CONJUNCTIONS, rng);
  const adj2 = pick(ADJECTIVES, rng);
  const noun3 = pick(NOUNS, rng);
  const core = `The ${adj} ${noun} ${verb} the ${noun2} ${conj} a ${adj2} ${noun3}`;
  if (extraTokens) return `${core} via ${extraTokens}.`;
  return `${core}.`;
}

function paragraph(rng: () => number, tokenBudget: { remaining: number }): string {
  // 3–5 sentences per paragraph
  const count = 3 + Math.floor(rng() * 3);
  const sentences: string[] = [];
  for (let i = 0; i < count; i++) {
    let extra: string | undefined;
    if (tokenBudget.remaining > 0 && rng() < 0.35) {
      const kind = Math.floor(rng() * 3);
      if (kind === 0) {
        extra = pick(TAGS, rng);
      } else if (kind === 1) {
        extra = pick(MENTIONS, rng);
      } else {
        extra = pick(WIKILINKS, rng);
      }
      tokenBudget.remaining--;
    }
    sentences.push(sentence(rng, extra));
  }
  return sentences.join(" ");
}

function codeBlock(rng: () => number): string {
  const langs = ["ts", "rust", "sh", "python", "json"] as const;
  const lang = pick(langs, rng);
  const lines = [
    `\`\`\`${lang}`,
    `// ${pick(ADJECTIVES, rng)} ${pick(NOUNS, rng)} implementation`,
    `function process(${pick(NOUNS, rng)}: ${pick(NOUNS, rng)}): void {`,
    `  // ${pick(VERBS, rng)} the ${pick(NOUNS, rng)}`,
    `  const ${pick(NOUNS, rng)} = ${pick(NOUNS, rng)}.${pick(VERBS, rng).replace(/s$/, "")}();`,
    `}`,
    `\`\`\``,
  ];
  return lines.join("\n");
}

function taskList(rng: () => number): string {
  const count = 3 + Math.floor(rng() * 4);
  const items: string[] = [];
  for (let i = 0; i < count; i++) {
    const done = rng() < 0.3 ? "x" : " ";
    items.push(`- [${done}] ${pick(VERBS, rng)} the ${pick(ADJECTIVES, rng)} ${pick(NOUNS, rng)}`);
  }
  return items.join("\n");
}

function bulletList(rng: () => number): string {
  const count = 4 + Math.floor(rng() * 4);
  const items: string[] = [];
  for (let i = 0; i < count; i++) {
    items.push(`- ${pick(ADJECTIVES, rng)} ${pick(NOUNS, rng)}: ${pick(VERBS, rng)}`);
  }
  return items.join("\n");
}

/** Count words in a string (split on whitespace). */
function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

/**
 * Generate a deterministic markdown document of approximately `targetWords`
 * words with headings, lists, emphasis, code fences, and ~100 inline tokens
 * (#tags, @mentions, [[wikilinks]]).
 *
 * The document is stable: same `seed` always produces identical output.
 */
export function generateBenchDoc(seed = 0xdeadbeef, targetWords = 10000): string {
  const rng = makePrng(seed);
  const parts: string[] = [];

  // ── Frontmatter ─────────────────────────────────────────────────────────────
  parts.push(
    [
      "---",
      "title: Benchmark Document — 10k Words",
      "tags: [benchmark, performance, engineering]",
      "date: 2026-06-11",
      "---",
    ].join("\n"),
  );
  parts.push("");

  // ── Sections ──────────────────────────────────────────────────────────────────
  // We generate sections until we hit the target word count. Each section has:
  //   - A heading (h1 every 5, h2 every 2, otherwise h3)
  //   - 2–4 prose paragraphs
  //   - Occasionally a code block, task list, or bullet list
  //   - A modest inline token budget per section

  const tokenBudget = { remaining: 110 }; // aim for ~100 tokens total
  let sectionIdx = 0;
  let approxWords = wordCount(parts.join("\n"));

  while (approxWords < targetWords) {
    const sectionWords: string[] = [];

    // Heading level
    const level = sectionIdx % 5 === 0 ? 1 : sectionIdx % 2 === 0 ? 2 : 3;
    const hashes = "#".repeat(level);
    const topic1 = pick(HEADING_WORDS, rng);
    const topic2 = pick(HEADING_WORDS, rng);
    const heading =
      level === 1 ? `${hashes} ${topic1}: ${topic2} Overview` : `${hashes} ${topic1} and ${topic2}`;
    sectionWords.push(heading);
    sectionWords.push("");

    // Prose paragraphs
    const paraCount = 2 + Math.floor(rng() * 3);
    for (let p = 0; p < paraCount; p++) {
      sectionWords.push(paragraph(rng, tokenBudget));
      sectionWords.push("");
    }

    // Occasional extra block
    if (rng() < 0.3) {
      sectionWords.push(codeBlock(rng));
      sectionWords.push("");
    } else if (rng() < 0.4) {
      sectionWords.push(taskList(rng));
      sectionWords.push("");
    } else if (rng() < 0.4) {
      sectionWords.push(bulletList(rng));
      sectionWords.push("");
    }

    parts.push(sectionWords.join("\n"));
    approxWords += wordCount(sectionWords.join("\n"));
    sectionIdx++;
  }

  return parts.join("\n");
}

/**
 * Word count of the generated document (useful in tests to assert the target
 * is met without re-generating from scratch).
 */
export { wordCount };

/**
 * Compute percentile (p50, p95, max) from an array of durations (ms).
 * Input need not be sorted. Returns { p50, p95, max } in ms.
 */
export function percentiles(durations: number[]): { p50: number; p95: number; max: number } {
  if (durations.length === 0) return { p50: 0, p95: 0, max: 0 };
  const sorted = [...durations].sort((a, b) => a - b);
  const idx = (p: number) => Math.min(Math.ceil((p / 100) * sorted.length) - 1, sorted.length - 1);
  return {
    p50: sorted[idx(50)],
    p95: sorted[idx(95)],
    max: sorted[sorted.length - 1],
  };
}
