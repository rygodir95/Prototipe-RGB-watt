// ZoneGlow desktop shell (Tauri). The Hub remains the controller.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
use std::sync::{Arc, Mutex};
use std::time::Duration;
use btleplug::api::{Central, Manager as _, Peripheral as _, ScanFilter, WriteType};
use btleplug::platform::{Manager, Peripheral};
use futures_util::StreamExt;
use serde::Serialize;
use tauri::{Emitter, Manager as _, State};
use uuid::Uuid;
mod status_fallback;
mod ble_session;
#[cfg(test)]
mod ble_session_tests;
use ble_session::{Delivery, Event, Session, Sessions};

const SERVICE_UUID: &str = "5ca90000-6d75-4ca5-b4d6-3f9e6c5b0001";
const STATUS_UUID: &str = "5ca90001-6d75-4ca5-b4d6-3f9e6c5b0001";
const COMMAND_UUID: &str = "5ca90002-6d75-4ca5-b4d6-3f9e6c5b0001";
const RESULT_UUID: &str = "5ca90003-6d75-4ca5-b4d6-3f9e6c5b0001";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BleDevice { address: String, name: String, rssi: Option<i16> }
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeEvent { session: u64, client_id: String, value: serde_json::Value }
struct BleSession {
    scope: Session,
    peripheral: Peripheral,
    command: Option<btleplug::api::Characteristic>,
    result: Option<btleplug::api::Characteristic>,
}
struct BleState {
    operation: tokio::sync::Mutex<()>,
    link: Mutex<Option<BleSession>>,
    sessions: Sessions,
}
impl BleState {
    fn new(app: tauri::AppHandle) -> Self {
        let sessions = Sessions::new(move |message| {
            let (name, value) = match message.event {
                Event::Connection(value) => ("ble-connection", serde_json::json!(value)),
                Event::Status(value) => ("ble-status", serde_json::json!(value)),
                Event::Result(value) => ("ble-result", serde_json::json!(value)),
                Event::Notifications(value) => {
                    eprintln!("BLE session {}: notifications unavailable; physical monitoring and STATUS reads continue", message.generation);
                    ("ble-notifications", serde_json::json!(value))
                }
            };
            let _ = app.emit(name, NativeEvent { session: message.generation, client_id: message.client_id, value });
        });
        Self { operation: tokio::sync::Mutex::new(()), link: Mutex::new(None), sessions }
    }
    async fn close_link(&self) -> Result<(), String> {
        let old = self.link.lock().map_err(|_| "BLE state lock failed")?.take();
        if let Some(link) = old {
            link.scope.stop();
            link.peripheral.disconnect().await.map_err(|error| error.to_string())?;
        }
        Ok(())
    }
}
fn parse_uuid(value: &str) -> Result<Uuid, String> { Uuid::parse_str(value).map_err(|error| error.to_string()) }

#[tauri::command]
async fn ble_scan() -> Result<Vec<BleDevice>, String> {
    let service = parse_uuid(SERVICE_UUID)?;
    let manager = Manager::new().await.map_err(|error| error.to_string())?;
    let adapter = manager.adapters().await.map_err(|error| error.to_string())?
        .into_iter().next().ok_or("No Bluetooth LE adapter is available")?;
    adapter.start_scan(ScanFilter::default()).await.map_err(|error| error.to_string())?;
    tokio::time::sleep(Duration::from_secs(6)).await;
    let peripherals = adapter.peripherals().await.map_err(|error| error.to_string())?;
    let mut devices = Vec::new();
    for peripheral in peripherals {
        let Some(properties) = peripheral.properties().await.map_err(|error| error.to_string())? else { continue; };
        if properties.services.iter().any(|uuid| *uuid == service) {
            devices.push(BleDevice { address: properties.address.to_string(),
                name: properties.local_name.unwrap_or_else(|| "Training Hub".to_string()), rssi: properties.rssi });
        }
    }
    adapter.stop_scan().await.map_err(|error| error.to_string())?;
    Ok(devices)
}
async fn find_peripheral(address: String) -> Result<Peripheral, String> {
    let manager = Manager::new().await.map_err(|error| error.to_string())?;
    let adapter = manager.adapters().await.map_err(|error| error.to_string())?
        .into_iter().next().ok_or("No Bluetooth LE adapter is available")?;
    adapter.start_scan(ScanFilter::default()).await.map_err(|error| error.to_string())?;
    tokio::time::sleep(Duration::from_secs(2)).await;
    let mut peripheral = None;
    for candidate in adapter.peripherals().await.map_err(|error| error.to_string())? {
        let is_match = candidate.properties().await.map_err(|error| error.to_string())?
            .map(|properties| properties.address.to_string() == address).unwrap_or(false);
        if is_match { peripheral = Some(candidate); break; }
    }
    let _ = adapter.stop_scan().await;
    peripheral.ok_or("Hub was not found; search again".into())
}
#[tauri::command]
async fn ble_connect(address: String, client_id: String, state: State<'_, BleState>) -> Result<u64, String> {
    // Reject concurrent attempts instead of queueing a stale connect behind a
    // newer disconnect. Disconnect invalidates the generation before waiting.
    let _operation = state.operation.try_lock().map_err(|_| "A BLE connection operation is already running")?;
    let scope = state.sessions.begin(client_id);
    let outcome = async {
        state.close_link().await?;
        let peripheral = scope.run(find_peripheral(address)).await?;
        *state.link.lock().map_err(|_| "BLE state lock failed")? = Some(BleSession {
            scope: scope.clone(), peripheral: peripheral.clone(), command: None, result: None,
        });
        let status_uuid = parse_uuid(STATUS_UUID)?;
        let result_uuid = parse_uuid(RESULT_UUID)?;
        let (command, status, result, notifications) = scope.run(async {
            peripheral.connect().await.map_err(|error| error.to_string())?;
            peripheral.discover_services().await.map_err(|error| error.to_string())?;
            if !peripheral.services().iter().any(|service| service.uuid.to_string() == SERVICE_UUID) {
                return Err("Training Hub BLE service was not found".into());
            }
            let characteristics = peripheral.characteristics();
            let command_uuid = parse_uuid(COMMAND_UUID)?;
            let command = characteristics.iter().find(|c| c.uuid == command_uuid).cloned()
                .ok_or("Training Hub command characteristic was not found")?;
            let status = characteristics.iter().find(|c| c.uuid == status_uuid).cloned()
                .ok_or("Training Hub status characteristic was not found")?;
            let result = characteristics.iter().find(|c| c.uuid == result_uuid).cloned()
                .ok_or("Training Hub result characteristic was not found")?;
            let notifications = peripheral.notifications().await.map_err(|error| error.to_string())?;
            peripheral.subscribe(&status).await.map_err(|error| error.to_string())?;
            peripheral.subscribe(&result).await.map_err(|error| error.to_string())?;
            Ok((command, status, result, notifications))
        }).await?;
        {
            let mut link = state.link.lock().map_err(|_| "BLE state lock failed")?;
            let link = link.as_mut().ok_or("BLE session was cancelled")?;
            link.command = Some(command);
            link.result = Some(result);
        }
        let notifications = notifications.filter_map(move |notification| {
            let delivery = if notification.uuid == status_uuid { Some(Delivery::Status(notification.value)) }
                else if notification.uuid == result_uuid { Some(Delivery::Result(String::from_utf8_lossy(&notification.value).to_string())) }
                else { None };
            std::future::ready(delivery)
        });
        let reader = peripheral.clone();
        let physical = peripheral.clone();
        scope.start(Box::pin(notifications), Arc::new(move || {
            let peripheral = reader.clone(); let status = status.clone();
            Box::pin(async move { peripheral.read(&status).await.map_err(|error| error.to_string()) })
        }), Arc::new(move || {
            let peripheral = physical.clone();
            Box::pin(async move { peripheral.is_connected().await.map_err(|error| error.to_string()) })
        }))?;
        if !scope.current() { return Err("BLE session was cancelled".into()); }
        Ok(scope.generation)
    }.await;
    if outcome.is_err() { scope.stop(); let _ = state.close_link().await; }
    outcome
}

#[tauri::command]
async fn ble_command(message: String, client_id: String, state: State<'_, BleState>) -> Result<String, String> {
    if message.is_empty() || message.len() > 180 { return Err("Invalid Hub command".to_string()); }
    let request_id = serde_json::from_str::<serde_json::Value>(&message)
        .ok().and_then(|json| json.get("id")?.as_u64())
        .filter(|id| *id > 0).ok_or("Invalid Hub command ID")?;
    let (scope, peripheral, command, result) = {
        let guard = state.link.lock().map_err(|_| "BLE state lock failed")?;
        let session = guard.as_ref().ok_or("Hub is not connected")?;
        (session.scope.clone(), session.peripheral.clone(),
            session.command.clone().ok_or("Hub is not ready")?, session.result.clone().ok_or("Hub is not ready")?)
    };
    if !scope.matches_client(&client_id) { return Err("BLE session was cancelled".into()); }
    scope.run(async {
        peripheral.write(&command, message.as_bytes(), WriteType::WithResponse).await
            .map_err(|error| error.to_string())?;
        // Preserve the matching-ID GATT result path and Stage B serialization.
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        let mut last_result_len = 0;
        let mut last_result_id = None;
        let mut last_result_prefix = String::new();
        loop {
            let bytes = peripheral.read(&result).await.map_err(|error| error.to_string())?;
            last_result_len = bytes.len();
            last_result_prefix = bytes.iter().take(12).map(|byte| format!("{byte:02x}"))
                .collect::<Vec<_>>().join("");
            if let Ok(json) = serde_json::from_slice::<serde_json::Value>(&bytes) {
                last_result_id = json.get("id").and_then(|value| value.as_u64());
                if last_result_id == Some(request_id) {
                    return String::from_utf8(bytes).map_err(|error| error.to_string());
                }
            }
            if tokio::time::Instant::now() >= deadline {
                return Err(format!("Hub did not return result for command {request_id} (last GATT read: {last_result_len} bytes, prefix: {last_result_prefix}, result ID: {})",
                    last_result_id.map_or("none".to_string(), |id| id.to_string())));
            }
            tokio::time::sleep(Duration::from_millis(75)).await;
        }
    }).await
}
#[tauri::command]
async fn ble_disconnect(state: State<'_, BleState>) -> Result<(), String> {
    state.sessions.stop(); // immediate cancellation, even during connect/read
    let _operation = state.operation.lock().await;
    state.close_link().await
}
fn main() {
    tauri::Builder::default()
        .setup(|app| { app.manage(BleState::new(app.handle().clone())); Ok(()) })
        .invoke_handler(tauri::generate_handler![ble_scan, ble_connect, ble_command, ble_disconnect])
        .run(tauri::generate_context!())
        .expect("error while running ZoneGlow");
}