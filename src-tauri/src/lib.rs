pub mod core;
pub mod ipc;
pub mod plugins;

use std::path::PathBuf;
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Manager, State};

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

/// Resolve the device-local, app-private directory plugin grants persist under (review C2).
/// This is the OS app-config dir; it never lives inside the synced library.
fn grants_dir(app: &AppHandle) -> Result<PathBuf, PluginCmdError> {
    app.path().app_config_dir().map_err(|e| PluginCmdError {
        code: plugins::error::PluginErrorCode::HostInternal,
        message: format!("cannot resolve app config dir for plugin grants: {e}"),
    })
}

/// Ensure the plugin host is loaded for `root`, rebuilding if the root changed.
/// Returns a guard holding the loaded host.
fn ensure_host<'a>(
    host_state: &'a PluginHostState,
    root: &std::path::Path,
    grants_dir: &std::path::Path,
) -> Result<std::sync::MutexGuard<'a, Option<PluginHost>>, PluginCmdError> {
    let mut guard = host_state.0.lock().map_err(|_| PluginCmdError {
        code: plugins::error::PluginErrorCode::HostInternal,
        message: "plugin host lock poisoned".into(),
    })?;
    let needs_reload = guard.as_ref().map(|h| h.root() != root).unwrap_or(true);
    if needs_reload {
        *guard = Some(PluginHost::load(
            root.to_path_buf(),
            grants_dir.to_path_buf(),
        ));
    }
    Ok(guard)
}

/// `plugins_list()` — the manager's plugin inventory (id, name, version, status,
/// declared caps/perms, granted set, registrations, warnings).
#[tauri::command]
fn plugins_list(
    app: AppHandle,
    app_state: State<'_, AppState>,
    host_state: State<'_, PluginHostState>,
) -> Result<Vec<PluginInfo>, PluginCmdError> {
    let root = current_library_root(&app_state)?;
    let gdir = grants_dir(&app)?;
    let guard = ensure_host(&host_state, &root, &gdir)?;
    Ok(guard.as_ref().map(|h| h.list()).unwrap_or_default())
}

/// `plugins_reload()` — re-discover manifests and reconcile grants for the open library,
/// then return the refreshed inventory. Used by the manager's reload affordance (#26).
#[tauri::command]
fn plugins_reload(
    app: AppHandle,
    app_state: State<'_, AppState>,
    host_state: State<'_, PluginHostState>,
) -> Result<Vec<PluginInfo>, PluginCmdError> {
    let root = current_library_root(&app_state)?;
    let gdir = grants_dir(&app)?;
    let mut guard = host_state.0.lock().map_err(|_| PluginCmdError {
        code: plugins::error::PluginErrorCode::HostInternal,
        message: "plugin host lock poisoned".into(),
    })?;
    // Unconditional rebuild: re-scan the plugins dir and reconcile the device-local grants.
    *guard = Some(PluginHost::load(root, gdir));
    Ok(guard.as_ref().map(|h| h.list()).unwrap_or_default())
}

/// `plugins_set_grant(plugin, perm, granted)` — grant/revoke a permission and (re)activate
/// or suspend the plugin accordingly.
#[tauri::command]
fn plugins_set_grant(
    plugin: String,
    perm: String,
    granted: bool,
    app: AppHandle,
    app_state: State<'_, AppState>,
    host_state: State<'_, PluginHostState>,
) -> Result<(), PluginCmdError> {
    let root = current_library_root(&app_state)?;
    let gdir = grants_dir(&app)?;
    let mut guard = ensure_host(&host_state, &root, &gdir)?;
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
    app: AppHandle,
    app_state: State<'_, AppState>,
    host_state: State<'_, PluginHostState>,
) -> Result<String, PluginCmdError> {
    let root = current_library_root(&app_state)?;
    let gdir = grants_dir(&app)?;
    let guard = ensure_host(&host_state, &root, &gdir)?;
    let host = guard.as_ref().ok_or_else(|| PluginCmdError {
        code: plugins::error::PluginErrorCode::HostInternal,
        message: "plugin host missing after load".into(),
    })?;
    host.invoke_command(&plugin, &command_id, &args_json)
        .map_err(Into::into)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
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
            // Phase 5 — IPC second wave (issue #32)
            ipc::commands2::list_groups,
            ipc::commands2::attach_file,
            ipc::commands2::asset_url,
            ipc::commands2::asset_exists,
            ipc::commands2::remove_asset,
            ipc::commands2::saved_searches_get,
            ipc::commands2::saved_searches_set,
            ipc::commands2::set_person,
            ipc::commands2::delete_person,
            ipc::commands2::mentions_for,
            ipc::commands2::rename_tag,
            ipc::commands2::merge_tag,
            ipc::commands2::delete_tag,
            ipc::commands2::rename_person,
            ipc::commands2::merge_person,
            ipc::commands2::calendar_window,
            ipc::commands2::settings_get_user,
            ipc::commands2::settings_set_user,
            ipc::commands2::settings_get_library,
            ipc::commands2::settings_set_library,
            // Phase 6 — schemas (issue #28)
            ipc::commands2::effective_schema,
            // Phase 6 — group management + trash IPC (issue #28)
            ipc::groups::create_group,
            ipc::groups::rename_group,
            ipc::groups::move_group,
            ipc::groups::move_entry,
            ipc::groups::ipc_trash_entry,
            ipc::groups::ipc_trash_group,
            ipc::groups::trash_list,
            ipc::groups::trash_restore,
            ipc::groups::trash_purge,
            plugins_list,
            plugins_reload,
            plugins_set_grant,
            plugins_invoke_command,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|handle, event| {
        // On mobile, trigger a full rescan when the app returns to the
        // foreground (spec 0013, reconcile INV-7).  The flag is drained
        // by the reconciler worker on its next tick; we never touch the
        // Index from this callback so there is no lock contention.
        #[cfg(mobile)]
        if let tauri::RunEvent::WindowEvent {
            event: tauri::WindowEvent::Resumed,
            ..
        } = &event
        {
            on_mobile_foreground(handle);
        }
        let _ = (handle, event); // suppress unused warnings on desktop
    });
}

/// Signal a full rescan when the app comes back to the foreground (mobile only).
///
/// Clones the `Arc<AtomicBool>` out of `AppState` while holding the lock for the
/// minimum time, then sets the flag after the lock is released.
#[cfg(mobile)]
fn on_mobile_foreground(handle: &tauri::AppHandle) {
    use std::sync::atomic::Ordering;
    use std::sync::Arc;
    use tauri::Manager as _;

    let flag: Option<Arc<std::sync::atomic::AtomicBool>> = {
        let state = handle.state::<AppState>();
        state.0.lock().ok().and_then(|g| {
            g.as_ref()
                .map(|lib| Arc::clone(&lib._reconciler_handle.needs_full_rescan))
        })
    };
    if let Some(f) = flag {
        f.store(true, Ordering::SeqCst);
    }
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
