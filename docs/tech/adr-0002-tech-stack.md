---
id: docs/tech/adr-0002-tech-stack
title: Application runtime and UI stack
kind: adr
status: accepted
related: [docs/spec/0001-product-vision, docs/spec/0006-markdown-editor, docs/spec/0010-plugins, docs/spec/0013-mobile, docs/tech/adr-0001-storage-format]
supersedes:
---

# Application runtime and UI stack

## Context

The product vision and the storage ADR (0001) both push at this decision:

- **calm and fast** — typing latency under 16ms, opening an entry under 100ms, switching entries under 50ms (see 0006). The runtime must be capable of this on a 5-year-old laptop.
- **local-first / privacy-oriented / no forced cloud** — the runtime should not pull in a default-on cloud connection or "auto-update from the internet" without user consent.
- **markdown-based** — the editor is a custom live-inline component (0006), not a stock textarea. We need a real rendering layer with fine-grained control.
- **highly customizable** — themes, keymaps, plugins. The UI layer must support deep theming and a sandboxed plugin runtime (0010).
- **cross-platform, desktop and mobile** — macOS, Windows, Linux, iOS, and Android are all first-class v1 targets with full feature parity (see 0013-mobile for what parity means on touch). The stack must compile to and behave on all five from one codebase.

Constraints from secondary concerns:

- Small download size and small memory footprint matter to the "calm" feel. Apps in this category that ship 300MB and idle at 600MB of RAM (looking at the Electron average) clash with the product's posture.
- Single-developer or small-team development is the assumed reality; the stack should not require maintaining three native codebases.
- Plugin runtime is a JS sandbox (0010). Whatever stack we pick must host one cleanly.

## Decision

**Tauri 2 (Rust core + system webview for UI).**

Specifically:

- **Core** in Rust: filesystem watcher, SQLite index, frontmatter parser, plugin host. Compiled per-platform; tiny binary; no Node runtime shipped.
- **UI** in a system webview (WebView2 on Windows, WKWebView on macOS and iOS, WebKitGTK on Linux, Android System WebView on Android), driven by TypeScript + a fine-grained UI framework — decided in adr-0003 (Svelte 5).
- **Editor** built on a customized CodeMirror 6 (or ProseMirror) instance running in the webview, talking to the Rust core for save/load/index queries.
- **Plugin runtime** in a sandboxed JavaScript engine embedded in the core (QuickJS or a V8 isolate) so plugins are isolated from the UI thread and from each other.
- **IPC** through Tauri's typed command bridge; large payloads go through a streaming channel to keep the UI responsive.

This trades some implementation cost (Rust + TS instead of one language) for binary size, memory footprint, security posture, and platform integration.

## Alternatives considered

**A. Tauri 2 (this ADR).** Pros: native binary per platform, ~10–20MB downloads, low idle memory, Rust core means a real systems-language for the index and watcher, system webview keeps the chrome OS-native. Cons: two languages (Rust + TS) to maintain; system webview means three subtly different rendering targets to test; Rust ramp-up has a real curve.

**B. Electron + Node + TypeScript.** Pros: one language, mature ecosystem, predictable rendering (one Chromium), every reference app in this space uses it. Cons: ~80–150MB downloads, 200–400MB idle memory, "calm and fast" becomes a constant fight; Node in the renderer is a security cliff that has bitten every Electron app; and Electron has no mobile target at all, which under mobile-in-v1 is disqualifying on its own. Rejected.

**C. Native per platform (Swift + Kotlin/Compose + ...).** Pros: best possible per-platform feel, lowest footprint, no webview quirks. Cons: 3× the code, 3× the bugs, and a custom markdown editor written three times. Rejected: not feasible for the team shape.

**D. Web app (PWA in the browser).** Pros: zero install, automatic updates, one codebase. Cons: filesystem access through OPFS or File System Access API is awkward and platform-uneven; offline-first is harder; users perceive "browser tab" as ephemeral. Rejected for v1: contradicts the "feels like a real app on my machine" posture. Could be a parallel deliverable later.

**E. .NET MAUI / Flutter / Qt / Avalonia.** Each could in principle work, and mobile-in-v1 strengthens Flutter's case specifically (its mobile story is more mature than Tauri's). Still rejected, for the same load-bearing reason: the editor needs a DOM-like rendering layer with very fine control, and writing the live-inline markdown editor on these stacks would mean reinventing what CodeMirror gives us for free — on mobile too, where CodeMirror's touch/IME handling is exactly the hard-won part.

## Consequences

**Good:**

- Small downloads, fast startup, low memory — the "calm" claim is technically defensible.
- Rust core lets us own the index/watcher layer without compromise. SQLite is a first-class dependency in Rust.
- The plugin runtime can be a properly sandboxed JS engine inside the core, separate from the UI webview. This is the right boundary for the permission model in 0010.
- Same TypeScript skills cover the UI and (most of) the plugin SDK. Plugin authors do not have to learn Rust.
- Tauri's IPC model maps naturally to the command/event surface we already need (see 0007 commands).

**Bad / costly:**

- Two languages on the team. Rust onboarding is real. Mitigation: scope the Rust surface — core data path, watcher, index — and keep everything else in TypeScript.
- Four webview engines across five targets (WebKitGTK / WKWebView / WebView2 / Android System WebView) means subtle CSS, input, and platform-key differences. Mitigation: a visual-regression suite per platform; lean on platform-neutral CSS.
- Tauri 2 is younger than Electron. Smaller community, smaller talent pool, occasional bumps in major releases.
- **Tauri's mobile story is the project's single largest technical risk.** With iOS and Android promised at full parity in v1 (0013-mobile), the least mature part of the chosen stack sits under a launch commitment: plugin/IPC behavior on mobile webviews, background limitations, and store-packaging paths all need proving, not assuming. Mitigation: the mobile spike is the *first* prototype milestone, not a trailing one — if it fails, this ADR must be superseded before significant UI code exists. Two constraints propagate to other ADRs: iOS forbids JIT, so the plugin engine must run interpreter-only (satisfied by QuickJS, adr-0005); mobile platforms do not allow desktop-style filesystem watching, so reconciliation must also work as rescan-on-foreground (design-0001).

## Follow-ups

- UI framework — decided in adr-0003 (Svelte 5).
- Editor base — decided in adr-0004 (CodeMirror 6).
- Plugin sandbox engine — decided in adr-0005 (QuickJS via rquickjs).
- Mobile spike as the first prototype milestone and go/no-go gate for this ADR. Checklist, derived from Tauri 2's known mobile gaps: (a) Android — list/create/watch files in a user-picked SAF folder tree (the stock fs plugin handles file URIs but not tree enumeration; expect a small custom Kotlin plugin, with the app's public Documents folder as the shippable fallback); (b) iOS — persist a security-scoped bookmark to a user-picked folder across launches and walk it from Rust (fallback: app Documents + iCloud container, the Obsidian pattern); (c) foreground/background lifecycle events reaching the Rust core (drives design-0001's rescan-on-foreground); (d) CodeMirror touch editing and IME on both webviews; (e) scheduled local notifications fire when the app is suspended (informs 0012's open question); (f) the on-device dev loop is tolerable (iOS device dev requires Xcode attached).
- First binary-size and cold-start measurements on all five targets once a thin prototype exists.
- Establish the Rust / TypeScript boundary doc: what crosses IPC, what stays in each side. — done (`design-0004-ipc-boundary`).
