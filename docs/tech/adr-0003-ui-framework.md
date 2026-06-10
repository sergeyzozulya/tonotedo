---
id: docs/tech/adr-0003-ui-framework
title: UI framework for the webview layer
kind: adr
status: accepted
related: [docs/spec/0001-product-vision, docs/spec/0006-markdown-editor, docs/spec/0007-keyboard-model, docs/spec/0013-mobile, docs/tech/adr-0002-tech-stack]
supersedes:
---

# UI framework for the webview layer

## Context

ADR 0002 picked Tauri 2 with a TypeScript UI in the system webview and deferred the framework choice. Two scoping facts shape this decision:

- The hottest path in the app — the live-inline editor — is **not** rendered by the UI framework. CodeMirror manages its own DOM (adr-0004). The framework renders everything around it: sidebar tree, entry list, properties panel, calendar grids, palette, search overlay. Those surfaces are dominated by virtualized lists fed by index queries over IPC, and by many small reactive updates (a tag chip recolors, a count badge increments) arriving as change events from the Rust core.
- Mobile ships at full parity in v1 (0013), so the chrome runs on low-end Android System WebViews and on WKWebView under memory pressure — bundle size, idle memory, and update jank are user-facing there in a way desktop forgives.

Secondary constraints: a single developer (ergonomics, docs, and community answers matter); no SSR or routing-meta-framework need (a windowed app, desktop and mobile); deep theming via CSS custom properties (framework-neutral); TypeScript end-to-end.

## Decision

**Svelte 5 (runes) with TypeScript.**

- Runes give fine-grained, compiler-backed reactivity: an IPC change event updates a piece of state and only the DOM that reads it changes. No virtual-DOM diff on the hot paths, no memoization discipline.
- The performance profile matches the calm-and-fast pillar where it is hardest to fake: measured comparisons put Svelte 5 well ahead of React 19 on bundle size (tens of KB smaller), idle and working memory (roughly half), list-update latency, and sustained frame rate under interaction load — the exact dimensions that matter on the mobile webviews 0013 commits to.
- Convenience is the other half of the brief, and it is Svelte's strongest suit: components are mostly plain markup + scoped styles + runes, with the least ceremony of any mainstream option; scoped styles in particular fit the per-zone theming model (0011) naturally.
- The community is mainstream-sized (an order of magnitude larger than Solid's), so platform-quirk answers, component references, and contributors exist when needed.

## Alternatives considered

**A. Svelte 5 (this ADR).** Cons, honestly: the compiler is a layer between source and behavior (debugging happens in compiled output, though source maps are good); TypeScript lives in a template dialect rather than plain TSX, so type inference at component boundaries is occasionally less direct; the ecosystem, while big, is smaller than React's — some niche components will be written, not installed.

**B. React 19 + Compiler.** The largest ecosystem, the most touch-tested components, the broadest familiarity. Rejected on the performance half of the brief: even with the compiler removing manual memoization, measured bundle (~3× Svelte), idle memory (~2×), and frame-rate dips under rapid interaction are all in the wrong direction for low-end mobile webviews — costs paid permanently to acquire an ecosystem advantage that is mostly irrelevant here (the hard component, the editor, is CodeMirror regardless, and this app's chrome is custom by design).

**C. SolidJS.** The previous draft of this ADR picked Solid, before mobile-at-parity entered the constraints. Its raw reactivity performance is unbeaten and its model is elegant, but it pairs Svelte-class numbers with a community a fraction of the size — when an Android WebView quirk or an IME edge case hits at month nine, the probability that someone has already hit it is materially lower. Re-weighed under mobile parity and a stated preference for mainstream tooling: rejected in favor of Svelte 5, which concedes almost nothing on performance and much less on convenience.

**D. Vue 3.x (Vapor mode).** Vapor-mode benchmarks land essentially at Svelte 5's level and Vue's ecosystem is large. Rejected on timing: Vapor is not yet the stable default — betting the chrome on a mode still stabilizing adds risk for no advantage over an already-stable equivalent. Worth a footnote if this ADR is ever revisited.

**E. No framework (custom DOM + small signals lib).** Obsidian ships exactly this, proving it viable for the category. Rejected for this team shape: hand-building every list, tree, overlay, and focus trap is sustained drag for a solo developer, and the saved kilobytes over Svelte are negligible (Svelte's runtime is already tiny).

## Consequences

**Good:**

- Fine-grained updates without re-render discipline; chrome performance headroom on all five targets, including the low-end Android webviews 0013 makes first-class.
- Smallest practical bundle and memory footprint after the no-framework option; aligned with ADR 0002's posture.
- Low-ceremony components keep the solo-dev velocity high; scoped styles map cleanly onto the theming token sheet (0011).

**Bad / costly:**

- Some primitives get written in-house (virtual list tuned to our row shapes, tree view) — true under every option except React, and only partially mitigated there.
- The Svelte compiler and its template dialect are a real (if shallow) learning layer; contributors from React-land must unlearn re-render thinking.
- Two custom-DOM islands (CodeMirror, plugin-provided views) must be bridged explicitly; this is true under any framework but worth naming.

## Follow-ups

- Spike: sidebar tree + entry list virtualization over real IPC with a 10k-entry synthetic library, on desktop and on a low-end Android device (ties into the ADR 0002 mobile spike and design-0001's benchmark plan).
- Define the CodeMirror ↔ Svelte boundary (who owns focus, how editor state surfaces to the properties panel) in the editor design doc that follows adr-0004.
- Theming: establish the CSS custom-property token sheet that 0011's themes resolve into, using Svelte's scoped styles per zone.
