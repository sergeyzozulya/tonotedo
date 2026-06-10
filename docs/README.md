# ToNoteDo docs

Two folders, no exceptions.

- `spec/` — what we're building. Vision and features.
- `tech/` — how we're building it. Design docs and ADRs.

Each doc is markdown with YAML frontmatter. The `kind` field discriminates artifact type: `vision`, `feature`, `design`, `adr`. Inside `docs/tech/`, filenames carry the kind as a prefix: `design-NNNN-slug.md` and `adr-NNNN-slug.md`.

## Legal (kind, status, folder) combinations

| kind     | folder       | filename pattern         | legal status values                              |
|----------|--------------|--------------------------|--------------------------------------------------|
| vision   | docs/spec/   | NNNN-slug.md             | draft, accepted, deprecated                      |
| feature  | docs/spec/   | NNNN-slug.md             | draft, accepted, implemented, deprecated         |
| design   | docs/tech/   | design-NNNN-slug.md      | draft, accepted, implemented, deprecated         |
| adr      | docs/tech/   | adr-NNNN-slug.md         | proposed, accepted, superseded, rejected         |

Any combination not in this table is illegal.

## Adding a doc

1. Pick the folder (`spec/` or `tech/`).
2. Copy the matching template from `_templates/`.
3. Number it: next free 4-digit prefix in that folder (and per filename prefix in `docs/tech/`). Numbering races are first-write-wins; later writer renumbers.
4. Fill the frontmatter. Status starts as `draft` (or `proposed` for ADRs).

## Cross-references

Use the `related:` frontmatter field with doc IDs in the form `docs/<folder>/<filename-without-extension>`. In prose, use plain relative markdown links.

## Lifecycles

See the legal-pairs table above. ADRs are immutable once `accepted`; change your mind = new ADR that `supersedes` the old one.
