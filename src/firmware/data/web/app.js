// ESP32 RGB Watt Zone Controller - Web UI
"use strict";

const $ = (id) => document.getElementById(id);
let config = null;
let ws = null;

const UI_VERSION = "1.3.0";   // Hub web UI version (About/Diagnostics)
let lastTel = null;           // last telemetry frame (Diagnostics)
let activeView = "dashboard"; // current nav view
let hubInfo = null;           // /api/info cache (About/Diagnostics)

function isHrMode() { return !!(config && config.controlSource === "hr"); }

// ---------------- Theme ----------------
function applyTheme(theme) {
  let effective = theme;
  if (theme === "system") {
    effective = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  document.documentElement.setAttribute("data-theme", effective);
  document.querySelectorAll("#themeSwitch button").forEach((b) => {
    b.classList.toggle("active", b.dataset.themeVal === theme);
  });
}
function initTheme() {
  const saved = localStorage.getItem("theme") || "system";
  applyTheme(saved);
  document.querySelectorAll("#themeSwitch button").forEach((b) => {
    b.addEventListener("click", () => {
      const t = b.dataset.themeVal;
      localStorage.setItem("theme", t);
      applyTheme(t);
      if (config) { config.theme = t; postConfig({ theme: t }); }
    });
  });
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if ((localStorage.getItem("theme") || "system") === "system") applyTheme("system");
  });
}

// ---------------- Toast ----------------
let toastTimer = null;
function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 2200);
}

// ---------------- Nav ----------------
function initNav() {
  document.querySelectorAll(".nav-btn").forEach((b) => {
    b.addEventListener("click", () => {
      document.querySelectorAll(".nav-btn").forEach((x) => x.classList.remove("active"));
      document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
      b.classList.add("active");
      $("view-" + b.dataset.view).classList.add("active");
      activeView = b.dataset.view;
      if (activeView === "devices") refreshDevices();
      if (activeView === "about") refreshAbout();
    });
  });
}

// ---------------- API ----------------
async function getConfig() {
  const r = await fetch("/api/config");
  config = await r.json();
  return config;
}
async function postConfig(patch) {
  const r = await fetch("/api/config", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  config = await r.json();
  return config;
}

// NOTE: there is no manual control-source selector any more. The active
// source follows the connected device's category (Devices -> Connect); the
// UI only READS config.controlSource for units/zones/state display.

// ---------------- Populate forms ----------------
function fillForms() {
  $("ftpInput").value = config.ftp;
  $("zoneCountSel").value = config.zoneCount;
  $("smoothInput").value = config.smoothing;
  $("smoothVal").textContent = config.smoothing;
  $("timeoutInput").value = config.powerTimeout;
  $("hysInput").value = config.hysteresis;
  $("ledPinInput").value = config.ledPin;
  $("ledCountInput").value = config.ledCount;
  $("ledTypeSel").value = config.ledType;
  $("ledEffectSel").value = config.ledEffect;
  $("brightInput").value = config.brightness;
  $("brightVal").textContent = config.brightness + "%";
  $("autoReconnect").checked = config.autoReconnect;
  $("debugToggle").checked = config.debug;
  $("wifiSsid").value = config.wifiSsid || "";
  $("hrMaxInput").value = config.hrMax || 0;

  // ---- Dashboard adapts to the active control source ----
  const hr = isHrMode();
  $("powerUnit").textContent = hr ? "BPM" : "W";
  $("statFtpLabel").textContent = hr ? "Max HR" : "FTP";
  $("statFtp").textContent = hr ? config.hrMax : config.ftp;
  $("statFtpUnit").textContent = hr ? "BPM" : "W";
  $("statZones").textContent = hr ? (config.hrZones ? config.hrZones.length : 5) : config.zoneCount;
  // Hysteresis is a Heart Rate (bpm) setting; Power zone hysteresis is
  // FTP-relative (1.5 % of FTP) and not user-configurable.
  $("hysUnit").textContent = "BPM";
  $("sourceMiniLabel").textContent = hr ? "Heart Rate" : "Power Source";

  // ---- Devices page: per-type saved source hints ----
  $("powerSavedHint").textContent = config.sourceName ? "Saved: " + config.sourceName : "No saved device";
  $("hrSavedHint").textContent = config.hrSourceName ? "Saved: " + config.hrSourceName : "No saved device";

  // ---- Zones page section subtitles ----
  $("powerZoneSub").textContent = "FTP: " + (config.ftp ? config.ftp + " W" : "not set") +
    " · " + config.zoneCount + " zones";
  // ---- HR zones: header summary + how Max HR interacts with the boundaries ----
  const hrSummary = "Max HR: " + (config.hrMax ? config.hrMax + " BPM" : "not set") + " · " +
    (config.hrZones ? config.hrZones.length : 5) + " zones. ";
  $("hrZoneNote").textContent = hrSummary + (config.hrZonesCustom
    ? "Boundaries customised — changing Max HR keeps them. Reset restores the defaults."
    : "Changing Max HR recalculates them automatically.");

  renderZoneEditor();
  renderHrZoneEditor();
}

// ---------------- Power zone editor ----------------
function renderZoneEditor() {
  const el = $("zoneEditor");
  el.innerHTML = "";
  if (!config.zones) return;
  config.zones.forEach((z, i) => {
    const hasMax = i < config.zones.length - 1;
    el.appendChild(zoneRow(z, i, "zone", { unit: "W", max: hasMax && z.max >= 0 ? z.max : null }));
  });
  bindZoneEditor(el, config.zones);
}

// ---------------- HR zone editor ----------------
function renderHrZoneEditor() {
  const el = $("hrEditor");
  el.innerHTML = "";
  if (!config.hrZones) return;
  const hrMax = config.hrMax || 0;   // 0 = not set: no percentages shown
  config.hrZones.forEach((z, i) => {
    const isLast = i === config.hrZones.length - 1;
    // Z5 ends at Max HR; the server also reports max = hrMax for the last zone.
    const maxBpm = isLast || z.max < 0 ? hrMax : z.max;
    const pct = hrMax > 0
      ? Math.floor(z.min / hrMax * 100) + "–" + Math.round(maxBpm / hrMax * 100) + "% Max HR"
      : null;
    el.appendChild(zoneRow(z, i, "hr-zone", {
      unit: "BPM", max: maxBpm, pct: pct,
    }));
  });
  bindZoneEditor(el, config.hrZones);
}

function zoneRow(z, i, testPrefix, opts) {
  const row = document.createElement("div");
  row.className = "zone-item" + (opts.pct ? " hr-zone-item" : "");
  const maxLabel = opts.max === null ? "∞" : opts.max;
  let html =
    '<input type="color" class="zone-color" value="' + z.color + '" data-i="' + i + '" data-testid="' + testPrefix + '-color-' + i + '" />' +
    '<div><div class="zlabel">Zone ' + (i + 1) + ' name</div>' +
      '<input type="text" class="zone-name" value="' + escapeAttr(z.name) + '" data-i="' + i + '" data-testid="' + testPrefix + '-name-' + i + '" /></div>' +
    '<div><div class="zlabel">Min ' + opts.unit + '</div>' +
      '<input type="number" class="zone-min" value="' + z.min + '" data-i="' + i + '" data-testid="' + testPrefix + '-min-' + i + '" /></div>' +
    '<div class="zmax"><div class="zlabel">Max ' + opts.unit + '</div>' +
      '<input type="number" value="' + (opts.max === null ? "" : opts.max) + '" disabled placeholder="' + maxLabel + '" /></div>' +
    '<div class="zone-swatch" style="background:' + z.color + '"></div>';
  if (opts.pct) {
    html += '<div class="zpct"><b>' + opts.pct + '</b><span>' + z.min + "–" + maxLabel + " " + opts.unit + '</span></div>';
  }
  row.innerHTML = html;
  return row;
}

function bindZoneEditor(el, zones) {
  el.querySelectorAll(".zone-color").forEach((c) =>
    c.addEventListener("input", (e) => {
      const i = +e.target.dataset.i;
      e.target.parentElement.querySelector(".zone-swatch").style.background = e.target.value;
      zones[i].color = e.target.value;
    })
  );
}
function escapeAttr(s) { return (s || "").replace(/"/g, "&quot;"); }

async function saveZones() {
  const zones = config.zones.map((z, i) => ({
    name: $("zoneEditor").querySelectorAll(".zone-name")[i].value,
    min: +$("zoneEditor").querySelectorAll(".zone-min")[i].value,
    color: $("zoneEditor").querySelectorAll(".zone-color")[i].value,
  }));
  await postConfig({ ftp: +$("ftpInput").value, zones: zones });
  fillForms();
  toast("Power zones saved");
}

async function saveHrZones() {
  const zones = config.hrZones.map((z, i) => ({
    name: $("hrEditor").querySelectorAll(".zone-name")[i].value,
    min: +$("hrEditor").querySelectorAll(".zone-min")[i].value,
    color: $("hrEditor").querySelectorAll(".zone-color")[i].value,
  }));
  await postConfig({ hrZones: zones });
  fillForms();
  toast("Heart Rate zones saved");
}

async function onZoneCountChange() {
  await postConfig({ zoneCount: +$("zoneCountSel").value, ftp: +$("ftpInput").value });
  fillForms();
  toast("Zone model updated");
}
async function resetZones() {
  await postConfig({ zoneCount: +$("zoneCountSel").value, ftp: +$("ftpInput").value });
  fillForms();
  toast("Zones reset to FTP defaults");
}
async function resetHrZones() {
  await postConfig({ hrZonesReset: true });
  fillForms();
  toast("Heart Rate zones reset to Max HR defaults");
}

// ---------------- Settings ----------------
async function saveSettings() {
  await postConfig({
    smoothing: +$("smoothInput").value,
    powerTimeout: +$("timeoutInput").value,
    hysteresis: +$("hysInput").value,
    ledPin: +$("ledPinInput").value,
    ledCount: +$("ledCountInput").value,
    ledType: $("ledTypeSel").value,
    ledEffect: +$("ledEffectSel").value,
    brightness: +$("brightInput").value,
    autoReconnect: $("autoReconnect").checked,
    debug: $("debugToggle").checked,
  });
  fillForms();
  toast("Settings saved");
}
async function saveWifi() {
  const ssid = $("wifiSsid").value.trim();
  if (!ssid) { toast("Enter an SSID"); return; }
  await fetch("/api/wifi", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ssid: ssid, pass: $("wifiPass").value }),
  });
  toast("Saved. Rebooting — reconnect to your network.");
}
async function factoryReset() {
  if (!confirm("Reset all settings to factory defaults?")) return;
  await fetch("/api/factory-reset", { method: "POST" });
  toast("Factory reset — rebooting…");
}

// ---------------- OTA ----------------
// A successful POST /api/ota only means the Hub ACCEPTED the file: it then
// flashes and reboots, briefly disappearing from the network. Success is
// reported only after the Hub answers /api/info again, and failure only if
// it does not come back within the polling budget - never from the POST
// alone, and never from the WebSocket disconnect the expected reboot
// causes (that is handled by the normal connection banner).
const OTA_POLL_MS = 2000;
const OTA_DROP_POLLS = 10;   // ~20 s waiting for the reboot gap
const OTA_BACK_POLLS = 45;    // ~90 s for flash + reboot + Wi-Fi rejoin
let otaBusy = false;

function setOtaStatus(msg, cls) {
  const el = $("otaStatus");
  if (!el) return;
  el.textContent = msg || "";
  el.className = "ota-status" + (cls ? " " + cls : "");
  el.hidden = !msg;
}
function otaSetBusy(busy) {
  otaBusy = busy;
  $("otaBtn").disabled = busy;
  $("otaFile").disabled = busy;
}
async function otaInfoReachable() {
  try { return (await fetch("/api/info", { cache: "no-store" })).ok; }
  catch (_) { return false; }
}
async function waitHubUnreachable() {
  // The old firmware answers /api/info right up to the reboot; wait for
  // that gap so a fast first poll cannot mistake the pre-reboot Hub for
  // the rebooted one.
  for (let i = 0; i < OTA_DROP_POLLS; i++) {
    if (!(await otaInfoReachable())) return true;
    await new Promise((r) => setTimeout(r, OTA_POLL_MS));
  }
  return false;   // no gap observed (very quick reboot) - keep waiting anyway
}
async function waitHubBack() {
  let announced = false;
  for (let i = 0; i < OTA_BACK_POLLS; i++) {
    if (await otaInfoReachable()) return true;
    if (!announced) { setOtaStatus("Reconnecting to Hub…"); announced = true; }
    await new Promise((r) => setTimeout(r, OTA_POLL_MS));
  }
  return false;
}
async function otaFinishUpdate() {
  const preInfo = hubInfo && hubInfo.deviceId ? hubInfo : null;
  setOtaStatus("Installing update…");
  await waitHubUnreachable();
  setOtaStatus("Hub restarting…");
  await new Promise((r) => setTimeout(r, OTA_POLL_MS));   // the reboot takes at least a beat
  const back = await waitHubBack();
  if (!back) {
    setOtaStatus("Update not confirmed — the Hub did not come back. Check its power and Wi-Fi, then reload this page.", "err");
    toast("Hub did not return after the update");
    otaSetBusy(false);
    return;
  }
  await loadHubInfo();   // refresh About/Diagnostics with the running firmware
  const info = hubInfo;
  let suffix = info && info.version ? " — running firmware " + info.version : "";
  if (preInfo && info && preInfo.deviceId !== info.deviceId) suffix += " (different Hub device ID)";
  $("otaBar").style.width = "100%";
  setOtaStatus("Update successful ✓" + suffix, "ok");
  toast("Update successful");
  otaSetBusy(false);
}
function otaUpload() {
  if (otaBusy) return;
  const f = $("otaFile").files[0];
  if (!f) { toast("Choose a firmware .bin first"); return; }
  loadHubInfo();   // record pre-update /api/info for comparison
  otaSetBusy(true);
  const bar = $("otaBar");
  bar.style.width = "0%";
  setOtaStatus("Uploading firmware…");
  const fd = new FormData();
  fd.append("firmware", f, f.name);
  const xhr = new XMLHttpRequest();
  xhr.open("POST", "/api/ota");
  xhr.upload.onprogress = (e) => {
    if (e.lengthComputable) bar.style.width = Math.round((e.loaded / e.total) * 100) + "%";
  };
  xhr.onload = () => {
    let ok = false;
    try { ok = JSON.parse(xhr.responseText).ok; } catch (_) {}
    if (ok) otaFinishUpdate();   // accepted -> follow the reboot + reconnect
    else {
      setOtaStatus("Update failed — the Hub rejected the file.", "err");
      toast("Update failed");
      otaSetBusy(false);
    }
  };
  xhr.onerror = () => {
    setOtaStatus("Upload error — could not send the file to the Hub.", "err");
    toast("Upload error");
    otaSetBusy(false);
  };
  xhr.send(fd);
}

// ---------------- Devices (Power + Heart Rate sensors) ----------------
const TYPE_LABEL = { CPS: "Power Meter", FTMS: "Smart Trainer", HRS: "Heart Rate Monitor" };
let deviceTimer = null;
async function scan() {
  await fetch("/api/scan", { method: "POST" });
  $("scanBtn").textContent = "Searching…";
  $("scanBtn").disabled = true;
  toast("Searching for power and heart rate sensors…");
  let ticks = 0;
  clearInterval(deviceTimer);
  deviceTimer = setInterval(async () => {
    await refreshDevices();
    if (++ticks > 8) {
      clearInterval(deviceTimer);
      $("scanBtn").textContent = "Scan";
      $("scanBtn").disabled = false;
    }
  }, 1000);
}
async function refreshDevices() {
  const r = await fetch("/api/devices");
  const data = await r.json();
  const all = data.devices || [];
  renderDeviceList($("powerDeviceList"), all.filter((d) => d.category === "power"), data.scanning);
  renderDeviceList($("hrDeviceList"), all.filter((d) => d.category === "hr"), data.scanning);
}
function renderDeviceList(list, devices, scanning) {
  if (!devices.length) {
    list.innerHTML = '<div class="empty">' + (scanning ? "Searching…" : "No devices found. Tap Scan.") + "</div>";
    return;
  }
  list.innerHTML = "";
  devices.forEach((d) => {
    const row = document.createElement("div");
    row.className = "device" + (d.connected ? " connected" : "");
    row.innerHTML =
      '<div class="device-info">' +
        '<span class="device-radio"></span>' +
        '<div class="device-meta">' +
          '<div class="device-name">' + escapeHtml(d.name) +
            ' <span class="badge badge-' + d.category + '">' + (TYPE_LABEL[d.type] || d.type) + '</span></div>' +
          '<div class="device-addr">' + d.address + "  ·  " + d.rssi + " dBm</div>" +
          '<div class="device-state">' + (d.connected ? "Connected" : "Available") + "</div>" +
        "</div></div>" +
      '<div class="device-actions"></div>';
    const actions = row.querySelector(".device-actions");
    if (d.connected) {
      actions.appendChild(mkBtn("Disconnect", "", () => disconnect()));
      actions.appendChild(mkBtn("Forget", "danger", () => forget()));
    } else {
      actions.appendChild(mkBtn("Connect", "primary", () => connect(d)));
    }
    list.appendChild(row);
  });
}
function mkBtn(label, cls, fn) {
  const b = document.createElement("button");
  b.className = "btn " + cls;
  b.textContent = label;
  b.setAttribute("data-testid", "device-" + label.toLowerCase() + "-btn");
  b.addEventListener("click", fn);
  return b;
}
async function connect(d) {
  // Connecting activates the device's control source first (mutual exclusion):
  // the previously active sensor is disconnected on the device side.
  const switching = (d.category === "hr") !== isHrMode();
  await fetch("/api/connect", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ address: d.address, name: d.name, category: d.category }),
  });
  await getConfig();   // pick up the (possibly switched) control source immediately
  fillForms();
  toast(switching
    ? "Switching to " + (d.category === "hr" ? "Heart Rate" : "Power") + " mode — connecting to " + d.name + "…"
    : "Connecting to " + d.name + "…");
  setTimeout(refreshDevices, 1200);
}
async function disconnect() { await fetch("/api/disconnect", { method: "POST" }); toast("Disconnected"); setTimeout(refreshDevices, 600); }
async function forget() { await fetch("/api/forget", { method: "POST" }); toast("Source forgotten"); setTimeout(refreshDevices, 600); }
function escapeHtml(s) { const d = document.createElement("div"); d.textContent = s; return d.innerHTML; }

// ---------------- WebSocket telemetry ----------------
// The Hub broadcasts telemetry ~5x/s, so sustained silence means the socket
// is dead. In the Android WebView (mobile shell iframe) a dead WebSocket can
// drop WITHOUT ever firing onclose - the network path (emulator NAT, Wi-Fi
// power-save) silently blackholes it. The dashboard would then freeze on the
// last received frame forever while REST commands still work. A watchdog
// re-arms on every telemetry frame and force-closes a silent socket, letting
// the normal onclose reconnect take over.
const WS_SILENCE_MS = 6000;   // ~30 missed telemetry frames = definitively dead
let wsWatchdog = null;
function armWsWatchdog() {
  clearTimeout(wsWatchdog);
  wsWatchdog = setTimeout(() => { try { ws.close(); } catch (_) {} }, WS_SILENCE_MS);
}
function initWs() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(proto + "://" + location.host + "/ws");
  ws.onmessage = (e) => { armWsWatchdog(); showHubReconnected(); try { updateLive(JSON.parse(e.data)); } catch (_) {} };
  ws.onerror = () => { try { ws.close(); } catch (_) {} };
  ws.onclose = () => { clearTimeout(wsWatchdog); showHubBanner(true); setTimeout(initWs, 2000); };
  armWsWatchdog();   // a socket that never opens at all must not hang either
}
const STATE_MAP = {
  RECEIVING_POWER: { cls: "live", label: "Receiving Data" },
  CONNECTED: { cls: "ok", label: "Connected" },
  CONNECTING: { cls: "warn", label: "Connecting…" },
  RECONNECTING: { cls: "warn", label: "Reconnecting…" },
  SCANNING: { cls: "warn", label: "Searching…" },
  DISCONNECTED: { cls: "", label: "Disconnected" },
  STARTING: { cls: "", label: "Starting" },
  ERROR: { cls: "err", label: "Error" },
};
function updateLive(t) {
  // Another client (or the Devices page) may have switched the control
  // source: follow immediately so units and zone colours match the mode.
  const tMode = t.mode || (config && config.controlSource);
  if (config && tMode && config.controlSource !== tMode) {
    config.controlSource = tMode;
    fillForms();
  }
  const hr = isHrMode();
  // Plain-English states instead of developer shorthand.
  let stateLabel = (t.state === "RECEIVING_POWER")
    ? (hr ? "Receiving heart rate" : "Receiving power")   // mode-specific wording
    : (STATE_MAP[t.state] || STATE_MAP.STARTING).label;
  if (t.state === "DISCONNECTED") {
    stateLabel = hr ? "No heart rate sensor connected" : "No power sensor connected";
  }
  $("powerWatts").textContent = t.smoothed;
  $("zoneNum").textContent = "Z" + (t.zone + 1);
  $("zoneName").textContent = (t.zoneName || "—").replace(/^Z\d+\s·\s/, "");
  const s = STATE_MAP[t.state] || STATE_MAP.STARTING;
  const pill = $("statusPill");
  pill.className = "status-pill " + s.cls;
  $("statusText").textContent = t.sim ? "Lighting test" : stateLabel;
  lastTel = t;
  if (activeView === "about") fillAbout();

  // Colour glow + brand: must show the SAME zone as the label. Use the current
  // zone's configured colour of the ACTIVE control source so
  // zone number = zone name = displayed colour.
  const zones = hr ? (config.hrZones || []) : (config.zones || []);
  const zoneColor = (t.zone >= 0 && t.zone < zones.length) ? zones[t.zone].color : t.color;
  $("powerGlow").style.background = "radial-gradient(circle, " + zoneColor + "cc, transparent 70%)";
  $("brandDot").style.background = zoneColor;
  $("brandDot").style.boxShadow = "0 0 24px " + zoneColor + "88";

  // Dashboard source
  $("dashSourceName").textContent = t.source || (t.sim ? "Simulation" : "—");
  const ds = $("dashSourceState");
  ds.querySelector("span:last-child").textContent = t.sim ? "Lighting test" : stateLabel;
  ds.querySelector(".pill-dot").style.background = s.cls === "live" || s.cls === "ok" ? "var(--ok)" : "var(--muted)";
}

// ---------------- Hub connection banner ----------------
// Three states: hidden (normal), red "lost" and a short green confirmation
// after a successful reconnect. The green state only appears after an
// actual connection loss during this page session - never on the initial
// connection - and auto-hides after ~3 s. A new loss while the green
// confirmation is up returns to red immediately and cancels its timer.
const HUB_OK_MS = 3000;
const HUB_OK_TEXT = "Hub reconnected ✓";
let hubWasLost = false;    // a disconnect was seen since the last green
let hubOkShowing = false;  // the green confirmation is currently visible
let hubOkTimer = null;
let hubLostText = "";      // red wording, captured from the banner HTML

function hideHubBanner() {
  const b = $("hubBanner");
  if (!b) return;
  b.hidden = true;
  b.classList.remove("ok");
  hubOkShowing = false;
}
function showHubBanner(show) {
  const b = $("hubBanner");
  if (!b) return;
  clearTimeout(hubOkTimer); hubOkTimer = null;
  if (show) {
    hubWasLost = true;
    if (!hubLostText) hubLostText = b.textContent;   // keep the HTML wording
    b.textContent = hubLostText;
    b.classList.remove("ok");
    b.hidden = false;
  } else {
    hideHubBanner();
  }
}
function showHubReconnected() {
  // What ws.onmessage calls: incoming telemetry proves the Hub is back.
  const b = $("hubBanner");
  if (!b) return;
  if (hubWasLost) {
    hubWasLost = false;
    hubOkShowing = true;
    b.textContent = HUB_OK_TEXT;
    b.classList.add("ok");
    b.hidden = false;
    hubOkTimer = setTimeout(() => { hubOkTimer = null; hideHubBanner(); }, HUB_OK_MS);
  } else if (!hubOkShowing) {
    hideHubBanner();   // normal connection, no loss seen: stay hidden
  }
}

// ---------------- First-run onboarding ----------------
// Hardware setup wizard (setup, NOT workout onboarding):
// Welcome -> Hub -> Add Sensor -> Zones -> Test Lighting -> Setup Complete.
// Skippable at any time; completion persists in localStorage; re-runnable from
// About. Uses only existing APIs (scan / connect / config / simulation).
const ONBOARD_KEY = "zoneglow.onboarding.done";
let obState = null;   // { step }
let obPoll = null;    // wizard scan poller

function onboardingDone() {
  try { return localStorage.getItem(ONBOARD_KEY) === "1"; } catch (_) { return false; }
}
function markOnboardingDone() {
  try { localStorage.setItem(ONBOARD_KEY, "1"); } catch (_) {}
}
function startOnboarding(force) {
  if (!force && (onboardingDone() || obState)) return;
  obState = { step: 0 };
  $("onboarding").hidden = false;
  renderOnboarding();
}
function closeOnboarding(done) {
  if (obPoll) { clearInterval(obPoll); obPoll = null; }
  obState = null;
  $("onboarding").hidden = true;
  if (done) { markOnboardingDone(); toast("Setup complete"); }
}
function obAddBtn(label, cls, fn, parent) {
  const b = document.createElement("button");
  b.className = "btn " + (cls || "");
  b.textContent = label;
  b.addEventListener("click", fn);
  parent.appendChild(b);
  return b;
}
function renderOnboarding() {
  const s = obState.step;
  const body = $("obBody"); body.innerHTML = "";
  const actions = $("obActions"); actions.innerHTML = "";
  const next = () => { obState.step = s + 1; renderOnboarding(); };
  const back = () => { obState.step = Math.max(0, s - 1); renderOnboarding(); };

  if (s === 0) {
    $("obTitle").textContent = "Welcome to ZoneGlow";
    $("obText").textContent = "Set up your Hub and its zone lighting in a few short steps. You can skip anytime — everything stays available in the app.";
    obAddBtn("Get started", "primary", next, actions);
  } else if (s === 1) {
    $("obTitle").textContent = "Your Hub";
    $("obText").textContent = "This app talks to the ZoneGlow Hub over Wi-Fi.";
    const info = document.createElement("div");
    info.className = "ob-info";
    info.textContent = "Device ID: " + ((hubInfo && hubInfo.deviceId) || "unknown") +
      "  ·  Firmware: " + ((hubInfo && hubInfo.version) || "unknown");
    body.appendChild(info);
    obAddBtn("Back", "", back, actions);
    obAddBtn("Next", "primary", next, actions);
  } else if (s === 2) {
    $("obTitle").textContent = "Add a sensor";
    $("obText").textContent = "Scan for power meters and heart rate monitors near the Hub, then connect one. You can also do this later on the Devices page.";
    const list = document.createElement("div");
    list.id = "obDeviceList";
    list.className = "ob-devices";
    body.appendChild(list);
    obRenderDevices([]);
    obAddBtn("Scan", "primary", obScan, body);
    obAddBtn("Back", "", back, actions);
    obAddBtn("Next", "primary", next, actions);
  } else if (s === 3) {
    // Zone basics: quick FTP / Max HR fields (the values the zone boundaries
    // are generated from). Full name/color editing stays on the Zones page.
    $("obTitle").textContent = "Configure zones";
    $("obText").textContent = "Zone boundaries are generated from your FTP (power) and Max HR (heart rate). Adjust them now, or fine-tune names, boundaries and colors later on the Zones page.";
    const wrap = document.createElement("div");
    wrap.className = "ob-zone-cfg";
    const addField = (label, key) => {
      const f = document.createElement("label");
      f.className = "ob-field";
      const l = document.createElement("span");
      l.textContent = label;
      const inp = document.createElement("input");
      inp.type = "number";
      inp.value = config[key];
      inp.addEventListener("change", async () => {
        const patch = {};
        patch[key] = +inp.value;
        await postConfig(patch);
        fillForms();
        toast(label + " updated");
      });
      f.appendChild(l);
      f.appendChild(inp);
      wrap.appendChild(f);
    };
    addField("FTP (W)", "ftp");
    addField("Max HR (BPM)", "hrMax");
    body.appendChild(wrap);
    obAddBtn("Back", "", back, actions);
    obAddBtn("Next", "primary", next, actions);
  } else if (s === 4) {
    $("obTitle").textContent = "Test lighting";
    $("obText").textContent = "Run a quick test that cycles through every zone so you can verify the colors on your LED strip. It never changes your settings.";
    obAddBtn("Test all zones", "primary", () => startDemo(1), body);
    obAddBtn("Back", "", back, actions);
    obAddBtn("Next", "primary", next, actions);
  } else if (s === 5) {
    // Hardware-setup ending: the Hub is standalone and keeps running with the
    // app closed - clients are configurators, not the controller.
    $("obTitle").textContent = "Setup complete";
    $("obText").textContent = "Your Hub is configured and runs on its own — you can close this app any time. Reconnect later to adjust settings or check status.";
    obAddBtn("Done", "primary", () => closeOnboarding(true), actions);
  }
}
async function obScan() {
  try { await fetch("/api/scan", { method: "POST" }); }
  catch (_) { toast("Cannot reach the Hub"); return; }
  toast("Searching for sensors…");
  let ticks = 0;
  if (obPoll) clearInterval(obPoll);
  obPoll = setInterval(async () => {
    try {
      const r = await fetch("/api/devices");
      obRenderDevices((await r.json()).devices || []);
    } catch (_) {}
    if (++ticks > 9 && obPoll) { clearInterval(obPoll); obPoll = null; }
  }, 1000);
}
function obRenderDevices(devices) {
  const list = $("obDeviceList");
  if (!list) return;
  if (!devices.length) {
    list.innerHTML = '<div class="empty">No sensors found yet. Tap Scan.</div>';
    return;
  }
  list.innerHTML = "";
  devices.slice(0, 6).forEach((d) => {
    const row = document.createElement("div");
    row.className = "ob-dev-row" + (d.connected ? " connected" : "");
    const label = document.createElement("span");
    label.innerHTML = escapeHtml(d.name) +
      ' <small>(' + (d.category === "hr" ? "Heart Rate" : "Power") + ")</small>";
    row.appendChild(label);
    if (d.connected) {
      const ok = document.createElement("em");
      ok.textContent = "Connected";
      row.appendChild(ok);
    } else {
      obAddBtn("Connect", "primary", () => connect(d), row);
    }
    list.appendChild(row);
  });
}

// ---------------- Lighting Test (user-facing "Test Lighting") ----------------
// A hardware verification sweep driven through the EXISTING /api/simulation
// endpoint: cycles Z1..Zmax and back down so the user can check every zone's
// color on the strip. It is a lighting test tool, NOT a simulated workout;
// stopping it returns control to the real sensor untouched. The developer
// Simulation Mode (PC simulator /dev panel) remains separate.
const DEMO_STEP_MS = 1200;
let demoTimer = null;
let demoPos = 0;
let demoCyclesLeft = 0;

async function postSimulation(patch, opts) {
  return fetch("/api/simulation", Object.assign({
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  }, opts || {}));
}
function demoSequence() {
  // One value per zone: a little above each zone's lower bound, so the cycle
  // walks Z1 -> Z2 -> ... -> Zmax and then back down (Zmax-1 ... Z1).
  const zones = isHrMode() ? (config.hrZones || []) : (config.zones || []);
  const vals = zones.map((z) => (z.min || 0) + (isHrMode() ? 3 : 10));
  if (!vals.length) return [];
  return vals.concat(vals.slice(0, -1).reverse());
}
async function startDemo(cycles) {
  if (demoTimer || !config) return;   // already running
  demoPos = 0;
  demoCyclesLeft = cycles || 1;   // dashboard runs exactly ONE automatic cycle, then stops
  try { await postSimulation({ enabled: true }); }
  catch (_) { toast("Cannot reach the Hub"); return; }
  $("demoBanner").hidden = false;
  await demoTick();
  demoTimer = setInterval(demoTick, DEMO_STEP_MS);
}
async function stopDemo() {
  if (demoTimer) { clearInterval(demoTimer); demoTimer = null; }
  $("demoBanner").hidden = true;
  try { await postSimulation({ enabled: false }); } catch (_) {}
}
async function demoTick() {
  const seq = demoSequence();
  if (!seq.length || demoPos >= seq.length * demoCyclesLeft) { await stopDemo(); return; }
  const v = seq[demoPos % seq.length];
  demoPos++;
  const patch = isHrMode() ? { bpm: v } : { watts: v };
  try { await postSimulation(patch); }
  catch (_) { await stopDemo(); toast("Connection to Hub lost — lighting test stopped"); }
}
// Best effort: never leave the Hub in Demo Mode when the UI goes away.
document.addEventListener("pagehide", () => {
  if (!demoTimer) return;
  try {
    if (typeof navigator !== "undefined" && navigator.sendBeacon) {
      navigator.sendBeacon("/api/simulation",
        new Blob([JSON.stringify({ enabled: false })], { type: "application/json" }));
    }
  } catch (_) {}
});

// ---------------- Configuration backup (export / import) ----------------
// Versioned JSON schema. Validation runs completely BEFORE anything is sent
// to the Hub, so a malformed file can never partially overwrite the config.
// Secrets (Wi-Fi) and sensor pairings are never exported.
const CFG_SCHEMA = "zoneglow.config";
const CFG_VERSION = 1;
const CFG_KEYS = ["controlSource", "ftp", "smoothing", "powerTimeout", "hysteresis",
  "zoneCount", "zones", "hrMax", "hrZonesCustom", "hrZones", "ledPin", "ledCount",
  "brightness", "ledType", "ledEffect", "autoReconnect", "debug", "theme"];

function buildBackup() {
  const cfg = {};
  CFG_KEYS.forEach((k) => { if (config && config[k] !== undefined) cfg[k] = config[k]; });
  return {
    schema: CFG_SCHEMA,
    version: CFG_VERSION,
    app: "ZoneGlow",
    exportedAt: new Date().toISOString(),
    config: cfg,
  };
}
function validateImportedConfig(doc) {
  try {
    if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
      throw new Error("Not a valid configuration backup");
    }
    if (doc.schema !== CFG_SCHEMA) {
      throw new Error("This file is not a ZoneGlow configuration backup");
    }
    if (doc.version !== CFG_VERSION) {
      throw new Error("Unsupported backup version: " + doc.version);
    }
    const c = doc.config;
    if (!c || typeof c !== "object" || Array.isArray(c)) {
      throw new Error("Backup is missing its configuration data");
    }
    const int = (v, lo, hi) => {
      const n = Number(v);
      if (!Number.isInteger(n) || n < lo || n > hi) return null;
      return n;
    };
    const out = {};

    // The active control source is DERIVED on the Hub from the connected
    // device's category, so the field is optional in backups. Old exports
    // still carry it; it is forwarded for old-Hub compatibility.
    if (c.controlSource !== undefined && c.controlSource !== null && c.controlSource !== "") {
      if (c.controlSource !== "hr" && c.controlSource !== "power") {
        throw new Error("Control source must be power or heart rate");
      }
      out.controlSource = c.controlSource;
    }

    // 0 = "not set": allowed (the Hub regenerates zones once a real FTP arrives).
    const ftp = int(c.ftp, 0, 1000);
    if (ftp === null) throw new Error("FTP must be 0 (not set) or a whole number up to 1000");
    out.ftp = ftp;

    const smoothing = int(c.smoothing, 0, 100);
    if (smoothing === null) throw new Error("Smoothing must be between 0 and 100");
    out.smoothing = smoothing;

    const powerTimeout = int(c.powerTimeout, 500, 60000);
    if (powerTimeout === null) throw new Error("Data timeout must be between 500 and 60000 ms");
    out.powerTimeout = powerTimeout;

    const hysteresis = int(c.hysteresis, 0, 100);
    if (hysteresis === null) throw new Error("Hysteresis must be between 0 and 100");
    out.hysteresis = hysteresis;

    const zoneCount = int(c.zoneCount, 5, 7);
    if (zoneCount === null) throw new Error("Zone count must be 5, 6 or 7");
    out.zoneCount = zoneCount;

    if (!Array.isArray(c.zones) || c.zones.length !== zoneCount) {
      throw new Error("Power zones (" + (c.zones ? c.zones.length : 0) +
        ") do not match the zone count (" + zoneCount + ")");
    }
    let prevMin = -1;
    out.zones = c.zones.map((z, i) => {
      if (!z || typeof z !== "object") throw new Error("Power zone " + (i + 1) + " is malformed");
      if (typeof z.name !== "string" || !z.name.trim()) {
        throw new Error("Power zone " + (i + 1) + " needs a name");
      }
      const min = int(z.min, 0, 9999);
      if (min === null) throw new Error("Power zone " + (i + 1) + " has an invalid minimum");
      if (min <= prevMin) throw new Error("Power zone minimums must increase from zone to zone");
      prevMin = min;
      if (!/^#[0-9a-fA-F]{6}$/.test(z.color || "")) {
        throw new Error("Power zone " + (i + 1) + " has an invalid color");
      }
      return { name: z.name.trim().slice(0, 23), min: min, color: z.color };
    });

    // 0 = "not set": allowed (the Hub regenerates HR zones once a real Max HR arrives).
    const hrMax = int(c.hrMax, 0, 230);
    if (hrMax === null) throw new Error("Max HR must be 0 (not set) or between 100 and 230");
    out.hrMax = hrMax;

    if (!Array.isArray(c.hrZones) || c.hrZones.length !== 5) {
      throw new Error("Heart Rate zones must contain exactly 5 zones");
    }
    let prevBpm = -1;
    out.hrZones = c.hrZones.map((z, i) => {
      if (!z || typeof z !== "object") throw new Error("Heart Rate zone " + (i + 1) + " is malformed");
      if (typeof z.name !== "string" || !z.name.trim()) {
        throw new Error("Heart Rate zone " + (i + 1) + " needs a name");
      }
      const min = int(z.min, 0, 250);
      if (min === null) throw new Error("Heart Rate zone " + (i + 1) + " has an invalid minimum");
      if (min <= prevBpm) throw new Error("Heart Rate zone minimums must increase from zone to zone");
      prevBpm = min;
      if (!/^#[0-9a-fA-F]{6}$/.test(z.color || "")) {
        throw new Error("Heart Rate zone " + (i + 1) + " has an invalid color");
      }
      return { name: z.name.trim().slice(0, 23), min: min, color: z.color };
    });
    if (c.hrZonesCustom !== undefined) {
      if (typeof c.hrZonesCustom !== "boolean") throw new Error("hrZonesCustom must be true or false");
      out.hrZonesCustom = c.hrZonesCustom;
    }

    const ledPin = int(c.ledPin, 0, 39);
    if (ledPin === null) throw new Error("LED GPIO pin must be between 0 and 39");
    out.ledPin = ledPin;
    const ledCount = int(c.ledCount, 1, 1000);
    if (ledCount === null) throw new Error("LED count must be between 1 and 1000");
    out.ledCount = ledCount;
    const brightness = int(c.brightness, 0, 100);
    if (brightness === null) throw new Error("Brightness must be between 0 and 100");
    out.brightness = brightness;
    if (c.ledType !== "WS2812B" && c.ledType !== "SK6812") {
      throw new Error("LED type must be WS2812B or SK6812");
    }
    out.ledType = c.ledType;
    const ledEffect = int(c.ledEffect, 0, 2);
    if (ledEffect === null) throw new Error("LED effect must be 0, 1 or 2");
    out.ledEffect = ledEffect;

    ["autoReconnect", "debug"].forEach((k) => {
      if (c[k] !== undefined) {
        if (typeof c[k] !== "boolean") throw new Error(k + " must be true or false");
        out[k] = c[k];
      }
    });
    if (c.theme !== undefined && c.theme !== null && c.theme !== "") {
      if (["light", "dark", "system"].indexOf(c.theme) === -1) {
        throw new Error("Theme must be light, dark or system");
      }
      out.theme = c.theme;
    }
    return { ok: true, config: out };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : "Invalid backup" };
  }
}
function exportConfig() {
  const json = JSON.stringify(buildBackup(), null, 2);
  const out = $("exportOut");
  out.value = json;
  out.hidden = false;
  $("exportCopyBtn").hidden = false;
  try {
    // File download where the platform supports it; the copyable text field
    // stays visible as the fallback (e.g. Android WebView).
    const blob = new Blob([json], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "zoneglow-config-" + new Date().toISOString().slice(0, 10) + ".json";
    a.click();
    setTimeout(() => { try { URL.revokeObjectURL(a.href); } catch (_) {} }, 5000);
  } catch (_) {}
  toast("Configuration exported");
}
async function applyImportedConfig(doc) {
  const v = validateImportedConfig(doc);
  if (!v.ok) { toast(v.error); return false; }
  let ok = true;
  try { await postConfig(v.config); }   // one atomic request
  catch (_) { ok = false; }
  if (!ok) { toast("Could not reach the Hub — configuration unchanged"); return false; }
  fillForms();
  toast("Configuration restored");
  return true;
}
function importConfigFile(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    let doc = null;
    try { doc = JSON.parse(reader.result); } catch (_) {}
    if (doc === null) { toast("Not a valid backup file"); return; }
    applyImportedConfig(doc);   // validates fully BEFORE anything is applied
  };
  reader.readAsText(file);
}

// ---------------- About / Diagnostics ----------------
async function loadHubInfo() {
  try { const r = await fetch("/api/info"); hubInfo = await r.json(); }
  catch (_) { hubInfo = null; }
  return hubInfo;
}
function refreshAbout() {
  loadHubInfo().then(fillAbout, fillAbout);
}
function wsStatusText() {
  if (!ws) return "not started";
  if (ws.readyState === 1) return "connected";
  if (ws.readyState === 0) return "connecting";
  return "disconnected";
}
function fillAbout() {
  if (!$("aboutAppVersion")) return;
  $("aboutAppVersion").textContent = UI_VERSION;
  $("aboutFwVersion").textContent = hubInfo
    ? (hubInfo.version + (hubInfo.build ? " (" + hubInfo.build + ")" : ""))
    : "unavailable";
  $("aboutDeviceId").textContent = (hubInfo && hubInfo.deviceId) || "unavailable";
  const connected = wsStatusText() === "connected";
  $("diagWs").textContent = connected ? "connected" : "reconnecting…";
  $("diagWsState").textContent = wsStatusText();
  $("diagApi").textContent = hubInfo ? "reachable" : "unreachable";
  const hr = isHrMode();
  $("diagSource").textContent = hr ? "Heart Rate" : "Power";
  const sensor = (lastTel && lastTel.source) ||
    (config ? (hr ? config.hrSourceName : config.sourceName) : "");
  const state = lastTel ? lastTel.state.replace(/_/g, " ").toLowerCase() : "unknown";
  $("diagSensor").textContent = (sensor ? sensor + " — " : "") + state;
}
function buildDiagnosticsText() {
  const hr = isHrMode();
  return [
    "ZoneGlow diagnostics",
    "Generated: " + new Date().toISOString(),
    "App version: " + UI_VERSION,
    "Hub firmware: " + ((hubInfo && hubInfo.version) || "unknown") +
      ((hubInfo && hubInfo.build) ? " (" + hubInfo.build + ")" : ""),
    "Hub device ID: " + ((hubInfo && hubInfo.deviceId) || "unknown"),
    "Hub connection (WebSocket): " + wsStatusText(),
    "API (/api/info): " + (hubInfo ? "reachable" : "unreachable"),
    "Control source: " + (hr ? "Heart Rate" : "Power"),
    "Sensor: " + ((lastTel && lastTel.source) || "none"),
    "Sensor state: " + (lastTel ? lastTel.state : "unknown"),
    "Zone: " + (lastTel ? "Z" + (lastTel.zone + 1) : "-") +
      ((lastTel && lastTel.zoneName) ? " (" + lastTel.zoneName + ")" : ""),
    "FTP: " + (config ? config.ftp : "?") + " W",
    "Max HR: " + (config ? config.hrMax : "?") + " BPM",
    "LED: " + (config ? config.ledCount : "?") + "x " + (config ? config.ledType : "?") +
      ", brightness " + (config ? config.brightness : "?") + "%",
  ].join("\n");
}
async function copyText(text) {
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (_) {}
  try {
    if (!document.body) return false;
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return !!ok;
  } catch (_) { return false; }
}
async function copyDiagnostics() {
  const ok = await copyText(buildDiagnosticsText());
  toast(ok ? "Diagnostics copied" : "Copy not available here");
}

// ---------------- Init ----------------
async function init() {
  initTheme();
  initNav();
  await getConfig();
  // Sync stored theme with device config (device is source of truth on first load if set)
  if (config.theme && !localStorage.getItem("theme")) { localStorage.setItem("theme", config.theme); applyTheme(config.theme); }
  fillForms();
  initWs();

  $("ftpInput").addEventListener("change", async () => { await postConfig({ ftp: +$("ftpInput").value }); fillForms(); toast("FTP updated"); });
  $("hrMaxInput").addEventListener("change", async () => { await postConfig({ hrMax: +$("hrMaxInput").value }); fillForms(); toast("Max HR updated"); });
  $("zoneCountSel").addEventListener("change", onZoneCountChange);
  $("saveZonesBtn").addEventListener("click", saveZones);
  $("saveHrZonesBtn").addEventListener("click", saveHrZones);
  $("resetZonesBtn").addEventListener("click", resetZones);
  $("resetHrZonesBtn").addEventListener("click", resetHrZones);
  $("saveSettingsBtn").addEventListener("click", saveSettings);
  $("wifiSaveBtn").addEventListener("click", saveWifi);
  $("factoryBtn").addEventListener("click", factoryReset);
  $("otaBtn").addEventListener("click", otaUpload);
  $("ledEffectSel").addEventListener("change", async () => { await postConfig({ ledEffect: +$("ledEffectSel").value }); toast("Effect updated"); });
  $("scanBtn").addEventListener("click", scan);
  $("smoothInput").addEventListener("input", () => ($("smoothVal").textContent = $("smoothInput").value));
  $("brightInput").addEventListener("input", () => ($("brightVal").textContent = $("brightInput").value + "%"));

  // ---- Demo Mode ----
  $("demoBtn").addEventListener("click", () => startDemo());
  $("demoExitBtn").addEventListener("click", stopDemo);

  // ---- About / Diagnostics ----
  $("copyDiagBtn").addEventListener("click", copyDiagnostics);
  $("onboardingRestartBtn").addEventListener("click", () => startOnboarding(true));

  // ---- Configuration backup ----
  $("exportCfgBtn").addEventListener("click", exportConfig);
  $("exportCopyBtn").addEventListener("click", async () => {
    const ok = await copyText($("exportOut").value);
    toast(ok ? "Copied" : "Copy not available here");
  });
  $("importCfgBtn").addEventListener("click", () => $("importCfgFile").click());
  $("importCfgFile").addEventListener("change", (e) => {
    importConfigFile(e.target.files && e.target.files[0]);
    e.target.value = "";   // allow re-importing the same file
  });

  // ---- Onboarding ----
  $("obSkipBtn").addEventListener("click", () => closeOnboarding(true));
  loadHubInfo();   // available for the onboarding Hub step + About
  if (!onboardingDone()) startOnboarding();
}
document.addEventListener("DOMContentLoaded", init);