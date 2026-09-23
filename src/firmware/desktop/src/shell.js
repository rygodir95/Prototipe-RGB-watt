// ZoneGlow desktop shell - connection state machine.
//
// States: Connected / Connecting… / Disconnected.
// - Probes the configured backend (GET /api/info) every 2 seconds.
// - When reachable, loads the EXISTING ZoneGlow UI from the backend in the
//   iframe (the backend serves data/web unchanged). If the backend goes away,
//   the shell stays open, shows the disconnected overlay and keeps retrying.
// - When the backend returns, the overlay hides again. The embedded UI
//   reconnects its own WebSocket by itself (app.js retries on close), so no
//   forced reload is needed unless the backend URL changed.
"use strict";

/* global ZoneGlowTransport */   // defined in transport.js (plain <script> global)

(function () {
  var $ = function (id) { return document.getElementById(id); };
  var UI_FRAME = $("uiFrame");
  var OVERLAY = $("overlay");
  var STATUS_TEXT = $("statusText");
  var BACKEND_LABEL = $("backendLabel");
  var BACKEND_URL_INPUT = $("backendUrl");
  var CONNECT_BTN = $("connectBtn");
  var OVERLAY_HINT = $("overlayHint");
  var BLE_BTN = $("bleBtn");
  var BLE_PANEL = $("blePanel");
  var BLE_HINT = $("bleHint");
  var BLE_DEVICES = $("bleDevices");
  var BLE_LIVE = $("bleLive");
  var BLE_CONFIG = $("bleConfig");
  var BLE_ZONES = $("bleZones");
  var BLE_SETUP = $("bleSetup"), BLE_FTP = $("bleFtp"), BLE_HR_MAX = $("bleHrMax"), BLE_BRIGHTNESS = $("bleBrightness"), BLE_SAVE_SETUP = $("bleSaveSetup");
  var BLE_SENSORS = $("bleSensors");
  var BLE_SCAN = $("bleScanBtn");
  var BLE_SENSOR_SCAN = $("bleSensorScanBtn");
  var BLE_LIGHTING = $("bleLightingBtn");
  var BLE_DISCONNECT = $("bleDisconnectBtn");
  var BLE_SHELL_DISCONNECT = $("bleShellDisconnect");

  var PROBE_INTERVAL_MS = 2000;
  var MAX_MISSED_PROBES = 2;   // tolerate one dropped probe before "Disconnected"
  var uiLoadedFor = "";        // backend URL currently loaded in the iframe
  var everConnected = false;
  var missedProbes = 0;
  var probing = false;
  var userInitiated = false;   // Connect button pressed (vs. automatic search)
  var splashHidden = false;
  var bleCommandId = 1;
  var bleLightingOn = false;
  var bleConfigParts = {};
  var bleMode = false;

  var SPLASH = $("splash");

  // Splash never artificially delays startup: it hides on the first
  // successful probe OR after 1.2 s, whichever comes first, then the normal
  // connection view ("Searching for Hub…" / "Connecting…") takes over.
  function hideSplash() {
    if (splashHidden) return;
    splashHidden = true;
    SPLASH.classList.add("hide");
    setTimeout(function () { SPLASH.style.display = "none"; }, 400);
  }

  function setState(state, url) {
    document.body.dataset.state = state;   // connected | connecting | disconnected
    STATUS_TEXT.textContent =
      state === "connected" ? "Connected" :
      state === "disconnected" ? "Disconnected" : "Connecting…";
    BACKEND_LABEL.textContent = url;
    if (state === "connected") {
      UI_FRAME.style.display = "block";
      OVERLAY.style.display = "none";
    } else {
      UI_FRAME.style.display = "none";
      OVERLAY.style.display = "flex";
      OVERLAY_HINT.textContent = state === "connecting"
        ? (userInitiated ? "Connecting to " + url + " …" : "Searching for Hub at " + url + " …")
        : "Cannot reach " + url + ". Make sure the Hub (or the PC simulator) is " +
          "running, or set the Hub address below. Retrying automatically every " +
          (PROBE_INTERVAL_MS / 1000) + " seconds.";
    }
  }

  function showUi(url) {
    if (uiLoadedFor !== url) {
      // The backend serves the existing ZoneGlow UI itself (same files the
      // ESP32 serves), so all relative REST/WS paths inside it just work.
      UI_FRAME.src = url + "/";
      uiLoadedFor = url;
    }
  }

  function tick() {
    if (bleMode) return;
    if (probing) return;
    probing = true;
    var url = ZoneGlowTransport.getUrl();
    if (!BACKEND_URL_INPUT.value) BACKEND_URL_INPUT.value = url;
    ZoneGlowTransport.probe(url)
      .then(function () {
        if (bleMode) { probing = false; return; }
        missedProbes = 0;
        everConnected = true;
        showUi(url);
        setState("connected", url);
        hideSplash();
        probing = false;
      })
      .catch(function () {
        if (bleMode) { probing = false; return; }
        missedProbes++;
        if (everConnected && missedProbes < MAX_MISSED_PROBES) {
          probing = false;   // brief hiccup while connected: keep the UI up
          return;
        }
        setState("disconnected", url);
        probing = false;
      });
  }

  CONNECT_BTN.addEventListener("click", function () {
    if (!ZoneGlowTransport.setUrl(BACKEND_URL_INPUT.value)) {
      BACKEND_URL_INPUT.classList.add("invalid");
      return;
    }
    BACKEND_URL_INPUT.classList.remove("invalid");
    uiLoadedFor = "";          // force the iframe to load from the new backend
    missedProbes = 0;
    everConnected = false;
    userInitiated = true;
    setState("connecting", ZoneGlowTransport.getUrl());
    tick();
  });
  BACKEND_URL_INPUT.addEventListener("input", function () {
    BACKEND_URL_INPUT.classList.remove("invalid");
  });

  function showBleDevices(devices) {
    BLE_DEVICES.textContent = "";
    if (!devices.length) { BLE_HINT.textContent = "No Training Hub was found. Keep the Hub powered and try again."; return; }
    BLE_HINT.textContent = "Choose the nearby Hub.";
    devices.forEach(function (device) {
      var row = document.createElement("div"); row.className = "ble-device";
      var label = document.createElement("div"); label.textContent = device.name || "Training Hub";
      var small = document.createElement("small"); small.textContent = device.address + (device.rssi === null ? "" : " · " + device.rssi + " dBm");
      label.appendChild(small);
      var button = document.createElement("button"); button.type = "button"; button.textContent = "Connect";
      button.addEventListener("click", function () { connectBle(device.address); });
      row.appendChild(label); row.appendChild(button); BLE_DEVICES.appendChild(row);
    });
  }
  function connectBle(address) {
    BLE_HINT.textContent = "Connecting…";
    HubBleTransport.connect(address).then(function () {
      HubBleBridge.configure(HubBleTransport);
      HubBleBridge.setConnected(true);
      // A GATT connection alone does not prove that commands and result
      // notifications work. Keep the picker visible until the UI's first
      // configuration request has actually succeeded.
      BLE_HINT.textContent = "Reading Hub settings…";
      return HubBleBridge.api("/api/config", "GET");
    }).then(function () {
      bleMode = true;
      BLE_PANEL.hidden = true;
      BLE_SHELL_DISCONNECT.hidden = false;
      uiLoadedFor = "bluetooth";
      UI_FRAME.src = "hub-ui/index.html";
      setState("connected", "Bluetooth");
      hideSplash();
      BLE_HINT.textContent = "Connected locally over Bluetooth.";
      BLE_LIGHTING.disabled = false; BLE_DISCONNECT.disabled = false;
      BLE_SENSOR_SCAN.disabled = false;
    }).catch(function (error) {
      BLE_HINT.textContent = "Bluetooth connected, but Hub settings could not be read: " + String(error);
      HubBleBridge.setConnected(false);
      HubBleTransport.disconnect().catch(function () {});
    });
  }
  function leaveBle() {
    if (!bleMode) return;
    bleMode = false;
    HubBleBridge.setConnected(false);
    BLE_SHELL_DISCONNECT.hidden = true;
    UI_FRAME.src = "about:blank";
    uiLoadedFor = "";
    BLE_PANEL.hidden = false;
    BLE_HINT.textContent = "Bluetooth disconnected. Search to reconnect.";
    setState("disconnected", ZoneGlowTransport.getUrl());
  }
  BLE_SHELL_DISCONNECT.addEventListener("click", function () { HubBleTransport.disconnect().then(leaveBle, leaveBle); });
  function scanBle() {
    BLE_SCAN.disabled = true; BLE_HINT.textContent = "Searching for nearby Hubs…";
    HubBleTransport.scan().then(showBleDevices).catch(function (error) {
      BLE_HINT.textContent = String(error);
    }).then(function () { BLE_SCAN.disabled = false; });
  }
  BLE_BTN.addEventListener("click", function () { hideSplash(); BLE_PANEL.hidden = false; scanBle(); });
  BLE_SCAN.addEventListener("click", scanBle);
  BLE_SAVE_SETUP.addEventListener("click", function () {
    var patch = { ftp: Number(BLE_FTP.value), hrMax: Number(BLE_HR_MAX.value), brightness: Number(BLE_BRIGHTNESS.value) };
    BLE_HINT.textContent = "Saving setup…";
    HubBleTransport.command(JSON.stringify({ id: bleCommandId++, op: "config_write", patch: patch }));
  });
  BLE_SENSOR_SCAN.addEventListener("click", function () {
    BLE_SENSOR_SCAN.disabled = true; BLE_HINT.textContent = "Searching for Power and HR sensors…";
    HubBleTransport.command(JSON.stringify({ id: bleCommandId++, op: "scan" }))
      .then(function () { setTimeout(function () {
        HubBleTransport.command(JSON.stringify({ id: bleCommandId++, op: "devices_read" }));
        BLE_SENSOR_SCAN.disabled = false;
      }, 6500); });
  });
  BLE_DISCONNECT.addEventListener("click", function () {
    HubBleTransport.disconnect(); BLE_LIGHTING.disabled = true; BLE_DISCONNECT.disabled = true;
    BLE_LIVE.hidden = true; BLE_HINT.textContent = "Disconnected. Search to connect again.";
  });
  BLE_LIGHTING.addEventListener("click", function () {
    bleLightingOn = !bleLightingOn;
    HubBleTransport.command(JSON.stringify({ id: bleCommandId++, op: "lighting_test", on: bleLightingOn }))
      .then(function () { BLE_LIGHTING.textContent = bleLightingOn ? "Stop Lighting Test" : "Lighting Test"; })
      .catch(function (error) { BLE_HINT.textContent = String(error); });
  });
  function renderBleZones(config) {
    BLE_ZONES.textContent = "";
    [["Power zones", "power", config.zones || []], ["HR zones", "hr", config.hrZones || []]].forEach(function (group) {
      var heading = document.createElement("h3"); heading.textContent = group[0]; BLE_ZONES.appendChild(heading);
      group[2].forEach(function (zone, index) {
        var row = document.createElement("div"); row.className = "ble-device";
        var name = document.createElement("input"); name.type = "text"; name.value = zone.name || ""; name.maxLength = 23; name.setAttribute("aria-label", group[0] + " " + (index + 1) + " name");
        var minimum = document.createElement("input"); minimum.type = "number"; minimum.value = zone.min; minimum.min = "0"; minimum.setAttribute("aria-label", group[0] + " " + (index + 1) + " minimum");
        var color = document.createElement("input"); color.type = "color"; color.value = zone.color || "#ffffff"; color.setAttribute("aria-label", group[0] + " " + (index + 1) + " color");
        var save = document.createElement("button"); save.type = "button"; save.textContent = "Save";
        save.addEventListener("click", function () {
          var value = Number(minimum.value);
          if (!Number.isInteger(value) || value < 0 || !name.value.trim()) { BLE_HINT.textContent = "Enter a zone name and a valid minimum."; return; }
          var message = JSON.stringify({ id: bleCommandId++, op: "zone_write", zone: { source: group[1], index: index, name: name.value.trim(), min: value, color: color.value } });
          BLE_HINT.textContent = "Saving " + group[0].toLowerCase() + "…";
          HubBleTransport.command(message).catch(function (error) { BLE_HINT.textContent = String(error); });
        });
        row.appendChild(name); row.appendChild(minimum); row.appendChild(color); row.appendChild(save); BLE_ZONES.appendChild(row);
      });
    });
    BLE_ZONES.hidden = false;
  }
  if (HubBleTransport.available()) {
    HubBleTransport.listen("ble-status", function (payload) {
      HubBleBridge.receiveStatus(payload);
      if (!bleMode) { BLE_LIVE.hidden = false; BLE_LIVE.textContent = payload; }
    });
    HubBleTransport.listen("ble-result", function (payload) {
      HubBleBridge.receiveResult(payload);
      if (bleMode) return;
      try {
        var result = JSON.parse(payload);
        if (!result.ok) { BLE_HINT.textContent = result.error || "Hub rejected the command"; return; }
        if (result.type !== "config" && result.type !== "devices") return;
        var transfer = bleConfigParts[result.id] || { parts: result.parts, values: [] };
        transfer.values[result.part] = result.data;
        bleConfigParts[result.id] = transfer;
        if (transfer.values.filter(Boolean).length !== transfer.parts) return;
        var config = JSON.parse(transfer.values.join("")); delete bleConfigParts[result.id];
        if (result.type === "devices") {
          BLE_SENSORS.textContent = "";
          (config.devices || []).forEach(function (sensor) {
            var row = document.createElement("div"); row.className = "ble-device";
            var label = document.createElement("div"); label.textContent = (sensor.name || sensor.category) + " · " + sensor.category;
            var small = document.createElement("small"); small.textContent = sensor.address + " · " + sensor.rssi + " dBm"; label.appendChild(small);
            var button = document.createElement("button"); button.textContent = "Use";
            button.addEventListener("click", function () {
              HubBleTransport.command(JSON.stringify({ id: bleCommandId++, op: "sensor_connect", sensor: sensor }));
              BLE_HINT.textContent = "Connecting to " + (sensor.name || sensor.address) + "…";
            });
            row.appendChild(label); row.appendChild(button); BLE_SENSORS.appendChild(row);
          });
          if (!config.devices || !config.devices.length) BLE_HINT.textContent = "No compatible sensors found. Try again.";
          return;
        }
        BLE_CONFIG.hidden = false;
        BLE_SETUP.hidden = false; BLE_FTP.value = config.ftp; BLE_HR_MAX.value = config.hrMax; BLE_BRIGHTNESS.value = config.brightness;
        renderBleZones(config);
        BLE_CONFIG.textContent = "Configuration loaded\\n" +
          "Source: " + config.controlSource + " · FTP: " + config.ftp + " W · Max HR: " + config.hrMax + " bpm\\n" +
          "Zones: " + config.zoneCount + " · LEDs: " + config.ledCount + " · Brightness: " + config.brightness + "%";
      } catch (_) { BLE_HINT.textContent = "Could not read Hub configuration"; }
    });
    HubBleTransport.listen("ble-connection", function (connected) { if (!connected) { BLE_LIGHTING.disabled = true; BLE_DISCONNECT.disabled = true; leaveBle(); } });
  } else { BLE_BTN.disabled = true; }

  setState("connecting", ZoneGlowTransport.getUrl());
  tick();
  setInterval(tick, PROBE_INTERVAL_MS);
  setTimeout(hideSplash, 1200);   // branding window: 1.2 s max, never blocking
})();

