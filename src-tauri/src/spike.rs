//! Phase 0 iOS spike probes (GitHub issue #1). Not production code.
//! Probe (b): filesystem access from Rust via std::fs in the app sandbox.
//! Probe (c): app lifecycle transitions reaching Rust (see run() in lib.rs).

use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::Manager;

#[derive(Serialize, Default)]
pub struct FsProbeReport {
    /// Absolute path of the Documents dir we operated in.
    documents_dir: String,
    /// Every entry discovered by the recursive std::fs::read_dir walk.
    walked_paths: Vec<String>,
    /// Bytes written then read back for the round-trip file.
    bytes_written: usize,
    bytes_read: usize,
    round_trip_ok: bool,
    /// Rename probe: old path gone, new path present.
    rename_ok: bool,
    /// Whether a read OUTSIDE the sandbox container was rejected (probe b-extended).
    outside_read_blocked: Option<bool>,
    outside_read_detail: String,
    errors: Vec<String>,
}

fn walk(dir: &Path, out: &mut Vec<String>, errors: &mut Vec<String>) {
    match fs::read_dir(dir) {
        Ok(entries) => {
            for entry in entries.flatten() {
                let path = entry.path();
                out.push(path.to_string_lossy().into_owned());
                if path.is_dir() {
                    walk(&path, out, errors);
                }
            }
        }
        Err(e) => errors.push(format!("read_dir {}: {e}", dir.display())),
    }
}

/// Frontend probes (editor, lifecycle) call this so their results print to the
/// process stdout, which iOS routes to the unified log (WKWebView console.log
/// does not). Spike-only evidence channel.
#[tauri::command]
pub fn spike_log(msg: String) {
    println!("SPIKE_FRONTEND {msg}");
}

#[tauri::command]
pub fn spike_fs_probe(app: tauri::AppHandle) -> FsProbeReport {
    let mut report = FsProbeReport::default();

    let docs: PathBuf = match app.path().document_dir() {
        Ok(p) => p,
        Err(e) => {
            report.errors.push(format!("document_dir(): {e}"));
            return report;
        }
    };
    report.documents_dir = docs.to_string_lossy().into_owned();

    // 1. Build a nested folder tree with several .md files.
    let root = docs.join("spike_vault");
    let _ = fs::remove_dir_all(&root); // clean slate across launches
    let nested = root.join("notes").join("daily");
    if let Err(e) = fs::create_dir_all(&nested) {
        report.errors.push(format!("create_dir_all: {e}"));
        return report;
    }
    for (rel, body) in [
        ("notes/index.md", "# Index\n"),
        ("notes/daily/2026-06-10.md", "# Today\n- spike\n"),
        ("notes/daily/2026-06-09.md", "# Yesterday\n"),
        ("README.md", "vault root\n"),
    ] {
        if let Err(e) = fs::write(root.join(rel), body) {
            report.errors.push(format!("write {rel}: {e}"));
        }
    }

    // 2. Recursive walk with std::fs.
    walk(&root, &mut report.walked_paths, &mut report.errors);
    report.walked_paths.sort();

    // 3. Read / write / round-trip one file.
    let rt = root.join("notes/daily/2026-06-10.md");
    let payload = "# Today\n- spike\n- round trip \u{1F331}\n";
    match fs::write(&rt, payload) {
        Ok(()) => report.bytes_written = payload.len(),
        Err(e) => report.errors.push(format!("write round-trip: {e}")),
    }
    match fs::read_to_string(&rt) {
        Ok(s) => {
            report.bytes_read = s.len();
            report.round_trip_ok = s == payload;
        }
        Err(e) => report.errors.push(format!("read round-trip: {e}")),
    }

    // 4. Rename one file.
    let old = root.join("notes/index.md");
    let new = root.join("notes/index-renamed.md");
    match fs::rename(&old, &new) {
        Ok(()) => report.rename_ok = !old.exists() && new.exists(),
        Err(e) => report.errors.push(format!("rename: {e}")),
    }

    // 5. Probe (b-extended): can we read OUTSIDE the sandbox? Expected: no.
    // Try another app's container-ish absolute path and the simulator's /etc/hosts.
    let outside_candidates = ["/etc/master.passwd", "/var/db/.AppleSetupDone"];
    let mut blocked_all = true;
    let mut detail = String::new();
    for c in outside_candidates {
        match fs::read(c) {
            Ok(b) => {
                blocked_all = false;
                detail.push_str(&format!("{c}: READABLE ({} bytes); ", b.len()));
            }
            Err(e) => detail.push_str(&format!("{c}: blocked ({}); ", e.kind())),
        }
    }
    report.outside_read_blocked = Some(blocked_all);
    report.outside_read_detail = detail;

    report
}
