// Offline-start regression test for the ZoneGlow desktop UI (jsdom).
//
// Reproduces the real Windows desktop scenario on any platform:
//   1. ZoneGlow.exe starts with NO backend connected: the bundled UI plus
//      the bundled default-config.json must render every Zones and Settings
//      field with the authoritative defaults, the status stays
//      "Disconnected", and backend-dependent controls are disabled (no
//      false saves).
//   2. The backend appears later: its real config replaces the offline
//      defaults, controls re-enable, the telemetry WebSocket keeps
//      retrying, and no page reload is needed.
//
// The real UI (data/web) and the generated default-config.json are served by
// a local server that mimics the desktop shell: /api/config is HELD while
// the backend is offline (long-poll), exactly like the shell's proxy.

import assert from "node:assert";
import { spawnSync } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.resolve(__dirname, "..", "..", "data", "web");
const EXPORTER = path.resolve(__dirname, "..", "..", "tools", "pc-simulator", "export_default_config.py");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "zoneglow-offline-ui-"));
const DEFAULTS_PATH = path.join(TMP, "default-config.json");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function exportDefaults() {
  for (const candidate of ["python", "python3"]) {
    const r = spawnSync(candidate, [EXPORTER, DEFAULTS_PATH], { encoding: "utf8" });
    if (r.status === 0) return;
  }
  throw new Error("python is required to generate default-config.json (authoritative defaults: tools/pc-simulator/pipeline.py)");
}

// ---- 1. the bundled defaults come from the single authoritative source ----
exportDefaults();
const defaults = JSON.parse(fs.readFileSync(DEFAULTS_PATH, "utf8"));
assert.equal(defaults.ftp, 221, "default FTP must be 221 W");
assert.equal(defaults.zoneCount, 7, "default power zone count must be 7");
assert.equal(defaults.zones.length, 7, "default power zones must be exported");
assert.equal(defaults.zones[6].name, "Z7 · Neuromuscular");
assert.equal(defaults.hrMax, 190, "default Max HR must be 190 BPM");
assert.equal(defaults.hrZones.length, 5, "5 default HR zones must be exported");
assert.equal(defaults.hrZones[4].name, "Z5 · Maximum");
assert.equal(defaults.hrZones[4].max, 190);
assert.equal(defaults.smoothing, 45);
assert.equal(defaults.powerTimeout, 5000);
assert.equal(defaults.hysteresis, 5);
assert.equal(defaults.ledPin, 5);
assert.equal(defaults.ledCount, 60);
assert.equal(defaults.brightness, 100);
assert.equal(defaults.ledType, "WS2812B");
assert.equal(defaults.ledEffect, 0);
assert.equal(defaults.autoReconnect, true);
console.log("PASS  bundled default-config.json matches the authoritative simulator/firmware defaults");

// ---- 2. the config the backend will serve once it appears (must differ) ----
const BACKEND_CONFIG = {
  controlSource: "hr",
  ftp: 250, smoothing: 30, powerTimeout: 8000, hysteresis: 12, zoneCount: 5,
  ledPin: 13, ledCount: 90, brightness: 55, ledType: "SK6812", ledEffect: 2,
  autoReconnect: false, sourceAddr: "aa:bb:cc:dd:ee:ff", sourceName: "ZG Trainer",
  wifiSsid: "MyWifi", theme: "dark", debug: false,
  hrMax: 185, hrZonesCustom: false, hrSourceAddr: "11:22:33:44:55:66", hrSourceName: "ZG Strap",
  zones: [
    { name: "Custom A", min: 0, max: 124, color: "#111111" },
    { name: "Custom B", min: 125, max: 168, color: "#222222" },
    { name: "Custom C", min: 169, max: 201, color: "#333333" },
    { name: "Custom D", min: 202, max: 234, color: "#444444" },
    { name: "Custom E", min: 235, max: -1, color: "#555555" },
  ],
  hrZones: [
    { name: "HR A", min: 92, max: 110, color: "#0a0a0a" },
    { name: "HR B", min: 111, max: 129, color: "#0b0b0b" },
    { name: "HR C", min: 130, max: 148, color: "#0c0c0c" },
    { name: "HR D", min: 149, max: 166, color: "#0d0d0d" },
    { name: "HR E", min: 167, max: 185, color: "#0e0e0e" },
  ],
};

// ---- 3. shell-like local server: static UI + default-config.json, ----
// ----    /api/config held while the backend is offline (long-poll)   ----
let backendOnline = false;
const held = [];
const server = http.createServer((req, res) => {
  const url = req.url.split("?")[0];
  if (url === "/default-config.json") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(fs.readFileSync(DEFAULTS_PATH));
  } else if (url === "/api/config") {
    if (backendOnline) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(BACKEND_CONFIG));
    } else {
      held.push({ req, res });
      req.on("close", () => {
        const i = held.findIndex((h) => h.req === req);
        if (i >= 0) held.splice(i, 1);
      });
    }
  } else if (url.startsWith("/api/")) {
    res.writeHead(502, { "Content-Type": "text/plain" });
    res.end("backend offline");
  } else {
    const file = url === "/" ? "index.html" : url.slice(1);
    const full = path.join(WEB, file);
    if (!full.startsWith(WEB) || !fs.existsSync(full) || !fs.statSync(full).isFile()) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("not found");
      return;
    }
    const type = file.endsWith(".js") ? "application/javascript" : file.endsWith(".css") ? "text/css" : "text/html";
    res.writeHead(200, { "Content-Type": type });
    res.end(fs.readFileSync(full));
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const ORIGIN = "http://127.0.0.1:" + server.address().port;

// ---- 4. boot the REAL UI inside a shell-like environment ----
let wsAttempts = 0;
const dom = new JSDOM(fs.readFileSync(path.join(WEB, "index.html"), "utf8"), {
  url: ORIGIN + "/",
  runScripts: "dangerously",
  resources: "usable",
  pretendToBeVisual: true,
  beforeParse(window) {
    window.fetch = (u, opts) => fetch(new URL(u, ORIGIN).href, opts);
    if (!window.AbortController) window.AbortController = AbortController;
    if (!window.matchMedia) {
      window.matchMedia = () => ({
        matches: false, media: "",
        addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
      });
    }
    // Telemetry socket stub: never opens, closes immediately -> the UI keeps
    // retrying (that retry loop is what reconnects telemetry later).
    window.WebSocket = class {
      constructor() {
        wsAttempts += 1;
        setTimeout(() => { if (typeof this.onclose === "function") this.onclose({}); }, 5);
      }
      close() {}
    };
  },
});
const doc = dom.window.document;

async function waitFor(check, timeoutMs, what) {
  const start = Date.now();
  for (;;) {
    let ok = false;
    try { ok = check(); } catch (e) { ok = false; }
    if (ok) return;
    if (Date.now() - start > timeoutMs) throw new Error("timeout waiting for: " + what);
    await sleep(100);
  }
}

// ---- 5. OFFLINE START: backend down, UI must render every default ----
await waitFor(() => doc.getElementById("ftpInput") && doc.getElementById("ftpInput").value === "221", 20000, "the offline defaults to render");

assert.equal(doc.getElementById("statusText").textContent, "Disconnected", "status must stay Disconnected while offline");
// Power zones (Zones page)
assert.equal(doc.getElementById("ftpInput").value, "221", "FTP field must show the default 221");
assert.equal(doc.querySelectorAll("#zoneEditor .zone-item").length, 7, "all 7 default power zones must render");
assert.equal(doc.querySelector("#zoneEditor .zone-name").value, "Z1 · Recovery");
assert.equal(doc.querySelector("#zoneEditor .zone-color").value.toLowerCase(), defaults.zones[0].color.toLowerCase());
// Heart rate zones (Zones page)
assert.equal(doc.getElementById("hrMaxInput").value, "190", "Max HR field must show the default 190");
assert.equal(doc.querySelectorAll("#hrEditor .zone-item").length, 5, "all 5 default HR zones must render");
assert.equal([...doc.querySelectorAll("#hrEditor .zone-name")].map((n) => n.value)[4], "Z5 · Maximum");
// Settings defaults
assert.equal(doc.getElementById("smoothInput").value, "45");
assert.equal(doc.getElementById("timeoutInput").value, "5000");
assert.equal(doc.getElementById("hysInput").value, "5");
assert.equal(doc.getElementById("ledPinInput").value, "5");
assert.equal(doc.getElementById("ledCountInput").value, "60");
assert.equal(doc.getElementById("ledTypeSel").value, "WS2812B");
assert.equal(doc.getElementById("ledEffectSel").value, "0");
assert.equal(doc.getElementById("brightInput").value, "100");
assert.equal(doc.getElementById("autoReconnect").checked, true);
assert.equal(doc.getElementById("debugToggle").checked, true);
// Backend-dependent controls disabled (no false saves while disconnected)
for (const id of ["saveZonesBtn", "saveHrZonesBtn", "resetZonesBtn", "resetHrZonesBtn", "saveSettingsBtn", "wifiSaveBtn", "otaBtn", "factoryBtn", "scanBtn", "ftpInput", "hrMaxInput", "zoneCountSel", "ledEffectSel", "simToggle"]) {
  assert.ok(doc.getElementById(id).disabled, id + " must be disabled while offline");
}
console.log("PASS  offline start: Zones + Settings fully populated with defaults, status Disconnected, saves disabled");

// ---- 6. BACKEND APPEARS: its config must replace the offline defaults ----
backendOnline = true;
for (const h of held.splice(0)) {
  try {
    h.res.writeHead(200, { "Content-Type": "application/json" });
    h.res.end(JSON.stringify(BACKEND_CONFIG));
  } catch (e) { /* request already gone */ }
}
await waitFor(() => doc.getElementById("ftpInput").value === "250", 20000, "the backend config to replace the defaults");

assert.equal(doc.getElementById("ftpInput").value, "250");
assert.equal(doc.getElementById("hrMaxInput").value, "185");
assert.equal(doc.getElementById("zoneCountSel").value, "5");
assert.equal(doc.querySelectorAll("#zoneEditor .zone-item").length, 5, "the backend zone count must replace the default 7");
assert.equal(doc.querySelector("#zoneEditor .zone-name").value, "Custom A");
assert.equal(doc.querySelectorAll("#hrEditor .zone-item").length, 5);
assert.equal([...doc.querySelectorAll("#hrEditor .zone-name")].map((n) => n.value)[4], "HR E");
assert.equal(doc.getElementById("statFtp").textContent, "185", "HR mode: Max HR stat must replace FTP");
assert.equal(doc.getElementById("smoothInput").value, "30");
assert.equal(doc.getElementById("hysInput").value, "12");
assert.equal(doc.getElementById("ledCountInput").value, "90");
assert.equal(doc.getElementById("autoReconnect").checked, false);
assert.ok(doc.querySelector("#sourceSeg button[data-src='hr']").classList.contains("active"), "the backend controlSource must be reflected");
for (const id of ["saveZonesBtn", "saveHrZonesBtn", "saveSettingsBtn", "scanBtn", "ftpInput", "hrMaxInput"]) {
  assert.ok(!doc.getElementById(id).disabled, id + " must re-enable after the backend connects");
}
assert.ok(wsAttempts > 0, "the telemetry WebSocket must keep retrying (it reconnects once the backend is reachable)");
console.log("PASS  backend online: real config replaced the offline defaults, controls re-enabled, telemetry retrying");

server.close();
dom.window.close();
fs.rmSync(TMP, { recursive: true, force: true });
console.log("offline-ui regression: ALL PASS");
