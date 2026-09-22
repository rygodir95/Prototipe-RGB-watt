// Native Tauri bridge for the Hub's local BLE GATT service.
"use strict";

var HubBleTransport = (function () {
  function core() {
    return window.__TAURI__ && window.__TAURI__.core;
  }
  function invoke(command, args) {
    if (!core()) return Promise.reject(new Error("Bluetooth is available in the Windows app"));
    return core().invoke(command, args || {});
  }
  function listen(event, callback) {
    if (!window.__TAURI__ || !window.__TAURI__.event) return Promise.reject(new Error("Bluetooth is unavailable"));
    return window.__TAURI__.event.listen(event, function (message) { callback(message.payload); });
  }
  return {
    available: function () { return !!core(); },
    scan: function () { return invoke("ble_scan"); },
    connect: function (address) { return invoke("ble_connect", { address: address }); },
    disconnect: function () { return invoke("ble_disconnect"); },
    command: function (message) { return invoke("ble_command", { message: message }); },
    listen: listen
  };
})();

