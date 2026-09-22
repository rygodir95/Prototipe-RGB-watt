// Adapter between the existing Web UI's API contract and the Hub BLE service.
// This is shared by the Windows and Android shells; the Hub remains authoritative.
"use strict";

var HubBleBridge = (function () {
  var transport = null;
  var connected = false;
  var nextId = 1;
  var pending = null;
  var serial = Promise.resolve();
  var config = null;
  var telemetryListeners = [];

  function configure(value) { transport = value; }
  function setConnected(value) {
    connected = !!value;
    if (!connected) {
      if (pending) { clearTimeout(pending.timer); pending.reject(new Error("Hub disconnected")); pending = null; }
      telemetryListeners.forEach(function (listener) { listener(null); });
    }
  }
  function sendNow(op, fields) {
    if (!connected || !transport) return Promise.reject(new Error("Hub is not connected"));
    var id = nextId++;
    var message = JSON.stringify(Object.assign({ id: id, op: op }, fields || {}));
    if (new TextEncoder().encode(message).length > 180) return Promise.reject(new Error("BLE command is too large"));
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () {
        if (pending && pending.id === id) pending = null;
        reject(new Error("Hub did not answer " + op));
      }, 10000);
      pending = { id: id, resolve: resolve, reject: reject, timer: timer };
      Promise.resolve(transport.command(message)).catch(function (error) {
        if (pending && pending.id === id) { clearTimeout(timer); pending = null; reject(error); }
      });
    });
  }
  function send(op, fields) {
    var result = serial.then(function () { return sendNow(op, fields); });
    serial = result.catch(function () {});
    return result;
  }
  function receiveResult(raw) {
    var result;
    try { result = typeof raw === "string" ? JSON.parse(raw) : raw; } catch (_) { return; }
    if (!pending || !result || result.id !== pending.id) return;
    var current = pending; pending = null; clearTimeout(current.timer);
    if (result.ok === false) current.reject(new Error(result.error || "Hub rejected the command"));
    else current.resolve(result);
  }
  async function readPaged(op) {
    var first = await send(op, { part: 0 });
    if (!Number.isInteger(first.parts) || first.parts < 1 || first.parts > 128 || first.part !== 0) {
      throw new Error("Invalid Hub response");
    }
    var chunks = [first.data];
    for (var part = 1; part < first.parts; part++) {
      var next = await send(op, { part: part });
      if (next.part !== part || next.parts !== first.parts || next.type !== first.type) throw new Error("Incomplete Hub response");
      chunks.push(next.data);
    }
    return JSON.parse(chunks.join(""));
  }
  async function readConfig() { config = await readPaged("config_read"); return config; }
  async function writeConfig(patch) {
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new Error("Invalid configuration");
    var scalar = Object.assign({}, patch);
    var zones = scalar.zones, hrZones = scalar.hrZones;
    delete scalar.zones; delete scalar.hrZones;
    // Keep the FTP/zone-count regeneration coupled, as in the HTTP API.
    if (Object.prototype.hasOwnProperty.call(scalar, "zoneCount")) {
      var model = { zoneCount: scalar.zoneCount };
      if (Object.prototype.hasOwnProperty.call(scalar, "ftp")) { model.ftp = scalar.ftp; delete scalar.ftp; }
      delete scalar.zoneCount;
      await send("config_write", { patch: model, ack: true });
    }
    // A single field always fits the bounded BLE command and firmware patch.
    for (var key of Object.keys(scalar)) {
      if (key === "controlSource" || key === "hrZonesCustom") continue; // derived/internal
      var one = {}; one[key] = scalar[key];
      await send("config_write", { patch: one, ack: true });
    }
    for (var group of [["power", zones], ["hr", hrZones]]) {
      if (!Array.isArray(group[1])) continue;
      await send("zone_begin", { source: group[0], count: group[1].length });
      for (var index = 0; index < group[1].length; index++) {
        var zone = group[1][index];
        await send("zone_stage", { zone: { source: group[0], index: index, name: zone.name, min: zone.min, color: zone.color } });
      }
      await send("zone_commit");
    }
    return readConfig();
  }
  async function api(path, method, body) {
    method = (method || "GET").toUpperCase();
    if (path === "/api/config" && method === "GET") return readConfig();
    if (path === "/api/config" && method === "POST") return writeConfig(body);
    if (path === "/api/info" && method === "GET") return send("info");
    if (path === "/api/scan" && method === "POST") { await send("scan"); return { ok: true }; }
    if (path === "/api/devices" && method === "GET") return readPaged("devices_read");
    if (path === "/api/connect" && method === "POST") {
      await send("sensor_connect", { sensor: { address: body.address, name: body.name, category: body.category } });
      return { ok: true };
    }
    if (path === "/api/disconnect" && method === "POST") { await send("sensor_disconnect"); return { ok: true }; }
    if (path === "/api/forget" && method === "POST") { await send("sensor_forget"); return { ok: true }; }
    if (path === "/api/factory-reset" && method === "POST") { await send("factory_reset"); return { ok: true, reboot: true }; }
    if (path === "/api/simulation" && method === "POST") {
      var sim = {};
      if (Object.prototype.hasOwnProperty.call(body, "enabled")) sim.on = !!body.enabled;
      if (Object.prototype.hasOwnProperty.call(body, "watts")) sim.value = Number(body.watts);
      if (Object.prototype.hasOwnProperty.call(body, "bpm")) sim.value = Number(body.bpm);
      if (Object.prototype.hasOwnProperty.call(body, "lightingTest")) sim.lightingTest = !!body.lightingTest;
      await send("simulation", sim); return { ok: true };
    }
    throw new Error(path + " is not available over Bluetooth");
  }
  function receiveStatus(raw) {
    var status;
    try { status = typeof raw === "string" ? JSON.parse(raw) : raw; } catch (_) { return; }
    if (!status || !connected) return;
    var hr = status.source === "hr";
    var zones = config ? (hr ? config.hrZones : config.zones) : null;
    var zone = zones && status.zone >= 0 ? zones[status.zone] : null;
    var frame = {
      mode: hr ? "hr" : "power", state: status.state, connected: !!status.connected,
      hasData: !!status.data, sim: !!status.sim, raw: status.raw == null ? status.value : status.raw,
      smoothed: status.value, hr: hr ? status.value : 0, hrRaw: hr ? (status.raw == null ? status.value : status.raw) : 0,
      hrMax: config ? config.hrMax : 0, zone: status.zone, zoneName: zone ? zone.name : "",
      color: status.color || "#000000", source: status.sim ? "Simulation" :
        (config ? (hr ? config.hrSourceName : config.sourceName) : "")
    };
    telemetryListeners.slice().forEach(function (listener) { listener(frame); });
  }
  function subscribeTelemetry(listener) {
    telemetryListeners.push(listener);
    return function () { telemetryListeners = telemetryListeners.filter(function (item) { return item !== listener; }); };
  }
  return { configure: configure, setConnected: setConnected, receiveResult: receiveResult,
    receiveStatus: receiveStatus, subscribeTelemetry: subscribeTelemetry, api: api };
})();

if (typeof module !== "undefined" && module.exports) module.exports = HubBleBridge;

