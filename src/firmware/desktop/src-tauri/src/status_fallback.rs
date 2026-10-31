// STATUS liveness fallback for the Hub BLE control link.
//
// The Hub notifies STATUS on change plus every 2 s (HubBleStatusHeartbeat.h),
// but GATT notification delivery is not guaranteed on every Windows stack - the
// same build already resolves command results through a GATT read for exactly
// that reason (see ble_command). If liveness depended on notifications alone, a
// silently dropped notification would be indistinguishable from a dead Hub and
// the UI's 6 s silence watchdog would report "Connection to Hub lost".
//
// This module is the pure rule behind the periodic fallback read in main.rs: no
// async, no btleplug, no clock, so the cadence is host testable.

/// STATUS may stay silent this long before the fallback reads it. Above the 2 s
/// Hub heartbeat (a healthy link is never read needlessly) and far below the
/// 6000 ms UI silence window.
pub const STATUS_FALLBACK_AFTER_MS: u64 = 2500;
/// How often main.rs evaluates the rule.
pub const STATUS_FALLBACK_TICK_MS: u64 = 500;
/// Delay before retrying a failed read, so a bad characteristic is not hammered.
pub const STATUS_FALLBACK_RETRY_MS: u64 = 2500;

/// Liveness clock for the STATUS characteristic.
#[derive(Debug, Default)]
pub struct StatusLiveness {
    last_frame_ms: u64,
    retry_after_ms: u64,
    in_flight: bool,
}

impl StatusLiveness {
    /// A valid STATUS frame reached the client (notification or fallback read).
    pub fn on_frame(&mut self, now_ms: u64) {
        self.last_frame_ms = now_ms;
        self.retry_after_ms = 0;
    }

    /// Should the fallback read STATUS now?
    pub fn should_read(&self, now_ms: u64) -> bool {
        if self.in_flight {
            return false;
        }
        if now_ms < self.retry_after_ms {
            return false;
        }
        now_ms.saturating_sub(self.last_frame_ms) >= STATUS_FALLBACK_AFTER_MS
    }

    /// Claims the read slot. False means a read is already in flight, so two
    /// STATUS reads can never overlap.
    pub fn begin_read(&mut self) -> bool {
        if self.in_flight {
            return false;
        }
        self.in_flight = true;
        true
    }

    /// Releases the slot. A successful read is itself a frame; a failed one is
    /// retried on the next interval instead of immediately.
    pub fn finish_read(&mut self, now_ms: u64, ok: bool) {
        self.in_flight = false;
        if ok {
            self.on_frame(now_ms);
        } else {
            self.retry_after_ms = now_ms.saturating_add(STATUS_FALLBACK_RETRY_MS);
        }
    }

    pub fn in_flight(&self) -> bool {
        self.in_flight
    }
}

/// A STATUS frame is forwarded only when it is a non-empty JSON object.
///
/// A GATT read can return the fixed-size value buffer padded with NULs, and an
/// empty or malformed frame is dropped by the UI anyway - so it must never be
/// emitted and never count as liveness.
pub fn status_payload(bytes: &[u8]) -> Option<String> {
    let text = String::from_utf8_lossy(bytes);
    let trimmed = text.trim_matches(|c: char| c == char::from(0u8) || c.is_whitespace());
    if trimmed.is_empty() {
        return None;
    }
    let value: serde_json::Value = serde_json::from_str(trimmed).ok()?;
    if !value.is_object() {
        return None;
    }
    Some(trimmed.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: u64 = 10_000;

    #[test]
    fn a_recent_notification_does_not_trigger_a_read() {
        let mut live = StatusLiveness::default();
        live.on_frame(NOW);
        assert!(!live.should_read(NOW + 1_000));
        assert!(!live.should_read(NOW + STATUS_FALLBACK_AFTER_MS - 1));
        assert!(!live.in_flight());
    }

    #[test]
    fn a_silent_link_is_read_periodically() {
        let mut live = StatusLiveness::default();
        live.on_frame(NOW);
        assert!(live.should_read(NOW + STATUS_FALLBACK_AFTER_MS));
        assert!(live.begin_read());
        live.finish_read(NOW + STATUS_FALLBACK_AFTER_MS + 60, true);
        assert!(!live.should_read(NOW + STATUS_FALLBACK_AFTER_MS + 1_000));
        assert!(live.should_read(NOW + 2 * STATUS_FALLBACK_AFTER_MS + 100));
    }

    #[test]
    fn a_failed_read_is_retried_on_the_next_interval() {
        let mut live = StatusLiveness::default();
        live.on_frame(NOW);
        assert!(live.begin_read());
        live.finish_read(NOW + STATUS_FALLBACK_AFTER_MS, false);
        assert!(!live.should_read(NOW + STATUS_FALLBACK_AFTER_MS + 100));
        let retry_at = NOW + STATUS_FALLBACK_AFTER_MS + STATUS_FALLBACK_RETRY_MS;
        assert!(live.should_read(retry_at));
        assert!(live.begin_read());
        live.finish_read(retry_at, true);
        assert!(!live.should_read(retry_at + 100));
        assert!(live.should_read(retry_at + STATUS_FALLBACK_AFTER_MS));
    }

    #[test]
    fn status_reads_never_overlap() {
        let mut live = StatusLiveness::default();
        live.on_frame(NOW);
        assert!(live.should_read(NOW + STATUS_FALLBACK_AFTER_MS));
        assert!(live.begin_read());
        assert!(!live.begin_read());
        assert!(!live.should_read(NOW + 10 * STATUS_FALLBACK_AFTER_MS));
        live.finish_read(NOW + 10 * STATUS_FALLBACK_AFTER_MS, true);
        assert!(!live.in_flight());
    }

    #[test]
    fn only_non_empty_json_objects_are_frames() {
        assert_eq!(status_payload(br#"{"state":"IDLE"}"#).as_deref(), Some(r#"{"state":"IDLE"}"#));
        let mut padded = br#"{"a":1}"#.to_vec();
        padded.extend_from_slice(&[0u8; 4]);
        assert_eq!(status_payload(&padded).as_deref(), Some(r#"{"a":1}"#));
        assert_eq!(status_payload(b""), None);
        let blank = [b' ', b' ', 0u8, 0u8];
        assert_eq!(status_payload(&blank), None);
        assert_eq!(status_payload(b"not json"), None);
        assert_eq!(status_payload(b"[1,2]"), None);
    }
}
