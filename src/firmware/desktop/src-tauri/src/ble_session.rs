//! Session ownership and delivery coordination, shared by production and tests.
//! No Tauri/btleplug dependencies: tests replace only the hardware operations.
use std::{future::Future, pin::Pin, sync::{Arc, Mutex}, time::Duration};
use futures_util::{Stream, StreamExt};
use tokio::{sync::watch, task::JoinHandle, time::{Instant, timeout}};
use crate::status_fallback::{status_payload, StatusLiveness, STATUS_FALLBACK_TICK_MS};

pub const STATUS_READ_TIMEOUT_MS: u64 = 1500;
pub type Operation<T> = Pin<Box<dyn Future<Output = Result<T, String>> + Send>>;
pub type ReadStatus = Arc<dyn Fn() -> Operation<Vec<u8>> + Send + Sync>;
pub type CheckConnection = Arc<dyn Fn() -> Operation<bool> + Send + Sync>;
pub type Notifications = Pin<Box<dyn Stream<Item = Delivery> + Send>>;

#[derive(Debug, Clone, PartialEq)]
pub enum Delivery { Status(Vec<u8>), Result(String) }
#[derive(Debug, Clone, PartialEq)]
pub enum Event { Connection(bool), Status(String), Result(String), Notifications(bool) }
#[derive(Debug, Clone)]
pub struct SessionEvent { pub generation: u64, pub client_id: String, pub event: Event }
type Sink = Arc<dyn Fn(SessionEvent) + Send + Sync>;

struct Entry {
    generation: u64,
    client_id: String,
    active: bool,
    notifications: bool,
    cancel: watch::Sender<bool>,
    tasks: Vec<JoinHandle<()>>,
}
struct Inner { next: u64, current: Option<Entry> }
#[derive(Clone)]
pub struct Sessions { inner: Arc<Mutex<Inner>>, sink: Sink }
#[derive(Clone)]
pub struct Session { owner: Sessions, pub generation: u64, cancel: watch::Receiver<bool> }

impl Sessions {
    pub fn new(sink: impl Fn(SessionEvent) + Send + Sync + 'static) -> Self {
        Self { inner: Arc::new(Mutex::new(Inner { next: 0, current: None })), sink: Arc::new(sink) }
    }
    pub fn begin(&self, client_id: String) -> Session {
        let mut inner = self.inner.lock().unwrap();
        self.retire(&mut inner);
        inner.next = inner.next.checked_add(1).expect("BLE generation exhausted");
        let generation = inner.next;
        let (cancel, receiver) = watch::channel(false);
        inner.current = Some(Entry { generation, client_id, active: false,
            notifications: true, cancel, tasks: Vec::new() });
        Session { owner: self.clone(), generation, cancel: receiver }
    }
    // The same lock orders event emission and invalidation. A check-then-emit
    // race cannot deliver an old event after a new generation is installed.
    fn send(&self, entry: &Entry, event: Event) {
        (self.sink)(SessionEvent { generation: entry.generation, client_id: entry.client_id.clone(), event });
    }
    fn retire(&self, inner: &mut Inner) {
        if let Some(entry) = inner.current.take() {
            entry.cancel.send_replace(true);
            for task in &entry.tasks { task.abort(); }
            self.send(&entry, Event::Connection(false));
        }
    }
    pub fn stop(&self) { self.retire(&mut self.inner.lock().unwrap()); }
    fn stop_generation(&self, generation: u64) {
        let mut inner = self.inner.lock().unwrap();
        if inner.current.as_ref().map(|entry| entry.generation) == Some(generation) {
            self.retire(&mut inner);
        }
    }
    #[cfg(test)]
    pub fn task_count(&self) -> usize {
        self.inner.lock().unwrap().current.as_ref().map_or(0, |entry| entry.tasks.len())
    }
}
impl Session {
    pub fn current(&self) -> bool {
        self.owner.inner.lock().unwrap().current.as_ref()
            .map_or(false, |entry| entry.generation == self.generation)
    }
    pub fn stop(&self) { self.owner.stop_generation(self.generation); }
    pub fn matches_client(&self, client_id: &str) -> bool {
        self.owner.inner.lock().unwrap().current.as_ref().map_or(false,
            |entry| entry.generation == self.generation && entry.active && entry.client_id == client_id)
    }
    pub fn emit(&self, event: Event) -> bool {
        let inner = self.owner.inner.lock().unwrap();
        match inner.current.as_ref() {
            Some(entry) if entry.generation == self.generation && entry.active => {
                self.owner.send(entry, event); true
            }
            _ => false,
        }
    }
    pub async fn run<T>(&self, work: impl Future<Output = Result<T, String>>) -> Result<T, String> {
        let mut cancel = self.cancel.clone();
        if *cancel.borrow() { return Err("BLE session was cancelled".into()); }
        tokio::select! {
            biased;
            _ = cancel.changed() => Err("BLE session was cancelled".into()),
            result = work => {
                if self.current() { result } else { Err("BLE session was cancelled".into()) }
            }
        }
    }
    fn notifications_ended(&self) {
        let mut inner = self.owner.inner.lock().unwrap();
        if let Some(entry) = inner.current.as_mut() {
            if entry.generation == self.generation && entry.active && entry.notifications {
                entry.notifications = false;
                self.owner.send(entry, Event::Notifications(false));
            }
        }
    }
    /// Install all workers before activation. They cannot poll hardware or emit
    /// until Connection(true) has been emitted under the generation lock.
    pub fn start(&self, mut notifications: Notifications, read: ReadStatus, connected: CheckConnection) -> Result<(), String> {
        let mut inner = self.owner.inner.lock().unwrap();
        let entry = inner.current.as_mut().filter(|entry| entry.generation == self.generation)
            .ok_or("BLE session was cancelled")?;
        if entry.active { return Err("BLE session is already active".into()); }
        let (start, gate) = watch::channel(false);
        let liveness = Arc::new(Mutex::new(StatusLiveness::default()));
        let epoch = Instant::now();
        let scope = self.clone();
        let live = liveness.clone();
        let mut notification_gate = gate.clone();
        let notification_task = tokio::spawn(async move {
            if notification_gate.changed().await.is_err() || !scope.current() { return; }
            while let Some(delivery) = notifications.next().await {
                match delivery {
                    Delivery::Status(value) => {
                        if let Some(text) = status_payload(&value) {
                            live.lock().unwrap().on_frame(epoch.elapsed().as_millis() as u64);
                            scope.emit(Event::Status(text));
                        }
                    }
                    Delivery::Result(text) => { scope.emit(Event::Result(text)); }
                }
            }
            // EOF says nothing about the Windows physical link. The fallback
            // and physical monitor remain owned by the active session.
            scope.notifications_ended();
        });
        let scope = self.clone();
        let mut fallback_gate = gate.clone();
        let fallback_task = tokio::spawn(async move {
            if fallback_gate.changed().await.is_err() || !scope.current() { return; }
            let mut initial = true;
            loop {
                if !scope.current() { return; }
                let now = epoch.elapsed().as_millis() as u64;
                let due = {
                    let mut state = liveness.lock().unwrap();
                    (initial || state.should_read(now)) && state.begin_read()
                };
                initial = false;
                if due {
                    // Exactly one read future, including the initial read. A
                    // timeout drops it before a subsequent retry is scheduled.
                    let payload = match timeout(Duration::from_millis(STATUS_READ_TIMEOUT_MS), read()).await {
                        Ok(Ok(value)) => status_payload(&value),
                        _ => None,
                    };
                    if !scope.current() { return; }
                    let ok = payload.is_some();
                    if let Some(text) = payload { scope.emit(Event::Status(text)); }
                    liveness.lock().unwrap().finish_read(epoch.elapsed().as_millis() as u64, ok);
                }
                tokio::time::sleep(Duration::from_millis(STATUS_FALLBACK_TICK_MS)).await;
            }
        });
        let scope = self.clone();
        let mut physical_gate = gate;
        let physical_task = tokio::spawn(async move {
            if physical_gate.changed().await.is_err() || !scope.current() { return; }
            loop {
                // Windows btleplug is_connected reads the cached value updated
                // by BluetoothLEDevice.ConnectionStatusChanged, not GATT data.
                // Errors/timeouts are unknown, NOT physical disconnections.
                if matches!(timeout(Duration::from_millis(500), connected()).await, Ok(Ok(false))) {
                    scope.stop();
                    return;
                }
                tokio::time::sleep(Duration::from_millis(500)).await;
            }
        });
        entry.tasks = vec![notification_task, fallback_task, physical_task];
        entry.active = true;
        self.owner.send(entry, Event::Connection(true));
        start.send_replace(true);
        Ok(())
    }
}