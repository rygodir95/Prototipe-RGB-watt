# Demo stability checks

Run after the firmware build, from `src/firmware`:

```
node tools/test_demo.cjs
python tools/test_request_paths.py
python tools/test_lighting.py
```

The client test executes the production Demo functions over two minutes of
virtual time, with response bodies slower than the demo cadence. It verifies
one in-flight request, response-body completion, a 1.5-second rest, stop/start
races, finite cycles, HTTP/network errors and timeouts during enable or a tick.

The native test executes production config/simulation callbacks and WebSocket
telemetry scheduling over two minutes of simulated loop time. It checks config
reads, telemetry broadcasts/cleanup, and dropping samples under backpressure.
It also exercises requests while runtime application or NVS writes are blocked.
The lighting test checks that simulation callbacks never render LEDs and that
normal output updates consume stored state outside mailbox locks.

These host tests use transport/hardware doubles; they do not prove ESP32 Wi-Fi,
RMT or power stability. After flashing, run the real-device soak with Node 22+:

```
node tools/soak_demo_hardware.cjs http://HUB_IP
```

This enables simulation for 120 seconds, sends serial zone-value updates, reads
`/api/config` concurrently, and listens to `/ws`. Any HTTP failure, WebSocket
disconnect or telemetry gap above three seconds fails the test. It reports
request/frame counts and maximum config latency, then attempts to disable
simulation. Close any other Demo session first. The script changes no settings.

## Runtime performance and reset diagnostics

`/api/diagnostics` returns cached heap/stack/Wi-Fi health plus cumulative call
counts and maximum measured microseconds for the loop, web service, LED show,
rebuild, runtime config, JSON requests, config reads and simulation handler.
Heap health is sampled every ten seconds. WebSocket counts include skipped
samples. These counters do not measure radio round-trip latency.

At boot, `[RESET]` distinguishes POWER_ON, SOFTWARE, PANIC, watchdog and BROWNOUT.
`[WIFI]` records AP start/stop/client association and STA disconnect reason codes.
Wi-Fi callbacks only enqueue bounded records; serial output is drained by loop
without waiting for UART space. `[PERF]` gives the same performance counters every
ten seconds, independent of the verbose measurement debug setting. No watchdog
or brownout protection is disabled. AP client events on this Arduino version do
not supply the same reason codes as STA disconnects.

LED rendering is owned by the setup/loop task and rejects other task callers.
Animated frames are capped at 30 FPS or half wire-time duty for long strips;
black frames are not resent. Zone/power/HR calculations still run at 10 Hz.
Telemetry is limited to 2 Hz, with unchanged data sent as a 2-second heartbeat;
its JSON slots and serializer capacity are reused. Demo POSTs retain single-flight
backpressure and use a 1.5-second pause after each complete response.

Routine scan/pair/disconnect/forget/Wi-Fi/reset commands are queued (8 slots,
HTTP 503 when full) and dispatched one per loop, retaining their existing logic.
The explicit OTA streaming route is unchanged: its flash-write behavior belongs
to firmware upload, not ordinary interaction or Lighting Test.
