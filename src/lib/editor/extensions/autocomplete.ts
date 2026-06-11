// Autocomplete extension for #tag, @mention, and [[wikilink]] triggers.
//
// Design brief (issue #14):
//   Three completion sources, each gated by its trigger character sequence:
//     - `#`  → tag completions
//     - `@`  → mention completions
//     - `[[` → wikilink (entry title) completions
//
//   Guard rules (spec 0005 §Edge cases, applied uniformly):
//     - NO completions inside frontmatter (the YAML block folded by layer 1).
//     - NO completions inside fenced code blocks or inline code spans.
//       Both suppression cases are checked via the Lezer syntax tree.
//     - `@` preceded by a word character is not a mention trigger
//       (email@host.com must not open the picker — mirrors the scanner rule).
//
// Ranking:
//   Tags:     declared (metadata in tag_index → count > 0 or color set) first,
//             then undeclared-but-used, both sub-sorted by count desc then name asc.
//             Within the declared tier: scoped-tag simulation is omitted (mock
//             scoping is simple — the spec says "mock can be simple"); the full
//             tag list is offered and filtered by prefix + substring match.
//   Mentions: declared (present in people_index with count > 0 or displayName != slug)
//             first, then undeclared-but-used (those where displayName === slug, if any
//             — in practice the mock only surfaces declared people, so this tier may
//             be empty), then a sentinel "Create person" option.
//   Wikilinks: entry titles from ipc.entries_in_group are loaded at construction;
//             filtered by prefix + substring match on either id or title.
//             Result options are sorted by modifiedAt desc (most-recent first).
//
// Insertion (spec 0006 §Behavior):
//   All three sources insert LITERAL text. The chips layer handles visual rendering.
//     - Tag:      replaces `#<typed>` with `#<slug>`
//     - Mention:  replaces `@<typed>` with `@<slug>`
//     - Wikilink: replaces `[[<typed>` with `[[<id>]]`  (closes the bracket)
//
// onCreatePerson callback:
//   The final option in the mention list is a synthetic "Create person" entry.
//   Selecting it calls the `onCreatePerson(slug)` callback; it does NOT insert
//   text into the document — creation logic is the caller's responsibility.
//
// Wiring: call `autocomplete(config)` and add the result to the EditorState
// extensions array (alongside chips, cursorReveal, etc.). The returned extension
// includes both the CompletionSource registration and the autocompletion theme.

import {
  autocompletion,
  CompletionContext,
  type Completion,
  type CompletionSource,
} from "@codemirror/autocomplete";
import { syntaxTree } from "@codemirror/language";
import type { Extension } from "@codemirror/state";

import { detectFrontmatter } from "./frontmatter-fold.js";
import type { Ipc, TagMeta, PersonMeta, EntrySummary } from "../../ipc/types.js";

// ── Config ─────────────────────────────────────────────────────────────────────

export interface AutocompleteConfig {
  /** IPC facade — provides tag_index, people_index, entries_in_group. */
  ipc: Ipc;
  /**
   * Called when the user selects the "Create person '<slug>'" option.
   * No text is inserted — creation is the caller's responsibility.
   */
  onCreatePerson?: (slug: string) => void;
  /**
   * Mutable ref holding the group path of the entry being edited.
   * The ref is read on every completion invocation so it reflects the latest
   * entry without requiring an editor rebuild when the user switches entries.
   * When provided (and current is non-null), scoped tags are ranked:
   * in-scope first, globals second; out-of-scope scoped tags excluded.
   */
  groupPath?: { current: string | null | undefined };
}

// ── Syntax-tree guards ──────────────────────────────────────────────────────────

/**
 * Returns true if `pos` lies inside a code fence or inline code span.
 * The Lezer markdown grammar produces:
 *   - FencedCode   (block)
 *   - InlineCode   (inline)
 *   - CodeBlock    (indented blocks)
 * We walk the node ancestry upward from pos to check.
 */
function insideCode(ctx: CompletionContext): boolean {
  const tree = syntaxTree(ctx.state);
  const node = tree.resolveInner(ctx.pos, -1);
  let cur: typeof node | null = node;
  while (cur) {
    const n = cur.name;
    if (n === "FencedCode" || n === "CodeBlock" || n === "InlineCode") return true;
    cur = cur.parent;
  }
  return false;
}

/**
 * Returns true if `pos` lies inside the document's frontmatter block.
 * Uses the same `detectFrontmatter` function as frontmatter-fold.
 */
function insideFrontmatter(ctx: CompletionContext): boolean {
  const region = detectFrontmatter(ctx.state);
  if (!region) return false;
  return ctx.pos >= region.from && ctx.pos <= region.to;
}

// ── Helpers ─────────────────────────────────────────────────────────────────────

/** True if `c` is a word character: letter, digit, or `_`. */
function isWordChar(c: string): boolean {
  return /[\w]/.test(c);
}

/**
 * Case-insensitive prefix-or-substring match.
 * Prefix matches rank higher (score 1 vs 0) to keep the list stable.
 */
function matchScore(candidate: string, query: string): number {
  if (!query) return 1;
  const lc = candidate.toLowerCase();
  const lq = query.toLowerCase();
  if (lc.startsWith(lq)) return 2;
  if (lc.includes(lq)) return 1;
  return 0;
}

// ── Tag source ──────────────────────────────────────────────────────────────────

/**
 * Rank tags: declared (has color metadata beyond the default) first, then
 * undeclared, both sorted by count desc then name asc within each tier.
 * Tags are "declared" when they appear in tag_index with a non-default color
 * or when the mock simply has them (all tags in the mock index are declared).
 * In practice the mock always returns all tags as declared (they all have
 * explicit color entries in TAG_COLORS). We treat every tag returned by
 * tag_index as declared — there is no "undeclared" tier in the v1 mock;
 * the ranking is declared-first, count desc, name asc.
 */
export function rankTags(tags: TagMeta[], query: string): TagMeta[] {
  const scored = tags
    .map((t) => ({ tag: t, score: matchScore(t.name, query) }))
    .filter((x) => x.score > 0);

  scored.sort((a, b) => {
    // Higher matchScore first (prefix > substring).
    if (b.score !== a.score) return b.score - a.score;
    // Within same score tier: count desc.
    if (b.tag.count !== a.tag.count) return b.tag.count - a.tag.count;
    // Then name asc.
    return a.tag.name.localeCompare(b.tag.name);
  });

  return scored.map((x) => x.tag);
}

/**
 * Returns true when `groupPath` is inside or equal to `scopePath`.
 * A group is "in scope" when its path equals the scope or starts with `scope/`.
 */
export function isInScope(groupPath: string | null | undefined, scopePath: string): boolean {
  if (!groupPath) return false;
  return groupPath === scopePath || groupPath.startsWith(scopePath + "/");
}

/**
 * Filter and rank tags with scope awareness.
 *
 * Rules:
 *  1. Scoped tags whose `scopePath` is an ancestor-or-equal of `groupPath` → visible, tier 1.
 *  2. Global tags (scopePath is null/undefined) → visible, tier 2.
 *  3. Scoped tags from sibling/unrelated groups → excluded.
 *  4. Global collision: if a global and a scoped tag share the same name, the
 *     global tag takes the slot (scoped declaration is redundant/warned).
 *
 * When `groupPath` is null/undefined, all scoped tags are excluded and only
 * globals are returned (safe default for entries without a group).
 */
export function rankTagsScoped(
  tags: TagMeta[],
  groupPath: string | null | undefined,
  query: string,
): TagMeta[] {
  const globalNames = new Set(tags.filter((t) => !t.scopePath).map((t) => t.name));

  const visible = tags.filter((t) => {
    if (!t.scopePath) return true; // global: always visible
    if (globalNames.has(t.name)) return false; // global collision: global wins
    return isInScope(groupPath, t.scopePath); // scoped: only if in scope
  });

  const scored = visible
    .map((t) => ({ tag: t, score: matchScore(t.name, query) }))
    .filter((x) => x.score > 0);

  scored.sort((a, b) => {
    // Scoped-in-scope first (tier 1).
    const scopedA = a.tag.scopePath ? 1 : 0;
    const scopedB = b.tag.scopePath ? 1 : 0;
    if (scopedB !== scopedA) return scopedB - scopedA;
    // Higher matchScore first.
    if (b.score !== a.score) return b.score - a.score;
    // Count desc.
    if (b.tag.count !== a.tag.count) return b.tag.count - a.tag.count;
    // Name asc.
    return a.tag.name.localeCompare(b.tag.name);
  });

  return scored.map((x) => x.tag);
}

/**
 * Rank people: declared (displayName differs from slug → real full_name set)
 * first, then undeclared. Within each tier, sort by count desc then slug asc.
 */
export function rankPeople(people: PersonMeta[], query: string): PersonMeta[] {
  const scored = people
    .map((p) => ({
      person: p,
      score: matchScore(p.slug, query) || matchScore(p.displayName, query),
    }))
    .filter((x) => x.score > 0);

  // Declared = displayName is different from slug (full_name was set).
  const isDeclared = (p: PersonMeta) => p.displayName !== p.slug;

  scored.sort((a, b) => {
    const da = isDeclared(a.person) ? 1 : 0;
    const db = isDeclared(b.person) ? 1 : 0;
    if (db !== da) return db - da; // declared first
    if (b.score !== a.score) return b.score - a.score;
    if (b.person.count !== a.person.count) return b.person.count - a.person.count;
    return a.person.slug.localeCompare(b.person.slug);
  });

  return scored.map((x) => x.person);
}

// ── Color initial helper (for mention option rendering) ──────────────────────

const COLOR_CLASS: Record<string, string> = {
  slate: "cm-tnd-ac-initial--slate",
  red: "cm-tnd-ac-initial--red",
  amber: "cm-tnd-ac-initial--amber",
  green: "cm-tnd-ac-initial--green",
  teal: "cm-tnd-ac-initial--teal",
  blue: "cm-tnd-ac-initial--blue",
  violet: "cm-tnd-ac-initial--violet",
  pink: "cm-tnd-ac-initial--pink",
};

function initialSpan(person: PersonMeta): HTMLElement {
  const span = document.createElement("span");
  span.className = `cm-tnd-ac-initial ${COLOR_CLASS["blue"] ?? ""}`;
  span.textContent = (person.displayName ?? person.slug).charAt(0).toUpperCase();
  return span;
}

// ── Source factory ──────────────────────────────────────────────────────────────

/**
 * Build the three completion sources. Returns them as an array so callers can
 * spread into the autocompletion override list.
 *
 * Sources are async because they call ipc. The first call to each is typically
 * fast (mock is synchronous; real Tauri IPC is <5ms). We fetch fresh data on
 * every invocation so updates (e.g. new entries_in_group) are reflected without
 * a restart — consistent with the chips layer's refreshMetadata approach.
 */
export function buildCompletionSources(config: AutocompleteConfig): CompletionSource[] {
  const { ipc, onCreatePerson, groupPath } = config;

  // ── Tag source ─────────────────────────────────────────────────────────────

  const tagSource: CompletionSource = async (ctx: CompletionContext) => {
    if (insideFrontmatter(ctx) || insideCode(ctx)) return null;

    // Match `#` followed by zero or more tag characters (letters/digits/-_/).
    const match = ctx.matchBefore(/#+[a-zA-Z0-9\-_/]*/);
    if (!match) return null;
    // Require the match to START with exactly one `#` not preceded by a word char.
    const charBefore = match.from > 0 ? ctx.state.doc.sliceString(match.from - 1, match.from) : "";
    if (isWordChar(charBefore)) return null;
    // Strip the leading `#` to get the typed query.
    const query = match.text.slice(1);

    const result = await ipc.tag_index();
    if (!result.ok) return null;
    const currentGroupPath = groupPath?.current;
    const tags =
      currentGroupPath != null
        ? rankTagsScoped(result.value, currentGroupPath, query)
        : rankTags(result.value, query);

    const options: Completion[] = tags.map((tag) => {
      // Hierarchical display: replace `/` with ` / ` in the label.
      const label = tag.name.includes("/") ? tag.name.replace(/\//g, " / ") : tag.name;
      return {
        label: `#${tag.name}`,
        displayLabel: `#${label}`,
        detail: tag.color !== "slate" ? tag.color : undefined,
        apply: `#${tag.name}`,
        boost: tag.count,
      };
    });

    return {
      from: match.from,
      options,
      validFor: /^#[a-zA-Z0-9\-_/]*$/,
    };
  };

  // ── Mention source ─────────────────────────────────────────────────────────

  const mentionSource: CompletionSource = async (ctx: CompletionContext) => {
    if (insideFrontmatter(ctx) || insideCode(ctx)) return null;

    // Match `@` followed by zero or more mention characters (letters/digits/-_).
    const match = ctx.matchBefore(/@[a-zA-Z0-9\-_]*/);
    if (!match) return null;
    // Word-boundary rule: `@` must NOT be preceded by a word char (email@host).
    const charBefore = match.from > 0 ? ctx.state.doc.sliceString(match.from - 1, match.from) : "";
    if (isWordChar(charBefore)) return null;

    const query = match.text.slice(1); // strip `@`

    const result = await ipc.people_index();
    if (!result.ok) return null;
    const people = rankPeople(result.value, query);

    const options: Completion[] = people.map((person) => {
      const isDeclared = person.displayName !== person.slug;
      const info: Completion["info"] = isDeclared
        ? () => {
            const el = document.createElement("span");
            el.className = "cm-tnd-ac-mention-info";
            el.appendChild(initialSpan(person));
            const nameSpan = document.createElement("span");
            nameSpan.textContent = ` ${person.displayName}`;
            el.appendChild(nameSpan);
            return el;
          }
        : undefined;

      return {
        label: `@${person.slug}`,
        displayLabel: isDeclared ? `@${person.slug} — ${person.displayName}` : `@${person.slug}`,
        detail: isDeclared ? person.displayName : undefined,
        apply: `@${person.slug}`,
        boost: person.count + (isDeclared ? 1000 : 0),
        info,
      };
    });

    // "Create person" sentinel — always last.
    const typedSlug = query || "…";
    const createOption: Completion = {
      label: `@create:${typedSlug}`,
      displayLabel: `Create person '${typedSlug}'`,
      detail: "new",
      boost: -9999,
      apply(view, _completion, _from, to) {
        // Do NOT insert text — just fire the callback.
        onCreatePerson?.(typedSlug === "…" ? "" : typedSlug);
        // Close the picker without modifying the document.
        view.dispatch({ selection: { anchor: to } });
      },
    };
    options.push(createOption);

    return {
      from: match.from,
      options,
      validFor: /^@[a-zA-Z0-9\-_]*$/,
    };
  };

  // ── Wikilink source ────────────────────────────────────────────────────────

  const wikilinkSource: CompletionSource = async (ctx: CompletionContext) => {
    if (insideFrontmatter(ctx) || insideCode(ctx)) return null;

    // Match `[[` followed by any non-`]` characters (the typed title/id fragment).
    const match = ctx.matchBefore(/\[\[[^\]]*$/);
    if (!match) return null;

    // Strip the opening `[[`.
    const query = match.text.slice(2);

    // Load entries from all groups. Consistent with chips' entryTitles approach.
    const GROUPS = ["work/atlas", "journal", "books", "inbox"];
    const summaries: EntrySummary[] = [];
    await Promise.all(
      GROUPS.map(async (g) => {
        const r = await ipc.entries_in_group(g);
        if (r.ok) summaries.push(...r.value.items);
      }),
    );

    // Filter by prefix or substring match on id or title.
    const filtered = summaries.filter((e) => {
      if (!query) return true;
      return matchScore(e.id, query) > 0 || matchScore(e.title, query) > 0;
    });

    // Sort by recency (most-recent first).
    filtered.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));

    const options: Completion[] = filtered.map((entry) => ({
      label: `[[${entry.id}`,
      displayLabel: entry.title,
      detail: entry.id,
      // Insert `[[id]]` — literal text, closing brackets included.
      apply: `[[${entry.id}]]`,
      boost: 0,
    }));

    return {
      from: match.from,
      options,
      // Valid while we're inside `[[…` with no `]]` yet.
      validFor: /^\[\[[^\]]*$/,
    };
  };

  return [tagSource, mentionSource, wikilinkSource];
}

// ── Public factory ─────────────────────────────────────────────────────────────

/**
 * Build the autocomplete extension for the ToNoteDo editor.
 *
 * Install by adding to the Editor's extension array AFTER the markdown extension
 * (so the syntax tree is available for code-fence guards):
 *
 *   extensions: [
 *     frontmatterFold,
 *     chips(chipConfig),
 *     cursorReveal,
 *     autocomplete({ ipc, onCreatePerson }),
 *     ...
 *   ]
 */
export function autocomplete(config: AutocompleteConfig): Extension {
  const sources = buildCompletionSources(config);
  return autocompletion({
    override: sources,
    // Close on blur (standard prose editor behavior).
    closeOnBlur: true,
    // Activate completions on every keypress that might extend a token.
    activateOnTyping: true,
    // Reasonable max items to keep the list manageable.
    maxRenderedOptions: 20,
  });
}
