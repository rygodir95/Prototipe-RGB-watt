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

  var PROBE_INTERVAL_MS = 2000;
  var MAX_MISSED_PROBES = 3;   // sustained loss threshold for "Disconnected"
  var uiLoadedFor = "";        // Hub URL currently loaded in the iframe
  var everConnected = false;
  var missedProbes = 0;
  var probing = false;

  function setState(state, url) {
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
        ? "Looking for the ZoneGlow Hub at " + url + " …"
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

  function tick() {
    if (probing) return;
    probing = true;
    var url = ZoneGlowTransport.getUrl();
    if (!HUB_URL_INPUT.value) HUB_URL_INPUT.value = url;
    ZoneGlowTransport.probe(url)
      .then(function () {
        missedProbes = 0;
        if (!everConnected) {
          everConnected = true;
          ZoneGlowTransport.setUrl(url);   // remember last successful Hub
        }
        showUi(url);
        setState("connected", url);
        probing = false;
      })
      .catch(function () {
        missedProbes++;
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
    setState("connecting", ZoneGlowTransport.getUrl());
    tick();
  });
  HUB_URL_INPUT.addEventListener("input", function () {
    HUB_URL_INPUT.classList.remove("invalid");
  });

  setState("connecting", ZoneGlowTransport.getUrl());
  tick();
  setInterval(tick, PROBE_INTERVAL_MS);
})();