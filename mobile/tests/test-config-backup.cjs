// ZoneGlow hub web UI - config backup / Lighting Test / onboarding / error states.
//
// Loads the REAL Hub-served UI (src/firmware/data/web/app.js) in a Node vm
// with a stubbed DOM, a controllable fake clock and a captured fetch, then
// verifies the production-readiness additions:
//   * configuration export/import: versioned schema, strict validation,
//     atomic apply (a malformed file never reaches POST /api/config),
//     secrets/sensor pairings never exported,
//   * Lighting Test lifecycle over the existing /api/simulation endpoint,
//   * onboarding persistence + re-launch (hardware-setup wizard),
//   * plain-English connection states + hub-lost banner on WS loss.
//
// Run: node mobile/tests/test-config-backup.cjs

"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const APP_JS = path.join(__dirname, "..", "..", "src", "firmware", "data", "web", "app.js");
const CFG_SCHEMA = "zoneglow.config";   // must match app.js
const CFG_VERSION = 1;                  // must match app.js

let failures = 0;
let count = 0;
function assert(cond, msg) {
  count++;
  if (cond) { console.log("  ok   - " + msg); }
  else { failures++; console.error("  FAIL - " + msg); }
}
async function settle() { await new Promise((r) => setTimeout(r, 10)); }
function fire(el, ev) { (el._listeners[ev] || []).forEach((fn) => fn({})); }

// ---------------- stub DOM / browser environment ----------------

function makeElement(elements) {
  const el = {
    _tc: "", _ih: "", _children: [], _listeners: {}, _id: "",
    style: {}, dataset: {}, value: "",
    checked: false, disabled: false, className: "", hidden: false,
    files: [],
    classList: {
      add() {}, remove() {}, toggle() {}, contains() { return false; },
    },
    appendChild(c) { el._children.push(c); return c; },
    addEventListener(ev, fn) { (el._listeners[ev] = el._listeners[ev] || []).push(fn); },
    querySelector() { return makeElement(); },
    querySelectorAll() { return []; },
    click() { (el._listeners.click || []).forEach((fn) => fn({})); },
  };
  Object.defineProperty(el, "textContent", {
    get() { return el._tc; },
    set(v) { el._tc = v === undefined || v === null ? "" : String(v); },
  });
  // DOM semantics the app relies on: setting innerHTML drops the children,
  // and assigning an id makes the element findable via getElementById.
  Object.defineProperty(el, "innerHTML", {
    get() { return el._ih; },
    set(v) { el._ih = v === undefined || v === null ? "" : String(v); el._children = []; },
  });
  Object.defineProperty(el, "id", {
    get() { return el._id; },
    set(v) {
      el._id = v === undefined || v === null ? "" : String(v);
      if (el._id && elements) elements[el._id] = el;
    },
  });
  Object.defineProperty(el, "children", { get() { return el._children; } });
  return el;
}

const DEVICES = [
  { address: "02:00:00:00:11:22", name: "Virtual Trainer", type: "FTMS",
    category: "power", rssi: -57, connected: false },
  { address: "02:00:00:00:55:66", name: "Virtual HR Strap", type: "HRS",
    category: "hr", rssi: -59, connected: false },
];

const INFO = { version: "1.0.0", versionCode: 10000, build: "sim",
  deviceId: "PC-SIMULATOR", serial: "SIM-000001" };

function configDoc() {
  return {
    controlSource: "power", ftp: 250, smoothing: 30, powerTimeout: 5000,
    hysteresis: 5, zoneCount: 7,
    zones: Array.from({ length: 7 }, (_, i) => ({
      name: "Z" + (i + 1) + " · Zone", min: i * 50,
      max: i < 6 ? i * 50 + 49 : -1, color: "#123456" })),
    hrMax: 190, hrZonesCustom: false,
    hrZones: Array.from({ length: 5 }, (_, i) => ({
      name: "Z" + (i + 1) + " · HR", min: 90 + i * 25, max: 0, color: "#654321" })),
    ledPin: 5, ledCount: 60, brightness: 80, ledType: "WS2812B", ledEffect: 0,
    autoReconnect: true, debug: false, wifiSsid: "HomeNet", theme: "dark",
    sourceAddr: "02:aa", sourceName: "Power Meter",
    hrSourceAddr: "02:bb", hrSourceName: "HR Strap",
  };
}

function makeContext(fetchOverride) {
  const elements = {};
  const listeners = {};
  const posts = [];   // captured POST bodies: {url, doc}
  const documentStub = {
    documentElement: makeElement(elements),
    body: makeElement(elements),
    getElementById: (id) => (elements[id] = elements[id] || makeElement(elements)),
    createElement: () => makeElement(elements),
    querySelectorAll: () => [],
    addEventListener: (ev, fn) => { (listeners[ev] = listeners[ev] || []).push(fn); },
  };

  // controllable clock with timers AND intervals
  let now = 0, nextId = 1;
  const timers = new Map();   // id -> {at, fn} | {interval, next, fn}
  const clock = {
    setTimeout(fn, ms) { const id = nextId++; timers.set(id, { at: now + ms, fn }); return id; },
    clearTimeout(id) { timers.delete(id); },
    setInterval(fn, ms) { const id = nextId++; timers.set(id, { interval: ms, next: now + ms, fn }); return id; },
    clearInterval(id) { timers.delete(id); },
    advance(ms) {
      now += ms;
      for (;;) {
        let due = null, dueAt = Infinity;
        for (const [id, t] of timers) {
          const at = t.interval !== undefined ? t.next : t.at;
          if (at <= now && at < dueAt) { due = id; dueAt = at; }
        }
        if (due === null) break;
        const t = timers.get(due);
        if (t.interval !== undefined) t.next = t.next + t.interval;
        else timers.delete(due);
        t.fn();
      }
    },
    now: () => now,
  };

  const cfg = configDoc();

  const defaultFetch = (url, opts) => {
    opts = opts || {};
    const u = String(url);
    if (opts.method === "POST") {
      posts.push({ url: u, body: opts.body || null });
      if (u === "/api/config") return Promise.resolve({ ok: true, json: async () => cfg });
      if (u === "/api/simulation") return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
      return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
    }
    if (u === "/api/config") return Promise.resolve({ ok: true, json: async () => cfg });
    if (u === "/api/info") return Promise.resolve({ ok: true, json: async () => INFO });
    if (u === "/api/devices") return Promise.resolve({ ok: true, json: async () => ({ devices: DEVICES, scanning: false }) });
    return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
  };

  class FileReader {
    readAsText(file) { this.result = file.content; if (this.onload) this.onload(); }
  }

  const ctx = {
    document: documentStub,
    window: { matchMedia: () => ({ matches: false, addEventListener() {} }) },
    localStorage: (() => { const m = new Map(); return {
      getItem: (k) => (m.has(k) ? m.get(k) : null),
      setItem: (k, v) => m.set(k, String(v)),
      removeItem: (k) => m.delete(k) }; })(),
    location: { protocol: "http:", host: "10.0.2.2:8080" },
    fetch: fetchOverride || defaultFetch,
    FileReader,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    setInterval: clock.setInterval,
    clearInterval: clock.clearInterval,
    console,
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(APP_JS, "utf-8"), ctx, { filename: "app.js" });
  return { ctx, elements, posts, clock, cfg };
}

// ---------------- fixtures ----------------

function validBackup(over) {
  const cfg = configDoc();
  const backup = {
    schema: CFG_SCHEMA, version: CFG_VERSION, app: "ZoneGlow",
    exportedAt: "2026-09-06T00:00:00.000Z",
    config: {
      controlSource: cfg.controlSource, ftp: 300, smoothing: 20,
      powerTimeout: 4000, hysteresis: 4, zoneCount: cfg.zoneCount,
      zones: cfg.zones, hrMax: 185, hrZones: cfg.hrZones,
      ledPin: 6, ledCount: 90, brightness: 70, ledType: "SK6812",
      ledEffect: 1, autoReconnect: false, debug: true, theme: "light",
    },
  };
  return Object.assign(backup, over || {});
}

function postsTo(posts, url) {
  return posts.filter((p) => p.url === url)
    .map((p) => { try { return JSON.parse(p.body); } catch (_) { return null; } })
    .filter((d) => d !== null);
}

async function main() {
  console.log("hub UI config backup / demo / onboarding / error states");

  // ---- 1. Export: versioned schema, no secrets, no sensor pairings ----
  {
    const env = makeContext();
    await env.ctx.getConfig();
    const backup = env.ctx.buildBackup();
    assert(backup.schema === CFG_SCHEMA && backup.version === CFG_VERSION,
      "export is schema-versioned (zoneglow.config v1)");
    ["wifiSsid", "wifiPass", "sourceAddr", "sourceName", "hrSourceAddr", "hrSourceName"]
      .forEach((k) => assert(!(k in backup.config), "export never contains " + k));
    ["ftp", "zoneCount", "zones", "hrMax", "hrZones", "ledPin", "ledCount",
     "brightness", "ledType", "ledEffect", "controlSource", "smoothing",
     "powerTimeout", "hysteresis", "autoReconnect", "theme"]
      .forEach((k) => assert(k in backup.config, "export includes " + k));
    assert(backup.config.zones.length === 7 && backup.config.hrZones.length === 5,
      "export carries all power and HR zones");
  }

  // ---- 2. Import validation: valid file passes, nothing is applied on reject ----
  {
    const env = makeContext();
    await env.ctx.getConfig();
    const v = env.ctx.validateImportedConfig(validBackup());
    assert(v.ok, "valid backup validates: " + (v.ok ? "" : v.error));
    assert(v.config.ftp === 300 && v.config.ledType === "SK6812",
      "validated config carries the imported values");

    const badCases = [
      [null, "not an object"],
      [[], "array"],
      [{ schema: "other" }, "wrong schema"],
      [Object.assign(validBackup(), { version: 99 }), "future version"],
      [Object.assign(validBackup(), { config: null }), "missing config"],
      [Object.assign(validBackup(), { config: Object.assign({}, validBackup().config, { ftp: 5 }) }), "ftp out of range"],
      [Object.assign(validBackup(), { config: Object.assign({}, validBackup().config, { zoneCount: 4 }) }), "bad zone count"],
      [Object.assign(validBackup(), { config: Object.assign({}, validBackup().config, { ledType: "APA" }) }), "bad led type"],
      [Object.assign(validBackup(), { config: Object.assign({}, validBackup().config, { hrZones: validBackup().config.hrZones.slice(0, 4) }) }), "short hr zones"],
      [Object.assign(validBackup(), { config: Object.assign({}, validBackup().config, { hrMax: 60 }) }), "hrMax out of range"],
    ];
    let allRejected = true;
    badCases.forEach(([doc]) => {
      const r = env.ctx.validateImportedConfig(doc);
      if (r.ok) { allRejected = false; console.error("    (accepted: " + JSON.stringify(doc && doc.config && doc.config.ftp) + ")"); }
    });
    assert(allRejected, "all malformed/incompatible backups are rejected");

    const dup = validBackup();
    dup.config.zones[3] = Object.assign({}, dup.config.zones[3], { min: dup.config.zones[2].min });
    assert(!env.ctx.validateImportedConfig(dup).ok, "non-ascending zone minimums rejected");

    const badColor = validBackup();
    badColor.config.hrZones[2] = Object.assign({}, badColor.config.hrZones[2], { color: "red" });
    assert(!env.ctx.validateImportedConfig(badColor).ok, "invalid zone color rejected");
  }

  // ---- 3. Import is atomic: rejected file -> ZERO posts; valid -> one POST ----
  {
    const env = makeContext();
    await env.ctx.getConfig();
    const rejected = await env.ctx.applyImportedConfig({ schema: "nope", version: 1 });
    assert(rejected === false && postsTo(env.posts, "/api/config").length === 0,
      "rejected import never reaches POST /api/config (config untouched)");
    assert(env.elements.toast.textContent.length > 0, "rejected import shows a plain-English error");

    const ok = await env.ctx.applyImportedConfig(validBackup());
    const sent = postsTo(env.posts, "/api/config");
    assert(ok === true && sent.length === 1,
      "valid import applies as ONE atomic request");
    assert(sent[0].ftp === 300 && sent[0].ledType === "SK6812" && sent[0].zones.length === 7,
      "applied patch carries the validated values");
  }

  // ---- 3b. Hub unreachable mid-import: nothing applied, friendly message ----
  {
    const env = makeContext((url, opts) => {
      if (opts && opts.method === "POST" && String(url) === "/api/config")
        return Promise.reject(new TypeError("Failed to fetch"));
      return Promise.resolve({ ok: true, json: async () => configDoc() });
    });
    await env.ctx.getConfig();
    const ok = await env.ctx.applyImportedConfig(validBackup());
    assert(ok === false, "unreachable Hub leaves import unfinished");
    assert(env.elements.toast.textContent.indexOf("Hub") !== -1,
      "unreachable Hub shows a connection message, not a raw error");
  }

  // ---- 4. importConfigFile: bad JSON file -> rejected, no post ----
  {
    const env = makeContext();
    await env.ctx.getConfig();
    env.ctx.importConfigFile({ content: "{ not json" });
    await settle();
    assert(postsTo(env.posts, "/api/config").length === 0,
      "unparseable file never posts to /api/config");
    assert(env.elements.toast.textContent === "Not a valid backup file",
      "unparseable file gets a clear message");
    env.ctx.importConfigFile({ content: JSON.stringify(validBackup()) });
    await settle();
    assert(postsTo(env.posts, "/api/config").length === 1,
      "parseable valid file posts exactly once");
  }

  // ---- 5. Lighting Test: existing /api/simulation endpoint, full cycle, stop ----
  {
    const env = makeContext();
    await env.ctx.getConfig();
    await env.ctx.startDemo(1);           // one full zone sweep (Test Lighting)
    await settle();
    assert(env.elements.demoBanner.hidden === false, "test banner is visible while running");
    env.clock.advance(1200 * 13);         // 13 values + the stopping tick
    await settle();
    const sim = postsTo(env.posts, "/api/simulation");
    assert(sim[0].enabled === true, "lighting test enables simulation first");

    // 7 zones -> 13 values: Z1..Z7 up then back down to Z1
    const vals = sim.filter((d) => d.watts !== undefined).map((d) => d.watts);
    assert(vals.length === 13, "one cycle posts exactly 13 zone values (got " + vals.length + ")");
    assert(vals[0] === 10 && vals[6] === 310, "cycle climbs from Z1 (" + vals[0] + ") to Z7 (" + vals[6] + ")");
    assert(vals[12] === 10, "cycle walks back down to Z1");
    assert(sim[sim.length - 1].enabled === false, "lighting test disables simulation at the end");
    assert(env.elements.demoBanner.hidden === true, "banner hides when the test ends");

    const env2 = makeContext();
    await env2.ctx.getConfig();
    await env2.ctx.startDemo();           // open-ended Test Lighting (dashboard)
    await settle();
    env2.clock.advance(13000);
    await settle();
    let sim2 = postsTo(env2.posts, "/api/simulation");
    assert(!sim2.some((d) => d.enabled === false),
      "open-ended demo keeps running (no auto-disable posts)");
    await env2.ctx.stopDemo();
    await settle();
    sim2 = postsTo(env2.posts, "/api/simulation");
    assert(sim2[sim2.length - 1].enabled === false,
      "Stop test returns the Hub to real sensor control");
    assert(env2.elements.demoBanner.hidden === true, "banner hides on stop");
  }

  // ---- 5b. Lighting test in HR mode sends bpm, not watts ----
  {
    const env = makeContext();
    env.cfg.controlSource = "hr";
    await env.ctx.getConfig();
    await env.ctx.startDemo(1);
    await settle();
    const sim = postsTo(env.posts, "/api/simulation");
    assert(sim.every((d) => d.watts === undefined), "HR test posts no watts");
    assert(sim.some((d) => d.bpm !== undefined), "HR test posts bpm values");
  }

  // ---- 6. Onboarding (hardware setup wizard): persistence + re-launch ----
  {
    const env = makeContext();
    await env.ctx.getConfig();            // init() loads config before the wizard
    assert(env.ctx.onboardingDone() === false, "onboarding incomplete on first run");
    env.ctx.startOnboarding(false);
    assert(env.elements.onboarding.hidden === false, "first run shows onboarding");
    assert(env.elements.obTitle.textContent === "Welcome to ZoneGlow",
      "onboarding opens on the Welcome step");
    // Skip -> done, persists
    env.ctx.closeOnboarding(true);
    assert(env.ctx.onboardingDone() === true, "skipping marks onboarding done");
    assert(env.elements.onboarding.hidden === true, "skipping hides onboarding");
    env.ctx.startOnboarding(false);
    assert(env.elements.onboarding.hidden === true, "completed onboarding does not auto-start");
    // Re-launch from About (force)
    env.ctx.startOnboarding(true);
    assert(env.elements.onboarding.hidden === false, "About can re-launch onboarding");

    // Walk the setup: Welcome -> Hub -> Add Sensor (Scan) -> Source -> Zones -> Test -> Complete
    const actions = env.elements.obActions;
    actions.children[0].click();          // "Get started"
    assert(env.elements.obTitle.textContent === "Your Hub", "step 2: Hub info");
    actions.children[1].click();          // "Next" -> sensor step
    assert(env.elements.obTitle.textContent === "Add a sensor", "step 3: add sensor");
    const scanBtn = env.elements.obBody.children[env.elements.obBody.children.length - 1];
    scanBtn.click();                       // Scan
    await settle();                         // obScan registers its poller in a microtask
    env.clock.advance(2000);
    await settle();
    const list = env.elements.obDeviceList;
    assert(list.children.length === 2, "wizard scan lists found sensors");
    actions.children[1].click();          // "Next" -> control source step
    assert(env.elements.obTitle.textContent === "Select control source", "step 4: control source");
    actions.children[1].click();          // "Next" -> zones step
    assert(env.elements.obTitle.textContent === "Configure zones", "step 5: zone basics");
    // Quick FTP edit inside the wizard saves through POST /api/config
    const ftpIn = env.elements.obBody.children[0].children[0].children[1];   // .ob-zone-cfg -> FTP field -> input
    ftpIn.value = "275";
    fire(ftpIn, "change");
    await settle();
    assert(postsTo(env.posts, "/api/config").some((d) => d.ftp === 275),
      "wizard FTP field saves through POST /api/config");
    actions.children[1].click();          // "Next" -> test lighting step
    assert(env.elements.obTitle.textContent === "Test lighting", "step 6: test lighting");
    actions.children[1].click();          // "Next" -> setup complete step
    assert(env.elements.obTitle.textContent === "Setup complete", "step 7: setup complete");
    assert(env.elements.obText.textContent.indexOf("runs on its own") !== -1,
      "setup complete explains the Hub is standalone");
    actions.children[0].click();          // "Done"
    assert(env.elements.onboarding.hidden === true && env.ctx.onboardingDone() === true,
      "finishing marks onboarding complete");
    // The wizard's scan poller must stop with the wizard.
    const before = env.posts.length;
    env.clock.advance(20000);
    await settle();
    assert(env.posts.length === before,
      "no stray scan polling after the wizard closes");
  }

  // ---- 7. Plain-English connection states ----
  {
    const env = makeContext();
    await env.ctx.getConfig();
    env.ctx.updateLive({ mode: "hr", state: "DISCONNECTED", sim: false,
      smoothed: 0, zone: 0, zoneName: "", color: "#000000" });
    assert(env.elements.statusText.textContent === "No heart rate sensor connected",
      "HR + disconnected shows the HR wording");
    env.ctx.updateLive({ mode: "power", state: "DISCONNECTED", sim: false,
      smoothed: 0, zone: 0, zoneName: "", color: "#000000" });
    assert(env.elements.statusText.textContent === "No power sensor connected",
      "Power + disconnected shows the power wording");
    env.ctx.updateLive({ mode: "power", state: "RECEIVING_POWER", sim: true,
      smoothed: 220, zone: 3, zoneName: "Z4 · Threshold", color: "#ff0000" });
    assert(env.elements.statusText.textContent === "Lighting test",
      "test-mode telemetry is clearly labelled as a lighting test");
  }

  // ---- 8. Hub-lost banner: shown on WS close (initWs onclose path), cleared
  //         on telemetry (initWs onmessage path). The watchdog test
  //         (test-telemetry-watchdog.cjs) covers the socket lifecycle itself;
  //         here we verify the app-level banner handlers directly.
  {
    const env = makeContext();
    await env.ctx.getConfig();
    env.ctx.showHubBanner(true);     // what ws.onclose does
    assert(env.elements.hubBanner.hidden === false,
      "socket loss shows the hub-lost banner (ws.onclose path)");
    env.ctx.showHubBanner(false);    // what ws.onmessage does
    assert(env.elements.hubBanner.hidden === true,
      "incoming telemetry clears the banner (ws.onmessage path)");
    // The banner's copy lives in index.html ("Connection to Hub lost -
    // reconnecting...") and is embedded in WebContent.h; the DOM stub here
    // does not carry HTML text, so the wording is asserted by the stale-copy
    // sweep in the commit verification instead.
  }

  // ---- 9. Diagnostics text ----
  {
    const env = makeContext();
    await env.ctx.getConfig();
    await env.ctx.loadHubInfo();
    env.ctx.updateLive({ mode: "power", state: "RECEIVING_POWER", sim: false,
      smoothed: 220, zone: 3, zoneName: "Z4 · Threshold", color: "#ff0000",
      source: "Power Meter" });
    const text = env.ctx.buildDiagnosticsText();
    assert(text.indexOf("ZoneGlow diagnostics") === 0, "diagnostics has a header");
    assert(text.indexOf("App version: 1.2.0") !== -1, "diagnostics includes app version");
    assert(text.indexOf("Hub firmware: 1.0.0") !== -1, "diagnostics includes firmware version");
    assert(text.indexOf("PC-SIMULATOR") !== -1, "diagnostics includes the device id");
    assert(text.indexOf("Control source: Power") !== -1, "diagnostics includes control source");
    assert(text.indexOf("Sensor: Power Meter") !== -1, "diagnostics includes the sensor");
  }

  console.log("");
  console.log(failures === 0 ? "ALL " + count + " CHECKS PASSED" : failures + " / " + count + " CHECKS FAILED");
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });