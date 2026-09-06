# Production Readiness Audit — ZoneGlow

Scope: stability and polish pass over the current baseline (Power + Heart Rate,
Hub web UI, Windows shell, Android shell, PC simulator). Findings are
categorized by release stage; items marked **(documented, not fixed)** were
left untouched per the audit rules. The current hardware-validation baseline
remains intact — no firmware architecture was changed in this pass.

Legend: A = must fix before hardware prototype · B = must fix before external
beta · C = must fix before Kickstarter/production · D = later/optional.

---

## A. MUST FIX BEFORE HARDWARE PROTOTYPE

| # | Finding | Area | Status |
|---|---|---|---|
| A1 | **Firmware device identity mismatch**: firmware AP SSID is `RGB-Watt-Controller` and mDNS host is `rgbwatt.local` (`src/firmware/src/main.cpp`), but the shells default to `zoneglow.local`. A phone/desktop that has never connected must be told the raw IP because `zoneglow.local` does not resolve. | firmware / shells | **(documented, not fixed)** — user-facing workaround exists (manual IP entry), but align mDNS + AP name before hardware validation on the bench |
| A2 | **Heap allocation inside BLE critical sections** (`src/firmware/src/BLEPower.cpp`) — stability risk on real hardware (known debt). | firmware | **(documented, not fixed)** — track under hub-hardware-validation.md gates |
| A3 | **Two config fields reach NVS without range validation**: `ledPin` is stored with no clamp at all (`to_int()` — the simulator even carries the comment "firmware: no clamp (known issue)") and `ftp` has no range check in `applyConfigPatch()`. Everything else (brightness, ledCount, smoothing, timeouts, effects) is clamped. A buggy/older client can push an invalid GPIO or FTP to NVS. Client-side import validation (new) protects the Import flow only. | firmware API | **(documented, not fixed)** — add clamps in `applyConfigPatch()` when firmware next opens for the prototype |
| A4 | **Anti-rollback ineffective** (known debt): versionCode comparison exists but unsigned/older OTA paths are not actually enforced on dev hardware. | firmware security | **(documented, not fixed)** — required before any OTA in the field (C1) |
| A5 | **OTA endpoint accepts unsigned images on dev builds** and `/api/ota` has no authentication. Combined with A6 this is remote-flash risk on any LAN the Hub joins. | firmware security | **(documented, not fixed)** — Gate requirement in `docs/hub-hardware-validation.md` |

## B. MUST FIX BEFORE EXTERNAL BETA

| # | Finding | Area | Status |
|---|---|---|---|
| B1 | **Open AP + unauthenticated web UI**: anyone in Wi-Fi range of the Hub AP (or on the LAN) can change all settings, flash OTA, or factory-reset. No user accounts by design — needs at minimum a setup-time PIN/token for the web API before strangers get the device. | security | **(documented, not fixed)** — deliberate scope decision; must be revisited for beta |
| B2 | **Cleartext HTTP/WS everywhere by design** (`network_security_config.xml` allows cleartext globally, Tauri CSP `null`, no HTTPS on device). Fine for LAN prototype; needs a documented threat-model decision + scoped cleartext config (pin to Hub host patterns instead of `cleartextTrafficPermitted="true"` global) before beta. | shells / network | **(documented, not fixed)** |
| B3 | **WebSocket has no protocol versioning** — telemetry JSON keys can drift between firmware and older shell/UI copies (Hub UI is version-locked to firmware, but Android/iOS packaged shells cache an iframe copy only per-connection; risk is low while the Hub always serves the UI). Add a `proto` field to telemetry before third-party clients appear. | protocol | **(documented, not fixed)** |
| B4 | **Exported config contains no integrity/authenticity check** (plain JSON, versioned schema `zoneglow.config` v1). Validation is strict on import, but a hand-edited file passes silently. Acceptable for v1; consider a checksum before beta. | config backup | **(documented, not fixed)** |
| B5 | **Demo Mode is client-driven**: the demo zone cycle runs from the UI via the existing `/api/simulation` endpoint. If the client dies mid-demo (battery pull, WebView kill), the Hub stays in Simulation Mode on the last value until a command arrives. Mitigations shipped: `pagehide` best-effort stop + easy Exit; hub-side auto-timeout of Simulation Mode would close the gap. | demo / firmware | **(documented, not fixed)** — candidate follow-up |
| B6 | **Android WebView download handling**: configuration Export relies on the anchor-download fallback + a copyable textarea because WebView `DownloadListener` is not wired in the Capacitor shell. Works (copy path), but a native save/share flow would be better for beta. | Android shell | **(documented, not fixed)** |
| B7 | **Diagnostics contain device identifiers** (deviceId, serial, IPs) in the Copy-diagnostics clipboard blob — fine for support, but document privacy wording before beta ships. | privacy | **(documented, not fixed)** |

## C. MUST FIX BEFORE KICKSTARTER / PRODUCTION

| # | Finding | Area |
|---|---|---|
| C1 | Enforce signed-OTA + effective anti-rollback (production build flags exist; enforcement is not wired — see A4). |
| C2 | Auth/PIN for the web API (see B1) plus per-device provisioning story. |
| C3 | HTTPS or TLS transport option on the Hub; scoped cleartext in shells (B2). |
| C4 | Telemetry protocol versioning (B3). |
| C5 | Brand/legal: trademark clearance for the final name, then execute `docs/rebrand-checklist.md` **in its listed order** (firmware mDNS first). |
| C6 | Icon/splash asset pass (launcher icons, Tauri icons, favicon) + SmartScreen/code-signing story for `ZoneGlow.exe` (currently unsigned — SmartScreen warns; "standalone exe shows nothing" was fixed earlier, but signing remains). |
| C7 | Hub-side Simulation/Demo auto-timeout (see B5) so a lost client cannot strand the lights in demo state. |
| C8 | Manufacturing: `/api/info` `deviceId`/`serial` provisioning flow (currently placeholder values on device). |

## D. LATER / OPTIONAL

| # | Finding | Area |
|---|---|---|
| D1 | Config export schema v2: include/exclude presets, multiple profiles per file. |
| D2 | Onboarding: localized copy + final brand assets in wizard. |
| D3 | i18n pass over all user-facing strings (currently English-only). |
| D4 | Telemetry `millis()` rollover-sensitive arithmetic in firmware C++ (`uint32_t` subtraction patterns) — audited visually as safe (differences only), no automated test practical outside the target; revisit with HIL tests. |
| D5 | Developer panel (`devpanel.html`) rebrand + access control before shipping dev units to third parties. |
| D6 | Rate-limiting for `/api/config` and `/api/ota` (currently unthrottled on LAN). |

---

## What this pass DID fix / add (for context)

- Startup UX: 1.2 s branded splash in both shells, never artificially delaying
  startup; splash yields to "Searching for Hub…" / "Connecting…" states;
  auto-reconnect everywhere (shell probes + UI WebSocket watchdog).
- First-run onboarding: Welcome → Hub → Sensor → Mode → Test Lights → Ready,
  skippable, persisted per browser/WebView, re-launchable from About.
- About/Diagnostics view: app/firmware version, device id, connection + WS/API
  status, active source + sensor, one-tap "Copy diagnostics".
- Configuration backup: versioned (`zoneglow.config` v1) JSON export/import,
  full client-side validation, atomic apply (nothing POSTed until the whole
  file validates), secrets and sensor pairings never exported.
- Demo Mode: polished user-facing zone cycle (Z1→Zmax→back down) via the
  existing `/api/simulation` API — zero firmware changes, clearly labelled,
  one-tap exit; developer Simulation Mode remains hidden in the dev panel.
- Error states: per-mode sensor wording ("No power sensor connected" / "No
  heart rate sensor connected"), "Connection to Hub lost — reconnecting…"
  banner on WebSocket loss, "Demo (simulated)" status.
- Tests: `test_edge_cases.py` (dropouts, invalid/zero HR, reconnect machine,
  rapid switching, persistence reload, invalid patches, fade) and
  `test-config-backup.cjs` (export schema, import validation, atomic-apply
  guarantee, demo lifecycle, onboarding persistence).
- CI: `windows-debug.yml` builds `ZoneGlow.exe` on every push (Windows build
  previously had no CI at all).

## Regression status at time of writing

- Simulator suite: 55 tests OK (plus the new edge-case tests).
- Node shell tests: transport 13/13, telemetry watchdog 19/19, config backup suite — all green locally.
- Android debug APK: built via `.github/workflows/android-debug.yml`.
- Windows exe: built via `.github/workflows/windows-debug.yml` (new).
- Real-hardware validation: still pending per `docs/hub-hardware-validation.md`
  (Gates A–E) — none of the above substitutes for it.