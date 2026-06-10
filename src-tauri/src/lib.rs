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
    tauri::Builder::default()
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
