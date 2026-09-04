// ZoneGlow desktop shell (Tauri).
//
// The window loads the ZoneGlow web UI from a localhost-only shell server
// started inside this process (server.rs) - the UI is bundled locally and
// rendered directly as the window content (no iframe), so it opens normally
// even when the backend is offline. Only /api/* REST calls and the /ws
// telemetry WebSocket are forwarded to the configured backend
// (BackendTransport in transport.rs); when it is offline the UI shows
// Disconnected (shell_init.js) and everything reconnects automatically once
// it returns. The app never becomes the controller - all BLE, zone and LED
// logic stays on the backend device.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod server;
mod transport;

use std::sync::Arc;
use tauri::Manager;

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let resource_dir = app.path().resource_dir().ok();
            // A missing bundled UI is survivable: the shell server serves a
            // clear notice page instead of the app silently disappearing.
            let web_root = server::resolve_web_root(resource_dir);
            if web_root.is_none() {
                eprintln!(
                    "[shell] WARNING: bundled ZoneGlow web UI not found. Install via \
                     ZoneGlow_x64-setup.exe (it places the bundled `web` folder next to \
                     ZoneGlow.exe), or run `npm run sync:web` before `npm run dev`."
                );
            }
            let backend: Arc<dyn transport::BackendTransport> =
                Arc::new(transport::SimulatorTransport::from_env_or_default());
            let port = server::spawn(web_root, Arc::clone(&backend))?;

            let url = tauri::Url::parse(&format!("http://127.0.0.1:{}/", port))
                .expect("valid shell server URL");
            tauri::WebviewWindowBuilder::new(
                app,
                "main",
                tauri::WebviewUrl::External(url),
            )
            .title("ZoneGlow — Training Zone Lighting")
            .inner_size(1180.0, 860.0)
            .min_inner_size(520.0, 640.0)
            .resizable(true)
            .center()
            // Injected before the ZoneGlow page scripts (see shell_init.js):
            // keeps the UI's status pill accurate while the backend is offline;
            // the UI's own WebSocket retry loop takes over once it returns.
            .initialization_script(include_str!("shell_init.js"))
            .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running ZoneGlow");
}