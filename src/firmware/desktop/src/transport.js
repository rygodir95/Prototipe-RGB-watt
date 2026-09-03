// ZoneGlow desktop - BackendTransport abstraction.
//
// The ZoneGlow web UI is served BY the backend itself (the PC simulator today,
// the real ESP32 controller in production). A "transport" therefore reduces to
// two things: which base URL to load the UI from, and how to check that the
// backend is alive. The UI, its REST API and its WebSocket telemetry are
// identical in both cases, so switching the desktop app from the PC Simulator
// (SimulatorTransport) to the ESP32 (Esp32Transport) later only means pointing
// this shell at the controller's LAN address - no UI rewrite, no code changes
// in the web app or firmware.
"use strict";

var ZoneGlowTransport = (function () {
  var TRANSPORTS = {
    simulator: {
      id: "simulator",
      label: "PC Simulator",
      defaultUrl: "http://localhost:8080",   // development default
      implemented: true
    },
    esp32: {
      id: "esp32",
      label: "ESP32 ZoneGlow Controller",
      defaultUrl: "",        // future: the controller's LAN address
      implemented: false     // intentionally NOT implemented in this milestone
    }
  };

  var STORAGE_KEY = "zoneglow.backend.url";

  function storage() {
    try {
      return typeof localStorage !== "undefined" ? localStorage : null;
    } catch (e) {
      return null;
    }
  }

  // Accepts "http://localhost:8080/", "localhost:8080", "192.168.1.50" ...
  // Returns "" for anything unusable.
  function normalizeUrl(url) {
    if (typeof url !== "string") return "";
    url = url.trim();
    if (url === "") return "";
    if (!/^https?:\/\//i.test(url)) {
      if (!/^[\w.-]+(:\d+)?(\/|$)/.test(url)) return "";
      url = "http://" + url;
    }
    return url.replace(/\/+$/, "");
  }

  function getUrl() {
    var s = storage();
    var saved = s ? s.getItem(STORAGE_KEY) : null;
    return normalizeUrl(saved) || TRANSPORTS.simulator.defaultUrl;
  }

  function setUrl(url) {
    var normalized = normalizeUrl(url);
    if (!normalized) return false;
    var s = storage();
    if (s) s.setItem(STORAGE_KEY, normalized);
    return true;
  }

  // Liveness probe. Both the simulator and the ESP32 firmware expose
  // GET /api/info; anything else is treated as "backend not reachable".
  function probe(url, timeoutMs) {
    timeoutMs = timeoutMs || 1500;
    var controller = typeof AbortController !== "undefined" ? new AbortController() : null;
    var timer = controller
      ? setTimeout(function () { controller.abort(); }, timeoutMs)
      : null;
    return fetch(url + "/api/info", { signal: controller ? controller.signal : undefined })
      .then(function (res) {
        if (timer) clearTimeout(timer);
        if (!res.ok) throw new Error("HTTP " + res.status);
        return true;
      })
      .catch(function (err) {
        if (timer) clearTimeout(timer);
        throw err;
      });
  }

  return {
    TRANSPORTS: TRANSPORTS,
    STORAGE_KEY: STORAGE_KEY,
    normalizeUrl: normalizeUrl,
    getUrl: getUrl,
    setUrl: setUrl,
    probe: probe
  };
})();

// Node export: lets the shell logic be smoke-tested without a browser.
/* global module */
if (typeof module !== "undefined" && module.exports) module.exports = ZoneGlowTransport;