// Headless tests for the autocomplete extension (issue #14).
//
// Tests are DOM-free and IPC-free where possible. They directly exercise:
//   1. rankTags / rankPeople — ranking + match logic (pure functions).
//   2. buildCompletionSources — source trigger detection + option content,
//      driven against a minimal mock IPC stub.
//   3. Literal insertion: applying a completion to an EditorState produces the
//      expected document text.
//   4. Create-person sentinel: always present, always last.
//
// Not tested here (requires a real DOM for autocompletion popup lifecycle):
//   - CSS/theme of the dropdown.
//   - Keyboard navigation within the popup.
//   Both are covered by the /dev demo.

import { describe, it, expect, vi } from "vitest";
import { EditorState, EditorSelection } from "@codemirror/state";
import { CompletionContext } from "@codemirror/autocomplete";

import { markdownExtension } from "../extensions/markdown.js";
import {
  rankTags,
  rankPeople,
  rankTagsScoped,
  isInScope,
  buildCompletionSources,
} from "../extensions/autocomplete.js";
import type { TagMeta, PersonMeta, Ipc } from "../../ipc/types.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const TAGS: TagMeta[] = [
  { name: "followup", color: "red", count: 5 },
  { name: "project/atlas", color: "blue", count: 8 },
  { name: "daily", color: "slate", count: 12 },
  { name: "engineering", color: "green", count: 3 },
  { name: "planning", color: "amber", count: 2 },
  { name: "strategy", color: "violet", count: 1 },
  // An "undeclared" tag: default slate color, lower count.
  { name: "random-undeclared", color: "slate", count: 0 },
];

const PEOPLE: PersonMeta[] = [
  { slug: "anna", displayName: "Anna K.", count: 6 },
  { slug: "bob", displayName: "Bob T.", count: 4 },
  { slug: "carol", displayName: "Carol M.", count: 2 },
  // An undeclared person: displayName === slug.
  { slug: "unknown-person", displayName: "unknown-person", count: 1 },
];

const ENTRIES = [
  {
    id: "work/atlas/project-overview",
    title: "Project Atlas — Overview",
    group: "work/atlas",
    modifiedAt: "2026-05-15T09:00:00Z",
    tags: [],
    people: [],
    path: "work/atlas/project-overview.md",
  },
  {
    id: "journal/2026-05-20",
    title: "Journal — 2026-05-20",
    group: "journal",
    modifiedAt: "2026-05-20T21:00:00Z",
    tags: [],
    people: [],
    path: "journal/2026-05-20.md",
  },
  {
    id: "books/deep-work",
    title: "Deep Work — Cal Newport",
    group: "books",
    modifiedAt: "2026-05-18T19:00:00Z",
    tags: [],
    people: [],
    path: "books/deep-work.md",
  },
];

/** Minimal stub IPC that satisfies the three calls autocomplete needs. */
function stubIpc(overrides?: {
  tags?: TagMeta[];
  people?: PersonMeta[];
  entries?: typeof ENTRIES;
}): Ipc {
  const tags = overrides?.tags ?? TAGS;
  const people = overrides?.people ?? PEOPLE;
  const entries = overrides?.entries ?? ENTRIES;
  return {
    tag_index: vi.fn(async () => ({ ok: true as const, value: tags })),
    people_index: vi.fn(async () => ({ ok: true as const, value: people })),
    entries_in_group: vi.fn(async () => ({
      ok: true as const,
      value: { items: entries },
    })),
    // Unused by autocomplete — stub out.
    read_entry: vi.fn() as never,
    write_entry: vi.fn() as never,
    search: vi.fn() as never,
    backlinks: vi.fn() as never,
    core_version: vi.fn() as never,
    attach_file: vi.fn() as never,
    asset_url: vi.fn() as never,
    asset_exists: vi.fn() as never,
    remove_asset: vi.fn() as never,
    entry_titles: vi.fn() as never,
    list_groups: vi.fn() as never,
    saved_searches_get: vi.fn() as never,
    saved_searches_set: vi.fn() as never,
    set_person: vi.fn() as never,
    delete_person: vi.fn() as never,
    mentions_for: vi.fn() as never,
    rename_tag: vi.fn() as never,
    merge_tag: vi.fn() as never,
    delete_tag: vi.fn() as never,
    calendar_window: vi.fn() as never,
    // Phase-6 group + trash commands — not used by autocomplete.
    create_group: vi.fn() as never,
    rename_group: vi.fn() as never,
    move_group: vi.fn() as never,
    move_entry: vi.fn() as never,
    trash_entry: vi.fn() as never,
    trash_group: vi.fn() as never,
    trash_list: vi.fn() as never,
    trash_restore: vi.fn() as never,
    trash_purge: vi.fn() as never,
    effective_schema: vi.fn() as never,
    on: vi.fn(() => () => {}),
  };
}

/** Build a CompletionContext at `pos` inside `doc`. */
function completionCtx(doc: string, pos: number, explicit = false): CompletionContext {
  const state = EditorState.create({
    doc,
    selection: EditorSelection.cursor(pos),
    extensions: [markdownExtension],
  });
  return new CompletionContext(state, pos, explicit);
}

// ── rankTags ──────────────────────────────────────────────────────────────────

describe("rankTags", () => {
  it("returns all tags when query is empty", () => {
    const result = rankTags(TAGS, "");
    expect(result).toHaveLength(TAGS.length);
  });

  it("prefix match comes before substring match", () => {
    const result = rankTags(TAGS, "pro");
    // "project/atlas" starts with "pro" (prefix); "engineering" doesn't match.
    expect(result[0].name).toBe("project/atlas");
  });

  it("filters out tags with no match", () => {
    const result = rankTags(TAGS, "zzz");
    expect(result).toHaveLength(0);
  });

  it("within prefix tier, higher count comes first", () => {
    const tags: TagMeta[] = [
      { name: "daily", color: "slate", count: 12 },
      { name: "data", color: "slate", count: 20 },
    ];
    const result = rankTags(tags, "da");
    expect(result[0].name).toBe("data"); // count 20 > 12
  });

  it("case-insensitive match (query uppercase, tags lowercase)", () => {
    const result = rankTags(TAGS, "DAILY");
    expect(result.some((t) => t.name === "daily")).toBe(true);
  });

  it("partial substring match on hierarchical name", () => {
    const result = rankTags(TAGS, "atlas");
    expect(result.some((t) => t.name === "project/atlas")).toBe(true);
  });
});

// ── rankPeople ────────────────────────────────────────────────────────────────

describe("rankPeople", () => {
  it("returns all people when query is empty", () => {
    const result = rankPeople(PEOPLE, "");
    expect(result).toHaveLength(PEOPLE.length);
  });

  it("declared people (displayName !== slug) come before undeclared", () => {
    const result = rankPeople(PEOPLE, "");
    const declaredNames = result.filter((p) => p.displayName !== p.slug).map((p) => p.slug);
    const undeclaredNames = result.filter((p) => p.displayName === p.slug).map((p) => p.slug);
    // All declared entries must appear before any undeclared.
    // findLastIndex polyfill: scan from the end.
    let lastDeclaredIdx = -1;
    for (let i = result.length - 1; i >= 0; i--) {
      if (result[i].displayName !== result[i].slug) {
        lastDeclaredIdx = i;
        break;
      }
    }
    const firstUndeclaredIdx = result.findIndex((p) => p.displayName === p.slug);
    if (undeclaredNames.length > 0 && declaredNames.length > 0) {
      expect(lastDeclaredIdx).toBeLessThan(firstUndeclaredIdx);
    }
  });

  it("filters to matches only", () => {
    const result = rankPeople(PEOPLE, "ann");
    expect(result.length).toBeGreaterThanOrEqual(1);
    expect(result.some((p) => p.slug === "anna")).toBe(true);
  });

  it("matches on displayName too (Anna K. matches 'anna k')", () => {
    const result = rankPeople(PEOPLE, "anna k");
    expect(result.some((p) => p.slug === "anna")).toBe(true);
  });

  it("no match for unrelated query", () => {
    const result = rankPeople(PEOPLE, "zzz");
    expect(result).toHaveLength(0);
  });
});

// ── Source trigger detection ──────────────────────────────────────────────────

describe("tagSource — trigger detection", () => {
  it("triggers on `#` at line start", async () => {
    const doc = "#";
    const [tagSource] = buildCompletionSources({ ipc: stubIpc() });
    const result = await tagSource(completionCtx(doc, 1, true));
    expect(result).not.toBeNull();
  });

  it("triggers after space + `#`", async () => {
    const doc = "some text #";
    const [tagSource] = buildCompletionSources({ ipc: stubIpc() });
    const result = await tagSource(completionCtx(doc, doc.length, true));
    expect(result).not.toBeNull();
  });

  it("triggers with partial slug typed", async () => {
    const doc = "#fol";
    const [tagSource] = buildCompletionSources({ ipc: stubIpc() });
    const result = await tagSource(completionCtx(doc, doc.length, true));
    expect(result).not.toBeNull();
    expect(result!.options.some((o) => o.label === "#followup")).toBe(true);
  });

  it("does NOT trigger inside frontmatter", async () => {
    const doc = "---\ntags: #test\n---\n\nbody";
    // pos=12: inside the frontmatter `tags:` line.
    const [tagSource] = buildCompletionSources({ ipc: stubIpc() });
    const result = await tagSource(completionCtx(doc, 12, true));
    expect(result).toBeNull();
  });

  it("does NOT trigger inside a fenced code block", async () => {
    const doc = "```\n#tag\n```";
    // pos=5: inside the fence after the opening ```.
    const [tagSource] = buildCompletionSources({ ipc: stubIpc() });
    const result = await tagSource(completionCtx(doc, 5, true));
    expect(result).toBeNull();
  });

  it("does NOT trigger inside inline code", async () => {
    const doc = "text `#tag` more";
    // pos=8: inside the inline code span.
    const [tagSource] = buildCompletionSources({ ipc: stubIpc() });
    const result = await tagSource(completionCtx(doc, 8, true));
    expect(result).toBeNull();
  });
});

describe("mentionSource — trigger detection", () => {
  it("triggers on `@` at line start", async () => {
    const doc = "@";
    const [, mentionSource] = buildCompletionSources({ ipc: stubIpc() });
    const result = await mentionSource(completionCtx(doc, 1, true));
    expect(result).not.toBeNull();
  });

  it("triggers after space + `@`", async () => {
    const doc = "met with @";
    const [, mentionSource] = buildCompletionSources({ ipc: stubIpc() });
    const result = await mentionSource(completionCtx(doc, doc.length, true));
    expect(result).not.toBeNull();
  });

  it("does NOT trigger when `@` is preceded by a word char (email boundary)", async () => {
    const doc = "email@";
    const [, mentionSource] = buildCompletionSources({ ipc: stubIpc() });
    const result = await mentionSource(completionCtx(doc, doc.length, true));
    expect(result).toBeNull();
  });

  it("does NOT trigger for mid-word `@` (email@example.com pattern)", async () => {
    // Position the cursor after `email@` — the `@` at pos 5 is preceded by `l` (word char).
    const doc = "email@example";
    const [, mentionSource] = buildCompletionSources({ ipc: stubIpc() });
    // Try completing at pos 6 (right after `@`), which is inside the `@example` piece.
    // The char before `@` is `l`, so the source must decline.
    const result = await mentionSource(completionCtx(doc, 6, true));
    expect(result).toBeNull();
  });

  it("does NOT trigger inside frontmatter", async () => {
    const doc = "---\nmentions: @anna\n---\n\nbody";
    const [, mentionSource] = buildCompletionSources({ ipc: stubIpc() });
    const result = await mentionSource(completionCtx(doc, 15, true));
    expect(result).toBeNull();
  });

  it("does NOT trigger inside fenced code", async () => {
    const doc = "```\n@user\n```";
    const [, mentionSource] = buildCompletionSources({ ipc: stubIpc() });
    const result = await mentionSource(completionCtx(doc, 5, true));
    expect(result).toBeNull();
  });
});

describe("wikilinkSource — trigger detection", () => {
  it("triggers on `[[`", async () => {
    const doc = "[[";
    const [, , wikilinkSource] = buildCompletionSources({ ipc: stubIpc() });
    const result = await wikilinkSource(completionCtx(doc, 2, true));
    expect(result).not.toBeNull();
  });

  it("triggers with partial id typed", async () => {
    const doc = "[[work";
    const [, , wikilinkSource] = buildCompletionSources({ ipc: stubIpc() });
    const result = await wikilinkSource(completionCtx(doc, doc.length, true));
    expect(result).not.toBeNull();
  });

  it("does NOT trigger inside frontmatter", async () => {
    const doc = "---\nrelated: [[foo\n---\n\nbody";
    const [, , wikilinkSource] = buildCompletionSources({ ipc: stubIpc() });
    const result = await wikilinkSource(completionCtx(doc, 16, true));
    expect(result).toBeNull();
  });

  it("does NOT trigger inside fenced code", async () => {
    const doc = "```\n[[link]]\n```";
    const [, , wikilinkSource] = buildCompletionSources({ ipc: stubIpc() });
    const result = await wikilinkSource(completionCtx(doc, 6, true));
    expect(result).toBeNull();
  });
});

// ── Option ranking: declared-first ───────────────────────────────────────────

describe("mentionSource — declared-first ranking", () => {
  it("declared people appear before undeclared people", async () => {
    const [, mentionSource] = buildCompletionSources({ ipc: stubIpc() });
    const doc = "@";
    const result = await mentionSource(completionCtx(doc, 1, true));
    expect(result).not.toBeNull();
    const opts = result!.options.filter((o) => !o.label.startsWith("@create:"));
    const declaredSlugs = PEOPLE.filter((p) => p.displayName !== p.slug).map((p) => p.slug);
    const undeclaredSlugs = PEOPLE.filter((p) => p.displayName === p.slug).map((p) => p.slug);
    if (undeclaredSlugs.length > 0 && declaredSlugs.length > 0) {
      // findLastIndex polyfill: scan from the end.
      let lastDeclaredIdx = -1;
      for (let i = opts.length - 1; i >= 0; i--) {
        if (declaredSlugs.some((s) => opts[i].label === `@${s}`)) {
          lastDeclaredIdx = i;
          break;
        }
      }
      const firstUndeclaredIdx = opts.findIndex((o) =>
        undeclaredSlugs.some((s) => o.label === `@${s}`),
      );
      expect(lastDeclaredIdx).toBeLessThan(firstUndeclaredIdx);
    }
  });

  it("all declared people are present in options", async () => {
    const [, mentionSource] = buildCompletionSources({ ipc: stubIpc() });
    const doc = "@";
    const result = await mentionSource(completionCtx(doc, 1, true));
    expect(result).not.toBeNull();
    for (const p of PEOPLE.filter((p) => p.displayName !== p.slug)) {
      expect(result!.options.some((o) => o.label === `@${p.slug}`)).toBe(true);
    }
  });
});

describe("tagSource — count-ranked ordering", () => {
  it("higher-count tags come first for an empty query", async () => {
    const [tagSource] = buildCompletionSources({ ipc: stubIpc() });
    const doc = "#";
    const result = await tagSource(completionCtx(doc, 1, true));
    expect(result).not.toBeNull();
    // `daily` has count 12 (highest), should appear before `strategy` (count 1).
    const opts = result!.options;
    const dailyIdx = opts.findIndex((o) => o.label === "#daily");
    const strategyIdx = opts.findIndex((o) => o.label === "#strategy");
    expect(dailyIdx).toBeLessThan(strategyIdx);
  });
});

// ── Literal insertion ─────────────────────────────────────────────────────────

describe("completion insertion — literal text", () => {
  it("tag completion inserts #slug literal", async () => {
    const [tagSource] = buildCompletionSources({ ipc: stubIpc() });
    const doc = "#fol";
    const ctx = completionCtx(doc, doc.length, true);
    const result = await tagSource(ctx);
    expect(result).not.toBeNull();

    const followupOpt = result!.options.find((o) => o.label === "#followup");
    expect(followupOpt).toBeDefined();
    // The `apply` field is the literal text that will replace the token.
    expect(followupOpt!.apply).toBe("#followup");
  });

  it("mention completion inserts @slug literal", async () => {
    const [, mentionSource] = buildCompletionSources({ ipc: stubIpc() });
    const doc = "@an";
    const ctx = completionCtx(doc, doc.length, true);
    const result = await mentionSource(ctx);
    expect(result).not.toBeNull();

    const annaOpt = result!.options.find((o) => o.label === "@anna");
    expect(annaOpt).toBeDefined();
    expect(annaOpt!.apply).toBe("@anna");
  });

  it("wikilink completion inserts [[id]] with closing brackets", async () => {
    const [, , wikilinkSource] = buildCompletionSources({ ipc: stubIpc() });
    const doc = "[[work";
    const ctx = completionCtx(doc, doc.length, true);
    const result = await wikilinkSource(ctx);
    expect(result).not.toBeNull();

    const atlasOpt = result!.options.find((o) => o.label.includes("work/atlas/project-overview"));
    expect(atlasOpt).toBeDefined();
    // apply must be `[[id]]` — literal with closing brackets.
    expect(atlasOpt!.apply).toBe("[[work/atlas/project-overview]]");
  });

  it("applying a completion to an EditorState produces the correct document text", async () => {
    // Build a state with `#fol` and apply the `#followup` completion.
    const doc = "#fol";
    const [tagSource] = buildCompletionSources({ ipc: stubIpc() });
    const ctx = completionCtx(doc, doc.length, true);
    const result = await tagSource(ctx);
    expect(result).not.toBeNull();

    const followupOpt = result!.options.find((o) => o.label === "#followup");
    expect(followupOpt).toBeDefined();

    // Simulate what CM6 does on selection: apply is a string, replace [from, pos].
    const apply = followupOpt!.apply as string;
    const state = EditorState.create({
      doc,
      selection: EditorSelection.cursor(doc.length),
      extensions: [markdownExtension],
    });
    const tr = state.update({
      changes: { from: result!.from, to: doc.length, insert: apply },
    });
    expect(tr.state.doc.toString()).toBe("#followup");
  });
});

// ── Create-person option ──────────────────────────────────────────────────────

describe("mentionSource — create-person sentinel", () => {
  it("always includes a create-person option", async () => {
    const [, mentionSource] = buildCompletionSources({ ipc: stubIpc() });
    const doc = "@";
    const result = await mentionSource(completionCtx(doc, 1, true));
    expect(result).not.toBeNull();
    const createOpt = result!.options.find((o) => o.label.startsWith("@create:"));
    expect(createOpt).toBeDefined();
  });

  it("create-person option is the last in the list", async () => {
    const [, mentionSource] = buildCompletionSources({ ipc: stubIpc() });
    const doc = "@";
    const result = await mentionSource(completionCtx(doc, 1, true));
    expect(result).not.toBeNull();
    const last = result!.options[result!.options.length - 1];
    expect(last.label.startsWith("@create:")).toBe(true);
  });

  it("create-person label contains the typed slug", async () => {
    const [, mentionSource] = buildCompletionSources({ ipc: stubIpc() });
    const doc = "@newperson";
    const result = await mentionSource(completionCtx(doc, doc.length, true));
    expect(result).not.toBeNull();
    const createOpt = result!.options.find((o) => o.label.startsWith("@create:"));
    expect(createOpt).toBeDefined();
    expect(createOpt!.displayLabel).toContain("newperson");
  });

  it("fires onCreatePerson callback (not null) but does NOT insert text", async () => {
    const onCreatePerson = vi.fn();
    const [, mentionSource] = buildCompletionSources({ ipc: stubIpc(), onCreatePerson });
    const doc = "@newperson";
    const result = await mentionSource(completionCtx(doc, doc.length, true));
    expect(result).not.toBeNull();

    const createOpt = result!.options.find((o) => o.label.startsWith("@create:"));
    expect(createOpt).toBeDefined();
    // The apply is a function — calling it should fire onCreatePerson.
    // We simulate a minimal view dispatch to avoid needing a real EditorView.
    const mockView = {
      dispatch: vi.fn(),
    };
    const applyFn = createOpt!.apply as (
      view: unknown,
      completion: unknown,
      from: number,
      to: number,
    ) => void;
    applyFn(mockView, createOpt, 0, doc.length);
    expect(onCreatePerson).toHaveBeenCalledWith("newperson");
    // The mock dispatch should be called (to move the cursor / close popup) but
    // there should be no document insertion — dispatch called with selection only.
    expect(mockView.dispatch).toHaveBeenCalledWith({ selection: { anchor: doc.length } });
  });
});

// ── Wikilink recency ordering ─────────────────────────────────────────────────

describe("wikilinkSource — recency ordering", () => {
  it("most-recently modified entries appear first", async () => {
    const [, , wikilinkSource] = buildCompletionSources({ ipc: stubIpc() });
    const doc = "[[";
    const result = await wikilinkSource(completionCtx(doc, 2, true));
    expect(result).not.toBeNull();

    const opts = result!.options;
    // ENTRIES sorted by modifiedAt desc:
    // journal/2026-05-20 (2026-05-20T21:00:00Z) → first
    // books/deep-work    (2026-05-18T19:00:00Z) → second
    // work/atlas/...     (2026-05-15T09:00:00Z) → third
    const ids = opts.map((o) => (o.apply as string).replace("[[", "").replace("]]", ""));
    const journalIdx = ids.indexOf("journal/2026-05-20");
    const atlasIdx = ids.indexOf("work/atlas/project-overview");
    expect(journalIdx).toBeLessThan(atlasIdx);
  });
});

// ── Scoped tag visibility matrix (phase 6 / issue #28) ────────────────────────

/**
 * Fixture tags for scoped-tag tests.
 *
 * Scope layout:
 *   global:          "global-a"  (scopePath null)
 *   scoped work:     "work-only" (scopePath "work")
 *   scoped atlas:    "atlas-tag" (scopePath "work/atlas")
 *   scoped other:    "other-tag" (scopePath "other")
 *   collision:       "collision" appears as both global and scoped (global wins)
 */
const SCOPED_TAGS: TagMeta[] = [
  { name: "global-a", color: "slate", count: 5, scopePath: null },
  { name: "work-only", color: "blue", count: 3, scopePath: "work" },
  { name: "atlas-tag", color: "green", count: 2, scopePath: "work/atlas" },
  { name: "other-tag", color: "red", count: 1, scopePath: "other" },
  { name: "collision", color: "slate", count: 4, scopePath: null },
  { name: "collision", color: "amber", count: 0, scopePath: "work/atlas" },
];

describe("isInScope", () => {
  it("exact match is in scope", () => {
    expect(isInScope("work", "work")).toBe(true);
  });

  it("descendant is in scope", () => {
    expect(isInScope("work/atlas", "work")).toBe(true);
    expect(isInScope("work/atlas/phase1", "work")).toBe(true);
    expect(isInScope("work/atlas/phase1", "work/atlas")).toBe(true);
  });

  it("sibling is NOT in scope", () => {
    expect(isInScope("work/other", "work/atlas")).toBe(false);
  });

  it("unrelated group is NOT in scope", () => {
    expect(isInScope("journal", "work")).toBe(false);
  });

  it("null/undefined groupPath is never in scope", () => {
    expect(isInScope(null, "work")).toBe(false);
    expect(isInScope(undefined, "work")).toBe(false);
  });
});

describe("rankTagsScoped — scope-visibility matrix", () => {
  it("global tags always visible regardless of groupPath", () => {
    const result = rankTagsScoped(SCOPED_TAGS, "journal", "");
    const names = result.map((t) => `${t.name}${t.scopePath ? "@" + t.scopePath : ""}`);
    expect(names).toContain("global-a");
    expect(names).toContain("collision"); // global collision wins
  });

  it("in-scope scoped tags visible (work/atlas inside work)", () => {
    const result = rankTagsScoped(SCOPED_TAGS, "work/atlas", "");
    const names = result.map((t) => t.name);
    expect(names).toContain("work-only"); // ancestor scope "work" ✓
    expect(names).toContain("atlas-tag"); // exact scope "work/atlas" ✓
    expect(names).toContain("global-a"); // global ✓
  });

  it("out-of-scope scoped tags excluded", () => {
    const result = rankTagsScoped(SCOPED_TAGS, "work/atlas", "");
    const names = result.map((t) => t.name);
    expect(names).not.toContain("other-tag"); // scoped to "other" — not visible from "work/atlas"
  });

  it("sibling scope excluded (work/atlas vs other)", () => {
    const result = rankTagsScoped(SCOPED_TAGS, "other", "");
    const names = result.map((t) => t.name);
    expect(names).toContain("other-tag"); // in scope ✓
    expect(names).not.toContain("atlas-tag"); // sibling ✗
    expect(names).not.toContain("work-only"); // sibling ✗
  });

  it("null groupPath shows only globals", () => {
    const result = rankTagsScoped(SCOPED_TAGS, null, "");
    expect(result.every((t) => !t.scopePath)).toBe(true);
  });

  it("global collision wins: scoped duplicate suppressed", () => {
    // "collision" exists as both global (scopePath null) and scoped (scopePath "work/atlas")
    const result = rankTagsScoped(SCOPED_TAGS, "work/atlas", "collision");
    const matches = result.filter((t) => t.name === "collision");
    // Only the global one should be returned.
    expect(matches).toHaveLength(1);
    expect(matches[0].scopePath).toBeNull();
  });

  it("in-scope scoped tags ranked before globals", () => {
    const result = rankTagsScoped(SCOPED_TAGS, "work/atlas", "");
    const firstScopedIdx = result.findIndex((t) => t.scopePath);
    const firstGlobalIdx = result.findIndex((t) => !t.scopePath);
    // Scoped tags should appear before globals (tier 1 > tier 2).
    expect(firstScopedIdx).toBeLessThan(firstGlobalIdx);
  });
});
