// Thin browser-to-native adapter for the local Hub BLE GATT service.
// It deliberately contains no business logic; the Hub remains authoritative.
"use strict";

var HubBleTransport = (function () {
  function plugin() {
    var cap = typeof window !== "undefined" ? window.Capacitor : null;
    return cap && cap.Plugins ? cap.Plugins.HubBle : null;
  }
  function required() {
    var value = plugin();
    if (!value) return Promise.reject(new Error("Bluetooth is available in the Android app, not this browser"));
    return Promise.resolve(value);
  }
  function call(name, args) { return required().then(function (p) { return p[name](args || {}); }); }
  function listen(name, callback) { return required().then(function (p) { return p.addListener(name, callback); }); }

  return {
    available: function () { return !!plugin(); },
    requestPermissions: function () { return call("requestBluetoothPermissions"); },
    scan: function () { return call("scan"); },
    connect: function (address) { return call("connect", { address: address }); },
    disconnect: function () { return call("disconnect"); },
    command: function (message) { return call("command", { message: message }); },
    listen: listen
  };
})();

