# Demo stability checks

Run after the firmware build, from `src/firmware`:

```
node tools/test_demo.cjs
python tools/test_request_paths.py
python tools/test_lighting.py
```

The client test executes the production Demo functions over two minutes of
virtual time, with response bodies slower than the demo cadence. It verifies
one in-flight request, response-body completion, a 1.2-second rest, stop/start
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
