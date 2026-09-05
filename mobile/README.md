# ZoneGlow Mobile (Android PoC)

Minimal Android proof-of-concept app for ZoneGlow. It is a thin **UI/configuration
client** for the ZoneGlow Hub over Wi-Fi/LAN — nothing more.

```
ZoneGlow Android App  ↔  Wi-Fi/LAN  ↔  ZoneGlow Hub  ↔  BLE sensors  ↔  LED
```

**The phone never talks to BLE sensors.** The Hub stays fully standalone and
remains responsible for BLE, zone logic, LED control, settings, persistence and
telemetry. No firmware behavior was changed and the Hub API is untouched.

## Architecture

The app is a [Capacitor](https://capacitorjs.com) Android shell that reuses the
**existing** ZoneGlow web UI (`src/firmware/data/web/`) — the Hub serves it:

1. The shell (`mobile/capacitor/www/`) shows a connection screen with a
   configurable Hub address and probes `GET /api/info` every 2 seconds.
2. Once the Hub answers, the shell loads the Hub's own copy of the ZoneGlow UI
   (Dashboard / Devices / Zones / Settings) in the app view.
3. Because the UI is served by the Hub itself, all relative REST calls and the
   WebSocket telemetry connection are same-origin — no CORS changes, no
   firmware changes, no native proxy code, and **the web UI remains the single
   source of truth** (identical files the ESP32 serves).
4. If the Hub disappears, the shell switches to `Reconnecting…` (the embedded UI
   keeps its own WebSocket retry running); after sustained loss it shows
   `Disconnected` and keeps probing automatically.

Connection states: **Connected · Connecting… · Disconnected · Reconnecting…**

Why the UI is streamed from the Hub instead of bundled: a bundled copy would
call `/api/...` against the app's local origin and fail — supporting it would
require CORS headers in the Hub firmware or a native HTTP/WebSocket proxy, both
of which this PoC explicitly avoids. This mirrors the desktop shell's
backend-served UI approach.

The last **successfully connected** Hub address is stored on the phone
(`localStorage`) and is the first thing probed on the next launch.

## What works in the PoC

- Existing ZoneGlow UI: Dashboard, Devices, Zones, Settings
- Power **and** Heart Rate telemetry via the Hub's WebSocket
- Simulation Mode (whenever the connected backend supports it — the PC
  simulator does; the real Hub firmware does too)
- Automatic reconnect with clear connection states
- Configurable Hub address, persisted on the phone

## Deliberately NOT included

Direct BLE support, background services, cloud features, accounts/login, push
notifications, iOS support, ESP-NOW, Light Node features, ANT+, multi-user,
any firmware changes.

## Layout

```
mobile/
  capacitor/          Capacitor project (shell webDir + generated Android app)
    www/              Connection shell only (index.html, shell.js, transport.js, shell.css)
    android/          Generated Android platform (app source, gradle, manifests)
  scripts/
    prepare.sh       One-shot: npm install + cap add/sync android
  README.md           This file
```

All native code lives under `mobile/` — nothing else in the repository is
affected. Hub firmware, Hub API, desktop shell and web UI are unchanged.

## Development

Prerequisites: Node.js 18+.

```bash
# 1. Start the PC simulator (acts as the Hub on your PC)
src/firmware/tools/pc-simulator/run_simulator.bat     # Windows

# 2. Prepare the Android project (installs deps, generates/syncs platform)
mobile/scripts/prepare.sh

# 3. Build & install on a connected device / emulator
cd mobile/capacitor/android
./gradlew installDebug
```

## Setting / changing the Hub address

- On the shell's connection screen, type the address and press **Connect**:
  `http://zoneglow.local`, an IP like `192.168.1.50`, or `host:port`
  (e.g. `10.0.2.2:8080`). Scheme is optional (`http://` is assumed).
- The value is saved on the phone after a **successful** connection and
  re-probed automatically on every launch.
- Note: Android's WebView usually does **not** resolve mDNS names
  (`zoneglow.local`) — the IP address is the reliable option on a real device.

## Testing against the PC simulator

The simulator serves the same UI and API as the Hub on `http://0.0.0.0:8080`.

- **Android emulator:** the emulator reaches the host PC via `10.0.2.2`, so set
  the Hub address to `10.0.2.2:8080`.
- **Physical device:** connect the phone to the same Wi-Fi/LAN as the PC and
  use the PC's LAN IP, e.g. `192.168.1.50:8080` (find it with `ipconfig` /
  `ip addr`).

## Android build (debug APK)

Prerequisites: JDK 17, Android SDK (API 34 platform + build-tools), `ANDROID_HOME` set.

```bash
cd mobile/capacitor/android
./gradlew assembleDebug
# APK: mobile/capacitor/android/app/build/outputs/apk/debug/app-debug.apk
```

Or open `mobile/capacitor/android` in **Android Studio** and press Run.
In Android Studio: SDK location is written to `local.properties` automatically
(also git-ignored).

## Network security (local HTTP/WebSocket)

Hubs on a LAN use plain `http://` and `ws://`. Two pieces make that work:

1. `capacitor.config.json` sets `server.androidScheme: "http"` — the shell
   itself is served from `http://localhost`, so embedding the Hub's
   `http://` UI is not treated as mixed content.
2. `android/app/src/main/res/xml/network_security_config.xml` permits cleartext
   traffic (referenced from `AndroidManifest.xml`). This is required for
   arbitrary LAN IPs; the app performs **no** sensitive/cloud traffic, so this
   is acceptable for the PoC. For a production release, restrict the config to
   your known Hub addresses.

## Troubleshooting

- **"Disconnected" although the simulator runs:** check the address
  (emulator: `10.0.2.2:8080`, device: PC LAN IP + `:8080`) and that your
  firewall allows inbound TCP 8080 on the PC.
- **mDNS name never connects:** use the Hub's IP instead (see above).