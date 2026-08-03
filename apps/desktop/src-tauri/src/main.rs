// Lia v3 desktop shell — Tauri 2.0 entrypoint.
//
// M0 scope: launch the webview, log a friendly startup message.
// The backend sidecar wiring (spawn Hono + readiness probe + lifecycle)
// lands in M1 — see docs/ARCHITECTURE.md § 13.3 and § 3.2.3.
//
// In M0 dev mode, the user runs `npm run dev:backend` separately; Tauri
// only manages the webview. In M1 we'll spawn the backend via
// `tauri-plugin-shell` sidecar (see ROADMAP).

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::Manager;

fn main() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            log::info!("Lia v3 desktop shell starting (M0)");
            let window = app.get_primary_window().expect("primary window");
            log::info!("window opened: {}", window.title().unwrap_or_default());
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                log::info!(
                    "window close requested: {}",
                    window.title().unwrap_or_default()
                );
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");

    // Suppress unused-import warning in release builds.
    let _ = Manager::app_handle;
}
