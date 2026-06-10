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

## Repo layout & conventions

See [AGENTS.md](AGENTS.md) (layout, tooling contract, the `#/dev` convention) and
[docs/](docs/README.md) (the specs the code is built against).
