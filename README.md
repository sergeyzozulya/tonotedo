# ToNoteDo

Beautiful integrated personal productivity app: calm, fast, private, modern, and powerful.

## What it is

- local-first
- offline-first
- cross-platform (desktop and mobile)
- privacy-oriented
- keyboard-friendly
- clean and simple UI
- highly customizable
- markdown-based
- multi-level groups
- entries (custom properties)
- calendar
- tags (global / scoped)
- mentions (people)
- plugins (providers and processors)

## What it is not

- no forced cloud / subscription
- no teams / enterprise
- no AI-everywhere
- no ugly database feeling

## Status

Spec-first: the v1 specs and tech ADRs are accepted; implementation is starting with the mobile spike (see `docs/tech/adr-0002-tech-stack.md`). See [docs/](docs/README.md).

Stack: Tauri 2 (Rust core) · Svelte 5 · CodeMirror 6 · SQLite index · QuickJS plugin sandbox.

## Docs

- [docs/spec/](docs/spec/) — product specs (vision, features)
- [docs/tech/](docs/tech/) — technical specs (design docs, ADRs)
- [docs/README.md](docs/README.md) — how the docs are organized

## License

[MIT](LICENSE) © Sergey Zozulya
