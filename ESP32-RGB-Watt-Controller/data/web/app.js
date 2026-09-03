// ESP32 RGB Watt Zone Controller - Web UI
"use strict";

const $ = (id) => document.getElementById(id);
let config = null;
let ws = null;
let simState = { enabled: false, watts: 150, bpm: 120 };

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
      if (b.dataset.view === "source") refreshDevices();
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

// ---------------- Control source ----------------
function initSourceSeg() {
  document.querySelectorAll("#sourceSeg button").forEach((b) => {
    b.addEventListener("click", async () => {
      if (b.classList.contains("active")) return;
      await postConfig({ controlSource: b.dataset.src });
      // The device disconnected the previous sensor and cleared its state;
      // reset the local simulation UI to match.
      simState.enabled = false;
      fillForms();
      toast(isHrMode() ? "Switched to Heart Rate mode" : "Switched to Power mode");
    });
  });
}

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
  if (config.hrMax) $("hrMaxInput").value = config.hrMax;

  // ---- UI adapts to the active control source ----
  const hr = isHrMode();
  $("statFtpLabel").textContent = hr ? "Max HR" : "FTP";
  $("statFtp").textContent = hr ? config.hrMax : config.ftp;
  $("statFtpUnit").textContent = hr ? "bpm" : "W";
  $("statZones").textContent = hr ? (config.hrZones ? config.hrZones.length : 5) : config.zoneCount;
  $("powerUnit").textContent = hr ? "BPM" : "W";
  $("powerRawUnit").textContent = hr ? "bpm" : "W";
  $("simUnit").textContent = hr ? "bpm" : "W";
  $("hysUnit").textContent = hr ? "bpm" : "W";
  $("powerZoneBlock").style.display = hr ? "none" : "";
  $("hrZoneBlock").style.display = hr ? "" : "none";
  $("resetZonesBtn").textContent = hr ? "Reset to Max HR defaults" : "Reset to FTP defaults";
  $("sourceTitle").textContent = hr ? "Heart Rate Sensors" : "Power Sources";
  $("sourceSub").textContent = hr
    ? "BLE Heart Rate Service devices (chest straps & watches)."
    : "BLE Cycling Power Service devices (power meters & smart trainers).";
  $("sourceMiniLabel").textContent = hr ? "Heart Rate Source" : "Power Source";
  $("navSourceBtn").textContent = hr ? "HR Sensors" : "Power Source";
  document.querySelectorAll("#sourceSeg button").forEach((b) => {
    b.classList.toggle("active", (b.dataset.src === "hr") === hr);
  });

  renderZoneEditor();
  renderHrZoneEditor();
  renderSimControls();
}

// ---------------- Power zone editor ----------------
function renderZoneEditor() {
  const el = $("zoneEditor");
  el.innerHTML = "";
  if (!config.zones) return;
  config.zones.forEach((z, i) => {
    el.appendChild(zoneRow(z, i, "zone", (i < config.zones.length - 1)));
  });
  bindZoneEditor(el, config.zones);
}

// ---------------- HR zone editor ----------------
function renderHrZoneEditor() {
  const el = $("hrEditor");
  el.innerHTML = "";
  if (!config.hrZones) return;
  config.hrZones.forEach((z, i) => {
    el.appendChild(zoneRow(z, i, "hr-zone", (i < config.hrZones.length - 1)));
  });
  bindZoneEditor(el, config.hrZones);
}

function zoneRow(z, i, testPrefix, hasMax) {
  const row = document.createElement("div");
  row.className = "zone-item";
  const maxLabel = !hasMax || z.max < 0 ? "∞" : z.max;
  row.innerHTML =
    '<input type="color" class="zone-color" value="' + z.color + '" data-i="' + i + '" data-testid="' + testPrefix + '-color-' + i + '" />' +
    '<div><div class="zlabel">Zone ' + (i + 1) + ' name</div>' +
      '<input type="text" class="zone-name" value="' + escapeAttr(z.name) + '" data-i="' + i + '" data-testid="' + testPrefix + '-name-' + i + '" /></div>' +
    '<div><div class="zlabel">Min ' + (testPrefix === "hr-zone" ? "bpm" : "W") + '</div>' +
      '<input type="number" class="zone-min" value="' + z.min + '" data-i="' + i + '" data-testid="' + testPrefix + '-min-' + i + '" /></div>' +
    '<div class="zmax"><div class="zlabel">Max ' + (testPrefix === "hr-zone" ? "bpm" : "W") + '</div>' +
      '<input type="number" value="' + (hasMax && z.max >= 0 ? z.max : "") + '" disabled placeholder="' + maxLabel + '" /></div>' +
    '<div class="zone-swatch" style="background:' + z.color + '"></div>';
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
  toast("Zones saved");
}

async function saveHrZones() {
  const zones = config.hrZones.map((z, i) => ({
    name: $("hrEditor").querySelectorAll(".zone-name")[i].value,
    min: +$("hrEditor").querySelectorAll(".zone-min")[i].value,
    color: $("hrEditor").querySelectorAll(".zone-color")[i].value,
  }));
  await postConfig({ hrZones: zones });
  fillForms();
  toast("HR zones saved");
}

async function onZoneCountChange() {
  await postConfig({ zoneCount: +$("zoneCountSel").value, ftp: +$("ftpInput").value });
  fillForms();
  toast("Zone model updated");
}
async function resetZones() {
  if (isHrMode()) {
    await postConfig({ hrZonesReset: true });
    fillForms();
    toast("HR zones reset to Max HR defaults");
  } else {
    await postConfig({ zoneCount: +$("zoneCountSel").value, ftp: +$("ftpInput").value });
    fillForms();
    toast("Zones reset to FTP defaults");
  }
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
function otaUpload() {
  const f = $("otaFile").files[0];
  if (!f) { toast("Choose a firmware .bin first"); return; }
  const bar = $("otaBar");
  const btn = $("otaBtn");
  btn.disabled = true;
  bar.style.width = "0%";
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
    if (ok) { bar.style.width = "100%"; toast("Firmware flashed — rebooting…"); }
    else { toast("Update failed"); btn.disabled = false; }
  };
  xhr.onerror = () => { toast("Upload error"); btn.disabled = false; };
  xhr.send(fd);
  toast("Uploading firmware…");
}

// ---------------- Power / HR Source ----------------
let deviceTimer = null;
async function scan() {
  await fetch("/api/scan", { method: "POST" });
  $("scanBtn").textContent = "Scanning…";
  $("scanBtn").disabled = true;
  toast("Scanning for " + (isHrMode() ? "heart rate sensors…" : "power sources…"));
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
  const list = $("deviceList");
  if (!data.devices || data.devices.length === 0) {
    list.innerHTML = '<div class="empty">' + (data.scanning ? "Scanning…" : "No devices found. Tap Scan.") + "</div>";
    return;
  }
  list.innerHTML = "";
  data.devices.forEach((d) => {
    const row = document.createElement("div");
    row.className = "device" + (d.connected ? " connected" : "");
    row.innerHTML =
      '<div class="device-info">' +
        '<span class="device-radio"></span>' +
        '<div class="device-meta">' +
          '<div class="device-name">' + escapeHtml(d.name) + (d.type ? ' <span class="badge">' + d.type + '</span>' : "") + "</div>" +
          '<div class="device-addr">' + d.address + "  ·  " + d.rssi + " dBm</div>" +
        "</div></div>" +
      '<div class="device-actions"></div>';
    const actions = row.querySelector(".device-actions");
    if (d.connected) {
      actions.appendChild(mkBtn("Disconnect", "", () => disconnect()));
      actions.appendChild(mkBtn("Forget", "danger", () => forget()));
    } else {
      actions.appendChild(mkBtn("Connect", "primary", () => connect(d.address, d.name)));
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
async function connect(address, name) {
  await fetch("/api/connect", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ address: address, name: name }),
  });
  toast("Connecting to " + name + "…");
  setTimeout(refreshDevices, 1200);
}
async function disconnect() { await fetch("/api/disconnect", { method: "POST" }); toast("Disconnected"); setTimeout(refreshDevices, 600); }
async function forget() { await fetch("/api/forget", { method: "POST" }); toast("Source forgotten"); setTimeout(refreshDevices, 600); }
function escapeHtml(s) { const d = document.createElement("div"); d.textContent = s; return d.innerHTML; }

// ---------------- Simulation ----------------
function initSim() {
  $("simToggle").addEventListener("change", () => {
    simState.enabled = $("simToggle").checked;
    $("simSlider").disabled = !simState.enabled;
    pushSim();
    toast(simState.enabled ? "Simulation ON" : "Simulation OFF");
  });
  $("simSlider").addEventListener("input", () => {
    if (isHrMode()) {
      simState.bpm = +$("simSlider").value;
      $("simVal").textContent = simState.bpm;
    } else {
      simState.watts = +$("simSlider").value;
      $("simVal").textContent = simState.watts;
    }
    pushSim();
  });
}

function renderSimControls() {
  const slider = $("simSlider");
  if (isHrMode()) {
    slider.min = 40;
    slider.max = 220;
    if (!simState.enabled) simState.bpm = Math.min(220, Math.max(40, simState.bpm || 120));
    slider.value = simState.bpm;
    $("simVal").textContent = simState.bpm;
    // Presets covering all 5 HR zones, derived from the configured boundaries.
    const mins = (config.hrZones || []).map((z) => z.min);
    const presets = [];
    if (mins.length === 5) {
      presets.push(Math.max(40, mins[0] - 10), mins[0] + 5, mins[1] + 5, mins[2] + 5, mins[3] + 5, mins[4] + 5, (config.hrMax || 190) + 10);
    }
    renderSimPresets(presets, true);
  } else {
    slider.min = 0;
    slider.max = 600;
    if (!simState.enabled) simState.watts = 150;
    slider.value = simState.watts;
    $("simVal").textContent = simState.watts;
    renderSimPresets([0, 50, 100, 150, 200, 250, 300, 400, 500], false);
  }
  slider.disabled = !simState.enabled;
  $("simToggle").checked = simState.enabled;
}

function renderSimPresets(values, hr) {
  const box = $("simPresets");
  box.innerHTML = "";
  const seen = {};
  values.forEach((v) => {
    v = Math.round(v);
    if (seen[v] || v < (hr ? 40 : 0) || v > (hr ? 220 : 600)) return;
    seen[v] = true;
    const b = document.createElement("button");
    b.textContent = v;
    b.addEventListener("click", () => {
      if (hr) simState.bpm = v; else simState.watts = v;
      if (!simState.enabled) simState.enabled = true;
      $("simSlider").value = v;
      $("simVal").textContent = v;
      $("simSlider").disabled = false;
      $("simToggle").checked = true;
      pushSim();
    });
    box.appendChild(b);
  });
}

let simTimer = null;
function pushSim() {
  clearTimeout(simTimer);
  simTimer = setTimeout(() => {
    const body = { enabled: simState.enabled };
    if (isHrMode()) body.bpm = simState.bpm;
    else body.watts = simState.watts;
    fetch("/api/simulation", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }, 80);
}

// ---------------- WebSocket telemetry ----------------
function initWs() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(proto + "://" + location.host + "/ws");
  ws.onmessage = (e) => { try { updateLive(JSON.parse(e.data)); } catch (_) {} };
  ws.onclose = () => setTimeout(initWs, 2000);
}
const STATE_MAP = {
  RECEIVING_POWER: { cls: "live", label: "Receiving Data" },
  CONNECTED: { cls: "ok", label: "Connected" },
  CONNECTING: { cls: "warn", label: "Connecting" },
  RECONNECTING: { cls: "warn", label: "Reconnecting" },
  SCANNING: { cls: "warn", label: "Scanning" },
  DISCONNECTED: { cls: "", label: "Disconnected" },
  STARTING: { cls: "", label: "Starting" },
  ERROR: { cls: "err", label: "Error" },
};
function updateLive(t) {
  $("powerWatts").textContent = t.smoothed;
  $("powerRaw").textContent = t.raw;
  $("zoneNum").textContent = "Z" + (t.zone + 1);
  $("zoneName").textContent = t.zoneName || "—";
  const s = STATE_MAP[t.state] || STATE_MAP.STARTING;
  const pill = $("statusPill");
  pill.className = "status-pill " + s.cls;
  $("statusText").textContent = t.sim ? "Simulation" : s.label;

  // Colour glow + brand: must show the SAME zone as the label. Use the current
  // zone's configured colour of the ACTIVE control source so
  // zone number = zone name = displayed colour.
  const hr = (t.mode || (config && config.controlSource)) === "hr";
  const zones = hr ? (config.hrZones || []) : (config.zones || []);
  const zoneColor = (t.zone >= 0 && t.zone < zones.length) ? zones[t.zone].color : t.color;
  $("powerGlow").style.background = "radial-gradient(circle, " + zoneColor + "cc, transparent 70%)";
  $("brandDot").style.background = zoneColor;
  $("brandDot").style.boxShadow = "0 0 24px " + zoneColor + "88";

  // Dashboard source
  $("dashSourceName").textContent = t.source || (t.sim ? "Simulation" : "—");
  const ds = $("dashSourceState");
  ds.querySelector("span:last-child").textContent = t.sim ? "Simulated" : s.label;
  ds.querySelector(".pill-dot").style.background = s.cls === "live" || s.cls === "ok" ? "var(--ok)" : "var(--muted)";
}

// ---------------- Init ----------------
async function init() {
  initTheme();
  initNav();
  initSim();
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
  $("saveSettingsBtn").addEventListener("click", saveSettings);
  $("wifiSaveBtn").addEventListener("click", saveWifi);
  $("factoryBtn").addEventListener("click", factoryReset);
  $("otaBtn").addEventListener("click", otaUpload);
  $("ledEffectSel").addEventListener("change", async () => { await postConfig({ ledEffect: +$("ledEffectSel").value }); toast("Effect updated"); });
  $("scanBtn").addEventListener("click", scan);
  $("smoothInput").addEventListener("input", () => ($("smoothVal").textContent = $("smoothInput").value));
  $("brightInput").addEventListener("input", () => ($("brightVal").textContent = $("brightInput").value + "%"));
}
document.addEventListener("DOMContentLoaded", init);