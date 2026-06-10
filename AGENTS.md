# Notes for LLM agents

This repository is spec-first. The specs in `docs/` are the source of truth. Code is a projection of the specs.

## Repository layout

- `docs/` — specs and tech docs (two subfolders, `spec/` and `tech/`, no exceptions — see `docs/README.md`).
- `src/` — TypeScript UI (Svelte 5), per adr-0002/adr-0003. Keymap preset definitions (0007) live in `src/presets/`.
- `src-tauri/` — Rust core (watcher, index, frontmatter, plugin host) and Tauri shell config, per adr-0002.
- Root carries only config files (`package.json`, lockfile, linters, CI). No other top-level folders without amending this file first.

## Tooling

Package manager: pnpm. TS tests: vitest (+ `svelte-check` for types). Rust: `cargo test`, `cargo clippy`, `rustfmt`. Formatting: prettier + eslint for TS/Svelte. Run these before declaring work done; do not invent other commands.

## Read order

1. `README.md` at the repo root.
2. `docs/README.md` (includes the legal-pairs table).
3. `docs/spec/0001-product-vision.md`.
4. Whatever specific doc the task concerns.

## Rules

- Never edit a doc with `status: accepted` or `status: implemented` without first proposing a new ADR (in `docs/tech/`, `kind: adr`) or a new draft doc that supersedes the old one.
- ADRs with `status: accepted` are immutable. Supersede, do not edit.
- The `(kind, status, folder)` legal-pairs table in `docs/README.md` is normative. Any combination not in that table is illegal.
- Inside `docs/tech/`, ADRs use the `adr-NNNN-slug.md` filename pattern; design docs use `design-NNNN-slug.md`. Numbering is per-prefix.
- Numbering is per-folder (and per-prefix in `docs/tech/`), 4 digits, zero-padded. First-write-wins on collisions; later writer renumbers.
- Templates live in `docs/_templates/`. Copy, do not improvise.
- Inside `docs/`, two subfolders is the design — do not add more. Top-level layout is fixed in the Repository layout section above.

## Lifecycle transitions

Author advances `status` when the doc is internally consistent and free of TODOs; no second reviewer required at N=1. For `kind: adr` moving to `accepted`, the author must list alternatives considered and consequences in the body before flipping the status.

## Extending the schema

Introducing a fifth `kind` value requires an ADR; do not extend the schema in passing.

## What doesn't belong in docs/

- Source code. Code fences are for illustrative snippets only.
- Issue tracking / todos. Use git issues or ask.
- Meeting notes, changelogs, release notes.
