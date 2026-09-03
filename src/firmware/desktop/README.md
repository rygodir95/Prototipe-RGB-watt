# ZoneGlow Desktop (Windows proof-of-concept)

A minimal Windows desktop application that bundles the **existing** ZoneGlow
web UI (Dashboard / Devices / Zones / Settings) locally and talks to the
ZoneGlow controller backend over REST + WebSocket only. It is a shell/window
only — it never becomes the controller. All BLE, power/HR processing, zone
logic, LED control and stored settings stay on the ESP32 (or, in development,
on the PC simulator).

## Architecture

```
ZoneGlow.exe (Tauri window + local shell server on 127.0.0.1)
 ├─ serves the bundled ZoneGlow web UI directly in the window (no iframe)
 └─ /api/*  → forwarded to the configured backend
    /ws     → tunnelled to the configured backend
        ↕
Development:  PC Simulator (tools/pc-simulator) at http://localhost:8080
Future:       ESP32 ZoneGlow Controller on the LAN (same REST/WS API)
```

- The window loads the ZoneGlow UI **from the shell itself**, so the UI opens
  and renders normally even when the backend is offline — no blank page, no
  browser error.
- Only REST calls (`/api/...`) and the telemetry WebSocket (`/ws`) reach the
  backend.
- `data/web/` (the firmware's embedded UI) stays the **single source of
  truth** — see "Web UI staging".

### Web UI staging (build step, not a second copy)

`scripts/sync-web.js` stages a byte-identical copy of the firmware's
`data/web/` into `src-tauri/generated-web/` (git-ignored, never edited by
hand). It runs automatically before `tauri dev` / `tauri build`
(`beforeDevCommand` / `beforeBuildCommand` in `tauri.conf.json`), and the
staged copy ships inside `ZoneGlow.exe` via `bundle.resources`.

### Local shell server (`src-tauri/src/server.rs`)

A localhost-only HTTP server inside the app (std-only, no extra crates):

- serves the staged UI at `/`, `/style.css`, `/app.js`;
- forwards `/api/*` to the backend — `GET /api/config` **long-polls** while
  the backend is offline so the UI's startup completes the moment the backend
  returns; every other call fails fast with 502;
- `/ws` is a blind TCP tunnel (handshake + frames pass through verbatim), so
  the UI's own WebSocket reconnect loop just works.

### Backend transport abstraction (`src-tauri/src/transport.rs`)

- `SimulatorTransport` — development default, `http://localhost:8080`
  (override with the `ZONEGLOW_BACKEND_URL` environment variable).
- `Esp32Transport` — placeholder, **not implemented yet**. The ESP32 serves
  the same REST/WS API, so enabling it later is just selecting that
  transport with the controller's LAN address.

### Offline / reconnect behaviour

- Backend down at startup: the UI renders normally and shows **Disconnected**
  (the UI's own status pill, set by the injected `shell_init.js`, which probes
  `/api/info` every 2 s through the shell server).
- Backend goes down while running: the WebSocket tunnel closes, the UI's
  `app.js` retries every 2 s, the pill flips to Disconnected, the window stays
  fully interactive.
- Backend returns: the pending config request resolves, the WebSocket
  reconnects, telemetry drives the UI again. Nothing is reloaded.
- The Developer/Test Panel (`/dev/`) is not exposed in the desktop app.

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

   A real desktop window opens showing the existing ZoneGlow UI. The order
   does not matter: with the simulator off the window still opens, renders and
   shows Disconnected; starting the simulator makes the data flow.

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
- The shell server binds 127.0.0.1 only and never exits on its own.
- This PoC was authored on a non-Windows build environment, so the Windows
  `.exe` must be produced on a Windows machine with the steps above; all
  backend-facing behaviour (REST proxy, config long-poll, WebSocket tunnelling,
  offline/reconnect, mode switching) was verified against the running simulator
  with the full simulator test suite passing (45/45).