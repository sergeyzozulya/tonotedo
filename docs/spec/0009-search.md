---
id: docs/spec/0009-search
title: Search
kind: feature
status: implemented
related: [docs/spec/0001-product-vision, docs/spec/0002-entries, docs/spec/0003-groups, docs/spec/0004-tags, docs/spec/0005-mentions, docs/spec/0007-keyboard-model, docs/spec/0008-calendar, docs/spec/0010-plugins, docs/tech/adr-0001-storage-format]
---

# Search

## Problem

At a few hundred entries, browsing the sidebar still works. Past a few thousand, the sidebar is a museum and search is the actual navigation surface. The vision is clear on what search must be: instant, keyboard-driven, local-only (no remote indexing), and capable of more than substring match — users need to filter by tag, group, date, and arbitrary properties without learning a database language.

The hard questions are: a query syntax that is friendly for casual use and expressive for power use; ranking that surfaces the right thing first; and integration with the index (ADR 0001) so search is fast on libraries with tens of thousands of entries.

## User stories

- I press `cmd+p`. A search box opens. I type "atlas budget" and the matching entries appear ranked. Enter opens the top one.
- I click a "tag" chip above the box and pick `#followup`. The list narrows to entries with that tag. My text query continues to apply on top.
- I add a "group" chip set to `Work/Atlas`. Tag + group + free-text compose to narrow the list.
- I save the current query + chip combination as "Atlas follow-ups." It appears in the sidebar; selecting it shows the live result.
- I type a query with a typo. Results are still found (the index does basic stemming and prefix matching).

## Behavior

**Surface.** A single search overlay opened by `cmd+p` (default). Different from the command palette (`cmd+k`, see 0007): the palette runs commands; search finds entries. The two are visually distinct but use the same UI shell.

**Backing store.** The SQLite index (ADR 0001) holds: full-text content of entries (body + title), all property values, tag membership, and mention membership (both surfaces of each — frontmatter and body, see 0004 / 0005), plus the declared people metadata from `_people.md` so that a query matching a person's slug or `full_name` also matches the entries that mention them (see 0005). SQLite FTS5 powers free-text matching. Structured operators are SQL filters on the index. The index is rebuildable from disk; search never reads the filesystem directly at query time.

**Query input.** The query string is plain text — no operator syntax. Multiple terms are AND by default (`atlas budget` requires both). Quoted phrases match exact (`"end of quarter"`). That is the entire textual query language in v1.

**Filter chips.** Structured filtering happens through chips above (or beside) the search box. v1 ships two chip kinds:

- **Tag chip** — pick one or more tags. Multi-select is "any of" within the chip.
- **Group chip** — pick a group path. Includes descendants.

Chips compose with each other and with the text query using AND. There is no UI for OR across chips; users who need OR layer values within one chip (which is "any of") or save two searches. Date, property, and state filters are deferred to a follow-up (see Non-goals); calendar-style "due before X" is best expressed via the calendar (0008) in v1.

This trades expressiveness for clarity: the user always knows what is being matched, and the parse error surface vanishes (there is nothing to parse). The same chip state is what a saved search persists; see Saved searches.

**Ranking.** Default order: recency-weighted relevance. Title matches outrank body matches. Exact tag matches do not contribute to rank — they are filters, not signals. The user can sort by `updated`, `created`, or title via a sort control next to the result list. Sort overrides ranking.

**Live results.** Results update as the user types, debounced ~80ms. No "press enter to search."

**Result item.** Title, group breadcrumb, matched snippet from body (highlighted), tag chips, age. Arrow keys move; enter opens; `cmd+enter` opens in a new pane (if multi-pane lands later).

**Saved searches.** A query can be saved with a name. Saved searches live in `_searches.md` at the library root, frontmatter array. Each saved search captures both the text query and the chip state:

```yaml
---
searches:
  - name: Atlas follow-ups
    text: ""
    filters:
      - { kind: tag, values: [followup] }
      - { kind: group, path: Work/Atlas }
  - name: Inbox
    text: ""
    filters:
      - { kind: group, path: Inbox }
---
```

Saved searches appear in the sidebar under a "Saved" section. Selecting one runs the live query and restores the chip state above the search box (so the user can refine). Saved searches are dynamic — there is no snapshot of results.

The `kind` discriminator on each filter is deliberate: new chip types (date, property, state, or an `or:` group) can be added later without migrating existing `_searches.md` files.

## Non-goals

- No remote / cloud indexing. The index never leaves the machine.
- No AI / semantic search in v1. (Anti-pillar.) A plugin can later layer this on; the core stays lexical. "Search by similar" / "more like this" falls under this — it is a processor plugin (per [0010-plugins](0010-plugins.md)), never core.
- No textual operator syntax in the search box (`tag:`, `-`, `OR`, parentheses). All structured filtering is via chips. Re-evaluate if power users push back hard.
- No date, property, or state chips in v1. Only tag and group. Date-bound queries belong to the calendar (0008); property/state filtering returns in a later iteration once the chip-input UX is designed per property type.
- No regex search in v1.
- No fuzzy matching across multiple typos in v1. Stemming + prefix is the floor; full Levenshtein is deferred.
- No search-time content scanning — the body of an entry is queryable only if it is in the index. Plugins that store content outside entries (rare) handle their own search.
- Trashed entries excluded from results unconditionally in v1 (no state chip). The trash view is the way to find them.

## Edge cases

- **Empty query and no chips.** Show recently updated entries (top 50). The search surface is also a recents surface.
- **Very large result set.** Virtualize the list; cap displayed results at 500; the user refines via chips or a more specific query if needed.
- **Stale index.** If the index is mid-rebuild, search runs against the partial index and surfaces a "indexing in progress" hint. Results converge as indexing completes.
- **External edit during search.** The result list updates after the file watcher reconciles the index (typically sub-second).

## Acceptance criteria

- `cmd+p` opens search from any focus zone (`cmd+f` is in-entry find, see 0007).
- Searching a declared person's `full_name` returns entries that mention them (see 0005).
- Typing matches against title and body; ranked by relevance with recency weighting.
- A tag chip narrows results to entries carrying any selected tag; chip composes with free-text.
- A group chip narrows results to entries inside that group's subtree.
- Saving a search persists name + text + chip state to `_searches.md`; reopening the app restores the saved search in the sidebar and re-runs it live.
- A search over a 10k-entry library returns first results under 100ms on a 5-year-old laptop.
- Index rebuilt from scratch yields identical query results to the pre-rebuild state.
