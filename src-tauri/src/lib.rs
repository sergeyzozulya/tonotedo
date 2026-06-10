pub mod core;
pub mod spike;

use tauri::{Emitter, RunEvent, WindowEvent};

/// Returns the version of this crate as a string.
#[tauri::command]
fn core_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            core_version,
            spike::spike_fs_probe,
            spike::spike_log
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    // Probe (c): app lifecycle reaching Rust. On iOS, Tauri 2's RunEvent does
    // not expose a dedicated background/foreground variant, but WindowEvent
    // surfaces Focused / Suspended / Resumed, and RunEvent surfaces
    // Ready / Resumed / Exit. We log + emit a frontend event for each so the
    // spike can observe empirically which actually fire on the simulator.
    app.run(|handle, event| {
        let label = match &event {
            RunEvent::Ready => Some("run:ready".to_string()),
            RunEvent::Resumed => Some("run:resumed".to_string()),
            RunEvent::Exit => Some("run:exit".to_string()),
            RunEvent::ExitRequested { .. } => Some("run:exit-requested".to_string()),
            RunEvent::WindowEvent { event, .. } => match event {
                WindowEvent::Focused(true) => Some("window:focused".to_string()),
                WindowEvent::Focused(false) => Some("window:blurred".to_string()),
                // `Suspended`/`Resumed` are `#[cfg(mobile)]` only. On iOS they map
                // to applicationWillResignActive / applicationWillEnterForeground.
                #[cfg(mobile)]
                WindowEvent::Suspended => Some("window:suspended".to_string()),
                #[cfg(mobile)]
                WindowEvent::Resumed => Some("window:resumed".to_string()),
                _ => None,
            },
            _ => None,
        };
        if let Some(label) = label {
            println!("SPIKE_LIFECYCLE {label}");
            let _ = handle.emit("spike://lifecycle", label);
        }
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
