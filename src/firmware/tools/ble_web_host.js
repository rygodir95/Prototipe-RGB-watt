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
  var lastFrame = null;
  var lastFrameAt = 0;
  // A status frame older than this is never replayed to a late subscriber: the
  // UI watchdog uses the same window, so replaying stale data would report a
  // dead link as alive.
  var STATUS_STALE_MS = 6000;
  // One exclusive slot per paged-transfer KIND. It covers the WHOLE read (page 0
  // to the final page, including the single permitted retry): the Hub keeps one
  // transfer slot per kind, so a second page-0 request would replace the token
  // under the first reader and answer "transfer expired". config_read and
  // devices_read keep independent slots.
  var readLocks = {};

  function configure(value) { transport = value; }
  function setConnected(value) {
    connected = !!value;
    if (!connected) {
      if (pending) { clearTimeout(pending.timer); pending.reject(new Error("Hub disconnected")); pending = null; }
      lastFrame = null;
      lastFrameAt = 0;
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
      Promise.resolve(transport.command(message)).then(function (result) {
        // Desktop can also read the result characteristic directly. Android
        // continues to resolve through the subscribed notification instead.
        if (result) receiveResult(result);
      }).catch(function (error) {
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
  // A paged read can lose its transfer between pages: the other paged read
  // (config_read / devices_read) may have started, the 60 s window may have
  // elapsed, or the page itself may have been dropped. That is ONE retry from
  // page 0 - never an unbounded loop, and never for a rejected command, an
  // unrelated error or a timeout.
  var TRANSFER_RETRY_LIMIT = 1;
  function isTransferFailure(error) {
    var message = error && error.message ? error.message : String(error);
    return /transfer expired/i.test(message) || /Incomplete Hub response/i.test(message) || /Invalid Hub response/i.test(message);
  }
  async function readPagedOnce(op) {
    var first = await send(op, { part: 0 });
    if (!Number.isInteger(first.parts) || first.parts < 1 || first.parts > 128 || first.part !== 0) {
      throw new Error("Invalid Hub response");
    }
    // Every page-0 request opens a new transfer on the Hub; carry its token so
    // a response from an older transfer is rejected instead of concatenated.
    var transfer = Number.isInteger(first.t) ? first.t : null;
    var chunks = [first.data];
    for (var part = 1; part < first.parts; part++) {
      var fields = { part: part };
      if (transfer !== null) fields.t = transfer;
      var next = await send(op, fields);
      if (next.part !== part || next.parts !== first.parts || next.type !== first.type) throw new Error("Incomplete Hub response");
      if (transfer !== null && Number.isInteger(next.t) && next.t !== transfer) throw new Error("Incomplete Hub response");
      chunks.push(next.data);
    }
    return JSON.parse(chunks.join(""));
  }
  // Run a whole paged read inside its kind's exclusive slot. A second read of
  // the same kind waits for the first to finish, so it can never replace the
  // transfer token mid-read; the retry below stays inside the same slot too.
  function withReadSlot(op, task) {
    var previous = readLocks[op] || Promise.resolve();
    var run = previous.then(task, task);        // run even if the previous read failed
    readLocks[op] = run.then(function () {}, function () {});
    return run;
  }
  async function readPaged(op) {
    return withReadSlot(op, async function () {
      var attempts = 0;
      for (;;) {
        try {
          return await readPagedOnce(op);
        } catch (error) {
          if (attempts >= TRANSFER_RETRY_LIMIT || !isTransferFailure(error)) throw error;
          attempts++;
        }
      }
    });
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
    lastFrame = frame;
    lastFrameAt = Date.now();
    telemetryListeners.slice().forEach(function (listener) { listener(frame); });
  }
  function subscribeTelemetry(listener) {
    telemetryListeners.push(listener);
    // A subscriber that arrives between notifications still gets the current
    // frame at once - but only while it is fresh.
    if (connected && lastFrame && (Date.now() - lastFrameAt) <= STATUS_STALE_MS) {
      var current = lastFrame;
      setTimeout(function () { listener(current); }, 0);
    }
    return function () { telemetryListeners = telemetryListeners.filter(function (item) { return item !== listener; }); };
  }
  return { configure: configure, setConnected: setConnected, receiveResult: receiveResult,
    receiveStatus: receiveStatus, subscribeTelemetry: subscribeTelemetry, api: api };
})();

if (typeof module !== "undefined" && module.exports) module.exports = HubBleBridge;

