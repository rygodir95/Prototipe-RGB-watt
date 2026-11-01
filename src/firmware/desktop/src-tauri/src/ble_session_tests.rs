//! Deterministic tests of the SAME workers and ownership gate used by main.rs.
//! Only hardware read/connection/notification operations are replaced.
use std::{collections::VecDeque, pin::Pin, sync::{Arc, Mutex, atomic::{AtomicBool, AtomicUsize, Ordering}}, task::{Context, Poll}, time::Duration};
use futures_util::{Stream, stream};
use tokio::time::{Instant, advance};
use crate::ble_session::*;
const STATUS: &[u8] = br##"{"source":"power","state":"IDLE","connected":true,"data":false,"sim":false,"raw":0,"value":0,"zone":0,"color":"#112233"}"##;
#[derive(Clone)]
enum Plan { Ok, Error, Hang, Delay(u64) }
#[derive(Default)]
struct Probe { started: AtomicUsize, running: AtomicUsize, maximum: AtomicUsize, cancelled: AtomicUsize }
struct ReadGuard { probe: Arc<Probe>, finished: bool }
impl Drop for ReadGuard {
    fn drop(&mut self) {
        self.probe.running.fetch_sub(1, Ordering::SeqCst);
        if !self.finished { self.probe.cancelled.fetch_add(1, Ordering::SeqCst); }
    }
}
fn reader(plans: Vec<Plan>) -> (ReadStatus, Arc<Probe>) {
    let probe = Arc::new(Probe::default());
    let stats = probe.clone();
    let plans = Arc::new(Mutex::new(VecDeque::from(plans)));
    (Arc::new(move || {
        let probe = stats.clone(); let plans = plans.clone();
        Box::pin(async move {
            probe.started.fetch_add(1, Ordering::SeqCst);
            let n = probe.running.fetch_add(1, Ordering::SeqCst) + 1;
            probe.maximum.fetch_max(n, Ordering::SeqCst);
            let mut guard = ReadGuard { probe, finished: false };
            let plan = plans.lock().unwrap().pop_front().unwrap_or(Plan::Ok);
            let result = match plan {
                Plan::Ok => Ok(STATUS.to_vec()),
                Plan::Error => Err("GATT read failed".into()),
                Plan::Hang => std::future::pending().await,
                Plan::Delay(ms) => { tokio::time::sleep(Duration::from_millis(ms)).await; Ok(STATUS.to_vec()) }
            };
            guard.finished = true;
            result
        })
    }), probe)
}
struct PendingNotifications(Arc<AtomicUsize>);
impl Stream for PendingNotifications {
    type Item = Delivery;
    fn poll_next(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<Option<Delivery>> { Poll::Pending }
}
impl Drop for PendingNotifications { fn drop(&mut self) { self.0.fetch_sub(1, Ordering::SeqCst); } }
fn pending_notifications() -> (Notifications, Arc<AtomicUsize>) {
    let alive = Arc::new(AtomicUsize::new(1));
    (Box::pin(PendingNotifications(alive.clone())), alive)
}
fn physical(flag: Arc<AtomicBool>) -> CheckConnection {
    Arc::new(move || { let flag = flag.clone(); Box::pin(async move { Ok(flag.load(Ordering::SeqCst)) }) })
}
struct Harness { sessions: Sessions, events: Arc<Mutex<Vec<(u64, SessionEvent)>>>, connected: Arc<AtomicBool> }
impl Harness {
    fn new() -> Self {
        let events = Arc::new(Mutex::new(Vec::new())); let sink = events.clone(); let epoch = Instant::now();
        let sessions = Sessions::new(move |event| { sink.lock().unwrap().push((epoch.elapsed().as_millis() as u64, event)); });
        Self { sessions, events, connected: Arc::new(AtomicBool::new(true)) }
    }
    fn start(&self, notifications: Notifications, read: ReadStatus) -> Session {
        let scope = self.sessions.begin("desktop-test-client-1".into());
        scope.start(notifications, read, physical(self.connected.clone())).unwrap();
        scope
    }
    fn count(&self, event: Event) -> usize { self.events.lock().unwrap().iter().filter(|(_, e)| e.event == event).count() }
    fn statuses(&self) -> usize { self.events.lock().unwrap().iter().filter(|(_, e)| matches!(e.event, Event::Status(_))).count() }
}
async fn settle() { for _ in 0..10 { tokio::task::yield_now().await; } }
async fn elapse(ms: u64) { for _ in 0..ms / 100 { advance(Duration::from_millis(100)).await; settle().await; } }

#[tokio::test(start_paused = true)]
async fn notification_eof_keeps_physical_session_and_reads_alive() {
    let h = Harness::new(); let (read, probe) = reader(vec![]);
    let session = h.start(Box::pin(stream::empty()), read);
    settle().await; elapse(8000).await;
    assert!(session.current()); assert!(h.statuses() >= 4);
    assert_eq!(h.count(Event::Notifications(false)), 1);
    assert_eq!(h.count(Event::Connection(false)), 0);
    assert_eq!(probe.maximum.load(Ordering::SeqCst), 1);
    h.sessions.stop();
}
#[tokio::test(start_paused = true)]
async fn notification_silence_keeps_gatt_fallback_running() {
    let h = Harness::new(); let (read, _) = reader(vec![]); let (notifications, alive) = pending_notifications();
    let scope = h.start(notifications, read); settle().await; elapse(8000).await;
    assert!(scope.current()); assert!(h.statuses() >= 4); assert_eq!(alive.load(Ordering::SeqCst), 1);
    assert_eq!(h.count(Event::Notifications(false)), 0); h.sessions.stop(); settle().await;
    assert_eq!(alive.load(Ordering::SeqCst), 0);
}
#[tokio::test(start_paused = true)]
async fn physical_disconnect_cancels_pending_notifications_exactly_once() {
    let h = Harness::new(); let (read, probe) = reader(vec![Plan::Hang]); let (notifications, alive) = pending_notifications();
    let scope = h.start(notifications, read); settle().await;
    h.connected.store(false, Ordering::SeqCst); elapse(600).await;
    assert!(!scope.current()); assert_eq!(h.count(Event::Connection(false)), 1);
    assert_eq!(h.sessions.task_count(), 0); assert_eq!(probe.running.load(Ordering::SeqCst), 0);
    assert_eq!(alive.load(Ordering::SeqCst), 0); h.sessions.stop(); scope.stop();
    assert_eq!(h.count(Event::Connection(false)), 1);
}
#[tokio::test(start_paused = true)]
async fn status_read_timeout_then_successful_retry_does_not_overlap() {
    let h = Harness::new(); let (read, probe) = reader(vec![Plan::Hang, Plan::Ok]);
    let (notifications, _) = pending_notifications(); let scope = h.start(notifications, read);
    settle().await; elapse(4300).await;
    assert!(scope.current()); assert_eq!(probe.started.load(Ordering::SeqCst), 2);
    assert_eq!(probe.cancelled.load(Ordering::SeqCst), 1); assert_eq!(probe.maximum.load(Ordering::SeqCst), 1);
    assert_eq!(h.statuses(), 1); assert_eq!(h.count(Event::Connection(false)), 0); h.sessions.stop();
}
#[tokio::test(start_paused = true)]
async fn disconnect_during_inflight_read_cancels_it_and_rejects_results() {
    let h = Harness::new(); let (read, probe) = reader(vec![Plan::Delay(1000)]);
    let (notifications, alive) = pending_notifications(); let scope = h.start(notifications, read); settle().await;
    assert_eq!(probe.running.load(Ordering::SeqCst), 1); h.sessions.stop(); settle().await; elapse(8000).await;
    assert_eq!(h.statuses(), 0); assert_eq!(probe.started.load(Ordering::SeqCst), 1);
    assert_eq!(probe.running.load(Ordering::SeqCst), 0); assert_eq!(alive.load(Ordering::SeqCst), 0);
    assert!(!scope.emit(Event::Status("late".into())));
}
#[tokio::test(start_paused = true)]
async fn reconnect_cancels_old_notification_and_read_completions() {
    let h = Harness::new(); let (old_read, old_probe) = reader(vec![Plan::Delay(1000)]);
    let (send, receive) = tokio::sync::oneshot::channel();
    let notifications = stream::once(async move { receive.await.unwrap_or(Delivery::Result("late".into())) });
    let old = h.start(Box::pin(notifications), old_read); settle().await;
    let new = h.sessions.begin("desktop-2".into()); let boundary = h.events.lock().unwrap().len();
    let (read, _) = reader(vec![]); let (notifications, _) = pending_notifications();
    new.start(notifications, read, physical(h.connected.clone())).unwrap();
    let _ = send.send(Delivery::Status(STATUS.to_vec())); settle().await; elapse(1500).await;
    assert!(!old.current()); assert!(new.current()); assert_eq!(old_probe.cancelled.load(Ordering::SeqCst), 1);
    assert!(h.events.lock().unwrap()[boundary..].iter().all(|(_, event)| event.generation == new.generation));
    h.sessions.stop();
}
#[tokio::test(start_paused = true)]
async fn old_session_events_and_disconnect_are_rejected_after_new_begin() {
    let h = Harness::new(); let (read, _) = reader(vec![]); let (notifications, _) = pending_notifications();
    let old = h.start(notifications, read); settle().await;
    let new = h.sessions.begin("desktop-2".into());
    assert!(!old.emit(Event::Status("old status".into()))); assert!(!old.emit(Event::Result("old result".into())));
    old.stop(); assert!(new.current()); assert_ne!(new.generation, old.generation); h.sessions.stop();
}
#[tokio::test(start_paused = true)]
async fn notification_eof_during_startup_waits_for_activation() {
    let h = Harness::new(); let scope = h.sessions.begin("startup".into());
    assert!(!scope.emit(Event::Status("too early".into()))); assert!(h.events.lock().unwrap().is_empty());
    let (read, _) = reader(vec![]); scope.start(Box::pin(stream::empty()), read, physical(h.connected.clone())).unwrap();
    settle().await;
    let events = h.events.lock().unwrap();
    assert_eq!(events[0].1.event, Event::Connection(true));
    assert!(events.iter().any(|(_, event)| event.event == Event::Notifications(false)));
    assert!(events.iter().any(|(_, event)| matches!(event.event, Event::Status(_))));
    assert!(!events.iter().any(|(_, event)| event.event == Event::Connection(false)));
    drop(events); h.sessions.stop();
}
#[tokio::test(start_paused = true)]
async fn repeated_disconnect_reconnect_has_no_duplicate_workers() {
    let h = Harness::new();
    for index in 0..25 {
        let scope = h.sessions.begin(format!("cycle-{index}"));
        let (read, probe) = reader(vec![Plan::Hang]); let (notifications, alive) = pending_notifications();
        scope.start(notifications, read.clone(), physical(h.connected.clone())).unwrap();
        assert!(scope.start(Box::pin(stream::empty()), read, physical(h.connected.clone())).is_err());
        assert_eq!(h.sessions.task_count(), 3); settle().await;
        assert_eq!(probe.running.load(Ordering::SeqCst), 1);
        h.sessions.stop(); h.sessions.stop(); settle().await;
        assert_eq!(h.sessions.task_count(), 0); assert_eq!(probe.running.load(Ordering::SeqCst), 0);
        assert_eq!(alive.load(Ordering::SeqCst), 0); assert_eq!(probe.started.load(Ordering::SeqCst), 1);
    }
    assert_eq!(h.count(Event::Connection(false)), 25);
}
#[tokio::test(start_paused = true)]
async fn watchdog_trace_comes_from_actual_fallback_workers() {
    let h = Harness::new(); let (read, probe) = reader(vec![]);
    h.start(Box::pin(stream::empty()), read); settle().await; elapse(20_000).await;
    let events = h.events.lock().unwrap();
    let statuses: Vec<_> = events.iter().filter(|(_, event)| matches!(event.event, Event::Status(_))).collect();
    assert!(statuses.len() >= 8);
    assert!(statuses.windows(2).all(|pair| pair[1].0 - pair[0].0 < 6000));
    assert_eq!(probe.maximum.load(Ordering::SeqCst), 1);
    if let Ok(path) = std::env::var("BLE_LIFECYCLE_TRACE") {
        let trace: Vec<_> = events.iter().map(|(at, event)| {
            let (name, value) = match &event.event {
                Event::Connection(value) => ("ble-connection", serde_json::json!(value)),
                Event::Notifications(value) => ("ble-notifications", serde_json::json!(value)),
                Event::Status(value) => ("ble-status", serde_json::json!(value)),
                Event::Result(value) => ("ble-result", serde_json::json!(value)),
            };
            serde_json::json!({"at":at,"name":name,"payload":{"session":event.generation,"clientId":event.client_id,"value":value}})
        }).collect();
        std::fs::write(path, serde_json::to_vec_pretty(&trace).unwrap()).unwrap();
    }
    drop(events); h.sessions.stop();
}
#[tokio::test(start_paused = true)]
async fn failed_read_and_unknown_physical_state_are_not_disconnects() {
    let h = Harness::new(); let (read, _) = reader(vec![Plan::Error, Plan::Ok]);
    let scope = h.sessions.begin("unknown".into());
    scope.start(Box::pin(stream::empty()), read, Arc::new(|| Box::pin(async { Err("unknown".into()) }))).unwrap();
    settle().await; elapse(3000).await;
    assert!(scope.current()); assert!(h.statuses() >= 1); assert_eq!(h.count(Event::Connection(false)), 0); h.sessions.stop();
}
#[tokio::test(start_paused = true)]
async fn cancelling_startup_rejects_activation_and_pending_work() {
    let h = Harness::new(); let scope = h.sessions.begin("cancel-startup".into());
    let pending_scope = scope.clone();
    let pending = tokio::spawn(async move { pending_scope.run(std::future::pending::<Result<(), String>>()).await });
    settle().await; h.sessions.stop(); settle().await; assert!(pending.await.unwrap().is_err());
    let (read, _) = reader(vec![]);
    assert!(scope.start(Box::pin(stream::empty()), read, physical(h.connected.clone())).is_err());
    assert_eq!(h.sessions.task_count(), 0); assert_eq!(h.count(Event::Connection(false)), 1);
}