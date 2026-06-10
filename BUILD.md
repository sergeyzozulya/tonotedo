# Building & running ToNoteDo

## Prerequisites

| What | Version | Install |
|---|---|---|
| Node.js | 22+ | nvm / brew |
| pnpm | 11+ | `corepack enable` |
| Rust | stable (1.96+) | `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \| sh` |
| Xcode (iOS only) | 26+ | App Store, then `sudo xcode-select -s /Applications/Xcode.app/Contents/Developer && sudo xcodebuild -license accept` |
| Android SDK (Android only) | see below | see below |

After installing Rust, shells need `source "$HOME/.cargo/env"` (or restart the terminal).

## Quick start — browser demo (no Rust needed)

```sh
pnpm install
pnpm dev
# open http://localhost:1420/#/dev
```

The `#/dev` page runs against a **mock IPC facade** (`src/lib/ipc/`) with a sample
library — theme switcher (5 themes × light/dark/system), entry list, live editor.
This always works in a plain browser; it is a repo convention (see AGENTS.md)
that every UI feature keeps it working.

The dev server pins port **1420** (`strictPort`) — if it fails to bind, something
else (often another worktree's dev server) is holding the port.

## Desktop app

```sh
pnpm tauri dev      # run (compiles the Rust core on first run, ~minutes)
pnpm tauri build    # release bundle for the current platform
```

## Checks (run before considering any change done)

```sh
# Frontend
pnpm format:check && pnpm lint && pnpm check && pnpm vitest run && pnpm build

# Rust core (from src-tauri/)
cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test
```

CI runs the same set on push/PR to `main` (`.github/workflows/ci.yml`).

## Mobile

Both platforms were validated end-to-end by the Phase 0 spikes (see issue #1 and
the `phase-0-spike-ios` / `phase-0-spike-android` branches, each with a
`SPIKE-*.md` evidence report). Mobile targets are **not yet committed to main**
— that lands in Phase 5. Until then, the spike branches are runnable references.

### iOS

```sh
rustup target add aarch64-apple-ios aarch64-apple-ios-sim x86_64-apple-ios
brew install cocoapods
pnpm tauri ios init   # one-time, generates src-tauri/gen/apple
pnpm tauri ios dev    # builds + launches in the booted simulator
```

Gotchas (learned in the spike):
- If the Swift package step fails with a git error, run
  `unset GIT_CONFIG_COUNT GIT_CONFIG_KEY_0 GIT_CONFIG_VALUE_0` first.
- Simulator needs no code signing; physical devices do.
- First-run brew pulls: `xcodegen`, `libimobiledevice`, `ios-deploy`.

### Android

One-time toolchain (Homebrew):

```sh
brew install openjdk@21 && brew install --cask android-commandlinetools
# accept licenses, then install: platform-tools platforms;android-35 \
#   build-tools;35.0.0 ndk;<latest> emulator system-images;android-35;google_apis;arm64-v8a
rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android
```

Required env (a gitignored `.mobile-env` at the repo root holds these on machines
set up by the build tooling — `source .mobile-env`):

```sh
export JAVA_HOME="$(brew --prefix openjdk@21)/libexec/openjdk.jdk/Contents/Home"
export ANDROID_HOME="$(brew --prefix)/share/android-commandlinetools"
export NDK_HOME="$ANDROID_HOME/ndk/<version>"
export PATH="$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$PATH"
```

```sh
pnpm tauri android init   # one-time, generates src-tauri/gen/android
emulator -avd <name> &    # or a USB device with debugging enabled
pnpm tauri android dev
```

Gotchas:
- **Run one mobile VM at a time** (iOS simulator *or* Android emulator) — both
  together crush a dev machine.
- First debug APK ~3 min; incremental rebuilds ~15 s.
- NDK 30-beta works; if a future NDK breaks the Rust cross-compile, install the
  newest stable via `sdkmanager` and point `NDK_HOME` at it.

## Benchmarks (issue #16 exit gate)

### What and why

Spec 0006 sets these budgets for the markdown editor:

| Metric | Budget |
|---|---|
| Typing input-to-paint p95 | < 16 ms (60 fps) |
| Open time (mount to first paint) | < 100 ms |
| Entry switch time | < 50 ms |

Spec 0013 requires the same budgets on a mid-range phone.

These are **paint-round-trip** measurements — they need a real browser or
device. A headless CI-runnable proxy suite exists (see below) but it does not
replace running on real hardware.

### Part 1 — Interactive browser/device benchmark (`/#/bench`)

```sh
pnpm dev
# Desktop: open http://localhost:1420/#/bench
# Phone:   run `pnpm dev --host` and open the LAN URL on the device
```

1. The page mounts the **full production editor** (all extensions, mock IPC)
   with a deterministic ~10 000-word markdown document (seed `0xdeadbeef`).
2. Click **Run benchmark** — the harness calibrates the display frame interval,
   then executes 300 scripted keystrokes (middle half of document), measuring
   per keystroke: **busy time** (synchronous dispatch cost — the editor's real
   work; this is what the 16 ms budget governs), **missed-next-frame rate**
   (change failed to reach the next vsync = visible jank), and informational
   painted time (vsync-bound; floors at ~1.5 frame intervals even at zero work
   — do NOT compare it against the 16 ms budget).
3. Results appear on-page, are `console.table`'d, and can be downloaded as JSON.
   Pass = busy p95 < 16 ms AND missed-next-frame ≤ 1%.

The JSON report includes `meta.userAgent` so desktop vs phone results can be
distinguished. For the Phase 3 exit gate, collect results on:
- **Desktop**: `pnpm tauri dev` (native Tauri WebView) or any Chromium build
- **Mid-range phone** (spec 0013): connect to `pnpm dev --host` URL in the
  device browser, or use `pnpm tauri ios/android dev`

### Part 2 — CI proxy benchmarks (vitest, DOM-free)

```sh
pnpm vitest run src/lib/editor/tests/bench.test.ts
```

These exercise `EditorState.create`, `state.update` (transaction apply),
`computeRevealDecorations`, `computeChipDecorations`, and `detectFrontmatter`
on the same 10 000-word document — no DOM, no rAF, no paint.

**What they catch**: gross algorithmic regressions (an O(n²) loop, a full
re-parse on every keystroke, etc.).

**What they do not catch**: rendering performance, DOM layout costs,
Svelte reactivity overhead, mobile GPU/memory pressure.

Thresholds (last measured 2026-06-11 on M2 Mac, ≥ 3× headroom):

| Test | Threshold | Measured p95 |
|---|---|---|
| `state.create` (10k doc) | < 25 ms p95 | ~7 ms |
| `tx apply` (300 insertions) | < 4 ms p95 | ~0.007 ms |
| `computeRevealDecorations` | < 8 ms p95 | ~0.09 ms |
| `computeChipDecorations` | < 8 ms p95 | ~0.09 ms |
| `detectFrontmatter` | < 2 ms p95 | ~0.002 ms |
| Combined apply+reveal+chips | < 8 ms p95 | ~0.12 ms |

If a threshold trips in CI, investigate the regression; do not simply raise
the number without a measured justification.

## Repo layout & conventions

See [AGENTS.md](AGENTS.md) (layout, tooling contract, the `#/dev` convention) and
[docs/](docs/README.md) (the specs the code is built against).
