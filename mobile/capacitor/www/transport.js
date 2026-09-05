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

  // ---- diagnostics --------------------------------------------------------
  // Prefixed so `adb logcat` (chromium tag) or the remote WebView console
  // shows every probe decision in one place.
  function log(msg) {
    try { console.log("[ZoneGlow][transport] " + msg); } catch (e) {}
  }

  function brief(v) {
    try {
      var s = typeof v === "string" ? v : JSON.stringify(v);
      return (s || String(v)).slice(0, 200);
    } catch (e) {
      return String(v).slice(0, 200);
    }
  }

  function errText(err) {
    return err ? (err.message || String(err)) : "unknown error";
  }

  // A reachable, valid Hub answers 200 with a JSON object. Anything else
  // (non-200, non-JSON body) means "not a ZoneGlow Hub here".
  function validateInfo(status, doc) {
    if (status !== 200) throw new Error("HTTP " + status);
    if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
      throw new Error("/api/info did not return a JSON object");
    }
    return true;
  }

  // Liveness probe. Both the simulator and the ESP32 Hub expose
  // GET /api/info.
  //
  // IMPORTANT: inside the Android WebView this shell is served at the origin
  // http://localhost, so a plain fetch() to the Hub is a CROSS-ORIGIN request.
  // The Hub serves no CORS headers (and must not need to), so the WebView
  // blocks the response and fetch() rejects with "Failed to fetch" even though
  // the Hub is reachable - the app would show "Disconnected" forever. The fix:
  // inside Capacitor, probe through the built-in native CapacitorHttp plugin
  // (native HTTP, no CORS; cleartext is governed by the app's network security
  // config). Plain fetch() is only a fallback for developing this shell in a
  // desktop browser.
  function probe(url, timeoutMs, fetchImpl) {
    timeoutMs = timeoutMs || 1500;
    var target = url + "/api/info";
    var startedAt = Date.now();
    log("probe GET " + target);

    var work;
    var cap = (typeof window !== "undefined" && window.Capacitor) || null;
    var nativeHttp = (cap && cap.isNativePlatform && cap.isNativePlatform()
      && cap.Plugins && cap.Plugins.CapacitorHttp)
      ? cap.Plugins.CapacitorHttp : null;

    if (nativeHttp) {
      log("using native CapacitorHttp (shell origin " +
        (typeof location !== "undefined" ? location.origin : "?") +
        "; plain fetch would be cross-origin and CORS-blocked)");
      work = nativeHttp.get({ url: target, connectTimeout: 5000, readTimeout: 5000 })
        .then(function (res) {
          var status = res && res.status;
          log("HTTP " + status + " in " + (Date.now() - startedAt) +
            " ms; body: " + brief(res && res.data));
          return validateInfo(status, res && res.data);   // res.data is parsed JSON
        }, function (err) {
          log("network error: " + errText(err));
          throw err instanceof Error ? err : new Error(errText(err));
        });
    } else {
      var doFetch = fetchImpl || (typeof fetch === "function" ? fetch : null);
      if (!doFetch) {
        log("no fetch available");
        return Promise.reject(new Error("no fetch available"));
      }
      log("using plain fetch (no native CapacitorHttp available)");
      work = doFetch(target)
        .then(function (res) {
          log("HTTP " + res.status + " in " + (Date.now() - startedAt) + " ms");
          if (!res.ok) throw new Error("HTTP " + res.status);
          return res.text();
        })
        .then(function (body) {
          log("body: " + brief(body));
          var doc;
          try { doc = JSON.parse(body); }
          catch (e) { throw new Error("/api/info did not return a JSON object"); }
          return validateInfo(200, doc);
        }, function (err) {
          log("fetch/network error: " + errText(err) +
            " (in a WebView/browser this is also how a CORS-blocked response appears)");
          throw err;
        });
    }

    // Hard timeout for both paths (native calls cannot be aborted via signal).
    var timeoutId;
    var timeoutP = new Promise(function (resolve, reject) {
      timeoutId = setTimeout(function () {
        log("probe timed out after " + timeoutMs + " ms");
        reject(new Error("probe timed out after " + timeoutMs + " ms"));
      }, timeoutMs);
    });
    return Promise.race([work, timeoutP]).then(
      function (v) { clearTimeout(timeoutId); return v; },
      function (e) { clearTimeout(timeoutId); throw e; }
    );
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