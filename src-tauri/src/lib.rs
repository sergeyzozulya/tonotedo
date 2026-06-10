pub mod core;
pub mod ipc;
pub mod plugins;

use std::path::PathBuf;
use std::sync::Mutex;

use serde::Serialize;
use tauri::State;

use ipc::AppState;
use plugins::error::PluginError;
use plugins::{PluginHost, PluginHostState, PluginInfo};

/// Returns the version of this crate as a string.
#[tauri::command]
fn core_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

// ── Plugin host commands (issue #25; serve the #26 manager UI) ──────────────────
//
// These delegate to `plugins::PluginHost`. The host is built lazily for the currently
// open library's root and cached in `PluginHostState`; it is rebuilt when the open
// library's root changes (e.g. the user opened a different library). The plugin host is
// kept in its own managed state, separate from `AppState`, so the IPC module (sibling
// scope) and the plugin module stay decoupled.

/// Error payload for plugin commands. Mirrors `PluginError` (and its TS facade type).
#[derive(Debug, Serialize)]
struct PluginCmdError {
    code: plugins::error::PluginErrorCode,
    message: String,
}

impl From<PluginError> for PluginCmdError {
    fn from(e: PluginError) -> Self {
        PluginCmdError {
            code: e.code,
            message: e.message,
        }
    }
}

/// Resolve the currently-open library root, or an error if none is open.
fn current_library_root(app_state: &AppState) -> Result<PathBuf, PluginCmdError> {
    let guard = app_state.0.lock().map_err(|_| PluginCmdError {
        code: plugins::error::PluginErrorCode::HostInternal,
        message: "app state lock poisoned".into(),
    })?;
    guard
        .as_ref()
        .map(|lib| lib.root.clone())
        .ok_or_else(|| PluginCmdError {
            code: plugins::error::PluginErrorCode::NotActive,
            message: "no library is open".into(),
        })
}

/// Ensure the plugin host is loaded for `root`, rebuilding if the root changed.
/// Returns a guard holding the loaded host.
fn ensure_host<'a>(
    host_state: &'a PluginHostState,
    root: &std::path::Path,
) -> Result<std::sync::MutexGuard<'a, Option<PluginHost>>, PluginCmdError> {
    let mut guard = host_state.0.lock().map_err(|_| PluginCmdError {
        code: plugins::error::PluginErrorCode::HostInternal,
        message: "plugin host lock poisoned".into(),
    })?;
    let needs_reload = guard.as_ref().map(|h| h.root() != root).unwrap_or(true);
    if needs_reload {
        *guard = Some(PluginHost::load(root.to_path_buf()));
    }
    Ok(guard)
}

/// `plugins_list()` — the manager's plugin inventory (id, name, version, status,
/// declared caps/perms, granted set, registrations, warnings).
#[tauri::command]
fn plugins_list(
    app_state: State<'_, AppState>,
    host_state: State<'_, PluginHostState>,
) -> Result<Vec<PluginInfo>, PluginCmdError> {
    let root = current_library_root(&app_state)?;
    let guard = ensure_host(&host_state, &root)?;
    Ok(guard.as_ref().map(|h| h.list()).unwrap_or_default())
}

/// `plugins_set_grant(plugin, perm, granted)` — grant/revoke a permission and (re)activate
/// or suspend the plugin accordingly.
#[tauri::command]
fn plugins_set_grant(
    plugin: String,
    perm: String,
    granted: bool,
    app_state: State<'_, AppState>,
    host_state: State<'_, PluginHostState>,
) -> Result<(), PluginCmdError> {
    let root = current_library_root(&app_state)?;
    let mut guard = ensure_host(&host_state, &root)?;
    let host = guard.as_mut().ok_or_else(|| PluginCmdError {
        code: plugins::error::PluginErrorCode::HostInternal,
        message: "plugin host missing after load".into(),
    })?;
    host.set_grant(&plugin, &perm, granted).map_err(Into::into)
}

/// `plugins_invoke_command(plugin, command_id, args_json)` — run a registered command.
/// Returns the command's JSON result string.
#[tauri::command]
fn plugins_invoke_command(
    plugin: String,
    command_id: String,
    args_json: String,
    app_state: State<'_, AppState>,
    host_state: State<'_, PluginHostState>,
) -> Result<String, PluginCmdError> {
    let root = current_library_root(&app_state)?;
    let guard = ensure_host(&host_state, &root)?;
    let host = guard.as_ref().ok_or_else(|| PluginCmdError {
        code: plugins::error::PluginErrorCode::HostInternal,
        message: "plugin host missing after load".into(),
    })?;
    host.invoke_command(&plugin, &command_id, &args_json)
        .map_err(Into::into)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppState(Mutex::new(None)))
        .manage(PluginHostState::empty())
        .invoke_handler(tauri::generate_handler![
            core_version,
            ipc::library_open,
            ipc::library_close,
            ipc::read_entry,
            ipc::write_entry,
            ipc::search,
            ipc::tag_index,
            ipc::people_index,
            ipc::entries_in_group,
            ipc::backlinks,
            ipc::entry_titles,
            plugins_list,
            plugins_set_grant,
            plugins_invoke_command,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn core_version_is_nonempty() {
        let v = core_version();
        assert!(!v.is_empty(), "core_version should not be empty");
    }
}
