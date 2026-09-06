// Regression test for the Android stale-dashboard bug.
//
// Bug (feature/mobile-app): against the PC simulator the mobile app could
// send commands (REST worked) but the Hub-served Dashboard froze on the last
// telemetry frame. Root cause: the Hub web UI's WebSocket only reconnected
// on `onclose`, and in the Android WebView a dead socket can drop WITHOUT
// firing onclose. The fix added a silence watchdog (WS_SILENCE_MS) that
// force-closes a silent socket so the onclose reconnect runs.
//
// This loads the REAL Hub-served UI (src/firmware/data/web/app.js) in a
// Node vm with a stubbed DOM and a controllable fake clock, then drives the
// WebSocket lifecycle the way the Android WebView does.
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const APP_JS = path.join(__dirname, "..", "..", "src", "firmware", "data", "web", "app.js");
const WS_SILENCE_MS = 6000;   // must match app.js

let failures = 0;
let count = 0;
function assert(cond, msg) {
  count++;
  if (cond) { console.log("  ok   - " + msg); }
  else { failures++; console.error("  FAIL - " + msg); }
}

// ---------------- stub DOM / browser environment ----------------

function makeElement() {
  // Real DOM elements stringify any value assigned to textContent (numbers
  // included - app.js assigns t.smoothed as a number). Mirror that.
  const el = {
    _tc: "",
    style: {}, dataset: {}, value: "", innerHTML: "",
    checked: false, disabled: false, className: "",
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    appendChild() {}, addEventListener() {},
    querySelector() { return makeElement(); },
    querySelectorAll() { return []; },
  };
  Object.defineProperty(el, "textContent", {
    get() { return this._tc; },
    set(v) { this._tc = v === undefined || v === null ? "" : String(v); },
  });
  return el;
}

function makeContext(overrides) {
  const elements = {};   // per-id stable elements so reads reflect writes
  const listeners = {};
  const documentStub = {
    documentElement: makeElement(),
    getElementById: (id) => (elements[id] = elements[id] || makeElement()),
    createElement: () => makeElement(),
    querySelectorAll: () => [],
    addEventListener: (ev, fn) => { (listeners[ev] = listeners[ev] || []).push(fn); },
  };

  // controllable clock
  let now = 0;
  let nextId = 1;
  const timers = new Map();
  const clock = {
    setTimeout(fn, ms) { const id = nextId++; timers.set(id, { at: now + ms, fn }); return id; },
    clearTimeout(id) { timers.delete(id); },
    advance(ms) {
      now += ms;
      for (;;) {
        let due = null;
        for (const [id, t] of timers) if (t.at <= now && (due === null || t.at < timers.get(due).at)) due = id;
        if (due === null) break;
        const t = timers.get(due);
        timers.delete(due);
        t.fn();
      }
    },
    now: () => now,
  };

  // fake WebSocket
  const sockets = [];
  class FakeWebSocket {
    constructor(url) {
      this.url = url; this.readyState = 1; this.closed = false;
      this.closeCalled = 0; sockets.push(this);
    }
    close() {
      this.closeCalled++;
      if (this.closed) return;
      this.closed = true; this.readyState = 3;
      if (this.onclose) this.onclose({ code: 1006 });
    }
    deliver(frame) {
      if (this.closed) throw new Error("deliver() on closed socket");
      this.onmessage({ data: JSON.stringify(frame) });
    }
  }

  const config = {
    controlSource: "power", ftp: 200, hrMax: 190, zoneCount: 7,
    zones: Array.from({ length: 7 }, (_, i) => ({ name: "Z" + (i + 1), min: i * 50, color: "#123456" })),
    hrZones: Array.from({ length: 5 }, (_, i) => ({ name: "HR" + (i + 1), min: 90 + i * 25, max: 0, color: "#123456" })),
    hrZonesCustom: false, sourceName: "", hrSourceName: "",
    smoothing: 0.5, powerTimeout: 3000, hysteresis: 5, ledPin: 2,
    ledCount: 30, ledType: "WS2812", ledEffect: 0, brightness: 80,
    autoReconnect: true, debug: false, wifiSsid: "", theme: "system",
  };

  const ctx = {
    document: documentStub,
    window: { matchMedia: () => ({ matches: false, addEventListener() {} }) },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    location: { protocol: "http:", host: "10.0.2.2:8080" },
    WebSocket: FakeWebSocket,
    fetch: () => Promise.resolve({ ok: true, json: async () => config }),
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    setInterval: () => 0,
    clearInterval() {},
    console,
  };
  Object.assign(ctx, overrides || {});
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(APP_JS, "utf-8"), ctx, { filename: "app.js" });
  return { ctx, elements, sockets, clock, config };
}

function frame(watts, zone, name) {
  return { mode: "power", state: "RECEIVING_POWER", sim: true, smoothed: watts,
    raw: watts, zone: zone, zoneName: "Z" + (zone + 1) + " · " + name, color: "#ff0000" };
}

// ---------------- tests ----------------

async function main() {
  console.log("hub-ui WebSocket watchdog (Android stale dashboard regression)");

  // 1. URL is derived dynamically from the iframe's own origin (10.0.2.2).
  {
    const env = makeContext();
    await env.ctx.getConfig();
    env.ctx.initWs();
    assert(env.sockets.length === 1, "one WebSocket opened");
    assert(env.sockets[0].url === "ws://10.0.2.2:8080/ws",
      "WebSocket URL derived from location.host: " + env.sockets[0].url);
  }

  // 1b. https origin -> wss.
  {
    const env = makeContext({ location: { protocol: "https:", host: "hub.local" } });
    await env.ctx.getConfig();
    env.ctx.initWs();
    assert(env.sockets[0].url === "wss://hub.local/ws", "https origin uses wss: " + env.sockets[0].url);
  }

  // 2. Live telemetry updates the dashboard (watts changed from Android).
  {
    const env = makeContext();
    await env.ctx.getConfig();
    env.ctx.initWs();
    const s = env.sockets[0];
    s.deliver(frame(189, 2, "Tempo"));
    assert(env.elements.powerWatts.textContent === "189", "dashboard shows 189 W");
    assert(env.elements.zoneName.textContent === "Tempo", "zone label shows Tempo");
    s.deliver(frame(330, 5, "Anaerobic"));
    assert(env.elements.powerWatts.textContent === "330", "dashboard updates live to 330 W");
    assert(env.elements.zoneNum.textContent === "Z6", "zone number updates live to Z6");
    assert(env.elements.zoneName.textContent === "Anaerobic", "zone label updates live to Anaerobic");
  }

  // 3. Silent (blackholed) socket is detected and replaced - THE regression:
  //    onclose never fires on its own; the watchdog must force-close it.
  {
    const env = makeContext();
    await env.ctx.getConfig();
    env.ctx.initWs();
    const s = env.sockets[0];
    s.deliver(frame(189, 2, "Tempo"));
    env.clock.advance(3000);
    s.deliver(frame(330, 5, "Anaerobic"));
    assert(!s.closed, "socket stays open while frames keep arriving");
    env.clock.advance(3000);         // 3s since last frame: still inside the window
    assert(!s.closed, "socket not closed on short gap (< WS_SILENCE_MS)");
    env.clock.advance(WS_SILENCE_MS);   // sustained silence: watchdog fires
    assert(s.closed, "watchdog force-closes a silently dead socket (no onclose ever fired)");
    env.clock.advance(2000);         // onclose reconnect delay
    assert(env.sockets.length === 2, "shell UI reconnects automatically after watchdog close");
    assert(env.sockets[1].url === "ws://10.0.2.2:8080/ws", "reconnect uses same dynamically-derived URL");
    env.sockets[1].deliver(frame(330, 5, "Anaerobic"));   // e.g. simulator restarted
    assert(env.elements.powerWatts.textContent === "330",
      "dashboard resumes live updates after reconnect (no app reinstall/reload)");
    assert(env.elements.zoneName.textContent === "Anaerobic", "zone label resumes after reconnect");
  }

  // 4. onerror also leads to a close + reconnect (previously unhandled).
  {
    const env = makeContext();
    await env.ctx.getConfig();
    env.ctx.initWs();
    const s = env.sockets[0];
    s.onerror && s.onerror({});
    assert(s.closed, "ws.onerror path closes the socket");
    env.clock.advance(2000);
    assert(env.sockets.length === 2, "reconnects after error-driven close");
  }

  // 5. A socket that never opens (hub down at load) also recovers.
  {
    const env = makeContext();
    await env.ctx.getConfig();
    env.ctx.initWs();
    env.clock.advance(WS_SILENCE_MS);
    assert(env.sockets[0].closed, "never-opening socket is force-closed by watchdog");
    env.clock.advance(2000);
    assert(env.sockets.length === 2, "reconnects after a never-opening socket");
  }

  console.log("");
  console.log(failures === 0 ? "ALL " + count + " CHECKS PASSED" : failures + " / " + count + " CHECKS FAILED");
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });