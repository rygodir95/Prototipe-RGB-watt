# PC Simulator — RGB Watt Controller (TESTING TOOL ONLY)

A small, isolated PC harness that lets you and an external tester exercise the
**existing** RGB Watt Controller web GUI, REST API, WebSocket telemetry,
power/zone/RGB pipeline and configuration behavior **without any ESP32, LED
strip or BLE power meter**.

> **Production safety:** this directory is not part of the firmware build.
> Nothing here is compiled for the ESP32, embedded into `WebContent.h`, or
> required by the device at runtime. The firmware sources (`src/`, `include/`,
> `data/web/`) are **unchanged**. The simulator only *reads* `data/web/` to
> serve the GUI.

Baseline: test snapshot v1.0.0-test1, commit `75150c31` (firmware state of
commit `5e539d9`, BLE concurrency fix deliberately NOT applied).

---

## 1. Architecture

```
Existing Web GUI (data/web/, UNCHANGED - served as-is)
        |  relative fetch("/api/...") + WebSocket("/ws")
        v
PC Simulator Backend (this directory, Python stdlib only)
        |  - REST API mirroring src/WebInterface.cpp 1:1
        |  - WebSocket telemetry identical to broadcastTelemetry()
        v
Virtual Power Source (slider / presets / noise / jump / script)
        v
Existing power/zone/RGB behavior: pipeline.py is a faithful
line-by-line port of PowerProcessor.cpp, PowerZones.cpp, Config.cpp
and the processPipeline() loop of main.cpp (100 ms tick, 200 ms broadcast)
```

`pipeline.py` maps to the firmware like this:

| Simulator (Python) | Firmware (C++) |
|---|---|
| `PowerProcessor` | `src/PowerProcessor.cpp` (EMA smoothing, alpha = 1 − s/100·0.95) |
| `zone_index()` | `PowerZones::zoneIndex()` (zone lookup + hysteresis margins) |
| `color_for()` | `PowerZones::colorFor()` (interpolated RGB) |
| `AppConfig` + defaults | `include/Config.h` + `src/Config.cpp` |
| `apply_config_patch()` | `applyConfigPatch()` in `src/WebInterface.cpp` |
| `build_config_json()` | `buildConfigJson()` |
| `Simulator._tick_pipeline()` | `processPipeline()` in `src/main.cpp` |
| JSON file `sim_config.json` | `src/Storage.cpp` (NVS blob, version-checked) |

BLE is **not** implemented on the PC. Instead a state machine mimics
`src/BLEPower.cpp` externally observable behavior: SCAN (6 s) → devices
appear staggered → CONNECTING (~1.2 s) → CONNECTED → RECEIVING_POWER, plus
disconnect, connection-lost, auto-reconnect (7 s cadence) and reconnect loops.

## 2. Prerequisites / installation

* **Windows** (also runs on Linux/macOS for what it's worth)
* **Python 3.8 or newer** — check with `py -3 --version`
* **No additional packages** — standard library only, nothing to `pip install`

Optional, if you plan to edit the GUI: nothing. The GUI is served from the
repo's `data/web/` folder — edits to those files are picked up on browser
reload.

## 3. Startup

Double-click **`run_simulator.bat`**, or from a terminal:

```
cd ESP32-RGB-Watt-Controller\tools\pc-simulator
py -3 simulator.py
```

A console window opens (keep it open - it doubles as the event log), and your
browser opens the GUI automatically.

* **Browser URL (existing GUI):** http://localhost:8080/
* **Developer / Test Panel:** http://localhost:8080/dev/
* Options: `--port 8081` (different port), `--host 0.0.0.0` (allow other
  devices on your LAN), `--no-browser`, `--config <path>`.

**Stopping:** press `Ctrl+C` in the console window (or just close it).
Restarting the simulator reboots the "device": boot state machine, saved source
auto-reconnect, and persisted config run exactly like on the ESP32.

## 4. How the GUI connects / how to use Simulation Mode

The GUI is served **by the simulator itself**, same as the ESP32 serves it from
`WebContent.h`. All requests are same-origin, so no GUI modification was
needed:

| Firmware route | Simulator route |
|---|---|
| `GET /`, `/style.css`, `/app.js` (from `WebContent.h`) | same, from `data/web/` |
| `GET/POST /api/config` | identical JSON contract |
| `POST /api/scan`, `GET /api/devices`, `POST /api/connect`, `/api/disconnect`, `/api/forget` | identical (virtual meters) |
| `POST /api/simulation` | identical |
| `POST /api/wifi`, `/api/factory-reset` | identical, but the "reboot" is simulated (config reload, server keeps running) |
| `POST /api/ota` | always `400 {"ok":false}` — OTA is hardware-only |
| `GET /api/info` | simulator identification strings |
| WebSocket `/ws`, 200 ms telemetry, same JSON keys | identical |

**Simulation Mode** works exactly like on the device: enable it on the GUI
dashboard, move the watt slider — the value feeds the same smoothing →
hysteresis → zone → RGB pipeline. The Developer panel's power controls set the
same virtual power value (they also drive the virtual BLE meter), so the GUI
sim slider and the panel always agree on "current power"; the last change wins.

## 5. Available controls (Developer / Test Panel, `/dev/`)

**Power**
* Continuous watt slider 0–600 W, numeric input (0–9999 W)
* Presets: 0 / 50 / 100 / 150 / 200 / 250 / 300 / 400 / 500 / 600 W
* Random noise toggle with configurable ±W amplitude
* Rapid jump between two watt values with configurable interval
* Freeze power value (holds the current value, telemetry keeps flowing)
* Stop telemetry (meter stays connected but goes silent → triggers the
  power-timeout path) / Restore telemetry
* Sudden power changes: just click presets — they apply within the next tick

**BLE simulation (states, no real BLE)**
* Scan (6 s, staggered results), connect either virtual meter, disconnect,
  connection lost (unexpected drop → auto-reconnect per config), reconnect
  now, forget
* "Meters hidden from scan" toggle — reproduces the known firmware issue where
  meters not advertising the service UUIDs are never discovered and
  auto-reconnect loops
* Auto-reconnect behavior follows the config value (`Settings → auto reconnect`)

**WebSocket**
* Pause telemetry broadcast / resume
* Disconnect all WS clients (the GUI auto-reconnects after ~2 s)

**Configuration** (uses the existing `/api/config` — no second config system)
* FTP changes (with zone rescaling), zone count 5/6/7, restore FTP-default zones
* One-click boundary-test zones: 0/100/130/160/190/220/250 W
* Hysteresis, smoothing, power timeout, brightness quick-apply
* Factory reset
* Persistence: config is saved to `sim_config.json` (the NVS equivalent) and
  survives restarts; factory reset restores defaults

**Zone boundary probes**
* Auto-generated per configured boundary: `b−1 / b / b+1` buttons set the power
  to the exact wattage (set hysteresis to 0 first for exact zone steps)

**Event / telemetry log**
* Timestamped events: power update, zone change, RGB change, BLE state change,
  WebSocket connect/disconnect, configuration update, timeout, script activity
* Also printed to the simulator console; "Clear log" button

**Test automation**
* Simple scripted sequence runner, e.g. `0,100,150,200,250,300,0` with a
  configurable per-step delay — exercises the complete pipeline

## 6. Known limitations / deviations from the device

1. **Python float64 vs ESP32 float32** — smoothed values can differ in the last
   decimals; zone boundaries land identically because rounding (`lround`) is
   ported exactly.
2. **No real BLE** — device discovery, CPS/FTMS notification parsing and
   radio behavior are simulated; a real meter can still surprise you.
3. **No physical LED output** — the panel shows the *calculated* color
   (brightness + fade applied). Breathing/comet effect *animation* is
   physical-LED-only and not animated in the preview.
4. **OTA is rejected** (`400`), Wi-Fi/"reboot" endpoints are simulated: config
   persists, server keeps running (watch the event log instead).
5. **Zone color hex parsing is strict**; the firmware's `strtol` accepts some
   malformed input as black. Only matters for deliberately malformed tests.
6. **The BLE concurrency defect of the baseline is reproduced in spirit, not in
   mechanism**: the PC has no ISRs or `portENTER_CRITICAL`; do not use the
   simulator to judge that specific bug.
7. WebSocket is a minimal RFC 6455 server (text frames, ping/pong) — enough
   for the GUI and any standard client.

## 7. What still requires real hardware

* `pio run` compile and flashing the ESP32 itself
* Physical LED strip rendering: brightness behavior, >60-LED performance,
  breathing/comet animation, fade-out on timeout (as light, not as a color box)
* Real BLE power meters/trainers: advertisement quirks, CPS vs FTMS
  negotiation, real notification streams, radio disconnects
* OTA update flow (signature verification, anti-rollback)
* NVS persistence across real power cycles

Manual test cases for the simulator: see **`TEST_SCENARIOS.md`**.