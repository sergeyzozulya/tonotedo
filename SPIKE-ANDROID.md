# Phase 0 Android Spike — Evidence Log (issue #1)

Branch: `phase-0-spike-android`. Stack: Tauri 2.11.2 + Svelte 5, NDK 30.0.14904198-beta1.

Every verdict below is backed by something actually run on the `spike` emulator
(API 35, arm64-v8a, `sdk_gphone64_arm64`). Markers are greppable in
`adb logcat -s RustStdoutStderr` (Rust `println!`) and `Tauri/Console` (web
`console.log`).

## Toolchain / environment

- JDK 21, Gradle 8.14.3, rustc 1.96.0.
- NDK: `30.0.14904198-beta1` (the pre-release shipped in `.mobile-env`). **It works** —
  Rust cross-compiled to `aarch64-linux-android` cleanly. No stable-NDK fallback needed.
- Build env per shell: `source ~/.cargo/env && source .mobile-env`, plus
  `unset GIT_CONFIG_COUNT GIT_CONFIG_KEY_0 GIT_CONFIG_VALUE_0` before the build
  (carried over from the iOS spike learning; precautionary, no failure observed here).
- vite port 1420 with strictPort was free in this worktree — no config override needed.

## (a1) std::fs in app-internal + app-specific external storage — PASS

Tapped "Run std::fs probe". Nested mkdir / write / walk / read / rename verified in
both locations:

```
SPIKE_PROBE fs label=internal_app_data ok=true root=/data/user/0/com.tonotedo.app steps=mkdir -p .../spike_vault/notes/daily | wrote 2 .md files | walked 4 entries | read index.md (31 bytes) | renamed daily note | verified rename
SPIKE_PROBE fs label=external_app_files ok=true root=/storage/emulated/0/Android/data/com.tonotedo.app/files steps=mkdir -p .../spike_vault/notes/daily | wrote 2 .md files | walked 4 entries | read index.md (31 bytes) | renamed daily note | verified rename
```

External path derived from `cache_dir().parent()/files` resolved correctly to the
app-specific external dir (no fallback to the hardcoded path needed).

## (a2) SAF via tauri-plugin-android-fs 28.1.0 — PASS

Compiles + registers (build succeeds with the plugin; FileProvider + plugin manifest
markers auto-injected into `AndroidManifest.xml`).

Folder-picker flow driven via adb. On API 35 the device root AND the `Download` root
itself report "Can't use this folder" and refuse selection. Workaround: created
`Download/spike_vault` via the picker's "CREATE NEW FOLDER", which is selectable.
After "USE THIS FOLDER" the system shows an **"Allow ToNoteDo to access files in
spike_vault?"** dialog — tapped ALLOW.

```
SPIKE_PROBE saf picked uri=FileUri { uri: "content://com.android.externalstorage.documents/tree/primary%3ADownload%2Fspike_vault/document/...", document_top_tree_uri: Some("content://.../tree/primary%3ADownload%2Fspike_vault") }
SPIKE_PROBE saf read_dir count=1 ["F:inner.md"]
SPIKE_PROBE saf persist_uri_permission OK
```

`read_dir` over the picked `content://` tree returned the file pushed into it.

**Persistence across process death — PASS.** After
`adb shell am force-stop com.tonotedo.app` + relaunch, tapping "Check persisted
permissions":

```
SPIKE_PROBE saf persisted_after_restart count=1 ["Dir { uri: FileUri { uri: "content://.../tree/primary%3ADownload%2Fspike_vault/document/...", document_top_tree_uri: Some(...) }, can_read: true, can_write: true }"]
```

The persisted permission survives a full process restart, read+write retained.

### Manual taps required (could not be fully eliminated)

The SAF flow needs human-equivalent taps; everything else is automatable. The
remaining manual/UI-driven steps on the emulator:

1. Navigate into `Download` and CREATE NEW FOLDER `spike_vault` (root + Download root
   are non-selectable on API 35 — privacy restriction).
2. "USE THIS FOLDER".
3. "ALLOW" on the access-grant dialog.

These were all driven successfully via `adb shell input tap` against
`uiautomator dump` coordinates. They are inherent to SAF's security model, not plugin
bugs. NOTE: a left-edge swipe is interpreted as the system back gesture and **cancels**
the picker (the plugin correctly logged `saf cancelled`) — use button taps, not edge
swipes.

## (c) lifecycle pause/resume into Rust — PASS (required a fix)

Predecessors wired `RunEvent::Resumed`, which **does not fire on Android** (verified:
HOME→relaunch produced only the web `visibilitychange`, no Rust marker). Fix: handle
`RunEvent::WindowEvent { event: WindowEvent::Suspended|Resumed }`, gated `#[cfg(mobile)]`
(matches the iOS-spike learning; host `cargo check` stays green). After the fix,
`adb shell input keyevent KEYCODE_HOME` then relaunch:

```
SPIKE_WEB visibility: hidden @ ...
SPIKE_LIFECYCLE WindowEvent::Suspended
SPIKE_LIFECYCLE WindowEvent::Resumed
SPIKE_WEB visibility: visible @ ...
```

Both Rust-side pause and resume now surface.

## (d) CodeMirror 6 in the System WebView — PASS

Mounts and a programmatic dispatch lands; assertion logged to logcat:

```
SPIKE_WEB cm6_mounted len=54
SPIKE_WEB cm6_edit ok=true newLen=76
```

The injected "PROGRAMMATIC EDIT OK" text is also visible in the WebView's
`uiautomator` accessibility tree.

## (f) dev loop / build times

- Frontend (vite): ~0.5s.
- First Android debug APK (Rust largely pre-built by predecessors, incremental link
  6.15s): wall-clock ~2m55s including Gradle.
- Incremental rebuild after a 1-line Rust change: ~15s (Rust relink 6.3s + Gradle).
- Debug universal APK size: ~289 MB (debug, unstripped, contains arm64 jniLib).
- `adb install -r`: a few seconds.

No NDK breakage. No stale-gradle-lock issues encountered (defensive `./gradlew --stop`
ran clean; no prior APK existed — predecessors' build never completed).

## Verdict

All Android legs of issue #1 pass on the emulator. SAF requires inherent manual
grant taps (security model, not a blocker). **Android gate: GO.**
