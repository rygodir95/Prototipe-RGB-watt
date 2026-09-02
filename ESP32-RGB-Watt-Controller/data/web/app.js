// ESP32 RGB Watt Zone Controller - Web UI
"use strict";

const $ = (id) => document.getElementById(id);
let config = null;
let ws = null;
let simState = { enabled: false, watts: 150 };

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
  $("statFtp").textContent = config.ftp;
  $("statZones").textContent = config.zoneCount;
  $("statBright").textContent = config.brightness;
  renderZoneEditor();
  renderZoneBar();
}

// ---------------- Zone editor ----------------
function renderZoneEditor() {
  const el = $("zoneEditor");
  el.innerHTML = "";
  config.zones.forEach((z, i) => {
    const row = document.createElement("div");
    row.className = "zone-item";
    const maxLabel = z.max < 0 ? "∞" : z.max;
    row.innerHTML =
      '<input type="color" class="zone-color" value="' + z.color + '" data-i="' + i + '" data-testid="zone-color-' + i + '" />' +
      '<div><div class="zlabel">Zone ' + (i + 1) + ' name</div>' +
        '<input type="text" class="zone-name" value="' + escapeAttr(z.name) + '" data-i="' + i + '" data-testid="zone-name-' + i + '" /></div>' +
      '<div><div class="zlabel">Min W</div>' +
        '<input type="number" class="zone-min" value="' + z.min + '" data-i="' + i + '" data-testid="zone-min-' + i + '" /></div>' +
      '<div class="zmax"><div class="zlabel">Max W</div>' +
        '<input type="number" value="' + (z.max < 0 ? "" : z.max) + '" disabled placeholder="' + maxLabel + '" /></div>' +
      '<div class="zone-swatch" style="background:' + z.color + '"></div>';
    el.appendChild(row);
  });
  el.querySelectorAll(".zone-color").forEach((c) =>
    c.addEventListener("input", (e) => {
      const i = +e.target.dataset.i;
      e.target.parentElement.querySelector(".zone-swatch").style.background = e.target.value;
      config.zones[i].color = e.target.value;
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

function renderZoneBar() {
  const track = $("zonebarTrack");
  if (!track || !config) return;
  track.innerHTML = "";
  config.zones.forEach((z) => {
    const s = document.createElement("span");
    s.style.background = z.color;
    track.appendChild(s);
  });
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

// ---------------- Power Source ----------------
let deviceTimer = null;
async function scan() {
  await fetch("/api/scan", { method: "POST" });
  $("scanBtn").textContent = "Scanning…";
  $("scanBtn").disabled = true;
  toast("Scanning for power sources…");
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
    simState.watts = +$("simSlider").value;
    $("simVal").textContent = simState.watts;
    pushSim();
  });
  $("simPresets").querySelectorAll("button").forEach((b) =>
    b.addEventListener("click", () => {
      simState.watts = +b.dataset.w;
      $("simSlider").value = simState.watts;
      $("simVal").textContent = simState.watts;
      if (!simState.enabled) { simState.enabled = true; $("simToggle").checked = true; $("simSlider").disabled = false; }
      pushSim();
    })
  );
}
let simTimer = null;
function pushSim() {
  clearTimeout(simTimer);
  simTimer = setTimeout(() => {
    fetch("/api/simulation", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: simState.enabled, watts: simState.watts }),
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
  RECEIVING_POWER: { cls: "live", label: "Receiving Power" },
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

  // Colour glow + brand
  $("powerGlow").style.background = "radial-gradient(circle, " + t.color + "cc, transparent 70%)";
  $("brandDot").style.background = t.color;
  $("brandDot").style.boxShadow = "0 0 24px " + t.color + "88";

  // Dashboard source
  $("dashSourceName").textContent = t.source || (t.sim ? "Simulation" : "—");
  const ds = $("dashSourceState");
  ds.querySelector("span:last-child").textContent = t.sim ? "Simulated" : s.label;
  ds.querySelector(".pill-dot").style.background = s.cls === "live" || s.cls === "ok" ? "var(--ok)" : "var(--muted)";

  // Zone bar marker
  positionMarker(t.smoothed);
}
function positionMarker(watts) {
  if (!config) return;
  const zones = config.zones;
  const last = zones[zones.length - 1].min;
  const scale = Math.max(last * 1.15, config.ftp * 1.6, 1);
  let pct = Math.min(100, Math.max(0, (watts / scale) * 100));
  $("zonebarMarker").style.left = "calc(" + pct + "% - 2px)";
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
  $("zoneCountSel").addEventListener("change", onZoneCountChange);
  $("saveZonesBtn").addEventListener("click", saveZones);
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
