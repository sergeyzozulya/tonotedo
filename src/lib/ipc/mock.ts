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
  CalendarWindowResult,
  CalendarWindowItem,
  TrashManifest,
  TrashOpResult,
  RestoreResult,
  PluginInfo,
} from "./types.js";
import {
  parseCalValue,
  parseRRule,
  expandRRule,
  parseCalDate,
  calDateToEpoch,
  formatCalDate,
} from "../calendar/date-math.js";
import { extractProp, extractOverrides } from "../calendar/placement.js";

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
  archived?: boolean;
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
due: 2026-06-12T14:00+00:00
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
due: 2026-06-15..2026-06-19
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
due: 2026-06-13
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
due: 2026-06-20
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
  // Recurring entry — weekly standup (for calendar RRULE demo, issue #21)
  {
    id: "work/atlas/standup",
    path: "work/atlas/standup.md",
    title: "Atlas Weekly Standup",
    group: "work/atlas",
    tags: ["project/atlas", "meeting"],
    people: ["anna", "bob", "sergey"],
    modifiedAt: "2026-06-01T00:00:00Z",
    text: `---
title: Atlas Weekly Standup
tags: [project/atlas, meeting]
people: [anna, bob, sergey]
due: 2026-06-01
repeat: "RRULE:FREQ=WEEKLY;BYDAY=MO"
overrides:
  "2026-06-08": "2026-06-09"
---

# Atlas Weekly Standup

Weekly sync for the Atlas team.
`,
  },
  // Recurring entry — daily journaling prompt (every weekday, COUNT=20)
  {
    id: "journal/daily-prompt",
    path: "journal/daily-prompt.md",
    title: "Daily Journaling Prompt",
    group: "journal",
    tags: ["daily", "template"],
    people: [],
    modifiedAt: "2026-06-01T00:00:00Z",
    text: `---
title: Daily Journaling Prompt
tags: [daily, template]
due: 2026-06-09
repeat: "RRULE:FREQ=DAILY;BYDAY=MO,TU,WE,TH,FR;COUNT=20"
---

# Daily Journaling Prompt

Three things I'm grateful for today.
`,
  },
  {
    id: "inbox/archived-old-idea",
    path: "inbox/archived-old-idea.md",
    title: "Old Idea (Archived)",
    group: "inbox",
    tags: ["ideas"],
    people: [],
    modifiedAt: "2026-01-10T00:00:00Z",
    archived: true,
    text: `---
archived: true
title: Old Idea (Archived)
tags: [ideas]
---

# Old Idea (Archived)

This entry has been archived and should not appear in default lists.
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

// Scoped tags: declared in _group.md `scoped_tags:` for specific groups.
// These are visible only within the group and its descendants (spec 0002 / issue #28).
const SCOPED_TAGS: Array<{
  tag: string;
  scopePath: string;
  color: ChipColor;
  description?: string;
}> = [
  {
    tag: "atlas/blocked",
    scopePath: "work/atlas",
    color: "red",
    description: "Blocked item in Atlas project.",
  },
  {
    tag: "atlas/shipped",
    scopePath: "work/atlas",
    color: "green",
    description: "Shipped in Atlas.",
  },
  { tag: "work/urgent", scopePath: "work", color: "red", description: "Urgent work item." },
];

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
  const global: TagMeta[] = Array.from(counts.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, count]) => {
      const m = TAG_META[name];
      const tag: TagMeta = { name, color: defaultColor(name), count, scopePath: null };
      if (m?.description) tag.description = m.description;
      if (m?.icon) tag.icon = m.icon;
      return tag;
    });
  const scoped: TagMeta[] = SCOPED_TAGS.map((s) => ({
    name: s.tag,
    color: s.color,
    count: 0,
    scopePath: s.scopePath,
    description: s.description,
  }));
  return [...global, ...scoped];
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

// ── Trash store (phase 6 — in-memory for /dev demo) ──────────────────────────

interface MockTrashSlot {
  trashId: string;
  originalRelPath: string;
  trashedAt: string;
  kind: "entry" | "group";
  /** Present when kind === "entry". */
  _entry?: MockEntry;
  /** Present when kind === "group": all entries that were in the group. */
  _entries?: Array<{ id: string; entry: MockEntry }>;
}

const trashStore = new Map<string, MockTrashSlot>();

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
  const s: EntrySummary = {
    id: e.id,
    path: e.path,
    title: e.title,
    group: e.group,
    tags: e.tags,
    people: e.people,
    modifiedAt: e.modifiedAt,
  };
  if (e.archived) s.archived = true;
  return s;
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

const MOCK_PLUGINS: PluginInfo[] = [
  {
    id: "com.example.mermaid",
    name: "Mermaid renderer",
    version: "0.2.0",
    status: "active",
    shape: ["processor"],
    capabilities: ["render-code-block"],
    permissions: [],
    granted: [],
    settings: [
      {
        key: "theme",
        type: "enum",
        label: "Diagram theme",
        options: ["default", "dark"],
        default: "default",
      },
    ],
    commands: [],
    views: [],
    strikes: 0,
    readme:
      "# Mermaid Renderer\n\nRenders `mermaid` fenced code blocks as diagrams inside the editor.\n\n## Usage\n\nCreate a fenced code block with the language identifier `mermaid`:\n\n````\n```mermaid\ngraph TD\n  A --> B\n```\n````\n\nThe block is replaced with an SVG diagram at read time.\n",
  },
  {
    id: "com.example.gcal",
    name: "Google Calendar",
    version: "1.0.0",
    status: "permissions-pending",
    shape: ["provider"],
    capabilities: ["command", "entries-owner"],
    permissions: ["read-entries", "write-entries", "network:www.googleapis.com"],
    // One permission already granted; the rest keep the plugin pending.
    granted: ["read-entries"],
    settings: [{ key: "apiToken", type: "secret", label: "API token" }],
    commands: [{ id: "com.example.gcal.sync", title: "Sync Google Calendar" }],
    views: [],
    strikes: 0,
    readme:
      "# Google Calendar\n\nSyncs Google Calendar events into the `Calendar/Google/` group as entries.\n\n## Setup\n\n1. Grant the requested permissions.\n2. Enter your API token in the plugin settings.\n3. Run **Sync Google Calendar** from the command palette.\n\n## Privacy\n\nNo data leaves your device except to `www.googleapis.com` via the granted network permission.\n",
  },
];

/** Mutable copy so mock plugins_set_grant has an effect within a session. */
const pluginStore: PluginInfo[] = MOCK_PLUGINS.map((p) => ({ ...p, granted: [...p.granted] }));

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
    const existing = store.get(id);
    const path = `${id}.md`;
    // Upsert: create if not found (new entry), update if found.
    const group = id.includes("/") ? id.split("/").slice(0, -1).join("/") : "";
    const title = id.split("/").at(-1) ?? id;
    const entry: MockEntry = existing
      ? { ...existing, text, modifiedAt: new Date().toISOString() }
      : {
          id,
          path,
          title,
          group,
          tags: [],
          people: [],
          modifiedAt: new Date().toISOString(),
          text,
        };
    store.set(id, entry);
    invalidateCaches();
    const newToken = `mock-tok-${id}-written`;
    // Carry selfToken so the conflict model can suppress the echo (design-0001).
    emit("index_changed", {
      paths: [path],
      kinds: [existing ? "modified" : "created"],
      selfToken: newToken,
    });
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

  async calendar_window(
    from: string,
    to: string,
    group?: string,
  ): Promise<Result<CalendarWindowResult>> {
    const fromDate = parseCalDate(from);
    const toDate = parseCalDate(to);
    if (!fromDate || !toDate) {
      return {
        ok: false,
        error: { code: "invalid_argument", message: "Invalid date range" },
      };
    }

    const GROUP_COLORS: Record<string, string> = {
      "work/atlas": "#4a90d9",
      journal: "#e8a050",
      books: "#6ab06a",
      inbox: "#9a70c8",
    };
    const winStartEpoch = calDateToEpoch(fromDate);
    const winEndEpoch = calDateToEpoch(toDate);

    const items: CalendarWindowItem[] = [];

    for (const e of store.values()) {
      if (group && e.group !== group && !e.group.startsWith(group + "/")) continue;

      const rawDue = extractProp(e.text, "due");
      if (!rawDue) continue;

      const value = parseCalValue(rawDue);
      if (!value) continue;

      const color =
        GROUP_COLORS[e.group] ??
        Object.entries(GROUP_COLORS).find(([k]) => e.group.startsWith(k + "/"))?.[1];

      const baseItem: Omit<CalendarWindowItem, "dateValue" | "occurrenceKey" | "isOccurrence"> = {
        entryId: e.id,
        title: e.title,
        group: e.group,
        groupColor: color,
        tags: e.tags,
      };

      // Check for RRULE.
      const rawRepeat = extractProp(e.text, "repeat");
      if (rawRepeat) {
        const rrule = parseRRule(rawRepeat.replace(/^["']|["']$/g, ""));
        if (rrule && rrule.unsupported.length === 0) {
          const startDate =
            value.kind === "date"
              ? value
              : value.kind === "datetime"
                ? (() => {
                    const d = new Date(value.epochMs);
                    return {
                      kind: "date" as const,
                      year: d.getFullYear(),
                      month: d.getMonth() + 1,
                      day: d.getDate(),
                    };
                  })()
                : value.kind === "range"
                  ? value.start.kind === "date"
                    ? value.start
                    : (() => {
                        const d = new Date((value.start as { epochMs: number }).epochMs);
                        return {
                          kind: "date" as const,
                          year: d.getFullYear(),
                          month: d.getMonth() + 1,
                          day: d.getDate(),
                        };
                      })()
                  : fromDate;

          const overrides = extractOverrides(e.text);
          const occurrences = expandRRule(rrule, startDate, fromDate, toDate, overrides);
          for (const occ of occurrences) {
            const key = formatCalDate(occ);
            items.push({
              ...baseItem,
              dateValue: key,
              occurrenceKey: key,
              isOccurrence: true,
            });
          }
          continue;
        }
      }

      // Single-date item: check window overlap.
      const startDate =
        value.kind === "date"
          ? value
          : value.kind === "datetime"
            ? (() => {
                const d = new Date(value.epochMs);
                return {
                  kind: "date" as const,
                  year: d.getFullYear(),
                  month: d.getMonth() + 1,
                  day: d.getDate(),
                };
              })()
            : value.start.kind === "date"
              ? value.start
              : (() => {
                  const d = new Date((value.start as { epochMs: number }).epochMs);
                  return {
                    kind: "date" as const,
                    year: d.getFullYear(),
                    month: d.getMonth() + 1,
                    day: d.getDate(),
                  };
                })();

      const endDate =
        value.kind === "range"
          ? value.end.kind === "date"
            ? value.end
            : (() => {
                const d = new Date((value.end as { epochMs: number }).epochMs);
                return {
                  kind: "date" as const,
                  year: d.getFullYear(),
                  month: d.getMonth() + 1,
                  day: d.getDate(),
                };
              })()
          : startDate;

      if (calDateToEpoch(endDate) < winStartEpoch || calDateToEpoch(startDate) > winEndEpoch) {
        continue;
      }

      items.push({
        ...baseItem,
        dateValue: rawDue,
        occurrenceKey: undefined,
        isOccurrence: false,
      });
    }

    return { ok: true, value: { items } };
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

  // ── Group schema (phase 6 / issue #28) ───────────────────────────────────────

  async effective_schema(groupPath: GroupPath): Promise<Result<string | null>> {
    // Mock parity: work/atlas has a status+priority schema; work inherits nothing.
    const schemas: Record<string, Record<string, { type: string; default?: unknown }>> = {
      "work/atlas": {
        status: { type: "string", default: "draft" },
        priority: { type: "number" },
      },
      work: {
        status: { type: "string" },
      },
    };
    // Walk ancestor chain (child overrides parent).
    const merged: Record<string, { type: string; default?: unknown }> = {};
    const parts = groupPath.split("/");
    for (let i = 1; i <= parts.length; i++) {
      const ancestor = parts.slice(0, i).join("/");
      if (schemas[ancestor]) {
        Object.assign(merged, schemas[ancestor]);
      }
    }
    if (Object.keys(merged).length === 0) {
      return { ok: true, value: null };
    }
    return { ok: true, value: JSON.stringify(merged) };
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

  // ── Group mutation commands (phase 6) ─────────────────────────────────────

  async create_group(path: GroupPath): Promise<Result<void>> {
    // Reject reserved component names (start with _ or .)
    const components = path.split("/").filter(Boolean);
    for (const c of components) {
      if (c.startsWith("_") || c.startsWith(".")) {
        return {
          ok: false,
          error: {
            code: "invalid_argument",
            message: `Group name '${c}' is reserved (starts with '_' or '.').`,
          },
        };
      }
    }
    // Check that at least the parent groups already exist.
    const parentParts = components.slice(0, -1);
    if (parentParts.length > 0) {
      const parentPath = parentParts.join("/");
      const parentExists = Array.from(store.values()).some(
        (e) => e.group === parentPath || e.group.startsWith(parentPath + "/"),
      );
      if (!parentExists) {
        return {
          ok: false,
          error: { code: "not_found", message: `Parent group not found: ${parentPath}` },
        };
      }
    }
    // Check collision: group already exists.
    const already = Array.from(store.values()).some(
      (e) => e.group === path || e.group.startsWith(path + "/"),
    );
    if (already) {
      return {
        ok: false,
        error: { code: "conflict", message: `Group already exists: ${path}` },
      };
    }
    // Insert a placeholder _group.md entry so the group appears in list_groups.
    const placeholderEntry: MockEntry = {
      id: `${path}/_group`,
      path: `${path}/_group.md`,
      title: path.split("/").at(-1) ?? path,
      group: path,
      tags: [],
      people: [],
      modifiedAt: new Date().toISOString(),
      text: `---\n---\n`,
    };
    // We use a special sentinel so we can identify it as a group placeholder.
    store.set(placeholderEntry.id, placeholderEntry);
    invalidateCaches();
    emit("index_changed", { paths: [path], kinds: ["created"] });
    return { ok: true, value: undefined };
  },

  async rename_group(oldPath: GroupPath, newName: string): Promise<Result<void>> {
    if (newName.startsWith("_") || newName.startsWith(".")) {
      return {
        ok: false,
        error: {
          code: "invalid_argument",
          message: `Group name '${newName}' is reserved.`,
        },
      };
    }
    const parentPath = oldPath.includes("/") ? oldPath.slice(0, oldPath.lastIndexOf("/")) : "";
    const newPath = parentPath ? `${parentPath}/${newName}` : newName;
    // Check sibling collision.
    const collision = Array.from(store.values()).some(
      (e) => e.group === newPath || e.group.startsWith(newPath + "/"),
    );
    if (collision) {
      return {
        ok: false,
        error: { code: "conflict", message: `Name already in use: ${newName}` },
      };
    }
    // Rewrite all entries whose group starts with oldPath.
    for (const [id, e] of store.entries()) {
      if (e.group === oldPath || e.group.startsWith(oldPath + "/")) {
        const newGroup = newPath + e.group.slice(oldPath.length);
        const newEntryPath = e.path.replace(oldPath + "/", newPath + "/");
        const newId = id.replace(oldPath + "/", newPath + "/");
        store.delete(id);
        store.set(newId, { ...e, id: newId, group: newGroup, path: newEntryPath });
      }
    }
    invalidateCaches();
    emit("index_changed", { paths: [oldPath, newPath], kinds: ["renamed", "renamed"] });
    return { ok: true, value: undefined };
  },

  async move_group(srcPath: GroupPath, dstParent: GroupPath): Promise<Result<void>> {
    // Circular check.
    if (dstParent === srcPath || dstParent.startsWith(srcPath + "/")) {
      return {
        ok: false,
        error: {
          code: "invalid_argument",
          message: `Cannot move '${srcPath}' into itself or a descendant.`,
        },
      };
    }
    const folderName = srcPath.split("/").at(-1) ?? srcPath;
    const newPath = dstParent ? `${dstParent}/${folderName}` : folderName;
    // Check collision.
    const collision = Array.from(store.values()).some(
      (e) => e.group === newPath || e.group.startsWith(newPath + "/"),
    );
    if (collision) {
      return {
        ok: false,
        error: { code: "conflict", message: `Name already in use at destination: ${folderName}` },
      };
    }
    for (const [id, e] of store.entries()) {
      if (e.group === srcPath || e.group.startsWith(srcPath + "/")) {
        const newGroup = newPath + e.group.slice(srcPath.length);
        const newEntryPath = e.path.replace(srcPath + "/", newPath + "/");
        const newId = id.replace(srcPath + "/", newPath + "/");
        store.delete(id);
        store.set(newId, { ...e, id: newId, group: newGroup, path: newEntryPath });
      }
    }
    invalidateCaches();
    emit("index_changed", { paths: [srcPath, newPath], kinds: ["renamed", "renamed"] });
    return { ok: true, value: undefined };
  },

  async move_entry(path: string, dstGroup: GroupPath): Promise<Result<void>> {
    const entryId = path.replace(/\.md$/, "");
    const e = store.get(entryId);
    if (!e) {
      return { ok: false, error: { code: "not_found", message: `Entry not found: ${path}` } };
    }
    const fileName = path.split("/").at(-1) ?? path;
    const newPath = dstGroup ? `${dstGroup}/${fileName}` : fileName;
    const newId = newPath.replace(/\.md$/, "");
    if (store.has(newId)) {
      return {
        ok: false,
        error: { code: "conflict", message: `File already exists at destination: ${fileName}` },
      };
    }
    store.delete(entryId);
    store.set(newId, { ...e, id: newId, group: dstGroup, path: newPath });
    invalidateCaches();
    emit("index_changed", { paths: [path, newPath], kinds: ["renamed", "renamed"] });
    return { ok: true, value: undefined };
  },

  // ── Trash commands (phase 6) ───────────────────────────────────────────────

  async trash_entry(path: string): Promise<Result<TrashOpResult>> {
    const entryId = path.replace(/\.md$/, "");
    const e = store.get(entryId);
    if (!e) {
      return { ok: false, error: { code: "not_found", message: `Entry not found: ${path}` } };
    }
    const trashId = `mock-trash-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    trashStore.set(trashId, {
      trashId,
      originalRelPath: path,
      trashedAt: new Date().toISOString(),
      kind: "entry",
      _entry: { ...e },
    });
    store.delete(entryId);
    invalidateCaches();
    emit("index_changed", { paths: [path], kinds: ["deleted"] });
    return { ok: true, value: { trashId } };
  },

  async trash_group(path: GroupPath): Promise<Result<TrashOpResult>> {
    // Collect all entries in the group.
    const affected = Array.from(store.entries()).filter(
      ([, e]) => e.group === path || e.group.startsWith(path + "/"),
    );
    const trashId = `mock-trash-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    trashStore.set(trashId, {
      trashId,
      originalRelPath: path,
      trashedAt: new Date().toISOString(),
      kind: "group",
      _entries: affected.map(([id, e]) => ({ id, entry: { ...e } })),
    });
    for (const [id] of affected) {
      store.delete(id);
    }
    invalidateCaches();
    emit("index_changed", { paths: [path], kinds: ["deleted"] });
    return { ok: true, value: { trashId } };
  },

  async trash_list(): Promise<Result<TrashManifest[]>> {
    const items: TrashManifest[] = Array.from(trashStore.values())
      .map(({ trashId, originalRelPath, trashedAt, kind }) => ({
        trashId,
        originalRelPath,
        trashedAt,
        kind,
      }))
      .sort((a, b) => b.trashedAt.localeCompare(a.trashedAt));
    return { ok: true, value: items };
  },

  async trash_restore(id: string): Promise<Result<RestoreResult>> {
    const slot = trashStore.get(id);
    if (!slot) {
      return { ok: false, error: { code: "not_found", message: `Trash slot not found: ${id}` } };
    }
    if (slot.kind === "entry" && slot._entry) {
      const e = slot._entry;
      const exists = store.has(e.id);
      const finalId = exists ? `${e.id}-restored` : e.id;
      store.set(finalId, { ...e, id: finalId });
      trashStore.delete(id);
      invalidateCaches();
      emit("index_changed", { paths: [e.path], kinds: ["created"] });
      return {
        ok: true,
        value: { path: finalId + ".md", hadCollision: exists },
      };
    } else if (slot.kind === "group" && slot._entries) {
      for (const { id: entryId, entry } of slot._entries) {
        store.set(entryId, { ...entry });
      }
      trashStore.delete(id);
      invalidateCaches();
      emit("index_changed", { paths: [slot.originalRelPath], kinds: ["created"] });
      return { ok: true, value: { path: slot.originalRelPath, hadCollision: false } };
    }
    return { ok: false, error: { code: "io_error", message: "Malformed trash slot." } };
  },

  async trash_purge(id: string): Promise<Result<void>> {
    trashStore.delete(id);
    return { ok: true, value: undefined };
  },

  // ── Plugins (issue #25) ─────────────────────────────────────────────────────

  async plugins_list(): Promise<Result<PluginInfo[]>> {
    return { ok: true, value: pluginStore.map((p) => ({ ...p, granted: [...p.granted] })) };
  },

  async plugins_reload(): Promise<Result<PluginInfo[]>> {
    // The mock has no real filesystem to re-scan; reload returns the current inventory,
    // mirroring the real command's shape (a refreshed PluginInfo[]).
    console.log("[mock ipc] plugins_reload");
    return { ok: true, value: pluginStore.map((p) => ({ ...p, granted: [...p.granted] })) };
  },

  async plugins_set_grant(plugin: string, perm: string, granted: boolean): Promise<Result<void>> {
    const p = pluginStore.find((x) => x.id === plugin);
    if (!p) {
      return { ok: false, error: { code: "not_found", message: `plugin ${plugin} not found` } };
    }
    if (!p.permissions.includes(perm)) {
      return {
        ok: false,
        error: {
          code: "invalid_argument",
          message: `permission ${perm} not requested by ${plugin}`,
        },
      };
    }
    const has = p.granted.includes(perm);
    if (granted && !has) p.granted.push(perm);
    if (!granted && has) p.granted = p.granted.filter((x) => x !== perm);
    // Re-derive status: active only when every requested permission is granted.
    const allGranted = p.permissions.every((x) => p.granted.includes(x));
    p.status = allGranted ? "active" : "permissions-pending";
    console.log(`[mock ipc] plugins_set_grant ${plugin} ${perm}=${granted} → ${p.status}`);
    return { ok: true, value: undefined };
  },

  async plugins_invoke_command(
    plugin: string,
    commandId: string,
    argsJson: string,
  ): Promise<Result<string>> {
    const p = pluginStore.find((x) => x.id === plugin);
    if (!p || p.status !== "active") {
      return {
        ok: false,
        error: { code: "invalid_argument", message: `plugin ${plugin} is not active` },
      };
    }
    if (!p.commands.some((c) => c.id === commandId)) {
      return {
        ok: false,
        error: { code: "not_found", message: `command ${commandId} not registered` },
      };
    }
    // The mock has no JS runtime — echo a deterministic result.
    console.log(`[mock ipc] plugins_invoke_command ${commandId}(${argsJson})`);
    return { ok: true, value: JSON.stringify({ ok: true, command: commandId }) };
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
export { ENTRIES, PEOPLE_DECLARED, peopleStore, MOCK_PLUGINS };

// ── Dev / test helpers ────────────────────────────────────────────────────────

/**
 * Simulate an external edit to an existing entry (e.g. a vim save).
 *
 * Writes `newText` directly into the mock store WITHOUT emitting a selfToken,
 * so the conflict model treats the resulting index_changed as external.
 * Only available in the mock — used by the /dev demo and unit tests.
 */
export function simulateExternalEdit(id: EntryId, newText: string): boolean {
  const e = store.get(id);
  if (!e) return false;
  const updated = { ...e, text: newText, modifiedAt: new Date().toISOString() };
  store.set(id, updated);
  invalidateCaches();
  // No selfToken — looks like an external change to the conflict model.
  emit("index_changed", { paths: [e.path], kinds: ["modified"] });
  return true;
}
