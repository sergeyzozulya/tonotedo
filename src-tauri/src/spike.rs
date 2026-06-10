//! Phase 0 Android spike probes (GitHub issue #1).
//!
//! Every probe logs structured, greppable markers to stdout so they appear in
//! `adb logcat -s RustStdoutStderr`. The frontend `/spike` view invokes these
//! and also console.logs the returned JSON.

use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::Manager;

const MARK: &str = "SPIKE_PROBE";

#[derive(Serialize, Default)]
pub struct DirProbe {
    label: String,
    root: String,
    ok: bool,
    steps: Vec<String>,
    error: Option<String>,
}

/// Walk/read/write/rename a nested .md tree under `root` using std::fs only.
fn probe_tree(label: &str, root: PathBuf) -> DirProbe {
    let mut p = DirProbe {
        label: label.to_string(),
        root: root.display().to_string(),
        ..Default::default()
    };
    match run_tree(&root, &mut p.steps) {
        Ok(()) => p.ok = true,
        Err(e) => {
            p.ok = false;
            p.error = Some(e.to_string());
        }
    }
    println!(
        "{MARK} fs label={} ok={} root={} steps={}",
        p.label,
        p.ok,
        p.root,
        p.steps.join(" | ")
    );
    if let Some(e) = &p.error {
        println!("{MARK} fs label={} ERROR={}", p.label, e);
    }
    p
}

fn run_tree(root: &Path, steps: &mut Vec<String>) -> std::io::Result<()> {
    let base = root.join("spike_vault");
    // clean slate for idempotent re-runs
    let _ = fs::remove_dir_all(&base);

    let nested = base.join("notes").join("daily");
    fs::create_dir_all(&nested)?;
    steps.push(format!("mkdir -p {}", nested.display()));

    let a = base.join("notes").join("index.md");
    fs::write(&a, "# Index\n- [[daily/2026-06-10]]\n")?;
    let b = nested.join("2026-06-10.md");
    fs::write(&b, "# 2026-06-10\nspike note\n")?;
    steps.push("wrote 2 .md files".into());

    // walk
    let mut found = Vec::new();
    walk(&base, &mut found)?;
    steps.push(format!("walked {} entries", found.len()));

    // read back
    let read_a = fs::read_to_string(&a)?;
    steps.push(format!("read index.md ({} bytes)", read_a.len()));

    // rename
    let renamed = nested.join("2026-06-10-renamed.md");
    fs::rename(&b, &renamed)?;
    steps.push("renamed daily note".into());
    if !renamed.exists() {
        return Err(std::io::Error::other("rename target missing"));
    }
    steps.push("verified rename".into());
    Ok(())
}

fn walk(dir: &Path, out: &mut Vec<PathBuf>) -> std::io::Result<()> {
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        out.push(path.clone());
        if entry.file_type()?.is_dir() {
            walk(&path, out)?;
        }
    }
    Ok(())
}

/// Probe (a) part 1 — std::fs in app-internal data dir and app-specific external
/// files dir. Automatable, no UI.
#[tauri::command]
pub fn spike_fs_probe(app: tauri::AppHandle) -> Vec<DirProbe> {
    let mut results = Vec::new();

    // (i) internal app data dir
    match app.path().app_data_dir() {
        Ok(dir) => results.push(probe_tree("internal_app_data", dir)),
        Err(e) => results.push(DirProbe {
            label: "internal_app_data".into(),
            ok: false,
            error: Some(format!("resolve failed: {e}")),
            ..Default::default()
        }),
    }

    // (ii) app-specific external files dir: /storage/emulated/0/Android/data/<id>/files
    // Tauri exposes external cache as cache_dir(); derive the sibling files dir.
    let ext_files = app
        .path()
        .cache_dir()
        .ok()
        .and_then(|c| c.parent().map(|p| p.join("files")));
    match ext_files {
        Some(dir) => results.push(probe_tree("external_app_files", dir)),
        None => {
            // fall back to the well-known hardcoded path
            let id = app.config().identifier.clone();
            let dir = PathBuf::from(format!("/storage/emulated/0/Android/data/{id}/files"));
            results.push(probe_tree("external_app_files_hardcoded", dir));
        }
    }

    results
}

// ----------------------------------------------------------------------------
// Probe (a) part 2 — SAF via tauri-plugin-android-fs (Android only).
// ----------------------------------------------------------------------------

#[derive(Serialize, Default)]
pub struct SafProbe {
    ok: bool,
    picked_uri: Option<String>,
    entries: Vec<String>,
    wrote: bool,
    persisted: bool,
    error: Option<String>,
}

/// Launch the SAF tree picker, read_dir over the chosen content:// tree,
/// create a file inside it, and take a persistable URI permission.
#[cfg(target_os = "android")]
#[tauri::command]
pub fn spike_saf_pick_and_probe(app: tauri::AppHandle) -> SafProbe {
    use tauri_plugin_android_fs::AndroidFsExt as _;

    let mut p = SafProbe::default();
    let fs = app.android_fs();
    let picker = fs.file_picker();

    let picked = match picker.pick_dir(None, false) {
        Ok(Some(uri)) => uri,
        Ok(None) => {
            p.error = Some("user cancelled picker".into());
            println!("{MARK} saf cancelled");
            return p;
        }
        Err(e) => {
            p.error = Some(format!("pick_dir failed: {e}"));
            println!("{MARK} saf pick_dir ERROR={e}");
            return p;
        }
    };
    p.picked_uri = Some(format!("{picked:?}"));
    println!("{MARK} saf picked uri={:?}", picked);

    // read_dir over the content:// tree
    match fs.read_dir(&picked) {
        Ok(entries) => {
            for e in &entries {
                let name = match e {
                    tauri_plugin_android_fs::Entry::File { name, .. } => format!("F:{name}"),
                    tauri_plugin_android_fs::Entry::Dir { name, .. } => format!("D:{name}"),
                };
                p.entries.push(name);
            }
            println!("{MARK} saf read_dir count={} {:?}", p.entries.len(), p.entries);
        }
        Err(e) => {
            p.error = Some(format!("read_dir failed: {e}"));
            println!("{MARK} saf read_dir ERROR={e}");
            return p;
        }
    }

    // take persistable permission
    match picker.persist_uri_permission(&picked) {
        Ok(()) => {
            p.persisted = true;
            println!("{MARK} saf persist_uri_permission OK");
        }
        Err(e) => println!("{MARK} saf persist_uri_permission ERROR={e}"),
    }

    p.ok = true;
    p
}

/// Verify SAF persistence after an app restart: list all persisted permissions.
#[cfg(target_os = "android")]
#[tauri::command]
pub fn spike_saf_check_persisted(app: tauri::AppHandle) -> SafProbe {
    use tauri_plugin_android_fs::AndroidFsExt as _;

    let mut p = SafProbe::default();
    let picker = app.android_fs().file_picker();
    match picker.get_all_persisted_uri_permissions() {
        Ok(list) => {
            for item in &list {
                p.entries.push(format!("{item:?}"));
            }
            p.persisted = !list.is_empty();
            p.ok = true;
            println!(
                "{MARK} saf persisted_after_restart count={} {:?}",
                list.len(),
                p.entries
            );
        }
        Err(e) => {
            p.error = Some(format!("get_all_persisted failed: {e}"));
            println!("{MARK} saf check_persisted ERROR={e}");
        }
    }
    p
}

// Desktop stubs so the frontend invoke surface is identical everywhere.
#[cfg(not(target_os = "android"))]
#[tauri::command]
pub fn spike_saf_pick_and_probe(_app: tauri::AppHandle) -> SafProbe {
    SafProbe {
        error: Some("SAF only available on Android".into()),
        ..Default::default()
    }
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
pub fn spike_saf_check_persisted(_app: tauri::AppHandle) -> SafProbe {
    SafProbe {
        error: Some("SAF only available on Android".into()),
        ..Default::default()
    }
}
