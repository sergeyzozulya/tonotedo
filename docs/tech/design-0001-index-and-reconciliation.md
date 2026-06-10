---
id: docs/tech/design-0001-index-and-reconciliation
title: Index schema, file watcher, and reconciliation
kind: design
status: draft
related: [docs/spec/0002-entries, docs/spec/0004-tags, docs/spec/0005-mentions, docs/spec/0008-calendar, docs/spec/0009-search, docs/spec/0013-mobile, docs/tech/adr-0001-storage-format, docs/tech/adr-0002-tech-stack]
supersedes:
---

# Index schema, file watcher, and reconciliation

## Context

ADR 0001 decides that markdown files are canonical and a SQLite index (`.tonotedo/index.db`) is a derivable cache, and defers the hard part to this doc: what the index holds, how the app notices the filesystem changed, and how the two are reconciled without ever treating the index as truth. ADR 0002 places this code in the Rust core.

## Constraints

- The index must answer, fast (0009: first results < 100ms on 10k entries): full-text queries (FTS5, stemming + prefix), tag and mention membership from *both* surfaces (frontmatter and body — 0004, 0005), property filters, calendar projections (0008), and link backreferences for rename rewrites (0006).
- Deleting `index.db` must be fully recoverable by a rescan (ADR 0001). Therefore: nothing lives only in the index.
- External edits (vim) must reconcile sub-second while the app runs (0002, 0006), and across app restarts via a startup rescan.
- Staleness authority is file mtime + content hash (ADR 0001).
- Batch rewrites (tag/person rename — 0004, 0005) must be journaled so a crash mid-batch is recoverable.

## Model

**Tables (sketch — names indicative, not frozen):**

- `files(path PK, mtime, size, content_hash)` — the reconciliation ledger; one row per `.md` file under the root, including reserved `_` files.
- `entries(id PK, path UNIQUE, slug, group_path, title, created, updated, archived)` — one row per entry file; `id` from frontmatter (0002).
- `properties(entry_id, key, declared_type, inferred_type, value_json)` — every frontmatter property, typed per 0002's schema-then-inference rule; unknown shapes stored as raw JSON.
- `tags(entry_id, tag, surface)` / `mentions(entry_id, slug, surface)` — `surface ∈ {frontmatter, body}`; membership queries take the union, rename rewrites use `surface` to know which text to touch.
- `links(src_entry_id, target_raw, resolved_entry_id NULL, resolved_group_path NULL)` — wikilinks and `ref` properties; `target_raw` keeps the written form (bare or path-qualified, 0006) so rewrites are textual and exact.
- `people(slug PK, full_name, color, avatar_path)` / `tag_meta(tag PK, ...)` — projections of `_people.md` / `_tags.md`, joined at query time for search-by-full-name (0009) and chip rendering.
- `fts` — FTS5 virtual table over title + body, porter stemming + prefix indexes; external-content mode keyed to `entries`.
- `meta(key, value)` — index schema version, library root fingerprint, last full-scan timestamp.

Calendar occurrences are **not** materialized; RRULEs (0008) expand in memory for the visible window. Schemas from `_group.md` are parsed into memory at load, not indexed — they only shape suggestions and write order.

**Watcher.** On desktop: platform watcher (FSEvents / inotify / ReadDirectoryChangesW via the `notify` crate) on the library root, ignoring `.tonotedo/`. Events are debounced (~100ms) and coalesced per path into a reconcile queue consumed by a single worker — one writer to SQLite, no lock contention with readers (WAL mode). On mobile (0013) there is no reliable always-on watcher: the rescan-diff path below runs on every app foreground (and on platform file-change signals where available), so reconciliation must be cheap enough to run routinely, not just at startup. Same pipeline, two triggers.

**Reconcile(path).** Compare (mtime, size) to `files`; on mismatch, hash; on hash change, re-parse frontmatter + body and replace that file's derived rows in one transaction. Deletions cascade. A changed `_group.md` / `_tags.md` / `_people.md` / `_settings.md` invalidates its projection instead.

**Rename detection.** A delete+create pair (or move event) carrying the same frontmatter `id` is a move: the `entries` row is updated in place, preserving backlink identity. The duplicate-id rule (0002) applies when two live files claim one id: first keeps it, second is re-id'd and the user notified.

**Startup rescan.** Walk the tree; diff against `files`; reconcile differences. An empty or version-mismatched `index.db` triggers a full rebuild on a background thread; queries run against the partial index with the "indexing in progress" hint (0009).

**Batch journal.** Multi-file rewrites append intents to `.tonotedo/journal/` (operation, file list, per-file done marker) before touching files; each file write is atomic (temp + rename, 0006). On launch, an unfinished journal is offered for resume or rollback.

## Interfaces

- The UI (webview) never opens SQLite. It calls typed query commands over Tauri IPC (`search(query, filters)`, `entries_in_group(path)`, `calendar_window(from, to)`, `backlinks(entry_id)`), each returning serialized rows; large result sets stream (ADR 0002).
- Writes flow one way: UI → core write API → file on disk → watcher/reconciler → index → change event → UI refresh. The editor does not patch the index directly; the file event is the commit signal. Self-originated writes carry a token so the reconciler can skip re-notifying the originating view.
- Plugins (0010) read through the same query API; provider writes go through the same atomic write path.

## Failure modes

- **Index corruption / failed migration** → delete `index.db`, full rebuild. Worst case is a rebuild-time wait, never data loss.
- **Watcher overflow or dropped events** (large git checkout inside the library) → watcher signals overflow; fall back to a full rescan.
- **Hash collision** — accepted risk with a 128-bit+ hash (xxh3-128 or blake3); not defended further.
- **Crash mid-batch-rename** → journal resume/rollback on next launch (0004/0005 guarantee).
- **Two app instances on one library** → SQLite WAL serializes index writes, but double-watching is wasteful; second instance opens read-only with a banner. Cross-*machine* concurrent edits arrive through file sync and are handled as external edits / conflicted copies per 0013's sync posture — the reconciler treats them like any other on-disk change.
- **Cloud placeholder ("dataless") files** (0013) → a path exists but content is evicted; reconcile marks the entry pending and requests materialization rather than indexing an empty body. The `files` ledger records the placeholder state so the entry is not misread as deleted.
- **Synced `index.db`** → the index must not travel between devices (0013); where sync exclusion is impossible, the per-device index filename fallback (0013 open question) applies. A foreign `index-*.db` appearing via sync is ignored and reported.

## Open questions

- Hash algorithm: xxh3-128 (speed) vs blake3 (also fast, cryptographic). Decide with the first benchmark.
- FTS5 tokenizer details for CJK and diacritics; porter covers English only — is `unicode61` + prefix enough for v1?
- Debounce window and self-write token design need validation against editor save-on-pause (~500ms, 0006) so the user never sees their own save echo back as an "external change."
- Benchmark plan from ADR 0001 (10k / 50k / 100k synthetic libraries): define corpus shape and target numbers per query class before optimizing.
