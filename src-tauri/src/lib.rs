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
