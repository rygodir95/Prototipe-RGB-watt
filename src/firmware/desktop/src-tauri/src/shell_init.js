// ZoneGlow desktop - shell status overlay, injected by Tauri BEFORE the
// ZoneGlow UI's own scripts run.
//
// The UI is served locally, so it always renders - even with the backend
// offline. This script only keeps the UI's own status pill honest while the
// backend is unreachable: it probes GET /api/info (through the shell server,
// which fails fast when the backend is down) every 2 seconds and shows
// "Disconnected" in the same style app.js uses for its DISCONNECTED state.
// Once the backend returns, the UI's WebSocket telemetry drives the pill
// again and this script stops touching it.
"use strict";
(function () {
  var offline = false;

  function setPillDisconnected() {
    var pill = document.getElementById("statusPill");
    var text = document.getElementById("statusText");
    if (pill) pill.className = "status-pill";   // same class app.js uses for DISCONNECTED
    if (text) text.textContent = "Disconnected";
    document.title = "ZoneGlow — Disconnected";
  }

  function setOnline() {
    if (offline) {
      offline = false;
      document.title = "ZoneGlow";
      // The pill itself is refreshed by the UI's own telemetry on the next
      // WebSocket frame - do not fight app.js over it.
    }
  }

  function probe() {
    fetch("/api/info", { cache: "no-store" })
      .then(function (res) {
        if (res.ok) setOnline();
        else setPillDisconnected();
      })
      .catch(function () {
        setPillDisconnected();
      });
  }

  document.addEventListener("DOMContentLoaded", function () {
    probe();
    setInterval(probe, 2000);
  });
})();