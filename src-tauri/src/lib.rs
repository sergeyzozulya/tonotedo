pub mod core;
pub mod ipc;

use ipc::AppState;

/// Returns the version of this crate as a string.
#[tauri::command]
fn core_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .manage(AppState(std::sync::Mutex::new(None)))
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
