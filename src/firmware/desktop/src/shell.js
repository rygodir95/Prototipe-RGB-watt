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

(function () {
  var $ = function (id) { return document.getElementById(id); };
  var UI_FRAME = $("uiFrame");
  var OVERLAY = $("overlay");
  var STATUS_TEXT = $("statusText");
  var BACKEND_LABEL = $("backendLabel");
  var BACKEND_URL_INPUT = $("backendUrl");
  var CONNECT_BTN = $("connectBtn");
  var OVERLAY_HINT = $("overlayHint");

  var PROBE_INTERVAL_MS = 2000;
  var MAX_MISSED_PROBES = 2;   // tolerate one dropped probe before "Disconnected"
  var uiLoadedFor = "";        // backend URL currently loaded in the iframe
  var everConnected = false;
  var missedProbes = 0;
  var probing = false;

  function setState(state, url) {
    document.body.dataset.state = state;   // connected | connecting | disconnected
    STATUS_TEXT.textContent =
      state === "connected" ? "Connected" :
      state === "disconnected" ? "Disconnected" : "Connecting…";
    BACKEND_LABEL.textContent = "PC Simulator · " + url;
    if (state === "connected") {
      UI_FRAME.style.display = "block";
      OVERLAY.style.display = "none";
    } else {
      UI_FRAME.style.display = "none";
      OVERLAY.style.display = "flex";
      OVERLAY_HINT.textContent = state === "connecting"
        ? "Looking for the ZoneGlow backend at " + url + " …"
        : "Cannot reach " + url + ". Start the PC simulator, or set the backend " +
          "address below. Retrying automatically every " +
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
    if (probing) return;
    probing = true;
    var url = ZoneGlowTransport.getUrl();
    if (!BACKEND_URL_INPUT.value) BACKEND_URL_INPUT.value = url;
    ZoneGlowTransport.probe(url)
      .then(function () {
        missedProbes = 0;
        everConnected = true;
        showUi(url);
        setState("connected", url);
        probing = false;
      })
      .catch(function () {
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
    setState("connecting", ZoneGlowTransport.getUrl());
    tick();
  });
  BACKEND_URL_INPUT.addEventListener("input", function () {
    BACKEND_URL_INPUT.classList.remove("invalid");
  });

  setState("connecting", ZoneGlowTransport.getUrl());
  tick();
  setInterval(tick, PROBE_INTERVAL_MS);
})();