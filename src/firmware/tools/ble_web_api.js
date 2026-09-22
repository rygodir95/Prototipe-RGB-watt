// Run the canonical Hub Web UI against the native BLE bridge in the parent shell.
// Only the packaged local copy loads this file; the ESP32-hosted Web UI stays HTTP.
"use strict";

(function () {
  var bridge = window.parent && window.parent.HubBleBridge;
  if (!bridge) throw new Error("Bluetooth bridge is unavailable");
  var networkFetch = window.fetch.bind(window);

  window.fetch = function (input, options) {
    var path = typeof input === "string" ? input : input && input.url;
    if (!path || !/^\/api\//.test(path)) return networkFetch(input, options);
    var method = (options && options.method) || "GET";
    var body = options && options.body ? JSON.parse(options.body) : undefined;
    var signal = options && options.signal;
    if (signal && signal.aborted) return Promise.reject(new DOMException("Aborted", "AbortError"));
    var call = bridge.api(path, method, body).then(function (value) {
      return new Response(JSON.stringify(value), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    if (!signal) return call;
    return Promise.race([call, new Promise(function (_, reject) {
      signal.addEventListener("abort", function () { reject(new DOMException("Aborted", "AbortError")); }, { once: true });
    })]);
  };

  // The existing dashboard expects WebSocket-style telemetry. Preserve that
  // interface locally; frames themselves come from the Hub's BLE status GATT.
  function BleSocket() {
    var self = this;
    this.readyState = 0;
    this.onmessage = null; this.onerror = null; this.onclose = null; this.onopen = null;
    this.unsubscribe = bridge.subscribeTelemetry(function (frame) {
      if (frame === null) { self.close(); return; }
      if (self.readyState === 1 && self.onmessage) self.onmessage({ data: JSON.stringify(frame) });
    });
    setTimeout(function () { if (self.readyState === 0) { self.readyState = 1; if (self.onopen) self.onopen(); } }, 0);
  }
  BleSocket.CONNECTING = 0; BleSocket.OPEN = 1; BleSocket.CLOSING = 2; BleSocket.CLOSED = 3;
  BleSocket.prototype.close = function () {
    if (this.readyState === 3) return;
    this.readyState = 3;
    if (this.unsubscribe) { this.unsubscribe(); this.unsubscribe = null; }
    if (this.onclose) this.onclose();
  };
  window.WebSocket = BleSocket;

  // These operations require a protected network upload/provisioning path.
  // Do not silently claim success or send Wi-Fi secrets over unpaired GATT.
  document.addEventListener("DOMContentLoaded", function () {
    var restrictions = [
      ["wifiSaveBtn", "Wi-Fi setup is not available over this Bluetooth connection."],
      ["otaBtn", "Firmware updates require the Hub's Wi-Fi connection."],
      ["importCfgBtn", "Bluetooth configuration import is unavailable until atomic restore is supported."]
    ];
    restrictions.forEach(function (item) {
      var button = document.getElementById(item[0]);
      if (!button) return;
      button.disabled = true;
      button.title = item[1];
      var note = document.createElement("p"); note.className = "muted"; note.textContent = item[1];
      button.insertAdjacentElement("afterend", note);
    });
  });
})();

