# Rebrand Checklist — ZoneGlow → future brand

**Status: reference only. The rename has NOT been performed.** "MetryLoom" is a
candidate brand pending trademark clearance; every ZoneGlow-specific reference
that a future rename must touch is inventoried here so the rename becomes a
mechanical sweep instead of an archaeology project.

Scope rule: user-visible names, identifiers, assets and artifact names change;
protocol/API semantics must NOT change in the same pass.

---

## 1. Visible product / app names (user-facing strings)

| Location | Current value |
|---|---|
| `src/firmware/data/web/index.html` | `<title>ZoneGlow</title>`, brand `<h1>ZoneGlow</h1>`, sub "Training Zone Lighting" |
| `src/firmware/data/web/app.js` | toasts/diagnostics text ("ZoneGlow diagnostics", "Welcome to ZoneGlow", onboarding copy) |
| `src/firmware/desktop/src/index.html` | `<title>ZoneGlow</title>`, overlay brand `<h1>ZoneGlow</h1>` |
| `mobile/capacitor/www/index.html` | `<title>ZoneGlow</title>`, overlay brand `<h1>ZoneGlow</h1>`, iframe title, status bar "ZoneGlow Hub" |
| `mobile/capacitor/www/shell.js` | overlay copy ("Looking for the ZoneGlow Hub…") |
| `src/firmware/desktop/src/shell.js` | overlay copy ("Looking for the ZoneGlow Hub…") |
| `mobile/capacitor/www/shell.css`, `src/firmware/desktop/src/shell.css` | header comments only (not user-visible) |
| `src/firmware/tools/pc-simulator/devpanel.html` | developer panel branding (low priority — internal tool) |

> Note: `src/firmware/include/WebContent.h` is **generated** from
> `data/web/` by `tools/embed_web.py` — never hand-edit; regenerate after
> renaming strings in `data/web/`. Same for
> `src/firmware/desktop/src-tauri/generated-web/` (desktop bundle).

## 2. Android package / application metadata

| Location | Current value |
|---|---|
| `mobile/capacitor/capacitor.config.json` | `appId: "com.zoneglow.app"`, `appName: "ZoneGlow"` |
| `mobile/capacitor/android/app/build.gradle` | `applicationId "com.zoneglow.app"`, namespace |
| `mobile/capacitor/android/app/src/main/res/values/strings.xml` | app title |
| `mobile/capacitor/android/app/src/main/AndroidManifest.xml` | `android:label` (via strings), FileProvider authorities `com.zoneglow.app.fileprovider` |
| `mobile/capacitor/android/app/src/main/res/xml/network_security_config.xml` | comments only |
| `mobile/capacitor/package.json` | name/description |
| `.github/workflows/android-debug.yml` | artifact names ("ZoneGlow Android debug APK" etc.) |

⚠️ Changing `applicationId` after a public release breaks update continuity —
decide the final package id **before** any external beta.

## 3. Windows / Tauri metadata

| Location | Current value |
|---|---|
| `src/firmware/desktop/src-tauri/tauri.conf.json` | `productName: "ZoneGlow"`, `mainBinaryName: "ZoneGlow"`, `identifier: "com.zoneglow.desktop"`, window title "ZoneGlow — Training Zone Lighting" |
| `src/firmware/desktop/src-tauri/Cargo.toml` | package name `zoneglow-desktop` (bin name) |
| `src/firmware/desktop/package.json` | name `zoneglow-desktop` |
| `src/firmware/desktop/src-tauri/src/main.rs` | comment only + error string |
| `.github/workflows/windows-debug.yml` | artifact name `ZoneGlow-windows-exe` |

## 4. Web title / favicon / assets

| Location | Current value |
|---|---|
| `src/firmware/data/web/index.html` | `<title>` (see above); **no favicon link exists yet** — adding the final brand favicon belongs to the rebrand pass |
| Hub UI CSS | brand dot gradient colors (`#ff7a59 → #ff3d68` mobile shell, blue desktop shell) — revisit with final brand palette |

## 5. Firmware UI strings + device identity (ESP32)

| Location | Current value | Note |
|---|---|---|
| `src/firmware/src/main.cpp` | `WiFi.softAP("RGB-Watt-Controller")` | **still the old product name** — AP SSID shown to users during setup |
| `src/firmware/src/main.cpp` | `MDNS.begin("rgbwatt")` → `rgbwatt.local` | mDNS hostname; shells default to `zoneglow.local` which the firmware **does not answer** — rename must align firmware mDNS with the shell default (or vice versa) |
| `src/firmware/data/web/index.html` (embedded) | ZoneGlow strings | via `WebContent.h` regeneration |
| `/api/info` `deviceId`/`serial` strings | firmware-defined | check `WebInterface.cpp` when renaming |

## 6. README / docs / developer docs

| Location |
|---|
| `README.md` (root) |
| `mobile/README.md` |
| `src/firmware/README.md`, `src/firmware/TESTING.md`, `src/firmware/TEST_REPORT.md` |
| `src/firmware/desktop/README.md` |
| `src/firmware/tools/pc-simulator/README.md`, `TEST_SCENARIOS.md` |
| `docs/*.md` (this file, `docs/production-readiness.md`, protocol & validation docs) |
| `CLAUDE.md`, `AGENTS.md` (project instructions mention the brand) |

## 7. Icons / splash assets

| Location | Current value |
|---|---|
| `mobile/capacitor/android/app/src/main/res/**/ic_launcher*.xml` + `drawable*/ic_launcher_*` | Capacitor default assets — replace with final brand icon set |
| `src/firmware/desktop/src-tauri/icons/icon.ico`, `icon.png` | current placeholder icons |
| Shell splash/brand blocks (`#splash` in both shells) | text + CSS dot animation — swap for final brand mark/animation |
| Hub web UI brand dot | CSS gradient |

## 8. Build / workflow / artifact names

| Location | Current value |
|---|---|
| `.github/workflows/android-debug.yml` | workflow name, artifact name |
| `.github/workflows/windows-debug.yml` | workflow name, artifact name `ZoneGlow-windows-exe` |
| Tauri binary/bundle names | `ZoneGlow.exe`, NSIS bundle |
| Test scripts/console tags | `[ZoneGlow][shell]`, `[ZoneGlow][transport]` log prefixes (`adb logcat` filters rely on them — update docs together) |

## 9. Hardcoded identifiers (non-UI)

| Kind | Current value | Location |
|---|---|---|
| localStorage keys | `zoneglow.hub.url` | `mobile/capacitor/www/transport.js` |
| localStorage keys | `zoneglow.backend.url` | `src/firmware/desktop/src/transport.js` |
| localStorage keys | `zoneglow.onboarding.done`, `theme` | `src/firmware/data/web/app.js` |
| Default Hub URL | `http://zoneglow.local` | mobile transport (must match firmware mDNS, see §5) |
| Tauri identifier | `com.zoneglow.desktop` | tauri.conf.json |
| Android appId / authority | `com.zoneglow.app`, `.fileprovider` | see §2 |
| JS global | `ZoneGlowTransport` | both shells + Node tests import it by name |
| Config backup schema tag | `"zoneglow.config"` | app.js export/import + regression test |
| WebStorage key for onboarding | see above | survives rename only if migrated |

> localStorage keys and the config-backup schema tag are **persistence
> formats**: renaming them silently orphans user data (saved Hub address,
> onboarding completion, old config backups). Any rename must either keep
> these as-is or ship a read-fallback for the old keys.

## 10. Rename procedure (suggested order)

1. Trademark clearance → freeze the final name, package ids, mDNS hostname.
2. Align firmware device identity (AP SSID, mDNS) FIRST — shells default URL
   depends on it.
3. Web UI strings (`data/web/`) → regenerate `WebContent.h` → resync
   `generated-web/` (embed_web.py + copy).
4. Shells (mobile + desktop): strings, splash, localStorage key migration.
5. Package ids / identifiers / artifact names + CI workflows.
6. Icons/splash assets (Android launcher, Tauri icons, favicon).
7. Docs sweep (§6), log-prefix sweep + test updates.
8. Run: simulator suite, Node shell/watchdog tests, both CI builds.