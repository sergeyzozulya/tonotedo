// Mock IPC — in-memory library for the browser demo and tests.
//
// ~15 entries across 4 groups (work/atlas, journal, books, inbox).
// Tags with chip palette colors, 5 people, wikilinks between entries.
// Deterministic data: no Date.now() or Math.random() in module init.

import type {
  Ipc,
  Result,
  EntryId,
  EntryContent,
  EntrySummary,
  TagMeta,
  PersonMeta,
  PersonInput,
  GroupMeta,
  Backlink,
  GroupPath,
  Cursor,
  Page,
  SearchQuery,
  AssetPath,
  IpcEventName,
  IpcEventPayload,
  IpcUnsubscribe,
  ChipColor,
  SavedSearch,
} from "./types.js";

// ── Mock data ─────────────────────────────────────────────────────────────────

interface MockEntry {
  id: EntryId;
  path: string;
  title: string;
  group: GroupPath;
  tags: string[];
  people: string[];
  modifiedAt: string;
  text: string;
}

const ENTRIES: MockEntry[] = [
  {
    id: "work/atlas/project-overview",
    path: "work/atlas/project-overview.md",
    title: "Project Atlas — Overview",
    group: "work/atlas",
    tags: ["project/atlas", "strategy"],
    people: ["anna", "sergey"],
    modifiedAt: "2026-05-15T09:00:00Z",
    text: `---
title: Project Atlas — Overview
tags: [project/atlas, strategy]
people: [anna, sergey]
---

# Project Atlas — Overview

Atlas is the codename for the next-generation search and indexing layer.
See [[work/atlas/meeting-2026-05|the kickoff meeting]] for context.

Key stakeholders: @anna (lead) and @sergey (infra).

#project/atlas drives most of this quarter's #strategy work.
`,
  },
  {
    id: "work/atlas/meeting-2026-05",
    path: "work/atlas/meeting-2026-05.md",
    title: "Atlas Kickoff Meeting",
    group: "work/atlas",
    tags: ["project/atlas", "meeting"],
    people: ["anna", "bob", "sergey"],
    modifiedAt: "2026-05-10T14:30:00Z",
    text: `---
title: Atlas Kickoff Meeting
tags: [project/atlas, meeting]
people: [anna, bob, sergey]
date: 2026-05-10
---

# Atlas Kickoff Meeting

Present: @anna, @bob, @sergey.

Discussed scope for [[work/atlas/project-overview|Atlas overview]].
Also reviewed [[work/atlas/tech-decisions]] for infrastructure choices.

Action items tagged #followup.
`,
  },
  {
    id: "work/atlas/tech-decisions",
    path: "work/atlas/tech-decisions.md",
    title: "Atlas Tech Decisions",
    group: "work/atlas",
    tags: ["project/atlas", "engineering", "architecture"],
    people: ["sergey"],
    modifiedAt: "2026-05-12T11:00:00Z",
    text: `---
title: Atlas Tech Decisions
tags: [project/atlas, engineering, architecture]
people: [sergey]
---

# Atlas Tech Decisions

@sergey owns the final call on these.

## Search backend

Evaluated three approaches. See [[work/atlas/project-overview]] for context.

Tags used in this doc: #engineering, #architecture.
`,
  },
  {
    id: "work/atlas/roadmap",
    path: "work/atlas/roadmap.md",
    title: "Atlas Q3 Roadmap",
    group: "work/atlas",
    tags: ["project/atlas", "planning"],
    people: ["anna", "bob"],
    modifiedAt: "2026-06-01T08:00:00Z",
    text: `---
title: Atlas Q3 Roadmap
tags: [project/atlas, planning]
people: [anna, bob]
---

# Atlas Q3 Roadmap

Milestones owned by @anna and @bob.

Links back to [[work/atlas/project-overview]] and [[work/atlas/tech-decisions]].

#planning items should be reviewed monthly.
`,
  },
  {
    id: "journal/2026-05-20",
    path: "journal/2026-05-20.md",
    title: "Journal — 2026-05-20",
    group: "journal",
    tags: ["daily", "reflection"],
    people: [],
    modifiedAt: "2026-05-20T21:00:00Z",
    text: `---
title: Journal — 2026-05-20
tags: [daily, reflection]
date: 2026-05-20
---

# Journal — 2026-05-20

Good progress on the indexer today. Read the first chapter of
[[books/deep-work|Deep Work]] during lunch.

#daily log #reflection.
`,
  },
  {
    id: "journal/2026-05-21",
    path: "journal/2026-05-21.md",
    title: "Journal — 2026-05-21",
    group: "journal",
    tags: ["daily"],
    people: ["anna"],
    modifiedAt: "2026-05-21T21:15:00Z",
    text: `---
title: Journal — 2026-05-21
tags: [daily]
date: 2026-05-21
---

# Journal — 2026-05-21

Sync with @anna about [[work/atlas/roadmap]].

Continued reading [[books/deep-work|Deep Work]].
`,
  },
  {
    id: "journal/2026-06-01",
    path: "journal/2026-06-01.md",
    title: "Journal — 2026-06-01",
    group: "journal",
    tags: ["daily", "review"],
    people: [],
    modifiedAt: "2026-06-01T22:00:00Z",
    text: `---
title: Journal — 2026-06-01
tags: [daily, review]
date: 2026-06-01
---

# Journal — 2026-06-01

Monthly #review day. Looked back at [[work/atlas/project-overview]] milestones.

Finished [[books/thinking-fast-and-slow]].
`,
  },
  {
    id: "books/deep-work",
    path: "books/deep-work.md",
    title: "Deep Work — Cal Newport",
    group: "books",
    tags: ["books", "productivity"],
    people: [],
    modifiedAt: "2026-05-18T19:00:00Z",
    text: `---
title: Deep Work — Cal Newport
tags: [books, productivity]
---

# Deep Work — Cal Newport

Core thesis: deep, focused work is the key differentiator in a distracted economy.

## Notes

- Ritual > willpower for scheduling focus blocks.
- Related reading: [[books/thinking-fast-and-slow]].

#books #productivity.
`,
  },
  {
    id: "books/thinking-fast-and-slow",
    path: "books/thinking-fast-and-slow.md",
    title: "Thinking, Fast and Slow — Kahneman",
    group: "books",
    tags: ["books", "psychology"],
    people: [],
    modifiedAt: "2026-05-25T20:00:00Z",
    text: `---
title: Thinking, Fast and Slow — Kahneman
tags: [books, psychology]
---

# Thinking, Fast and Slow — Kahneman

System 1 (fast) vs System 2 (slow). Cognitive biases and heuristics.

## Notes

- Anchoring is pervasive; see also [[books/deep-work]] on focus.

#books #psychology.
`,
  },
  {
    id: "books/the-pragmatic-programmer",
    path: "books/the-pragmatic-programmer.md",
    title: "The Pragmatic Programmer",
    group: "books",
    tags: ["books", "engineering"],
    people: [],
    modifiedAt: "2026-04-10T18:00:00Z",
    text: `---
title: The Pragmatic Programmer
tags: [books, engineering]
---

# The Pragmatic Programmer

Hunt & Thomas. Timeless craft advice.

## Notes

- DRY principle, the broken window theory.
- Pairs well with [[work/atlas/tech-decisions]] for practical application.

#books #engineering.
`,
  },
  {
    id: "inbox/follow-up-anna",
    path: "inbox/follow-up-anna.md",
    title: "Follow-up with Anna",
    group: "inbox",
    tags: ["followup", "action"],
    people: ["anna"],
    modifiedAt: "2026-06-05T10:00:00Z",
    text: `---
title: Follow-up with Anna
tags: [followup, action]
people: [anna]
---

# Follow-up with Anna

Action item from [[work/atlas/meeting-2026-05]].

Need to confirm timeline with @anna before end of week.

#followup #action.
`,
  },
  {
    id: "inbox/ideas-backlog",
    path: "inbox/ideas-backlog.md",
    title: "Ideas Backlog",
    group: "inbox",
    tags: ["ideas", "backlog"],
    people: [],
    modifiedAt: "2026-06-03T16:00:00Z",
    text: `---
title: Ideas Backlog
tags: [ideas, backlog]
---

# Ideas Backlog

Unprocessed ideas that need triaging.

- Graph view for [[work/atlas/project-overview|Atlas]].
- Reading list based on [[books/deep-work]].

#ideas #backlog.
`,
  },
  {
    id: "inbox/bob-introduction",
    path: "inbox/bob-introduction.md",
    title: "Introduction: Bob",
    group: "inbox",
    tags: ["people", "onboarding"],
    people: ["bob"],
    modifiedAt: "2026-05-08T09:30:00Z",
    text: `---
title: Introduction: Bob
tags: [people, onboarding]
people: [bob]
---

# Introduction: Bob

@bob joins the Atlas team. Background: distributed systems, Rust.

Involved in [[work/atlas/meeting-2026-05]] and [[work/atlas/roadmap]].

#people #onboarding.
`,
  },
  {
    id: "inbox/weekly-template",
    path: "inbox/weekly-template.md",
    title: "Weekly Review Template",
    group: "inbox",
    tags: ["template", "review"],
    people: [],
    modifiedAt: "2026-04-01T08:00:00Z",
    text: `---
title: Weekly Review Template
tags: [template, review]
---

# Weekly Review Template

1. Review [[inbox/ideas-backlog]].
2. Check #followup items.
3. Update [[work/atlas/roadmap]] if needed.

#template #review.
`,
  },
  {
    id: "inbox/contacts",
    path: "inbox/contacts.md",
    title: "Contacts",
    group: "inbox",
    tags: ["people"],
    people: ["anna", "bob", "carol", "david"],
    modifiedAt: "2026-03-15T12:00:00Z",
    text: `---
title: Contacts
tags: [people]
people: [anna, bob, carol, david]
---

# Contacts

Directory of key contacts.

- @anna — product lead, [[work/atlas/project-overview]]
- @bob — infra, [[work/atlas/tech-decisions]]
- @carol — design
- @david — research

#people.
`,
  },
  {
    id: "work/atlas/blocks-demo",
    path: "work/atlas/blocks-demo.md",
    title: "Blocks Demo (checkboxes, attachments, images)",
    group: "work/atlas",
    tags: ["demo"],
    people: [],
    modifiedAt: "2026-06-10T00:00:00Z",
    text: `---
title: Blocks Demo
tags: [demo]
---

# Blocks Demo

## Tasks

- [x] Design the attachment block spec
- [ ] Implement checkbox toggle (content-only, per spec 0006)
- [ ] Wire paste handler for images
- [ ] Write tests

## Inline image

![Blueprint cover](_assets/blueprint-cover.png)

![Sketch](_assets/sketch.png)

## Attachments

See the spec draft: [spec-draft.pdf](_assets/spec-draft.pdf)

Broken link (file missing): [missing-file.pdf](_assets/missing-file.pdf)
`,
  },
];

// ── Tag index ─────────────────────────────────────────────────────────────────

const TAG_COLORS: Record<string, ChipColor> = {
  "project/atlas": "blue",
  strategy: "violet",
  meeting: "teal",
  engineering: "green",
  architecture: "green",
  planning: "amber",
  daily: "slate",
  reflection: "teal",
  review: "amber",
  books: "violet",
  productivity: "green",
  psychology: "teal",
  followup: "red",
  action: "red",
  ideas: "amber",
  backlog: "slate",
  people: "blue",
  onboarding: "teal",
  template: "slate",
  demo: "slate",
};

// Declared tag metadata (would live in _tags.md).
const TAG_META: Record<string, { description?: string; icon?: string }> = {
  "project/atlas": { description: "Atlas next-gen search project.", icon: "🗺️" },
  followup: { description: "Things to come back to within a week.", icon: "⏳" },
  daily: { description: "Daily journal entries.", icon: "📅" },
  engineering: { description: "Technical engineering notes." },
  strategy: { description: "Strategic planning and direction." },
  review: { description: "Periodic review items." },
  books: { description: "Book notes and reading list.", icon: "📚" },
};

function defaultColor(tag: string): ChipColor {
  return TAG_COLORS[tag] ?? "slate";
}

function buildTagIndex(): TagMeta[] {
  const counts = new Map<string, number>();
  for (const e of store.values()) {
    for (const t of e.tags) {
      counts.set(t, (counts.get(t) ?? 0) + 1);
    }
  }
  return Array.from(counts.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, count]) => {
      const m = TAG_META[name];
      const tag: TagMeta = { name, color: defaultColor(name), count };
      if (m?.description) tag.description = m.description;
      if (m?.icon) tag.icon = m.icon;
      return tag;
    });
}

// ── People index ──────────────────────────────────────────────────────────────

// Declared people: have entries in _people.md with metadata.
// carol and david are declared but without color (minimal metadata).
// sergey is NOT declared — used in entries but no _people.md record.
const PEOPLE_DECLARED = new Set(["anna", "bob", "carol", "david"]);

const PEOPLE_NAMES: Record<string, string> = {
  anna: "Anna K.",
  bob: "Bob T.",
  carol: "Carol M.",
  david: "David R.",
};

const PEOPLE_DESCRIPTIONS: Record<string, string> = {
  anna: "Product lead, Atlas team.",
  bob: "Infra engineer, distributed systems.",
};

const PEOPLE_COLORS: Record<string, ChipColor> = {
  anna: "violet",
  bob: "teal",
  carol: "pink",
};

// anna has a mock avatar stored in the asset store (added below).
const PEOPLE_AVATAR_PATHS: Record<string, string> = {
  anna: "work/atlas/_assets/blueprint-cover.png",
};

/** Mutable people declaration store for set_person / delete_person. */
const peopleStore = new Map<string, PersonInput>(
  Array.from(PEOPLE_DECLARED).map((slug) => [
    slug,
    {
      slug,
      displayName: PEOPLE_NAMES[slug],
      description: PEOPLE_DESCRIPTIONS[slug],
      color: PEOPLE_COLORS[slug] as ChipColor | undefined,
      avatarPath: PEOPLE_AVATAR_PATHS[slug],
    },
  ]),
);

function buildPeopleIndex(): PersonMeta[] {
  const counts = new Map<string, number>();
  for (const e of store.values()) {
    for (const p of e.people) {
      counts.set(p, (counts.get(p) ?? 0) + 1);
    }
  }
  return Array.from(counts.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([slug, count]) => {
      const decl = peopleStore.get(slug);
      const meta: PersonMeta = {
        slug,
        displayName: decl?.displayName ?? PEOPLE_NAMES[slug] ?? slug,
        count,
        declared: peopleStore.has(slug),
        description: decl?.description,
      };
      if (decl?.color) meta.color = decl.color;
      if (decl?.avatarPath) meta.avatarPath = decl.avatarPath;
      return meta;
    });
}

/** Extract @mention slugs from entry body text. */
function extractMentions(text: string): string[] {
  const slugs: string[] = [];
  const re = /(?:^|[\s.,;:!?(\[{])@([\w-]+)/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    slugs.push(m[1].toLowerCase());
  }
  return slugs;
}

function mentionsForSlug(slug: string): EntrySummary[] {
  const results: EntrySummary[] = [];
  for (const e of store.values()) {
    // Union of both surfaces: frontmatter people array + body @mentions.
    const inFrontmatter = e.people.includes(slug);
    const bodyMentions = extractMentions(e.text);
    const inBody = bodyMentions.includes(slug.toLowerCase());
    if (inFrontmatter || inBody) {
      results.push(toSummary(e));
    }
  }
  // Most-recent first (spec 0005 §People view).
  results.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
  return results;
}

// ── Backlinks ─────────────────────────────────────────────────────────────────

/** Very simple wikilink extractor: [[target]] or [[target|display]]. */
function extractWikilinks(text: string): string[] {
  const targets: string[] = [];
  const re = /\[\[([^\]|]+)(?:\|[^\]]*)?]]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    targets.push(m[1].trim());
  }
  return targets;
}

function buildBacklinkIndex(): Map<EntryId, Backlink[]> {
  const index = new Map<EntryId, Backlink[]>();
  for (const e of ENTRIES) {
    const links = extractWikilinks(e.text);
    for (const target of links) {
      // target may be "work/atlas/project-overview" (id without extension)
      const existing = index.get(target) ?? [];
      existing.push({
        sourceId: e.id,
        sourceTitle: e.title,
        linkText: target,
      });
      index.set(target, existing);
    }
  }
  return index;
}

// ── In-memory state ───────────────────────────────────────────────────────────

/** Mutable copy of entries so write_entry works during a session. */
const store = new Map<EntryId, MockEntry>(ENTRIES.map((e) => [e.id, { ...e }]));

/** In-memory saved-search list (mirrors _searches.md frontmatter shape). */
let savedSearchStore: SavedSearch[] = [];

// ── Asset store (issue #13 — in-memory for /dev demo) ────────────────────────

// Two tiny sample images as base64 data URIs so the /dev demo shows inline
// images without any real files. Each is a 4×4 PNG generated offline.
// "blueprint-cover.png" — a 4x4 solid blue square (#4488ff).
const BLUEPRINT_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAADklEQVQI12NgYGD4TwABBAEAmRb3sgAAAABJRU5ErkJggg==";
// "sketch.png" — a 4×4 solid green square (#44bb66).
const SKETCH_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAADklEQVQI12NgYNj6HwAECAIA/8l7SAAAAABJRU5ErkJggg==";

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

interface MockAsset {
  bytes: Uint8Array;
  mime: string;
}

/** vault-relative AssetPath → asset bytes + mime type */
const assetStore = new Map<AssetPath, MockAsset>([
  [
    "work/atlas/_assets/blueprint-cover.png",
    { bytes: b64ToBytes(BLUEPRINT_PNG_B64), mime: "image/png" },
  ],
  ["work/atlas/_assets/sketch.png", { bytes: b64ToBytes(SKETCH_PNG_B64), mime: "image/png" }],
  [
    "work/atlas/_assets/spec-draft.pdf",
    {
      bytes: new TextEncoder().encode("%PDF-1.4 mock"),
      mime: "application/pdf",
    },
  ],
]);

/** Cache of object URLs so we don't call URL.createObjectURL repeatedly. */
const objectUrlCache = new Map<AssetPath, string>();

function assetObjectUrl(path: AssetPath): string {
  const cached = objectUrlCache.get(path);
  if (cached) return cached;
  const asset = assetStore.get(path);
  if (!asset) return "";
  const blob = new Blob([asset.bytes.buffer as ArrayBuffer], { type: asset.mime });
  const url = URL.createObjectURL(blob);
  objectUrlCache.set(path, url);
  return url;
}

let tagIndexCache: TagMeta[] | null = null;
let backlinkIndex: Map<EntryId, Backlink[]> | null = null;

function getTagIndex(): TagMeta[] {
  if (!tagIndexCache) tagIndexCache = buildTagIndex();
  return tagIndexCache;
}

function getBacklinkIndex(): Map<EntryId, Backlink[]> {
  if (!backlinkIndex) backlinkIndex = buildBacklinkIndex();
  return backlinkIndex;
}

function invalidateCaches(): void {
  tagIndexCache = null;
  backlinkIndex = null;
}

function toSummary(e: MockEntry): EntrySummary {
  return {
    id: e.id,
    path: e.path,
    title: e.title,
    group: e.group,
    tags: e.tags,
    people: e.people,
    modifiedAt: e.modifiedAt,
  };
}

// ── Simple paged cursor (base64 of offset) ────────────────────────────────────

const PAGE_SIZE = 50;

function encodeCursor(offset: number): Cursor {
  return btoa(String(offset));
}

function decodeCursor(cursor?: Cursor): number {
  if (!cursor) return 0;
  try {
    return parseInt(atob(cursor), 10) || 0;
  } catch {
    return 0;
  }
}

function makePage<T>(items: T[], cursor?: Cursor): Page<T> {
  const offset = decodeCursor(cursor);
  const slice = items.slice(offset, offset + PAGE_SIZE);
  const nextOffset = offset + PAGE_SIZE;
  return {
    items: slice,
    nextCursor: nextOffset < items.length ? encodeCursor(nextOffset) : undefined,
  };
}

// ── Event bus ─────────────────────────────────────────────────────────────────

type Handler = (payload: unknown) => void;
const listeners = new Map<string, Set<Handler>>();

function emit(event: string, payload: unknown): void {
  for (const h of listeners.get(event) ?? []) {
    try {
      h(payload);
    } catch {
      // never let a handler break the store
    }
  }
}

// ── IPC implementation ────────────────────────────────────────────────────────

export const mock: Ipc = {
  async core_version(): Promise<Result<string>> {
    return { ok: true, value: "mock-0.0.0" };
  },

  async read_entry(id: EntryId): Promise<Result<EntryContent>> {
    const e = store.get(id);
    if (!e) {
      return {
        ok: false,
        error: { code: "not_found", message: `Entry not found: ${id}` },
      };
    }
    return {
      ok: true,
      value: { id: e.id, path: e.path, text: e.text, selfToken: `mock-tok-${id}` },
    };
  },

  async write_entry(id: EntryId, text: string): Promise<Result<{ selfToken: string }>> {
    const e = store.get(id);
    if (!e) {
      return {
        ok: false,
        error: { code: "not_found", message: `Entry not found: ${id}` },
      };
    }
    const updated = { ...e, text, modifiedAt: "2026-06-10T00:00:00Z" };
    store.set(id, updated);
    invalidateCaches();
    const newToken = `mock-tok-${id}-written`;
    emit("index_changed", { paths: [e.path], kinds: ["modified"] });
    return { ok: true, value: { selfToken: newToken } };
  },

  async search(query: SearchQuery): Promise<Result<Page<EntrySummary>>> {
    const q = query.text.toLowerCase().trim();
    let results = Array.from(store.values());

    if (q) {
      results = results.filter(
        (e) =>
          e.title.toLowerCase().includes(q) ||
          e.text.toLowerCase().includes(q) ||
          e.tags.some((t) => t.toLowerCase().includes(q)) ||
          e.people.some((p) => p.toLowerCase().includes(q)),
      );
    }

    const f = query.filters;
    if (f?.group) results = results.filter((e) => e.group === f.group);
    if (f?.tags?.length) results = results.filter((e) => f.tags!.some((t) => e.tags.includes(t)));
    if (f?.people?.length)
      results = results.filter((e) => f.people!.some((p) => e.people.includes(p)));

    const sort = query.sort ?? "modified_desc";
    results.sort((a, b) => {
      if (sort === "title_asc") return a.title.localeCompare(b.title);
      if (sort === "modified_asc") return a.modifiedAt.localeCompare(b.modifiedAt);
      return b.modifiedAt.localeCompare(a.modifiedAt); // modified_desc / relevance
    });

    return { ok: true, value: makePage(results.map(toSummary), query.cursor) };
  },

  async tag_index(): Promise<Result<TagMeta[]>> {
    return { ok: true, value: getTagIndex() };
  },

  async people_index(): Promise<Result<PersonMeta[]>> {
    return { ok: true, value: buildPeopleIndex() };
  },

  async entries_in_group(group: GroupPath, cursor?: Cursor): Promise<Result<Page<EntrySummary>>> {
    const items = Array.from(store.values())
      .filter((e) => e.group === group || e.group.startsWith(group + "/"))
      .sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt))
      .map(toSummary);
    return { ok: true, value: makePage(items, cursor) };
  },

  async backlinks(id: EntryId): Promise<Result<Backlink[]>> {
    const idx = getBacklinkIndex();
    return { ok: true, value: idx.get(id) ?? [] };
  },

  async attach_file(
    entryPath: string,
    name: string,
    bytes: Uint8Array,
  ): Promise<Result<AssetPath>> {
    // Derive the entry's group from its path (e.g. "work/atlas/foo.md" → "work/atlas").
    const dir = entryPath.includes("/") ? entryPath.slice(0, entryPath.lastIndexOf("/")) : "";
    const assetsPrefix = dir ? `${dir}/_assets/` : "_assets/";

    // Collision-safe naming: if the name is taken, append -2, -3, …
    let candidate = assetsPrefix + name;
    if (assetStore.has(candidate)) {
      const dot = name.lastIndexOf(".");
      const base = dot === -1 ? name : name.slice(0, dot);
      const ext = dot === -1 ? "" : name.slice(dot);
      let n = 2;
      while (assetStore.has(`${assetsPrefix}${base}-${n}${ext}`)) n++;
      candidate = `${assetsPrefix}${base}-${n}${ext}`;
    }

    // Guess MIME from extension.
    const ext = candidate.slice(candidate.lastIndexOf(".") + 1).toLowerCase();
    const mimeMap: Record<string, string> = {
      png: "image/png",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      webp: "image/webp",
      gif: "image/gif",
      svg: "image/svg+xml",
      pdf: "application/pdf",
    };
    const mime = mimeMap[ext] ?? "application/octet-stream";

    assetStore.set(candidate, { bytes, mime });
    console.log(`[mock ipc] attach_file → ${candidate}`);
    return { ok: true, value: candidate };
  },

  async asset_url(assetPath: AssetPath): Promise<Result<string>> {
    if (!assetStore.has(assetPath)) {
      return { ok: false, error: { code: "not_found", message: `Asset not found: ${assetPath}` } };
    }
    return { ok: true, value: assetObjectUrl(assetPath) };
  },

  async asset_exists(assetPath: AssetPath): Promise<Result<boolean>> {
    return { ok: true, value: assetStore.has(assetPath) };
  },

  async remove_asset(assetPath: AssetPath): Promise<Result<void>> {
    if (!assetStore.has(assetPath)) {
      return {
        ok: false,
        error: { code: "not_found", message: `Asset not found: ${assetPath}` },
      };
    }
    // Revoke the object URL if one was created.
    const cached = objectUrlCache.get(assetPath);
    if (cached) {
      URL.revokeObjectURL(cached);
      objectUrlCache.delete(assetPath);
    }
    assetStore.delete(assetPath);
    console.log(`[mock ipc] remove_asset → ${assetPath}`);
    return { ok: true, value: undefined };
  },

  async entry_titles(): Promise<Result<Record<EntryId, string>>> {
    const map: Record<string, string> = {};
    for (const e of store.values()) {
      map[e.id] = e.title;
    }
    return { ok: true, value: map };
  },

  async list_groups(): Promise<Result<GroupMeta[]>> {
    // Derive groups from the mock entry data: collect unique group paths
    // and count entries per group (exact match, not descendants — the sidebar
    // aggregates counts up the tree itself).
    const counts = new Map<string, number>();
    for (const e of store.values()) {
      counts.set(e.group, (counts.get(e.group) ?? 0) + 1);
    }
    // Also register any intermediate path segments implied by the group paths
    // so that "work" appears even if no entry sits directly in "work/".
    const allPaths = new Set<string>();
    for (const path of counts.keys()) {
      const parts = path.split("/");
      for (let i = 1; i <= parts.length; i++) {
        allPaths.add(parts.slice(0, i).join("/"));
      }
    }
    const groups: GroupMeta[] = Array.from(allPaths).map((path) => ({
      path,
      name: path.split("/").at(-1) ?? path,
      count: counts.get(path) ?? 0,
    }));
    return { ok: true, value: groups };
  },

  // ── Saved searches (spec 0009) ────────────────────────────────────────────────

  async saved_searches_get(): Promise<Result<SavedSearch[]>> {
    return { ok: true, value: [...savedSearchStore] };
  },

  async saved_searches_set(searches: SavedSearch[]): Promise<Result<void>> {
    savedSearchStore = searches.map((s) => ({ ...s, filters: s.filters.map((f) => ({ ...f })) }));
    return { ok: true, value: undefined };
  },

  // ── People mutation commands ───────────────────────────────────────────────────

  async set_person(person: PersonInput): Promise<Result<void>> {
    peopleStore.set(person.slug, { ...person });
    invalidateCaches();
    console.log(`[mock ipc] set_person → ${person.slug}`);
    return { ok: true, value: undefined };
  },

  async delete_person(slug: string): Promise<Result<void>> {
    if (!peopleStore.has(slug)) {
      return { ok: false, error: { code: "not_found", message: `Person not found: ${slug}` } };
    }
    peopleStore.delete(slug);
    invalidateCaches();
    console.log(`[mock ipc] delete_person → ${slug}`);
    return { ok: true, value: undefined };
  },

  async mentions_for(slug: string): Promise<Result<EntrySummary[]>> {
    return { ok: true, value: mentionsForSlug(slug) };
  },

  // ── Tag mutation commands ──────────────────────────────────────────────────────

  async rename_tag(oldName: string, newName: string): Promise<Result<void>> {
    // Rewrite all entries in the store that reference oldName.
    for (const [id, e] of store.entries()) {
      const updated = e.tags.map((t) => (t === oldName ? newName : t));
      if (updated.some((t, i) => t !== e.tags[i])) {
        store.set(id, { ...e, tags: updated });
      }
    }
    // Rewrite TAG_COLORS reference.
    if (TAG_COLORS[oldName]) {
      TAG_COLORS[newName] = TAG_COLORS[oldName];
      delete TAG_COLORS[oldName];
    }
    invalidateCaches();
    console.log(`[mock ipc] rename_tag ${oldName} → ${newName}`);
    return { ok: true, value: undefined };
  },

  async merge_tag(sourceTag: string, targetTag: string): Promise<Result<void>> {
    for (const [id, e] of store.entries()) {
      const updated = e.tags.map((t) => (t === sourceTag ? targetTag : t));
      // De-duplicate after rewrite.
      const deduped = [...new Set(updated)];
      if (deduped.join(",") !== e.tags.join(",")) {
        store.set(id, { ...e, tags: deduped });
      }
    }
    if (TAG_COLORS[sourceTag]) delete TAG_COLORS[sourceTag];
    invalidateCaches();
    console.log(`[mock ipc] merge_tag ${sourceTag} → ${targetTag}`);
    return { ok: true, value: undefined };
  },

  async delete_tag(name: string): Promise<Result<void>> {
    // Remove only from suggestions / metadata — do not touch entry text.
    if (TAG_COLORS[name]) delete TAG_COLORS[name];
    invalidateCaches();
    console.log(`[mock ipc] delete_tag → ${name}`);
    return { ok: true, value: undefined };
  },

  on<E extends IpcEventName>(
    event: E,
    handler: (payload: IpcEventPayload<E>) => void,
  ): IpcUnsubscribe {
    const h = handler as Handler;
    const set = listeners.get(event) ?? new Set();
    set.add(h);
    listeners.set(event, set);
    return () => {
      listeners.get(event)?.delete(h);
    };
  },
};

// Export raw data for tests.
export { ENTRIES, PEOPLE_DECLARED, peopleStore };
