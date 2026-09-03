// ZoneGlow desktop shell (Tauri).
//
// The window hosts only the connection shell (../src/index.html): it probes
// the configured backend and loads the EXISTING ZoneGlow web UI from it
// (PC simulator today, the real ESP32 controller in production). No custom
// Tauri commands are needed, and the app never becomes the controller - all
// BLE, zone and LED logic stays on the backend device.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running ZoneGlow");
}