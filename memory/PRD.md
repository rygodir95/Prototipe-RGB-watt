# ESP32 RGB Watt Zone Controller — PRD

## Problem Statement
Standalone ESP32 firmware (PlatformIO/Arduino) that reads live cycling power over
BLE Cycling Power Service, smooths it (EMA), computes power zones, continuously
interpolates an RGB colour, and drives an addressable LED strip. Includes a modern
web configuration UI, persistent NVS config, Wi-Fi (AP fallback), auto-reconnect,
and simulation mode. No PC/Windows/Python/OpenRGB during operation.

## User Choices
- Board: Generic ESP32 Dev Module (esp32dev)
- UI hosting: embedded in firmware (PROGMEM) — no filesystem upload (agent recommendation)
- Live transport: WebSocket
- LED defaults: GPIO 5, 60 LEDs, WS2812B
- Deliverable: compile-clean PlatformIO project only

## Architecture
BLE Power Source → Watts → EMA smoothing → Zone calc (+hysteresis) → Colour interpolation → LED strip
- Modular: Config, AppState, Storage(NVS), PowerProcessor, PowerZones, LEDController(Adafruit_NeoPixel),
  BLEPower(NimBLE CPS client), Simulation, WebInterface(ESPAsyncWebServer + WS), WebContent(generated), main.cpp
- UI source in data/web/*, embedded via tools/embed_web.py → include/WebContent.h
- Libs: NimBLE-Arduino 1.4, Adafruit NeoPixel, esp32async AsyncTCP + ESPAsyncWebServer, ArduinoJson 7

## Implemented (2026-06)
- All 13 phases: LED control, BLE CPS scan/connect/notify/parse, EMA smoothing, 5/6/7 zones,
  continuous colour interpolation, NVS persistence + factory reset, source selection + auto-reconnect,
  web dashboard (live WS), zone editor, settings, light/dark/system theme, simulation mode,
  graceful error handling, non-blocking loop.
- State machine: STARTING/SCANNING/CONNECTING/CONNECTED/RECEIVING_POWER/DISCONNECTED/RECONNECTING/ERROR
- Wi-Fi STA with AP fallback (SSID RGB-Watt-Controller), mDNS rgbwatt.local
- **Verified: `pio run` compiles cleanly** (RAM 17%, Flash 36.9%, 0 project warnings)

## Notes / Limitations
- Firmware cannot be run/tested in this cloud pod (no ESP32 hardware). Verification = clean compile.
- Only standard BLE CPS (0x1818/0x2A63) supported. FTMS-only / proprietary trainers need extra protocol work (documented in README).

## Backlog (P1/P2)
- FTMS service support for trainers that don't expose CPS
- Per-LED gradient / effects (comet, breathing) instead of solid fill
- OTA firmware updates
- Multi-source averaging / cadence & HR display
- Config import/export (JSON download/upload)
