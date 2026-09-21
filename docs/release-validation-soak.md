# V1 physical soak-test runbook

## Scope and baseline

This is a release-validation procedure for the Hub firmware at commit
`dea7c2f` on `fix/led-pin-validation`. It is not a product-release approval.
Do not make feature, branding, or broad refactoring changes while executing it.

The procedure reuses `src/firmware/tools/soak_network_hardware.cjs` and the
existing `/api/diagnostics`, serial `[RESET]`, `[WIFI]`, `[PERF]`, and `[NET]`
records. It has a `--live` mode so real sensors remain the source of telemetry;
it never enables simulation in that mode.

## Equipment and setup

- ESP32 flashed from this baseline; data-capable USB cable and continuous serial
  capture at 115200 baud.
- Correctly powered LED strip with common ground; use a supply appropriate for
  the strip, not the ESP32 USB supply.
- A real BLE power sensor and a BLE heart-rate sensor, plus a browser on the
  same network. Prefer router station mode for the endurance run.
- Node.js 22 or newer on the observer computer.

Before beginning, take a copy of the device configuration, record firmware
build/device ID, and save `/api/diagnostics` as `before.json`. Verify a clean
boot, the web UI, config persistence after one reboot, and one Lighting Test
cycle. Pair both sensors and confirm that each reports live data before the
timed run.

## Timed procedure (minimum 3 hours)

1. Start serial capture immediately after the final power-on. Keep it running
   for the whole session; do not reset or unplug the device.
2. In a separate terminal, start the existing runner in live-sensor mode:

   ```text
   cd src/firmware
   node tools/soak_network_hardware.cjs http://HUB_IP 10800 soak-live.json --live
   ```

   It reads config every 500 ms, samples diagnostics every 10 seconds, keeps a
   single WebSocket connection open, records all HTTP/WS failures, and writes a
   JSON report even on failure. It does not change configuration or sensor
   source in `--live` mode.
3. During each of the first two hours, perform one controlled sensor recovery:
   put the active sensor out of range or stop it for 30–60 seconds, then restore
   it; record the time and confirm data, zone, and LEDs recover. Perform this
   once for power and once for heart rate. Do not run a BLE scan during an
   ordinary endurance run; run the scan stress check separately if desired.
4. At about one hour and two hours, switch Power → Heart Rate → Power through
   the UI. Confirm only the chosen source is active, telemetry resumes, the
   correct zone set is used, and the LED colour matches the active source.
5. Once during the run, start Lighting Test and verify one complete visible
   zone-colour round trip, then stop it and confirm live sensor colours resume.
6. Exercise Wi-Fi recovery once: briefly remove and restore router/AP access
   without power-cycling the Hub. Record the event and confirm browser/WS and
   live telemetry recover. If testing direct AP mode, run it as a separately
   labelled observation: existing evidence does not establish its prior
   client-path instability as a firmware defect.
7. At completion, save `/api/diagnostics` as `after.json`, save the runner JSON
   report, capture the dashboard, and power-cycle once to verify configuration
   and the last selected source persist.

## PASS / FAIL

Pass only when all of the following are true:

- The runner reports `transportPassed: true`: zero HTTP failures, exactly one
  WebSocket open, zero unexpected WS close/error, telemetry frames throughout,
  and maximum WS frame gap below 3 seconds.
- `uptimeMs` grows throughout the report; reset reason does not change; serial
  has no panic, brownout, watchdog, task-stall, or unexpected reboot evidence.
- Wi-Fi/BLE interruptions deliberately introduced above recover without manual
  reboot; WebSocket/UI telemetry and sensor data recover; no unexplained
  Wi-Fi-event or diagnostic-loss increase occurs.
- Free heap and largest free block show no meaningful progressive decline across
  the 10-second samples. `minHeap` may only decrease as a historical peak
  allocation watermark; interpret it alongside the current free/largest values.
- No unexplained `/api/diagnostics` counter increase occurs (network sample
  drops, WS errors, or abnormal retry/PCB growth), no configuration loss occurs,
  and Lighting Test plus both source-switch directions are correct.

Fail on any crash/reset/watchdog/panic, unrecovered Wi-Fi/BLE/WS failure,
runner request failure, persistent wrong LED behaviour, configuration loss, or
unexplained accumulating resource/failure counter. Preserve logs and report the
first failure time; do not patch unrelated code during the run.

## Evidence bundle

Retain `soak-live.json`, `before.json`, `after.json`, full serial capture,
dashboard screenshots before/after each source switch and Lighting Test, the
firmware build identity, and a short event timeline (sensor and Wi-Fi recovery
times). Redact Wi-Fi credentials and device identifiers before sharing outside
the test team.

## Router / TP-Link interpretation

The existing `NETWORK_HARDWARE_RESULTS.md` shows 120 s and 600 s station-mode
passes, including a source-address-bound TP-Link USB Wi-Fi sample. It does not
prove the cause of earlier direct-AP failures. Treat a repeatable failure as a
firmware issue only when the current baseline and collected diagnostics show a
firmware-side fault; otherwise record its topology, adapter, and router context
as an environment observation.
