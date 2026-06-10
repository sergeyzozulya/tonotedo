---
id: docs/tech/adr-0001-storage-format
title: On-disk storage format
kind: adr
status: accepted
related: [docs/spec/0001-product-vision, docs/spec/0002-entries, docs/spec/0003-groups, docs/spec/0010-plugins]
supersedes:
---

# On-disk storage format

## Context

The product vision commits to four properties that the storage format must serve at the same time:

- **local-first** and **offline-first** — the app must work fully without a network, and the user's data must live on the user's machine.
- **markdown-based** — content is markdown; the user should be able to read and edit their data without the app.
- **privacy-oriented** and **no forced cloud** — the format must be inspectable, portable, and friendly to user-owned backups (filesystem copy, git, rsync, Time Machine).
- **plugin-friendly** — third-party providers and processors will read and write entries; an opaque format raises the bar for plugin authors.

These together push toward "files on disk." But the product also needs to feel **fast** (calm and fast are pillars). On a library of tens of thousands of entries, naive file scans for every query are not acceptable. So the format must also support fast lookups, full-text search, and aggregations.

The choice made here is load-bearing: it constrains entries (0002), groups (0003), tags (0004), search, sync (if it is ever added), import/export, and the plugin contract.

## Decision

**Markdown files on disk are canonical. A local SQLite index is a derivable, disposable cache.**

Concretely:

- Each entry is one `.md` file with YAML frontmatter for typed properties and tags, and a markdown body.
- Groups are folders. Nesting groups is nesting folders. Group-level metadata (description, scoped tag definitions, property schema overrides) lives in a per-folder `_group.md` file with frontmatter.
- The library root is a single user-chosen folder. Everything else is relative to it.
- A SQLite database (`.tonotedo/index.db`) inside the library root mirrors the filesystem for queries: search, filters, tag aggregations, calendar views. It is rebuildable by scanning the filesystem — if it is deleted, the next launch rebuilds it.
- File mtime + content hash are the authority for "is the index stale." External edits (the user opens an `.md` file in vim) are detected on watch and reconciled.
- The hidden `.tonotedo/` folder holds everything that is not live user content: the index (`.tonotedo/index.db`, derivable — rebuilt by scanning the filesystem), trash (`.tonotedo/trash/`, see 0003 — user content pending permanent deletion), installed plugins (`.tonotedo/plugins/`, see 0010 — restorable by re-installing), and app-private state (window layout, recently opened, etc.). It is never the source of truth for live entries. Deleting it is destructive in two bounded ways: anything still in trash is gone, and plugins must be re-installed; the entry library itself is untouched.

## Alternatives considered

**A. Pure markdown files, no index.** Simplest. Scales to a few thousand entries; falls apart beyond that for tag filters, search, and calendar queries. Rejected: contradicts "fast" pillar at realistic library sizes.

**B. Single SQLite database, markdown stored as a column.** Fast, transactional, easy to query. Rejected: opaque to the user, contradicts "markdown-based" and "privacy-oriented" in spirit if not letter, and makes the plugin contract heavier (plugins must speak SQL or go through the app).

**C. Markdown files + SQLite index (this ADR).** Files are the truth; the index accelerates queries. Two layers of state, but only one source of truth. The index can drift, but drift is bounded and recoverable.

**D. Markdown files + CRDT log for sync.** Future-friendly for sync, but adds a CRDT runtime cost to every write and complicates the "open it in vim" story. Deferred: revisit if and when a sync feature is specified. The chosen format does not preclude it.

## Consequences

**Good:**

- Users can back up with any tool that copies files. Git works. iCloud Drive / Dropbox work (with the usual caveats about concurrent edits).
- A user who stops using the app keeps their data in a format other tools can read.
- Plugins can be filesystem-level: a "git auto-commit" plugin needs no API, just a file watcher.
- The index is a performance detail, not a data structure. We can change the index schema freely without migrating user data.

**Bad / costly:**

- Reconciliation between filesystem and index is non-trivial; we need a file watcher and a rescan-on-startup path.
- Properties richer than strings/numbers/dates (e.g. relations between entries) are awkward in YAML. The entries spec (0002) constrains property types accordingly.
- Performance for a library of 100k+ entries needs to be measured early; this is a follow-up benchmark, not an assumption.
- Editing the same file outside the app while the app has unsaved changes can lose data without conflict UX. The markdown editor spec (0006) must define the policy.

## Follow-ups

- Spec entry frontmatter schema in 0002 (entries). — done (0002).
- Spec group folder + `_group.md` schema in 0003 (groups). — done (0003).
- Design doc: index schema, watcher, and reconciliation strategy. — done (`design-0001-index-and-reconciliation`).
- Benchmark plan: synthetic library at 10k / 50k / 100k entries. — open, tracked in design-0001's open questions.
