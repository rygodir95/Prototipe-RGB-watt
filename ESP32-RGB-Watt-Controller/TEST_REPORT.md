# TEST REPORT — ESP32 RGB Watt Zone Controller (snapshot v1.0.0-dev, commit 5e539d9)

**Date:** 2026-09-03
**Prepared by:** automated review agent (Base44) — this environment has **no PlatformIO toolchain and no ESP32 hardware**, therefore **no compile and no runtime tests were executed**. Everything below is **static source verification** performed against the repository at commit `5e539d9`.

---

## 1. Tests actually performed (static verification)

| ID | Verification | Method | Result |
|---|---|---|---|
| R01 | Project structure completeness | GitHub tree listing vs README's documented structure | **PASS** — `platformio.ini`, `src/` (10 .cpp incl. `main.cpp`), `include/` (14 headers incl. generated `WebContent.h`), `data/web/` (`index.html` 10.9 KB, `style.css` 11.7 KB, `app.js` 15.2 KB), `tools/embed_web.py`, `README.md` all present |
| R02 | Simulation Mode usable without BLE meter / LED strip | Code trace: `include/Simulation.h` (header-only) → `processPipeline()` in `src/main.cpp`: when `sim.enabled()`, the simulated wattage bypasses BLE entirely and feeds the same smoothing → zone → colour → LED pipeline | **PASS (static)** — power → zone → RGB logic is fully exercisable on a bare ESP32 via the dashboard simulation |
| R03 | Web GUI presence/structure | Review of `data/web/` sources (dashboard, theme, zone editor, device manager, simulation controls per README and UI source) | **PASS (static)** — not executed; runtime behaviour untested |
| R04 | REST API inventory | `src/WebInterface.cpp`: `/api/config` (GET + POST patch), `/api/info`, scan/connect/disconnect/forget/simulation/Wi-Fi/factory-reset endpoints, OTA upload handler with ECDSA signature + anti-rollback checks (prod) | **PASS (static)** — endpoints exist and validate/clamp inputs; not executed |
| R05 | WebSocket telemetry | `AsyncWebSocket ws("/ws")` with periodic broadcast loop (`WebInterface::loop`) | **PASS (static)** — not executed |
| R06 | BLE protocol parsing correctness | `BLEPower::onNotify`: CPS 0x2A63 (flags+int16 power) and FTMS 0x2AD2 (flag-conditional field offsets) — both match Bluetooth SIG layouts; implausible values (<0, >3000 W) rejected | **PASS (static)** |
| R07 | Config persistence robustness | `Storage.cpp`: versioned blob, size/version mismatch → defaults, factory reset clears only the app namespace | **PASS (static)** |
| R08 | Prior build evidence | Committed `.pio/build/esp32dev/` artifacts (object files, 1.5 MB sconsign DB) | **EVIDENCE ONLY** — proves the project compiled successfully on the original developer's machine; **not** verified in a clean environment |

## 2. Tests NOT performed (require toolchain or hardware)

- Clean `pio run` compile (needs local PlatformIO).
- All runtime cases T02–T13 in `TESTING.md` (need an ESP32).
- Physical LED output, BLE scan/connect/notify with a real meter, OTA flashing.

**This snapshot has NOT been hardware-tested.** No claim of on-device validation is made.

## 3. Regressions / open defects found during this review

1. `src/BLEPower.cpp` still uses `portENTER_CRITICAL` around heap-allocating `std::map`/`std::vector` operations (scan results + device list) — concurrency risk when BLE scanning overlaps web polling. A prepared FreeRTOS-mutex fix exists but was **intentionally not applied** in this snapshot per instructions.
2. Discovery relies on service UUIDs in BLE advertisements (some meters won't be found).
3. Open AP + unauthenticated web API; dev builds accept unsigned OTA; production builds verify against a public development signing key; `tools/production/` missing from the repo.
4. Build artifacts (`.pio/`) committed to the repository.

## 4. Verdict for the external tester

The snapshot is **structurally complete and reviewable as-is**: a tester with PlatformIO can compile it, flash it to any generic ESP32 dev board, and run the full no-meter test matrix (T02–T13) using Simulation Mode, the web GUI, REST API and WebSocket. Items 1–3 above are the known issues the tester should specifically probe for and report on.