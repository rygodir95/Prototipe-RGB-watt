// ZoneGlow hub web UI - Devices page rendering regression.
//
// Root-cause guard for the hardware bug where scan results appeared in
// serial output and in GET /api/devices, but never rendered on the
// Devices page: the REAL firmware /api/devices response lacked the
// `category` field ("power"/"hr") that refreshDevices() filters on,
// while the PC simulator and every test fixture included it.
//
// Verifies:
//   * post-fix firmware payloads (with category) render into the correct
//     POWER / HEART RATE sections with the right badges and labels,
//   * the pre-fix payload shape (no category) renders NOTHING (documents
//     why the bug was invisible on hardware),
//   * scanning / empty-list messaging,
//   * a source-level contract guard: the real firmware's /api/devices
//     handler MUST emit category "power"/"hr" exactly like the simulator,
//     so the schemas cannot silently diverge again.
//
// Run: node mobile/tests/test-devices-render.cjs

"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..", "..");
const APP_JS = path.join(ROOT, "src", "firmware", "data", "web", "app.js");
const WEBINTERFACE = path.join(ROOT, "src", "firmware", "src", "WebInterface.cpp");
const SIMULATOR = path.join(ROOT, "src", "firmware", "tools", "pc-simulator", "simulator.py");

let failures = 0;
let count = 0;
function assert(cond, msg) {
  count++;
  if (cond) { console.log("  ok   - " + msg); }
  else { failures++; console.error("  FAIL - " + msg); }
}

// ---------------- stub DOM / browser environment ----------------

function makeElement(elements) {
  const el = {
    _tc: "", _ih: "", _children: [], _listeners: {}, _id: "",
    style: {}, dataset: {}, value: "", checked: false, disabled: false,
    className: "", hidden: false, files: [],
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    setAttribute() {},
    appendChild(c) { el._children.push(c); return c; },
    addEventListener(ev, fn) { (el._listeners[ev] = el._listeners[ev] || []).push(fn); },
    querySelector() { return makeElement(elements); },
    querySelectorAll() { return []; },
    click() { (el._listeners.click || []).forEach((fn) => fn({})); },
  };
  Object.defineProperty(el, "textContent", {
    get() { return el._tc; },
    // DOM semantics: assigning textContent makes innerHTML return the
    // escaped text (escapeHtml in app.js relies on this).
    set(v) {
      el._tc = v === undefined || v === null ? "" : String(v);
      el._ih = el._tc.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    },
  });
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

// Loads the REAL hub-served app.js with a stubbed DOM and a fixed
// /api/devices payload (the only endpoint refreshDevices() touches).
function makeContext(devicesPayload) {
  const elements = {};
  const documentStub = {
    documentElement: makeElement(elements),
    body: makeElement(elements),
    getElementById: (id) => (elements[id] = elements[id] || makeElement(elements)),
    createElement: () => makeElement(elements),
    querySelectorAll: () => [],
    addEventListener: () => {},
  };
  const ctx = {
    document: documentStub,
    window: { matchMedia: () => ({ matches: false, addEventListener() {} }) },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    location: { protocol: "http:", host: "10.0.2.2:8080" },
    fetch: () => Promise.resolve({ ok: true, json: async () => devicesPayload }),
    setTimeout: () => 0, clearTimeout: () => {},
    setInterval: () => 0, clearInterval: () => {},
    console,
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(APP_JS, "utf-8"), ctx, { filename: "app.js" });
  return { ctx, elements };
}

// ---------------- fixtures: exact firmware payload shapes ----------------
// The real firmware serves only the ACTIVE control source's devices in
// /api/devices (mutual exclusion), so power mode returns only CPS/FTMS
// and HR mode returns only HRS. The objects below mirror the serial-log
// devices confirmed on hardware.

// POST-FIX power-mode response (what the patched WebInterface.cpp emits).
const FW_POWER_FIXED = {
  scanning: false,
  devices: [
    { address: "d1:cf:c0:11:22:33", name: "Tacx Flux 23806", type: "CPS",
      category: "power", rssi: -63, connected: false },
    { address: "e5:aa:bb:cc:dd:ee", name: "ASSIOMA53341L", type: "CPS",
      category: "power", rssi: -68, connected: false },
    { address: "c8:11:22:33:44:55", name: "VANRYSEL-HT-0595", type: "FTMS",
      category: "power", rssi: -71, connected: false },
  ],
};

// POST-FIX hr-mode response.
const FW_HR_FIXED = {
  scanning: false,
  devices: [
    { address: "f4:12:fa:ae:11:22", name: "HR Strap 0595", type: "HRS",
      category: "hr", rssi: -66, connected: true },
  ],
};

// PRE-FIX power-mode response (category missing) - what the bug looked like.
const FW_POWER_PREFIX = {
  scanning: false,
  devices: FW_POWER_FIXED.devices.map((d) => {
    const c = Object.assign({}, d);
    delete c.category;
    return c;
  }),
};

async function main() {
  console.log("hub UI Devices page rendering + firmware/simulator schema contract");

  // ---- 1. Post-fix power-mode payload renders into the POWER section ----
  {
    const env = makeContext(FW_POWER_FIXED);
    await env.ctx.refreshDevices();
    const power = env.elements.powerDeviceList;
    const hr = env.elements.hrDeviceList;
    assert(power.children.length === 3,
      "CPS + FTMS devices render as 3 rows in the POWER section");
    assert(hr.children.length === 0 && hr.innerHTML.indexOf("No devices found") !== -1,
      "HEART RATE section stays empty in power mode");
    const html = power.children.map((r) => r.innerHTML).join("\n");
    assert(html.indexOf("Tacx Flux 23806") !== -1 &&
           html.indexOf("ASSIOMA53341L") !== -1 &&
           html.indexOf("VANRYSEL-HT-0595") !== -1,
      "device names reach the DOM");
    assert(html.indexOf("badge-power") !== -1, "power devices carry the power badge");
    assert(html.indexOf("Power Meter") !== -1 && html.indexOf("Smart Trainer") !== -1,
      "CPS and FTMS map to their plain-English type labels");
    assert(html.indexOf("badge-hr") === -1, "no HR badge in power-mode rows");
    assert(power.children.every((r) => r.className === "device"),
      "unconnected rows are not marked connected");
  }

  // ---- 2. Post-fix hr-mode payload renders into the HEART RATE section ----
  {
    const env = makeContext(FW_HR_FIXED);
    await env.ctx.refreshDevices();
    const power = env.elements.powerDeviceList;
    const hr = env.elements.hrDeviceList;
    assert(hr.children.length === 1, "HRS device renders in the HEART RATE section");
    assert(power.children.length === 0, "POWER section stays empty in HR mode");
    assert(hr.children[0].innerHTML.indexOf("badge-hr") !== -1 &&
           hr.children[0].innerHTML.indexOf("Heart Rate Monitor") !== -1,
      "HR row carries the HR badge and type label");
    assert(hr.children[0].className === "device connected",
      "connected device row is marked connected");
    assert(hr.children[0].innerHTML.indexOf("Connected") !== -1,
      "connected row shows the Connected state");
  }

  // ---- 3. Pre-fix payload (no category): nothing renders (the bug) ----
  {
    const env = makeContext(FW_POWER_PREFIX);
    await env.ctx.refreshDevices();
    const power = env.elements.powerDeviceList;
    const hr = env.elements.hrDeviceList;
    assert(power.children.length === 0 && hr.children.length === 0,
      "payload without category renders NO rows (documents the hardware bug)");
    assert(power.innerHTML.indexOf("No devices found") !== -1,
      "the UI showed the empty message although devices were in the JSON");
  }

  // ---- 4. Scanning state only affects the empty-list message ----
  {
    const env = makeContext({ scanning: true, devices: [] });
    await env.ctx.refreshDevices();
    assert(env.elements.powerDeviceList.innerHTML.indexOf("Searching…") !== -1,
      "scanning + no devices shows Searching…");
    const env2 = makeContext({ scanning: true, devices: FW_POWER_FIXED.devices });
    await env2.ctx.refreshDevices();
    assert(env2.elements.powerDeviceList.children.length === 3,
      "devices still render while scanning is in progress");
  }

  // ---- 5. Source-level contract guard (firmware <-> simulator <-> web UI) ----
  {
    const fw = fs.readFileSync(WEBINTERFACE, "utf-8");
    // /api/connect is registered via attachJsonPost(), so that is the next
    // route boundary after the /api/devices GET handler.
    const start = fw.indexOf('server.on("/api/devices"');
    const end = fw.indexOf('attachJsonPost("/api/connect"');
    assert(start !== -1 && end > start, "firmware has a /api/devices handler");
    const region = fw.slice(start, end);
    assert(/o\["category"\]\s*=\s*"power";/.test(region),
      "firmware /api/devices tags power devices (category: \"power\")");
    assert(/o\["category"\]\s*=\s*"hr";/.test(region),
      "firmware /api/devices tags HR devices (category: \"hr\")");
    assert((region.match(/o\["category"\]/g) || []).length === 2,
      "exactly one category assignment per control-source branch");

    const sim = fs.readFileSync(SIMULATOR, "utf-8");
    assert(sim.indexOf('"category": "hr" if m["type"] == "HRS" else "power"') !== -1,
      "simulator /api/devices emits the same category mapping");

    const app = fs.readFileSync(APP_JS, "utf-8");
    assert(app.indexOf('d.category === "power"') !== -1 &&
           app.indexOf('d.category === "hr"') !== -1,
      "web UI still filters on the same category values");
  }

  console.log("");
  console.log(failures === 0 ? "ALL " + count + " CHECKS PASSED" : failures + " / " + count + " CHECKS FAILED");
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });