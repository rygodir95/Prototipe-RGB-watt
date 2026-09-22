// ZoneGlow mobile shell - connection state machine.
//
// States: Connected / Connecting… / Disconnected / Reconnecting…
// - Probes the configured Hub (GET /api/info) every 2 seconds.
// - When reachable, loads the EXISTING ZoneGlow UI from the Hub in the
//   iframe (the Hub serves data/web unchanged). The Hub stays fully
//   standalone: BLE, zone logic, LED control, settings, persistence and
//   telemetry all run on the Hub; the phone is only a UI client.
// - On the first missed probe after a successful connection the state
//   becomes "Reconnecting…" (the embedded UI stays visible - its own
//   WebSocket retry keeps running). After sustained loss the shell shows
//   the disconnected overlay and keeps retrying automatically.
// - The last successfully connected Hub address is stored on the phone.
"use strict";

/* global ZoneGlowTransport */   // defined in transport.js (plain <script> global)

(function () {
  var $ = function (id) { return document.getElementById(id); };
  var UI_FRAME = $("uiFrame");
  var OVERLAY = $("overlay");
  var STATUS_TEXT = $("statusText");
  var HUB_LABEL = $("hubLabel");
  var HUB_URL_INPUT = $("hubUrl");
  var CONNECT_BTN = $("connectBtn");
  var OVERLAY_HINT = $("overlayHint");
  var BLE_BTN = $("bleBtn");
  var BLE_PANEL = $("blePanel");
  var BLE_HINT = $("bleHint");
  var BLE_DEVICES = $("bleDevices");
  var BLE_LIVE = $("bleLive");
  var BLE_CONFIG = $("bleConfig"), BLE_SENSORS = $("bleSensors"), BLE_SENSOR_SCAN = $("bleSensorScanBtn");
  var BLE_SETUP = $("bleSetup"), BLE_FTP = $("bleFtp"), BLE_HR_MAX = $("bleHrMax"), BLE_BRIGHTNESS = $("bleBrightness"), BLE_SAVE_SETUP = $("bleSaveSetup"), BLE_ZONES = $("bleZones");
  var BLE_SCAN = $("bleScanBtn");
  var BLE_LIGHTING = $("bleLightingBtn");
  var BLE_DISCONNECT = $("bleDisconnectBtn");
  var BLE_SHELL_DISCONNECT = $("bleShellDisconnect");

  var PROBE_INTERVAL_MS = 2000;
  var MAX_MISSED_PROBES = 3;   // sustained loss threshold for "Disconnected"
  var uiLoadedFor = "";        // Hub URL currently loaded in the iframe
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

  function log(msg) {
    try { console.log("[ZoneGlow][shell] " + msg); } catch (e) {}
  }

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
    log("state -> " + state + " (hub: " + url + ")");
    document.body.dataset.state = state;   // connected|connecting|disconnected|reconnecting
    STATUS_TEXT.textContent =
      state === "connected" ? "Connected" :
      state === "disconnected" ? "Disconnected" :
      state === "reconnecting" ? "Reconnecting…" : "Connecting…";
    HUB_LABEL.textContent = url;
    if (state === "connected" || state === "reconnecting") {
      UI_FRAME.style.display = "block";
      OVERLAY.style.display = "none";
    } else {
      UI_FRAME.style.display = "none";
      OVERLAY.style.display = "flex";
      OVERLAY_HINT.textContent = state === "connecting"
        ? (userInitiated ? "Connecting to " + url + " …" : "Searching for Hub at " + url + " …")
        : "Cannot reach " + url + ". Make sure the Hub is powered and on " +
          "the same Wi-Fi, or set the Hub address below. Retrying " +
          "automatically every " + (PROBE_INTERVAL_MS / 1000) + " seconds.";
    }
  }

  function showUi(url) {
    if (uiLoadedFor !== url) {
      // The Hub serves the existing ZoneGlow UI itself (same files the
      // ESP32 serves), so all relative REST/WS paths inside it just work.
      UI_FRAME.src = url + "/";
      uiLoadedFor = url;
    }
  }

  // WebView load diagnostics (iframe navigation is not CORS-restricted;
  // this confirms the Hub UI actually rendered in the app view).
  UI_FRAME.addEventListener("load", function () {
    log("hub UI loaded in webview from " + uiLoadedFor);
  });

  function tick() {
    if (bleMode) return;
    if (probing) return;
    probing = true;
    var url = ZoneGlowTransport.getUrl();
    if (!HUB_URL_INPUT.value) HUB_URL_INPUT.value = url;
    ZoneGlowTransport.probe(url)
      .then(function () {
        if (bleMode) { probing = false; return; }
        missedProbes = 0;
        everConnected = true;
        ZoneGlowTransport.setUrl(url);   // keep last successfully connected Hub
        showUi(url);
        setState("connected", url);
        hideSplash();
        probing = false;
      })
      .catch(function (err) {
        if (bleMode) { probing = false; return; }
        missedProbes++;
        log("probe failed (" + missedProbes + "/" + MAX_MISSED_PROBES +
          " missed): " + (err && err.message ? err.message : err));
        if (everConnected && missedProbes < MAX_MISSED_PROBES) {
          setState("reconnecting", url);   // brief hiccup: keep the UI up
          probing = false;
          return;
        }
        setState("disconnected", url);
        probing = false;
      });
  }

  CONNECT_BTN.addEventListener("click", function () {
    if (!ZoneGlowTransport.setUrl(HUB_URL_INPUT.value)) {
      HUB_URL_INPUT.classList.add("invalid");
      return;
    }
    HUB_URL_INPUT.classList.remove("invalid");
    uiLoadedFor = "";          // force the iframe to load from the new Hub
    missedProbes = 0;
    everConnected = false;
    userInitiated = true;
    setState("connecting", ZoneGlowTransport.getUrl());
    tick();
  });

  function showBleDevices(devices) {
    BLE_DEVICES.textContent = "";
    if (!devices.length) { BLE_HINT.textContent = "No Training Hub was found. Keep the Hub powered and try again."; return; }
    BLE_HINT.textContent = "Choose the nearby Hub.";
    devices.forEach(function (device) {
      var row = document.createElement("div"); row.className = "ble-device";
      var label = document.createElement("div");
      label.textContent = device.name || "Training Hub";
      var small = document.createElement("small"); small.textContent = device.address + " · " + device.rssi + " dBm";
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
    }).catch(function (error) { BLE_HINT.textContent = error.message || String(error); });
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
    HubBleTransport.requestPermissions().then(function () { return HubBleTransport.scan(); })
      .then(function (result) { showBleDevices(result.devices || []); })
      .catch(function (error) { BLE_HINT.textContent = error.message || String(error); })
      .then(function () { BLE_SCAN.disabled = false; });
  }

  BLE_BTN.addEventListener("click", function () {
    hideSplash(); BLE_PANEL.hidden = false; scanBle();
  });
  BLE_SCAN.addEventListener("click", scanBle);
  BLE_SAVE_SETUP.addEventListener("click", function () {
    var patch = { ftp: Number(BLE_FTP.value), hrMax: Number(BLE_HR_MAX.value), brightness: Number(BLE_BRIGHTNESS.value) };
    BLE_HINT.textContent = "Saving setup…";
    HubBleTransport.command(JSON.stringify({ id: bleCommandId++, op: "config_write", patch: patch }))
      .catch(function (error) { BLE_HINT.textContent = error.message || String(error); });
  });
  BLE_SENSOR_SCAN.addEventListener("click", function () {
    BLE_SENSOR_SCAN.disabled = true; BLE_HINT.textContent = "Searching for sensors…";
    HubBleTransport.command(JSON.stringify({ id: bleCommandId++, op: "scan" })).then(function () { setTimeout(function () {
      HubBleTransport.command(JSON.stringify({ id: bleCommandId++, op: "devices_read" })); BLE_SENSOR_SCAN.disabled = false;
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
      .catch(function (error) { BLE_HINT.textContent = error.message || String(error); });
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
          HubBleTransport.command(message).catch(function (error) { BLE_HINT.textContent = error.message || String(error); });
        });
        row.appendChild(name); row.appendChild(minimum); row.appendChild(color); row.appendChild(save); BLE_ZONES.appendChild(row);
      });
    });
    BLE_ZONES.hidden = false;
  }
  if (HubBleTransport.available()) {
    HubBleTransport.listen("status", function (status) {
      HubBleBridge.receiveStatus(status);
      if (bleMode) return;
      BLE_LIVE.hidden = false; BLE_LIVE.textContent = JSON.stringify(status, null, 2);
    });
    HubBleTransport.listen("result", function (result) {
      HubBleBridge.receiveResult(result);
      if (bleMode) return;
      if (!result.ok) { BLE_HINT.textContent = result.error || "Hub rejected the command"; return; }
      if (result.type !== "config" && result.type !== "devices") return;
      var transfer = bleConfigParts[result.id] || {parts:result.parts, values:[]}; transfer.values[result.part] = result.data; bleConfigParts[result.id] = transfer;
      if (transfer.values.filter(Boolean).length !== transfer.parts) return;
      var data = JSON.parse(transfer.values.join("")); delete bleConfigParts[result.id];
      if (result.type === "config") { BLE_CONFIG.hidden = false; BLE_CONFIG.textContent = "FTP: " + data.ftp + " W · Max HR: " + data.hrMax + " bpm\nZones: " + data.zoneCount + " · LEDs: " + data.ledCount; BLE_SETUP.hidden = false; BLE_FTP.value = data.ftp; BLE_HR_MAX.value = data.hrMax; BLE_BRIGHTNESS.value = data.brightness; renderBleZones(data); return; }
      BLE_SENSORS.textContent = ""; (data.devices || []).forEach(function (sensor) { var row=document.createElement("div"); row.className="ble-device"; row.textContent=(sensor.name||sensor.category)+" · "+sensor.category; var b=document.createElement("button"); b.textContent="Use"; b.onclick=function(){HubBleTransport.command(JSON.stringify({id:bleCommandId++,op:"sensor_connect",sensor:sensor}));}; row.appendChild(b); BLE_SENSORS.appendChild(row); });
    });
    HubBleTransport.listen("connection", function (event) { if (!event.connected) { BLE_LIGHTING.disabled = true; BLE_DISCONNECT.disabled = true; leaveBle(); } });
    HubBleTransport.listen("bleError", function (event) { BLE_HINT.textContent = event.error || "Bluetooth error"; });
  } else {
    BLE_BTN.disabled = true; BLE_BTN.title = "Bluetooth is available in the Android app";
  }
  HUB_URL_INPUT.addEventListener("input", function () {
    HUB_URL_INPUT.classList.remove("invalid");
  });

  setState("connecting", ZoneGlowTransport.getUrl());
  tick();
  setInterval(tick, PROBE_INTERVAL_MS);
  setTimeout(hideSplash, 1200);   // branding window: 1.2 s max, never blocking
})();

