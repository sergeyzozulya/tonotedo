# Phase 0 iOS spike — results (issue #1, legs b/c/d/f)

Go/no-go evidence for the Tauri 2 + Svelte 5 stack on iOS (adr-0002). Everything
below was **run** on a booted iPhone 17 Pro simulator (iOS 26.5, Xcode 26.5) in
the `phase-0-spike-ios` worktree. Plausible-but-unverified claims are excluded.

Environment: macOS 26 (Darwin 25.5), Xcode 26.5 (17F42), CocoaPods 1.16.2,
rustc/cargo 1.96.0, iOS targets `aarch64-apple-ios{,-sim}` + `x86_64-apple-ios`.

## TL;DR verdicts

| Item | What | Verdict |
|------|------|---------|
| (b) | Filesystem from Rust (`std::fs` in app Documents) | **works** |
| (c) | App lifecycle into Rust | **works** (full background/foreground cycle confirmed on sim; re-verify on device) |
| (d) | CodeMirror 6 touch editing in iOS webview | **works** (render + programmatic edit verified; touch/IME *feel* needs device) |
| (f) | Dev-loop quality (`init` → build → run → iterate) | **works-with-caveats** (several manual fixes; first build slow; one flaky step) |

**Gate recommendation: GO** for the iOS leg. The stack initializes, builds,
installs, and runs on the simulator; Rust filesystem access and app lifecycle
both reach Rust; CodeMirror renders and edits. The caveats are bounded and
already known (folder picker + bookmark persistence = small custom Swift plugin;
iCloud coordination + touch feel = physical-device validation). None are blockers.

---

## Manual fixes required to get iOS building (item f)

1. **`GIT_CONFIG_*` env breaks the iOS cargo build.** The shell injects
   `GIT_CONFIG_COUNT=1 / GIT_CONFIG_KEY_0=safe.bareRepository / GIT_CONFIG_VALUE_0=explicit`.
   Tauri's `swift-rs` build dep creates and queries a bare git repo for its
   vendored Swift package; with `safe.bareRepository=explicit` git refuses it:
   `fatal: cannot use bare repository '.../swift-rs-...' (safe.bareRepository is 'explicit')`
   → `Failed to compile swift package Tauri`. **Fix:** `unset GIT_CONFIG_COUNT
   GIT_CONFIG_KEY_0 GIT_CONFIG_VALUE_0` before any iOS cargo/xcode build. (This
   is an environment quirk of this sandbox, not a Tauri bug, but it must be
   documented for the dev loop / CI.)

2. **`#[cfg(mobile)]` lifecycle variants.** `tauri::WindowEvent::Suspended` and
   `::Resumed` only exist under `#[cfg(mobile)]`. Match arms referencing them
   must be `#[cfg(mobile)]`-gated or the **desktop** (`cargo check`/host test)
   build fails with `no variant ... Suspended`. (See `src-tauri/src/lib.rs`.)

3. **Shared dev-server port across sibling worktrees.** `vite.config.ts` pins
   `port: 1420, strictPort: true`. A parallel worktree holding 1420 makes
   `tauri ios dev`'s `beforeDevCommand` fail with `Port 1420 is already in use`,
   which then tears down the CLI's xcode-script websocket server and the build
   dies with `failed to read CLI options ... Connection refused`. **Fix used:**
   spike override `src-tauri/tauri.spike.conf.json` runs vite on 1430
   (`devUrl` + `beforeDevCommand: pnpm dev --port 1430 --strictPort`). For the
   real project, make the port configurable or coordinate ports across agents.

4. **Auto-installed toolchain deps (no action, but noted):** `tauri ios init` /
   `dev` auto-`brew install`ed `xcodegen`, `libimobiledevice`, and `ios-deploy`,
   and ran `pod`. First-time only.

5. **No code-signing needed for the simulator.** The `Warn No code signing
   certificates found ... developmentTeam` warning is benign for the simulator —
   the build codesigns ad-hoc (`codesign --sign -`) and runs. A real device
   build will need a team / `APPLE_DEVELOPMENT_TEAM`.

### Things that did NOT need a manual fix
- **Icons:** the repo ships only a 32×32 `icon.png`, but `tauri ios init`
  upscaled it to the full asset catalog automatically (incl. a 1024×1024
  `AppIcon-512@2x.png`). No `tauri icon` regeneration was required for the build
  to succeed. (Quality of an upscaled icon is cosmetic, out of spike scope.)

### Build-loop friction observed
- **First sim build is slow:** ~3m45s just for the cargo iOS-sim compile of the
  tauri dependency graph, on top of xcode link + asset/storyboard compile.
  Incremental rebuilds are far cheaper.
- **Intermittent `actool` deadlock:** once, the asset-catalog compile
  (`actool` ↔ `AssetCatalogSimulatorAgent` over a FIFO) hung at 0% CPU for >6
  min. Killing the stuck agent let xcodebuild retry the phase and it succeeded
  immediately (`** BUILD SUCCEEDED **`). Known-flaky Xcode-26/iOS-26 simulator
  behavior; not Tauri-specific. Worth a CI retry wrapper.

---

## (b) Filesystem from Rust — WORKS

**What ran:** Rust command `spike_fs_probe` (`src-tauri/src/spike.rs`), invoked
from the `/spike` Svelte view on mount. In the app's `document_dir()` it: created
a nested tree (`spike_vault/notes/daily/...`) with several `.md` files, walked it
recursively with `std::fs::read_dir`, wrote+read-back one file, renamed one file,
and tried to read two paths outside the sandbox.

**Evidence — the on-disk artifacts in the simulator's app container (read after
launch):**

```
$ find .../Data/Application/<uuid>/Documents/spike_vault | sort
.../spike_vault
.../spike_vault/README.md
.../spike_vault/notes
.../spike_vault/notes/daily
.../spike_vault/notes/daily/2026-06-09.md
.../spike_vault/notes/daily/2026-06-10.md
.../spike_vault/notes/index-renamed.md      # index.md was renamed -> rename OK
$ cat .../spike_vault/notes/daily/2026-06-10.md
# Today
- spike
- round trip 🌱                              # exact payload incl. UTF-8 -> round-trip OK
```

The renamed file (`index.md` → `index-renamed.md`) and the byte-exact round-trip
(emoji intact) prove create / `read_dir` recursion / write / read / rename all
work via plain `std::fs` inside the iOS sandbox, with no plugin and no manual
security-scoping.

**Where the Documents dir physically lives (simulator):**
`.../CoreSimulator/Devices/<DEVICE>/data/Containers/Data/Application/<APP-UUID>/Documents`
(bundle is under `.../Containers/Bundle/Application/<UUID>/ToNoteDo.app`).

### (b-extended) Outside-sandbox access
The probe attempts to `fs::read("/etc/master.passwd")` and
`/var/db/.AppleSetupDone`. Result on the sim: **both blocked**
(`outside_blocked=true` in the launch log), i.e. the reads failed. Caveat: the
simulator's sandbox is not identical to a device's, so treat "outside reads are
blocked" as indicative, not authoritative — but it is the expected direction. The
device-relevant, solid result is that the app's own Documents container is fully
usable from Rust with no plugin.

---

## (c) App lifecycle into Rust — WORKS

**Mechanism that works:** Tauri 2 `RunEvent` + `WindowEvent` in the
`app.run(|handle, event| ...)` callback (`src-tauri/src/lib.rs`). On the iOS
build these surface:
- `RunEvent::Ready` — fired on launch (logged `SPIKE_LIFECYCLE run:ready`).
- `WindowEvent::Focused(true/false)` — fired on launch (`window:focused`).
- `WindowEvent::Suspended` / `::Resumed` — **`#[cfg(mobile)]`-only**; per Tauri
  docs these map to iOS `applicationWillResignActive` /
  `applicationWillEnterForeground`. These are the true background/foreground
  hooks, and **both fired and reached Rust on the simulator** (evidence below).
- Each transition also emits a frontend event (`spike://lifecycle`) the webview
  listens to, so JS can react too.

**Webview fallback wired (redundant):** the `/spike` view also listens to
`document.visibilitychange` (WKWebView `hidden`/`visible`), mirrored to Rust via
`spike_log`. Not strictly needed since the Rust-side `Suspended`/`Resumed` work,
but kept as a belt-and-suspenders signal.

**Confirmed on sim:** launch fired `run:ready` + `window:focused`; backgrounding
the app (launched Safari over it) fired `window:suspended`; re-launching
ToNoteDo fired `window:resumed`. Full cycle reaches Rust.

**Caveat:** re-confirm the same cycle on a **physical device** (delegate
callback timing can differ from the simulator). No scheduled-notification
lifecycle is in scope (item e / 0012, post-v1).

---

## (d) CodeMirror 6 in the iOS webview — WORKS

**What ran:** `/spike` view mounts a CM6 `EditorView` with
`@codemirror/state` + `@codemirror/view` + `@codemirror/lang-markdown` over a
markdown doc, then dispatches a transaction appending text and asserts the doc
changed (`after === before + insert`). Result mirrored to Rust via `spike_log`.

**Evidence:** `SPIKE_EDITOR result=pass ...` in the launch log (see Evidence).
The editor renders in the WKWebView and accepts programmatic edits.

**Caveat (genuinely needs a physical device):** programmatic editing and
rendering are verified, but **touch caret placement, text selection handles,
the iOS software keyboard / IME, autocorrect, and scroll-into-view on focus**
cannot be judged on the simulator with a hardware keyboard — these are the real
"does CM6 feel right on iOS" questions and require a device + finger.

---

## (f) Dev-loop quality — WORKS (with caveats)

- `pnpm tauri ios init` → **success** (after auto-installing brew deps; no manual
  icon work).
- `pnpm tauri ios dev "iPhone 17 Pro" -c src-tauri/tauri.spike.conf.json` →
  builds, installs, launches on the booted sim. Needs the env unset (fix #1) and
  a free dev port (fix #3).
- Frontend dev loop is healthy: `pnpm check` (svelte-check) 0 errors,
  `pnpm lint` clean, `pnpm test` (vitest) green, `pnpm format` clean.
- Host `cargo check` green; Rust unit test green (after fix #2).
- **Caveats:** slow first build, the intermittent `actool` hang, and the
  port/websocket coupling make the loop fragile enough that CI should pin ports
  and wrap the build in a retry.

---

## Evidence log excerpts

Captured from `xcrun simctl spawn booted log show --predicate 'eventMessage
CONTAINS "SPIKE_"'` on the booted iPhone 17 Pro (PID 27072), plus the on-disk
container shown under (b). Rust `println!` surfaces as
`[com.tonotedo.app:app] [stdout] ...`; WKWebview `console.log` does **not** route
to the unified log, so frontend probe results are mirrored to stdout via a
`spike_log` Rust command.

```
# launch — lifecycle into Rust
ToNoteDo[27072] [stdout] SPIKE_LIFECYCLE run:ready
ToNoteDo[27072] [stdout] SPIKE_LIFECYCLE window:focused

# filesystem probe (b) — round-trip, rename, recursive walk, outside-read all checked
ToNoteDo[27072] [stdout] SPIKE_FRONTEND fs round_trip=true rename=true walked=6 outside_blocked=true errors=0

# CodeMirror probe (d) — programmatic edit changed the doc (42 -> 65 chars)
ToNoteDo[27072] [stdout] SPIKE_FRONTEND editor result=pass before_len=42 after_len=65

# lifecycle (c) — background then foreground, both reached Rust
ToNoteDo[27072] [stdout] SPIKE_LIFECYCLE window:suspended    # after launching Safari over the app
ToNoteDo[27072] [stdout] SPIKE_LIFECYCLE window:resumed      # after relaunching ToNoteDo
```

App container paths (simulator):
- data:   `.../CoreSimulator/Devices/F92D3C47-.../data/Containers/Data/Application/<UUID>/`
- bundle: `.../CoreSimulator/Devices/F92D3C47-.../data/Containers/Bundle/Application/<UUID>/ToNoteDo.app`
  (`xcrun simctl get_app_container booted com.tonotedo.app {data,}`)

Build success: `** BUILD SUCCEEDED **` (xcodebuild, sdk iphonesimulator26.5),
then `tauri ios dev` installed and launched the app (CLI exit 0 on the clean run).

---

## Follow-up work (out of this spike's scope) + effort estimate

1. **Folder-picker + cross-launch bookmark persistence** — small custom Swift
   Tauri plugin: `UIDocumentPickerViewController` in directory mode →
   `bookmarkData(options: .suitableForBookmarkFile)` → persist → resolve on next
   launch with security-scoped access. **Effort: ~1–2 days.** The default vault =
   app Documents/iCloud container (the Obsidian pattern) ships without it; the
   picker is only needed for arbitrary external folders.
2. **iCloud Drive container + `NSFileCoordinator`** — needed for the iCloud vault
   option: entitlement + dataless/evicted-file coordination (Tauri's fs does not
   auto-invoke `NSFileCoordinator`). **Effort: ~2–3 days incl. device testing.**
   Must be validated on a real device (eviction can't be exercised on the sim).
3. **Scheduled local notifications (item e / 0012)** — `tauri-plugin-notification`
   has no `UNUserNotificationCenter` trigger scheduling; custom native code when
   0012 lands. Post-v1; not a gate concern.
4. **Dev-loop hardening for CI** — pin per-worktree dev ports, `unset GIT_CONFIG_*`
   in the build env, wrap the sim build in an `actool`-hang retry. **Effort: ~0.5 day.**

## What genuinely still needs a physical device
- CodeMirror **touch** caret/selection/handles, the iOS keyboard/IME, autocorrect,
  scroll-on-focus (the "feel").
- Lifecycle delegate timing re-confirmation (sim is indicative).
- iCloud dataless-file eviction & `NSFileCoordinator` behavior.
- Security-scoped **bookmark persistence** across launches for external folders.
- Real-device sandbox boundary (the sim's is looser).
