pub mod core;
pub mod spike;

/// Returns the version of this crate as a string.
#[tauri::command]
fn core_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[allow(unused_mut)]
    let mut builder = tauri::Builder::default();

    // Probe (a) part 2 — register the community SAF plugin (Android only).
    #[cfg(target_os = "android")]
    {
        builder = builder.plugin(tauri_plugin_android_fs::init());
    }

    builder
        .invoke_handler(tauri::generate_handler![
            core_version,
            spike::spike_fs_probe,
            spike::spike_saf_pick_and_probe,
            spike::spike_saf_check_persisted,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        // Probe (c) — lifecycle events surfaced to Rust via the RunEvent loop.
        .run(|app, event| match event {
            tauri::RunEvent::Ready => {
                println!("SPIKE_LIFECYCLE RunEvent::Ready");
                let _ = tauri::Emitter::emit(app, "spike-lifecycle", "ready");
            }
            tauri::RunEvent::Resumed => {
                // Desktop event-loop resume; does NOT fire on Android.
                println!("SPIKE_LIFECYCLE RunEvent::Resumed");
                let _ = tauri::Emitter::emit(app, "spike-lifecycle", "resumed");
            }
            // Mobile pause/resume arrives as WindowEvent::Suspended/Resumed,
            // gated #[cfg(mobile)] in tauri. This is the reliable Android path.
            #[cfg(mobile)]
            tauri::RunEvent::WindowEvent {
                event: tauri::WindowEvent::Suspended,
                ..
            } => {
                println!("SPIKE_LIFECYCLE WindowEvent::Suspended");
                let _ = tauri::Emitter::emit(app, "spike-lifecycle", "suspended");
            }
            #[cfg(mobile)]
            tauri::RunEvent::WindowEvent {
                event: tauri::WindowEvent::Resumed,
                ..
            } => {
                println!("SPIKE_LIFECYCLE WindowEvent::Resumed");
                let _ = tauri::Emitter::emit(app, "spike-lifecycle", "resumed");
            }
            tauri::RunEvent::Exit => {
                println!("SPIKE_LIFECYCLE RunEvent::Exit");
            }
            tauri::RunEvent::ExitRequested { .. } => {
                println!("SPIKE_LIFECYCLE RunEvent::ExitRequested");
            }
            _ => {}
        });
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
