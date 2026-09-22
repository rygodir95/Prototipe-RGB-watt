// ZoneGlow desktop shell (Tauri).
//
// The window hosts only the connection shell (../src/index.html): it probes
// the configured backend and loads the EXISTING ZoneGlow web UI from it
// (PC simulator today, the real ESP32 controller in production). No custom
// Tauri commands are needed, and the app never becomes the controller - all
// BLE, zone and LED logic stays on the backend device.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::Mutex;
use std::time::Duration;

use btleplug::api::{Central, Manager as _, Peripheral as _, ScanFilter, WriteType};
use btleplug::platform::{Manager, Peripheral};
use futures_util::StreamExt;
use serde::Serialize;
use tauri::{Emitter, State};
use uuid::Uuid;

const SERVICE_UUID: &str = "5ca90000-6d75-4ca5-b4d6-3f9e6c5b0001";
const STATUS_UUID: &str = "5ca90001-6d75-4ca5-b4d6-3f9e6c5b0001";
const COMMAND_UUID: &str = "5ca90002-6d75-4ca5-b4d6-3f9e6c5b0001";
const RESULT_UUID: &str = "5ca90003-6d75-4ca5-b4d6-3f9e6c5b0001";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BleDevice {
    address: String,
    name: String,
    rssi: Option<i16>,
}

struct BleSession {
    peripheral: Peripheral,
    command: btleplug::api::Characteristic,
}

struct BleState(Mutex<Option<BleSession>>);

fn parse_uuid(value: &str) -> Result<Uuid, String> {
    Uuid::parse_str(value).map_err(|error| error.to_string())
}

#[tauri::command]
async fn ble_scan() -> Result<Vec<BleDevice>, String> {
    let service = parse_uuid(SERVICE_UUID)?;
    let manager = Manager::new().await.map_err(|error| error.to_string())?;
    let adapter = manager.adapters().await.map_err(|error| error.to_string())?
        .into_iter().next().ok_or("No Bluetooth LE adapter is available")?;
    adapter.start_scan(ScanFilter::default()).await
        .map_err(|error| error.to_string())?;
    tokio::time::sleep(Duration::from_secs(6)).await;
    let peripherals = adapter.peripherals().await.map_err(|error| error.to_string())?;
    let mut devices = Vec::new();
    for peripheral in peripherals {
        let Some(properties) = peripheral.properties().await.map_err(|error| error.to_string())? else { continue; };
        let advertises_hub = properties.services.iter().any(|uuid| *uuid == service);
        if advertises_hub {
            devices.push(BleDevice {
                address: properties.address.to_string(),
                name: properties.local_name.unwrap_or_else(|| "Training Hub".to_string()),
                rssi: properties.rssi,
            });
        }
    }
    adapter.stop_scan().await.map_err(|error| error.to_string())?;
    Ok(devices)
}

#[tauri::command]
async fn ble_connect(address: String, app: tauri::AppHandle, state: State<'_, BleState>) -> Result<(), String> {
    let service_uuid = parse_uuid(SERVICE_UUID)?;
    let status_uuid = parse_uuid(STATUS_UUID)?;
    let command_uuid = parse_uuid(COMMAND_UUID)?;
    let result_uuid = parse_uuid(RESULT_UUID)?;
    let manager = Manager::new().await.map_err(|error| error.to_string())?;
    let adapter = manager.adapters().await.map_err(|error| error.to_string())?
        .into_iter().next().ok_or("No Bluetooth LE adapter is available")?;
    adapter.start_scan(ScanFilter::default()).await.map_err(|error| error.to_string())?;
    tokio::time::sleep(Duration::from_secs(2)).await;
    let mut peripheral = None;
    for candidate in adapter.peripherals().await.map_err(|error| error.to_string())? {
        // The scan result address is the stable identifier presented by the
        // desktop UI, so reconnecting does not depend on a device name.
        let is_match = candidate.properties().await.map_err(|error| error.to_string())?
            .map(|properties| properties.address.to_string() == address)
            .unwrap_or(false);
        if is_match { peripheral = Some(candidate); break; }
    }
    let peripheral = peripheral.ok_or("Hub was not found; search again")?;
    let _ = adapter.stop_scan().await;
    peripheral.connect().await.map_err(|error| error.to_string())?;
    peripheral.discover_services().await.map_err(|error| error.to_string())?;
    if !peripheral.services().iter().any(|service| service.uuid == service_uuid) {
        let _ = peripheral.disconnect().await;
        return Err("Training Hub BLE service was not found".to_string());
    }
    let characteristics = peripheral.characteristics();
    let command = characteristics.iter().find(|characteristic| characteristic.uuid == command_uuid)
        .cloned().ok_or("Training Hub command characteristic was not found")?;
    let status = characteristics.iter().find(|characteristic| characteristic.uuid == status_uuid)
        .cloned().ok_or("Training Hub status characteristic was not found")?;
    let result = characteristics.iter().find(|characteristic| characteristic.uuid == result_uuid)
        .cloned().ok_or("Training Hub result characteristic was not found")?;
    peripheral.subscribe(&status).await.map_err(|error| error.to_string())?;
    peripheral.subscribe(&result).await.map_err(|error| error.to_string())?;
    let mut notifications = peripheral.notifications().await.map_err(|error| error.to_string())?;
    let event_app = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(notification) = notifications.next().await {
            let payload = String::from_utf8_lossy(&notification.value).to_string();
            let event = if notification.uuid == status_uuid { "ble-status" } else if notification.uuid == result_uuid { "ble-result" } else { continue };
            let _ = event_app.emit(event, payload);
        }
        let _ = event_app.emit("ble-connection", false);
    });
    *state.0.lock().map_err(|_| "BLE state lock failed")? = Some(BleSession { peripheral, command });
    app.emit("ble-connection", true).map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
async fn ble_command(message: String, state: State<'_, BleState>) -> Result<(), String> {
    if message.is_empty() || message.len() > 180 { return Err("Invalid Hub command".to_string()); }
    let (peripheral, command) = {
        let guard = state.0.lock().map_err(|_| "BLE state lock failed")?;
        let session = guard.as_ref().ok_or("Hub is not connected")?;
        (session.peripheral.clone(), session.command.clone())
    };
    peripheral.write(&command, message.as_bytes(), WriteType::WithResponse).await
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn ble_disconnect(state: State<'_, BleState>) -> Result<(), String> {
    let session = state.0.lock().map_err(|_| "BLE state lock failed")?.take();
    if let Some(session) = session { session.peripheral.disconnect().await.map_err(|error| error.to_string())?; }
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .manage(BleState(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![ble_scan, ble_connect, ble_command, ble_disconnect])
        .run(tauri::generate_context!())
        .expect("error while running ZoneGlow");
}

