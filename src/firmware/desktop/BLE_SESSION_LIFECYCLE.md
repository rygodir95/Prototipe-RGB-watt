# Desktop BLE session lifecycle

The starting Windows build (9c2fe2d5159abbe3634c04c4a050f8c52a2c5925,
Actions run 41254057877) resolved btleplug 0.13.5. The dependency is now pinned
to that exact version, so the audited Windows semantics cannot drift silently.

## Physical state, not STATUS delivery

Audited crate sources:
- https://docs.rs/crate/btleplug/0.13.5/source/src/winrtble/peripheral.rs
- https://docs.rs/crate/btleplug/0.13.5/source/src/winrtble/ble/device.rs

BLEDevice registers BluetoothLEDevice.ConnectionStatusChanged. Its callback
updates Peripheral's cached connected atomic and emits CentralEvent::DeviceDisconnected.
Peripheral::is_connected() reads that atomic without a GATT transaction. The
session's independent 500 ms physical monitor uses this API; it never infers
physical disconnection from notification EOF, silence, STATUS failure or timeout.
An unknown/failed physical check is not interpreted as a disconnect.

Limitations: this is the Windows-reported state, not a direct radio probe, and
Windows may delay reporting a loss. Inside btleplug's Windows callback a failed
ConnectionStatus query is mapped to not-connected; its public API does not expose
that distinction. We cannot prove radio loss independently with this API.

## Ownership and startup

Every attempt has a native generation and a frontend client token. Connection
operations are exclusive. Disconnect invalidates the generation immediately,
including during startup, before waiting for peripheral cleanup. Replacing or
invalidating a session explicitly aborts its notification, fallback and physical
monitor workers. Command responses are cancellation-guarded too.

All workers are installed behind an activation gate. Connection(true) precedes
worker polling and the initial bounded STATUS read. Notification EOF emits only
ble-notifications(false), retaining physical monitoring and fallback reads.
Session checking and native emission share one lock. The native transport also
rejects queued event envelopes for obsolete client tokens/generations, so even
already-queued Tauri events cannot reach the current bridge. Event listeners are
registered before invoking connect. The shell tracks connecting separately from
bleMode and cancels stale promise continuations after an early disconnect.

## Bounded STATUS delivery

A single worker owns the initial and subsequent STATUS reads. Each future has a
1500 ms application timeout. Timeout/error releases the read slot and preserves
the existing 2500 ms retry policy; there is never more than one read future per
session. Invalid JSON is not liveness. Identical valid frames are not deduplicated.

Important API limitation: dropping a timed-out btleplug future bounds application
waiting and prevents its result from being emitted; btleplug does not expose a
native WinRT operation cancellation/join handle. Therefore no claim is made that
Windows has cancelled the underlying radio operation at that instant. Strict
non-overlap of OS-internal operations after a timeout cannot be guaranteed by the
existing API. Tests prove application future non-overlap, cancellation and event
isolation, not OS-internal cancellation.

No ESP32 code, UUID, firmware 2 s heartbeat, October firmware mutexes, Stage B
transfer-slot/retry behavior or 6 s UI watchdog was changed.

## Verification

Windows CI runs cargo tests against the production coordination module with
mock hardware operations and deterministic Tokio time. Cases cover notification
EOF/silence, physical loss with pending notifications, timeout/retry, cancellation
in flight, replacement, stale events, startup EOF and repeated reconnects. A
20-second trace is exported from actual fallback workers, then passed through the
real native transport, bridge, WebSocket adapter and UI watchdog. A negative
control then stops delivery and verifies that the unchanged watchdog does fire.
Additional executable shell/transport tests cover early disconnect, stale events,
subscription readiness and pending startup completions.

CI also runs existing BLE transfer/liveness, mobile and PC simulator regressions,
then builds the Windows executable from the same commit and packages COMMIT.txt
and SHA256SUMS.txt. This is code/test/build verification only. No real Windows
Bluetooth adapter, ESP32 Hub or pedals are available in CI; hardware verification
is still required.