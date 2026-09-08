// ZoneGlow hub web UI - Hub connection banner regression tests.
//
// Loads the REAL Hub-served UI (src/firmware/data/web/app.js) in a Node vm
// with a stubbed DOM and a controllable fake clock, then verifies the
// reconnect-confirmation banner lifecycle:
//   * initial connection -> no banner, never a success message
//   * disconnect -> red "Connection to Hub lost - reconnecting..." banner
//   * reconnect (telemetry) -> green "Hub reconnected [check]"
//   * green auto-hides after ~3 s (telemetry during it keeps it up)
//   * a new disconnect during the green period -> red immediately,
//     success-hide timer cancelled
//   * repeated disconnect/reconnect cycles
//   * OTA status stays independent of the banner (and vice versa)
//
// Run: node mobile/tests/test-reconnect-banner.cjs

"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const APP_JS = path.join(__dirname, "..", "..", "src", "firmware", "data", "web", "app.js");
const RED_TEXT = "Connection to Hub lost — reconnecting…";   // must match index.html
const OK_TEXT = "Hub reconnected ✓";                          // must match app.js

let failures = 0;
let count = 0;
function assert(cond, msg) {
  count++;
  if (cond) console.log("  ok   - " + msg);
  else { failures++; console.error("  FAIL - " + msg); }
}

// ---------------- stub DOM / browser environment ----------------

function makeElement() {
  const el = {
    _tc: "", style: {}, dataset: {}, hidden: false, disabled: false,
    value: "", className: "",
    _listeners: {},
    classList: (() => {
      const set = new Set();
      return {
        add: (c) => set.add(c),
        remove: (c) => set.delete(c),
        toggle: (c, on) => {
          if (on === undefined) { if (set.has(c)) set.delete(c); else set.add(c); }
          else if (on) set.add(c); else set.delete(c);
        },
        contains: (c) => set.has(c),
      };
    })(),
    addEventListener(ev, fn) { (el._listeners[ev] = el._listeners[ev] || []).push(fn); },
    appendChild() {},
    querySelector() { return makeElement(); },
    querySelectorAll() { return []; },
  };
  Object.defineProperty(el, "textContent", {
    get() { return el._tc; },
    set(v) { el._tc = v === undefined || v === null ? "" : String(v); },
  });
  return el;
}

function makeContext() {
  const elements = {};
  let now = 0;
  let nextId = 1;
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
        if (t.interval !== undefined) t.next += t.interval; else timers.delete(due);
        t.fn();
      }
    },
  };
  const ctx = {
    document: {
      documentElement: makeElement(),
      body: makeElement(),
      getElementById: (id) => (elements[id] = elements[id] || makeElement()),
      createElement: () => makeElement(),
      querySelectorAll: () => [],
      addEventListener() {},
    },
    window: { matchMedia: () => ({ matches: false, addEventListener() {} }) },
    localStorage: (() => {
      const m = new Map();
      return {
        getItem: (k) => (m.has(k) ? m.get(k) : null),
        setItem: (k, v) => m.set(k, String(v)),
        removeItem: (k) => m.delete(k),
      };
    })(),
    location: { protocol: "http:", host: "10.0.2.2:8080" },
    fetch: () => Promise.resolve({ ok: true, json: async () => ({}) }),
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    setInterval: clock.setInterval,
    clearInterval: clock.clearInterval,
    console,
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(APP_JS, "utf8"), ctx, { filename: "app.js" });
  // index.html ships the banner hidden with the red wording pre-filled.
  const banner = ctx.document.getElementById("hubBanner");   // create the stub
  banner.hidden = true;
  banner.textContent = RED_TEXT;
  return { ctx, elements, clock };
}

// ---------------- tests ----------------

async function main() {
  console.log("hub connection banner: reconnect confirmation");

  // ---- 1. Initial connection: no banner, no success message ----
  {
    const { ctx, elements } = makeContext();
    ctx.showHubReconnected();   // what ws.onmessage does on the first frame
    assert(elements.hubBanner.hidden === true, "initial connection shows no banner");
    assert(!elements.hubBanner.classList.contains("ok"), "initial connection is never green");
    ctx.showHubReconnected();   // more initial telemetry
    assert(elements.hubBanner.hidden === true, "repeated initial telemetry keeps the banner hidden");
  }

  // ---- 2. Disconnect -> red reconnecting banner ----
  {
    const { ctx, elements } = makeContext();
    ctx.showHubBanner(true);    // what ws.onclose does
    assert(elements.hubBanner.hidden === false, "disconnect shows the banner");
    assert(!elements.hubBanner.classList.contains("ok"), "disconnect banner is not green");
    assert(elements.hubBanner.textContent === RED_TEXT, "disconnect shows the red lost wording");
  }

  // ---- 3. Reconnect -> green "Hub reconnected" confirmation ----
  {
    const { ctx, elements } = makeContext();
    ctx.showHubBanner(true);
    ctx.showHubReconnected();  // first telemetry after the loss
    assert(elements.hubBanner.hidden === false, "reconnect keeps the banner visible");
    assert(elements.hubBanner.classList.contains("ok"), "reconnect banner is green");
    assert(elements.hubBanner.textContent === OK_TEXT, "reconnect shows the success wording");
  }

  // ---- 4. Green auto-hides after ~3 s; telemetry during it keeps it up ----
  {
    const { ctx, elements, clock } = makeContext();
    ctx.showHubBanner(true);
    ctx.showHubReconnected();
    ctx.showHubReconnected();   // telemetry keeps arriving at ~5 Hz
    ctx.showHubReconnected();
    assert(elements.hubBanner.hidden === false, "telemetry during the green period keeps it visible");
    clock.advance(2999);
    assert(elements.hubBanner.hidden === false, "green banner still visible just before 3 s");
    clock.advance(1);
    assert(elements.hubBanner.hidden === true, "green banner auto-hides after ~3 s");
    assert(!elements.hubBanner.classList.contains("ok"), "auto-hide clears the green state");
    ctx.showHubReconnected();   // normal telemetry afterwards
    assert(elements.hubBanner.hidden === true, "telemetry after auto-hide keeps the banner hidden");
  }

  // ---- 5. Drop during the green period: red immediately, timer cancelled ----
  {
    const { ctx, elements, clock } = makeContext();
    ctx.showHubBanner(true);
    ctx.showHubReconnected();
    clock.advance(1000);
    ctx.showHubBanner(true);    // lost again while green is visible
    assert(elements.hubBanner.hidden === false, "a new drop keeps the banner visible");
    assert(!elements.hubBanner.classList.contains("ok"), "a new drop returns to red immediately");
    assert(elements.hubBanner.textContent === RED_TEXT, "a new drop restores the red wording");
    clock.advance(10000);
    assert(elements.hubBanner.hidden === false, "the cancelled success-hide timer never fires");
    ctx.showHubReconnected();   // recovery still works afterwards
    assert(elements.hubBanner.classList.contains("ok") && elements.hubBanner.textContent === OK_TEXT,
      "recovery after the interrupted cycle shows green again");
  }

  // ---- 6. Repeated disconnect/reconnect cycles ----
  {
    const { ctx, elements, clock } = makeContext();
    for (let i = 0; i < 3; i++) {
      ctx.showHubBanner(true);
      assert(elements.hubBanner.textContent === RED_TEXT && elements.hubBanner.hidden === false,
        "cycle " + (i + 1) + ": red banner");
      ctx.showHubReconnected();
      assert(elements.hubBanner.textContent === OK_TEXT && elements.hubBanner.classList.contains("ok"),
        "cycle " + (i + 1) + ": green confirmation");
      clock.advance(3000);
      assert(elements.hubBanner.hidden === true, "cycle " + (i + 1) + ": auto-hidden");
    }
  }

  // ---- 7. OTA status stays independent of the banner ----
  {
    const { ctx, elements } = makeContext();
    ctx.showHubBanner(true);
    ctx.showHubReconnected();   // green up
    ctx.setOtaStatus("Installing update…", "");
    assert(elements.otaStatus.textContent === "Installing update…" && elements.otaStatus.hidden === false,
      "OTA status renders while the green banner is up");
    assert(elements.hubBanner.classList.contains("ok"),
      "OTA status does not touch the banner");
    ctx.showHubBanner(true);    // drop during OTA
    assert(!elements.hubBanner.classList.contains("ok") && elements.hubBanner.textContent === RED_TEXT,
      "banner reacts to a drop during OTA");
    assert(elements.otaStatus.textContent === "Installing update…",
      "banner changes do not touch the OTA status");
  }

  console.log("");
  console.log(failures === 0 ? "ALL " + count + " CHECKS PASSED" : failures + " / " + count + " CHECKS FAILED");
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });