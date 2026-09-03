# ZoneGlow Desktop (Windows proof-of-concept)

A minimal Windows desktop application that reuses the **existing** ZoneGlow
web UI (Dashboard / Devices / Zones / Settings) unchanged, served by the
**existing** PC simulator backend. It is a shell/window only — it never becomes
the controller. All BLE, power/HR processing, zone logic, LED control and
stored settings stay on the ESP32 (or, in development, on the simulator).

## Architecture

```
Development (this milestone):

  ZoneGlow.exe (Tauri window + connection shell)
        ↕  HTTP REST + WebSocket (loaded from the backend)
  PC Simulator (tools/pc-simulator) at http://localhost:8080
        ↕
  virtual ESP32 / virtual BLE sensors / virtual LED behaviour

Future production (same shell, different backend address):

  ZoneGlow.exe
        ↕
  ESP32 ZoneGlow Controller
        ↕ BLE
  Power Meter / Smart Trainer / Heart Rate Monitor
        ↕
  LED strip
```

The UI is **loaded from the backend itself** (the simulator serves
`data/web/`, exactly what the ESP32 serves), so no frontend files are copied
or modified, and relative REST paths (`/api/config`, `/api/devices`, …) and
the WebSocket endpoint (`/ws`) work unchanged.

### Backend transport abstraction

`src/transport.js` is the single place that knows how to reach a backend:

- `SimulatorTransport` — default, `http://localhost:8080`
- `Esp32Transport` — placeholder, **not implemented yet**; pointing the shell
  at the controller's LAN address is all that will be needed, because the UI,
  REST API and telemetry are identical.

The backend address is configurable at runtime (disconnected overlay →
"Backend address") and persisted in `localStorage`; the development default is
`http://localhost:8080`.

### Connection states (shell-level only)

`Connected` / `Connecting…` / `Disconnected`, shown in a slim bar above the
UI. If the backend is unavailable the window stays open with a clear
disconnected state and retries every 2 s. When the backend returns, the
overlay hides and the embedded UI reconnects its WebSocket on its own
(`app.js` retries on close). The Developer/Test Panel (`/dev/`) is **not**
exposed anywhere in the desktop navigation.

## Prerequisites (Windows 10/11)

- Node.js 18+ (for `npm`)
- Rust (stable) with the **MSVC** toolchain — https://rustup.rs
- WebView2 Runtime (preinstalled on Windows 11; the Tauri build handles most
  Windows 10 setups automatically)

## Run (development)

1. Start the PC simulator (unchanged, independently runnable):

   ```
   cd tools/pc-simulator
   run_simulator.bat        # or: python simulator.py
   ```

2. Start the desktop app:

   ```
   cd desktop
   npm install
   npm run dev
   ```

   A real desktop window opens, connects to `http://localhost:8080` and shows
   the existing ZoneGlow UI with live telemetry.

## Build ZoneGlow.exe

```
cd desktop
npm install
npm run build:exe
```

- Executable: `desktop/src-tauri/target/release/ZoneGlow.exe`
- The regular `npm run build` additionally produces an NSIS installer (not
  required for this milestone).

No auto updater, code signing, installer work, tray, USB or real-ESP32
communication is included — those are future tasks.

## Notes / limitations

- The simulator is **not** embedded in or auto-launched by the app; run it
  separately (keeping it independently runnable, as required).
- If the backend is not reachable, the window stays open in the Disconnected
  state — the app never exits on its own.
- This PoC was authored on a non-Windows build environment, so the Windows
  `.exe` must be produced on a Windows machine with the steps above; all
  backend-facing behaviour (probe, REST, WebSocket telemetry, mode switching)
  was verified against the running simulator with the full simulator test
  suite passing (45/45).