// Native Tauri bridge. Client tokens fence queued native events across connects.
"use strict";
var HubBleTransport = (function () {
  var sequence = 0, clientId = null, session = null, connecting = false;
  var instance = window.crypto.randomUUID();
  var ready = Promise.resolve();
  function core() { return window.__TAURI__ && window.__TAURI__.core; }
  function invoke(command, args) {
    if (!core()) return Promise.reject(new Error("Bluetooth is available in the Windows app"));
    return core().invoke(command, args || {});
  }
  function listen(event, callback) {
    if (!window.__TAURI__ || !window.__TAURI__.event) return Promise.reject(new Error("Bluetooth is unavailable"));
    var registration = window.__TAURI__.event.listen(event, function (message) {
      var payload = message.payload;
      if (!payload || payload.clientId !== clientId) return;
      if (session !== null && payload.session !== session) return;
      session = payload.session;
      if (event === "ble-connection" && payload.value === false) {
        clientId = null; session = null; connecting = false;
      }
      callback(payload.value);
    });
    ready = Promise.all([ready, registration]);
    return registration;
  }
  return {
    available: function () { return !!core(); },
    scan: function () { return invoke("ble_scan"); },
    connect: function (address) {
      if (connecting || clientId !== null) return Promise.reject(new Error("A BLE session is already active or connecting"));
      var token = "desktop-" + instance + "-" + (++sequence);
      clientId = token; session = null; connecting = true;
      // Native event subscriptions must finish before native startup can emit.
      return ready.then(function () {
        if (clientId !== token) throw new Error("BLE session was cancelled");
        return invoke("ble_connect", { address: address, clientId: token });
      }).then(function (generation) {
        if (clientId !== token) throw new Error("BLE session was cancelled");
        if (session !== null && session !== generation) throw new Error("BLE session changed during startup");
        session = generation; connecting = false;
        return generation;
      }).catch(function (error) {
        if (clientId === token) { clientId = null; session = null; connecting = false; }
        throw error;
      });
    },
    disconnect: function () {
      clientId = null; session = null; connecting = false;
      return invoke("ble_disconnect");
    },
    command: function (message) {
      var token = clientId;
      if (token === null) return Promise.reject(new Error("Hub is not connected"));
      return invoke("ble_command", { message: message, clientId: token }).then(function (result) {
        if (clientId !== token) throw new Error("BLE session was cancelled");
        return result;
      });
    },
    listen: listen
  };
})();