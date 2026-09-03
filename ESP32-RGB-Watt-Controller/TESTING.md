# TESTING — ESP32 RGB Watt Zone Controller

**Test snapshot:** v1.0.0-dev · commit `5e539d9` (2026-09-02)
**Purpose:** stable, clearly identifiable test version of the current project for an external software tester. No new development in this snapshot.

This is a *firmware* project (PlatformIO / Arduino-ESP32 / C++). There is no PC-side runtime, no Docker image, and no unit-test harness — the firmware only runs on an ESP32.

---

## 1. How to run / start the project

```bash
# Prerequisites: Python 3 + PlatformIO Core
pip install platformio

# From ESP32-RGB-Watt-Controller/ :

pio run                     # compile (default env: esp32dev-dev)
pio run --target upload     # flash to ESP32 over USB
pio device monitor          # serial monitor @ 115200 baud
```

- Build environments: `esp32dev-dev` (default — verbose logs, unsigned OTA allowed) and `esp32dev-prod` (signed OTA enforced).
- The web UI is **embedded in the firmware** (`include/WebContent.h`, generated from `data/web/`). No filesystem upload is needed. If `data/web/` is edited, regenerate with `python3 tools/embed_web.py`.
- First boot (no Wi-Fi configured): the device opens Access Point **`RGB-Watt-Controller`** — connect to it and open `http://192.168.4.1`. After joining a home Wi-Fi network via Settings, it is reachable at `http://rgbwatt.local` (mDNS).
- Hardware wiring for the LED strip (GPIO 5 default, external 5 V supply, series resistor, common ground) is documented in `README.md`.

---

## 2. What can be tested WITHOUT physical hardware

| Level | What is possible |
|---|---|
| **No ESP32 at all** | Static code review only: project structure, `data/web/` UI source (plain HTML/CSS/JS), BLE protocol parsing, zone/colour math, config model. Nothing can be executed. |
| **ESP32 only — no BLE power meter, no LED strip** | **Simulation Mode** (dashboard) injects a wattage into the exact same pipeline as real BLE data: watts → EMA smoothing → zone calculation (with hysteresis) → RGB colour interpolation → LED driver. The **full web GUI**, **REST API**, **WebSocket live telemetry**, **config persistence** (NVS), **Wi-Fi AP/STA**, **factory reset**, and **state machine** are all testable. Colour values are visible in the UI and serial debug even without a physical strip. |
| **ESP32 + LED strip — no power meter** | Everything above, plus the physical LED output: solid/breathing/comet effects in the simulated colour, fade-out on timeout. |
| **ESP32 + BLE power meter** | Full end-to-end: BLE scan → connect (CPS or FTMS) → notifications → zones → LEDs. |

**Verification note (from source review):** `Simulation` is a header-only class (`include/Simulation.h`) whose `watts()` value is consumed by `processPipeline()` in `src/main.cpp`, bypassing BLE entirely when enabled — so the power → zone → RGB logic is fully testable on a bare ESP32 without any BLE device or LED strip.

---

## 3. Recommended test cases (no meter / no strip required)

| ID | Area | Test case | Expected result |
|---|---|---|---|
| T01 | Build | `pio run` (dev env) | Compiles without errors; note any warnings |
| T02 | Boot | Flash + serial monitor 115200 | Boot banner, version `1.0.0-dev`, AP `RGB-Watt-Controller` starts |
| T03 | Web GUI | Open `http://192.168.4.1` | Dashboard loads; light/dark/system theme works |
| T04 | Simulation | Enable Simulation, set 0 W → 300 W in steps | Raw/smoothed watts update live; zone indicator advances Recovery → Neuromuscular; interpolated RGB changes continuously |
| T05 | Zone math | Set watts at each zone boundary (±1 W) | Correct zone; verify hysteresis prevents boundary flicker |
| T06 | Smoothing | Change smoothing 0 ↔ 100, step the simulated watts | Higher smoothing → slower response |
| T07 | Zones config | Switch 7 → 5 → 6 zones; edit names/boundaries/colours; change FTP | Zones regenerate/rescale; invalid input sanitised |
| T08 | REST API | `GET /api/config`, `POST /api/config` patches, `GET /api/info` | Values apply live and match what the GUI shows |
| T09 | WebSocket | Watch telemetry while simulating | Live updates without manual refresh; no stale values |
| T10 | Persistence | Change config → reboot → reload | All settings survive (NVS); factory reset restores defaults |
| T11 | Timeout | Disable simulation | LEDs/UI fade to inactive after the configured power timeout |
| T12 | API robustness | Malformed JSON to POST endpoints, out-of-range values | 400 / clamped values, no crash or reboot |
| T13 | Reconnect loop | Enable simulation, then trigger the BLE scan API with no meter present | Scan completes cleanly; repeated scans stay stable |

*(Exact endpoint paths are defined in `setupRoutes()` in `src/WebInterface.cpp`.)*

## Test cases requiring extra hardware

- **LED strip:** physical effect rendering (T04–T11 visual result), brightness behaviour, LED count >60 performance.
- **Real BLE power meter / trainer:** device discovery, connect, CPS vs FTMS negotiation, live notification parsing, disconnect/auto-reconnect, saved-source restore on boot.
- **Second ESP32 or OTA flow:** flashing a `firmware.bin` through Settings → OTA (dev build accepts unsigned images).

---

## 4. Known limitations and known issues (as of this snapshot)

1. **BLE/web concurrency defect (highest priority):** scan results and the device list are protected with `portENTER_CRITICAL` critical sections around heap-allocating `std::map`/`std::vector` operations (`src/BLEPower.cpp`). Allocating with interrupts disabled can cause rare deadlocks/crashes when BLE scanning coincides with web API polling. A prepared fix (FreeRTOS mutex) exists but is **deliberately NOT applied** in this snapshot — the snapshot reflects the current codebase. Testers should watch for instability in T04/T09/T13 while scanning.
2. **Device discovery depends on service UUIDs being present in the BLE advertisement.** Meters/trainers that don't advertise 0x1818/0x1826 will never appear in a scan, and auto-reconnect to them loops.
3. **Open access point + unauthenticated web UI/API.** Anyone in Wi-Fi range can reconfigure the device; dev builds also accept unsigned OTA. Not an issue for bench testing; do not deploy in the wild.
4. **Production builds verify OTA against a publicly documented *development* signing key** (`include/ManufacturerKey.h`); the real production provisioning pipeline (`tools/production/`, referenced by `platformio.ini` and the README) is not in the repo.
5. **Platform not pinned:** `platform = espressif32` resolves to whatever the installed PlatformIO ships (Arduino core 2.x); the esp32async server libraries target newer cores. The committed `.pio` build artifacts prove it compiled on the original developer's machine, but a fresh environment may resolve different versions.
6. Minor: `ledPin` accepts flash pins (6–11) → crash if set; `std::string` leak on aborted POST bodies; blocking `show()` degrades responsiveness at very high LED counts (~1000); `millis()` rollover in the reboot check (49 days); anti-rollback version check may fall back to compiled defaults since image versions aren't stamped.
7. **Repo hygiene:** committed `.pio/` build artifacts (~MB of `.o`/db files) and `.emergent/` tooling bloat the repository; a `.gitignore` entry is needed.

**No ESP32 hardware testing has been performed on this snapshot** — all statements about runtime behaviour are from source-code review. See `TEST_REPORT.md`.