# ZoneGlow Hub — Hardware Validation Plan

This document is the **authoritative validation plan** for the Power + Heart Rate →
Zone → Lighting system on real ESP32 hardware. Release gates defined here govern
all downstream work (e.g. remote Light Node implementation requires Gates A–E).

## Rules (apply to every phase)

1. **Baseline frozen.** No new features, no refactors, no rebranding, no
   unrelated technical-debt fixes during validation.
2. **Smallest possible fix.** If something fails, diagnose only the failing
   layer and change the minimum required to pass. Add a regression test where
   practical (simulator test suites cover config/pipeline logic).
3. **Product boundary.** The Hub is a standalone device. It must operate
   independently with no Web / Windows / Android client open. Clients are
   configurators only.
4. **Explicit continuation.** Each phase starts only after the previous gate
   passes and the operator says to continue.
5. **Evidence.** For every gate, record: serial log excerpt, UI screenshot or
   photo, and pass/fail per checklist item.

## Not implemented during validation

Cadence · Pace · ESP-NOW · Light Node firmware · ANT+ · multi-user ·
cloud/accounts · workout recording · training features · new lighting
features · MetryLoom rebrand.

---

## Validation baseline

| Item | Value |
|---|---|
| Branch | `feature/mobile-app` |
| Commit | `7529fa6` (ZoneGlow production polish) |
| PlatformIO environment | `esp32dev-dev` (default; board `esp32dev`) |
| Framework | Arduino (espressif32), 4 MB flash, `min_spiffs.csv` partitions |
| Firmware version | `1.0.0-dev` (development build) |
| Binary | `src/firmware/.pio/build/esp32dev-dev/firmware.bin` |
| Libraries | NimBLE-Arduino ^1.4.1 · Adafruit NeoPixel ^1.12.3 · AsyncTCP ^3.3.2 · ESPAsyncWebServer ^3.6.0 · ArduinoJson ^7.2.0 |

**Hardware under test (Phase 1):** classic ESP32 Dev Kit V1, 30-pin,
ESP32-WROOM-32, 4 MB flash, Wi-Fi + BLE, microUSB. The `esp32dev` board target
is correct for this board (generic ESP32 Dev Module).

---

## Phase 1 — ESP32 Bring-up (Gate A)

Goal: the existing firmware boots and the Hub is reachable over Wi-Fi, with the
web UI, REST API, WebSocket telemetry and NVS persistence all working.
**No LED strip and no BLE sensor required for this phase.**

### 1. Build

```bash
pip install platformio        # PlatformIO Core
cd src/firmware
pio run                       # builds default env: esp32dev-dev
```

Expected: `SUCCESS` at the end; binary at
`.pio/build/esp32dev-dev/firmware.bin`. No firmware behavior is changed.

### 2. Flash

```bash
pio run --target upload
```

- USB driver: DevKit V1 uses CP2102 or CH340 USB-serial — install the matching
  Windows driver if the board does not appear as a COM port.
- If the console shows `Connecting........_____` and never uploads, hold the
  **BOOT** button while it says "Connecting", release when upload starts.
- Flash uses the standard esptool 460800 baud upload; two app partitions
  (`app0`/`app1`) exist for OTA support — both are flashed-managed by the
  partition table, nothing extra to do.

### 3. Serial monitor

```bash
pio device monitor            # 115200 baud
```

Garbage characters for the first ~100 ms after a reset are normal (bootloader
uses a different baud rate). Ctrl+C exits.

### 4. Expected first-boot serial output

Fresh chip (no stored config, no Wi-Fi credentials):

```
[BOOT] RGB Watt Controller
[FW] Version 1.0.0-dev (development)
[SEC] Device ID: 246F28A1B2C3
[SEC] Serial: RGBW-A1B2C3
[SEC] Build: development  SecureBoot: 0  FlashEnc: 0
[STORE] No stored config, using defaults
[WIFI] AP started: RGB-Watt-Controller  IP: 192.168.4.1
[WIFI] mDNS: http://rgbwatt.local
[WEB] Server started on port 80
```

Notes:
- `[SEC] Device ID` / `Serial` values are derived from the chip MAC and will
  differ per board.
- Additional `[BLE]` / `[HR]` NimBLE initialisation lines may appear between
  the WIFI and WEB lines — informational only.
- The AP SSID is **`RGB-Watt-Controller`** (open network) and the mDNS name is
  `rgbwatt`. This is the known firmware-identity mismatch with the ZoneGlow
  brand — deliberately **not** changed during validation.
- With a stored config, `[STORE] No stored config...` becomes
  `[STORE] Configuration loaded`; with Wi-Fi credentials stored, the
  `[WIFI] Connecting to <ssid>....` sequence runs first, falling back to AP on
  failure.

### 5. Verification checklist (Gate A)

| # | Check | How to verify | Pass criteria |
|---|---|---|---|
| V1.1 | Boot stability | Watch serial for ≥ 5 min | Full boot log, no reboot loop, no `Brownout` / panic / watchdog reset messages |
| V1.2 | Wi-Fi / AP works | Phone or laptop Wi-Fi list | Network **RGB-Watt-Controller** visible; connect; device assigns an IP (client gets `192.168.4.x`) |
| V1.3 | Embedded Web UI loads | Browser: `http://192.168.4.1` | ZoneGlow dashboard loads (first run shows the setup guide); no broken assets |
| V1.4 | REST API responds | `curl http://192.168.4.1/api/info` and `/api/config` | JSON with `version`, `deviceId`, `serial`, `build` / full config (FTP 221, 7 zones, LED GPIO 5, 60 LEDs, WS2812B) |
| V1.5 | WebSocket telemetry works | Open dashboard and watch status; or devtools Network → WS → `/ws` | Frames arriving ~5×/s with `state`, `mode`, `zone`, `color`, `source` fields |
| V1.6 | Configuration persists | Change e.g. FTP in Zones page (serial shows `[STORE] Configuration saved`), then power-cycle | Same FTP value after reboot; serial shows `[STORE] Configuration loaded` |

Optional (not gating): connect the Hub to your home Wi-Fi via
Settings → Wi-Fi and confirm it reboots, joins the network (new IP shown in
serial) and the AP is gone.

**Gate A passes only when V1.1–V1.6 all pass.**

### Failure protocol (Phase 1)

- **No COM port / no `Connecting`:** driver or cable issue — try another USB
  cable (data-capable), check Device Manager; not a firmware failure.
- **Boot loop:** note the repeated `rst:0x...` line and the abort message in
  serial; report both.
- **AP not visible / UI not loading:** check `[WIFI]` and `[WEB]` lines exist;
  test from a second client device before concluding.
- **Config not persisting:** check for `[STORE] Configuration saved` at the
  moment of saving; a missing line means the save request never arrived.

For any failure: report serial output + failing check; the fix will be the
smallest possible change to the failing layer only.

---

## Phase 2 — Local LED output (Gate B)

Wire the WS2812B strip: GPIO 5 → 330 Ω → DIN, external 5 V PSU to strip,
common GND. Verify: default off state (no data), Test Lighting cycles all zone
colors on the strip, brightness and effects (Solid/Breathing/Comet) behave,
no-power timeout fades LEDs out. Record colors match the zone editor.

## Phase 3 — Real Heart Rate sensor (Gate C)

Standard Bluetooth SIG Heart Rate Service (`0x1818`) sensor. Verify: scan
finds it (type `HRS`), connect activates Heart Rate mode, live BPM in the
dashboard matches a reference (e.g. chest strap app), zones/colors follow BPM,
reconnect after sensor sleep/restart works, values survive the configured
data timeout (LEDs fade).

## Phase 4 — Favero Assioma power (Gate D)

Verify: scan finds the Assioma (type `CPS`), connect activates Power mode,
live watts match the Assioma app, zone/color follow power, pedaling cadence
irregularity does not break the BLE link over 10+ min, reconnect after sensor
sleep works.

## Phase 5 — Power ↔ Heart Rate switching (Gate E)

Verify: connecting an HR sensor switches mode automatically and disconnects
the power sensor (and vice versa); saved per-source devices restore
independently; both modes' zone boundaries and colors stay intact after
switching; reboot restores the last active mode. **Gates A–E together are the
precondition for any remote Light Node / ESP-NOW implementation.**

## Phase 6 — Web / Windows / Android clients (Gate F)

Each client connects to the Hub by IP, the dashboard reflects live state, and
— per the product boundary — closing every client changes nothing on the Hub.
Windows exe and Android debug APK come from CI artifacts.

## Phase 7 — Fault / reconnect testing (Gate G)

Sensor out of range, sensor battery pull, Wi-Fi AP loss/restore, Hub power
cycle mid-operation, 20+ rapid config changes, factory reset → defaults
return and Hub re-enters AP mode. No panics, no stuck states.

## Phase 8 — Endurance session (Gate H)

2–3 h continuous run with a live sensor. Watch serial for heap warnings,
watchdog resets or stack traces; dashboard stays responsive; config intact
afterwards. Record boot count = 1 for the whole session.