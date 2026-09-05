// ZoneGlow mobile - Hub transport abstraction.
//
// The ZoneGlow web UI is served BY the Hub itself (the PC simulator in
// development, the real ESP32 ZoneGlow Hub in production). A "transport"
// therefore reduces to two things: which base URL to load the UI from,
// and how to check that the Hub is alive. The UI, its REST API and its
// WebSocket telemetry are identical in both cases, so pointing the mobile
// app at any Hub address needs no UI rewrite and no firmware changes.
"use strict";

var ZoneGlowTransport = (function () {
  var DEFAULT_URL = "http://zoneglow.local";
  var STORAGE_KEY = "zoneglow.hub.url";

  function storage() {
    try {
      return typeof localStorage !== "undefined" ? localStorage : null;
    } catch (e) {
      return null;
    }
  }

  // Accepts "http://zoneglow.local/", "192.168.1.50", "10.0.2.2:8080" ...
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

  // Last successfully connected Hub address (requirement: persist on the
  // phone). Falls back to the default suggestion when nothing stored yet.
  function getUrl() {
    var s = storage();
    var saved = s ? s.getItem(STORAGE_KEY) : null;
    return normalizeUrl(saved) || DEFAULT_URL;
  }

  function setUrl(url) {
    var normalized = normalizeUrl(url);
    if (!normalized) return false;
    var s = storage();
    if (s) s.setItem(STORAGE_KEY, normalized);
    return true;
  }

  // Liveness probe. Both the simulator and the ESP32 Hub expose
  // GET /api/info; anything else is treated as "Hub not reachable".
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
    DEFAULT_URL: DEFAULT_URL,
    STORAGE_KEY: STORAGE_KEY,
    normalizeUrl: normalizeUrl,
    getUrl: getUrl,
    setUrl: setUrl,
    probe: probe
  };
})();

/* global module */   // only present under Node (smoke tests), never in the WebView

// Node export: lets the shell logic be smoke-tested without a browser.
if (typeof module !== "undefined" && module.exports) module.exports = ZoneGlowTransport;