# ESP32 RGB Watt Zone Controller

A **standalone ESP32 device** that reads live cycling power over Bluetooth Low
Energy (BLE), computes your current power zone, smoothly interpolates an RGB
colour from the power value and drives an addressable LED strip — all
configurable from a modern, responsive web interface.

No PC, Windows, Python or OpenRGB is required during normal operation.

```
BLE Power Source  →  Watts  →  Smoothing (EMA)  →  Zone calc  →  Colour interpolation  →  LED strip
```

---

## Features

- **Generic BLE Cycling Power Service (CPS)** client — works with any power
  meter *or* smart trainer that exposes standard CPS data.
- **FTMS fallback** — smart trainers exposing power only through the Fitness
  Machine Service (Indoor Bike Data) are also supported automatically.
- Configurable **EMA smoothing** and optional **zone-boundary hysteresis**.
- **5 / 6 / 7 zone** models (default 7), fully editable names, boundaries and colours.
- **Continuous colour interpolation** between adjacent zone colours — no hard switching.
- Addressable **WS2812B / SK6812** support with configurable GPIO, count and brightness.
- **LED effects**: Solid, Breathing and Comet — all driven by the current power colour.
- **No-power fade-out** to an inactive state after a configurable timeout.
- Clear internal **state machine** surfaced live in the UI.
- **Modern web dashboard** with light / dark / system themes, live WebSocket updates,
  device manager, visual zone editor and a **simulation mode**.
- **Over-the-air (OTA) firmware updates** straight from the web UI — no USB needed.
- **Persistent config** in NVS with **factory reset**.
- **Wi-Fi**: connects to your network, or falls back to its own Access Point.
- Non-blocking architecture (`millis()`, async callbacks, no long `delay()`).

---

## Hardware

| Part            | Notes                                             |
|-----------------|---------------------------------------------------|
| ESP32 Dev Module| Any generic ESP32 (`esp32dev`)                    |
| LED strip       | WS2812B or SK6812 addressable RGB                 |
| 5V PSU          | Sized for your LED count (~60mA per LED at full white) |
| 330–470Ω resistor | In series with the data line (recommended)      |
| 1000µF capacitor | Across strip 5V/GND (recommended)                |

### Wiring (defaults)

```
ESP32 GPIO 5  ──[330Ω]──►  LED DIN
ESP32 GND     ───────────  LED GND  ───  PSU GND
PSU 5V        ───────────  LED 5V
```

> Power the strip from an external 5V supply, not the ESP32's 5V pin, for
> anything beyond a few LEDs. Always share a common ground.

Pin, LED count, type and brightness are all changeable in **Settings**.

---

## Build & Flash (PlatformIO)

```bash
# Install PlatformIO Core (if needed)
pip install platformio

# From the project root:
pio run                     # compile
pio run --target upload     # flash over USB
pio device monitor          # serial @ 115200
```

The web UI is **embedded in the firmware** (`include/WebContent.h`, generated
from `data/web/`), so **no filesystem upload is needed**.

If you edit the UI under `data/web/`, regenerate the header:

```bash
python3 tools/embed_web.py
pio run --target upload
```

---

## First-time setup

1. On first boot (no Wi-Fi configured) the ESP32 starts an Access Point:
   **`RGB-Watt-Controller`**.
2. Connect to it and open `http://192.168.4.1`.
3. (Optional) In **Settings → Wi-Fi**, enter your home network; the device
   reboots and joins it. It's then reachable at `http://rgbwatt.local`.
4. Go to **Power Source → Scan**, select your power meter / trainer, **Connect**.
5. Start pedalling — the strip colour follows your power. Or use **Simulation**
   on the dashboard to test without hardware.

The core RGB controller works fully offline; internet is never required.

---

## BLE Compatibility

The firmware implements the **standard Bluetooth SIG Cycling Power Service**
and, as a fallback, the **Fitness Machine Service (FTMS)**:

- CPS Service `0x1818` → Cycling Power Measurement `0x2A63` (instantaneous power, W)
- FTMS Service `0x1826` → Indoor Bike Data `0x2AD2` (instantaneous power field, W)

On connect the device tries CPS first, then FTMS, and feeds either into the same
pipeline. Any device advertising one of these services is discoverable, including:

- **Power meters:** Favero Assioma, Garmin Rally, Wahoo POWRLINK, 4iiii,
  SRAM/Quarq, Magene, Elite, and other standard CPS meters.
- **Smart trainers** via CPS or FTMS: many Tacx, Wahoo KICKR and Elite trainers.

> Trainers using a fully proprietary protocol (neither CPS nor FTMS power) still
> require additional protocol support and are not covered. No manufacturer-specific
> code is used — every compatible source flows through the same pipeline.

### Firmware Update (OTA)

In **Settings → Firmware Update (OTA)**, choose a compiled `firmware.bin`
(`.pio/build/esp32dev/firmware.bin`) and upload it. The device flashes and
reboots automatically — no USB cable required after the first flash.

---

## Configuration (persisted to NVS)

FTP, zone count/names/boundaries/colours, LED pin/count/type/brightness,
smoothing, hysteresis, power timeout, selected power source, auto-reconnect,
Wi-Fi credentials, UI theme and debug flag. **Factory Reset** restores defaults.

### Defaults

FTP 221 W · 7 zones (Recovery → Neuromuscular) · Blue→Cyan→Green→Yellow→Orange→Red→Deep Red ·
GPIO 5 · 60 LEDs · WS2812B · 100% brightness · smoothing on · auto-reconnect on.

---

## Project Structure

```
ESP32-RGB-Watt-Controller/
├── platformio.ini
├── include/            Config, AppState, Storage, PowerProcessor, PowerZones,
│                       LEDController, BLEPower, Simulation, WebInterface, WebContent(generated)
├── src/                matching .cpp implementations + main.cpp
├── data/web/           index.html, style.css, app.js  (UI source)
├── tools/embed_web.py  regenerates include/WebContent.h
└── README.md
```

---

## Serial Debug

At 115200 baud (toggle in Settings):

```
[BLE] Scanning...
[BLE] Found Favero Assioma
[BLE] Connecting...
[BLE] Connected
[POWER] 237 W  Smoothed: 234 W
[ZONE] Zone 4 - Threshold
[RGB] 255, 180, 0
```
