// ZoneGlow hub web UI - Lighting Test sequence regression tests.
//
// The Lighting Test must run exactly ONE automatic cycle:
// Z1 -> Z2 -> ... -> Zmax -> ... -> Z2 -> Z1 -> stop automatically.
// Respect the configured zone count (5/6/7), never repeat the highest
// zone when reversing, never repeat Z1 at the end, hide the banner on
// completion, keep manual early stop working, and restart cleanly from
// Z1 afterwards. Both automatic completion and manual stop use the
// existing cleanup (enabled:false -> hub clears telemetry).
//
// Run: node mobile/tests/test-lighting-test-sequence.cjs

"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const APP_JS = path.join(__dirname, "..", "..", "src", "firmware", "data", "web", "app.js");
const STEP_MS = 1200;   // must match DEMO_STEP_MS in app.js

let failures = 0;
let count = 0;
function assert(cond, msg) {
  count++;
  if (cond) { console.log("  ok   - " + msg); }
  else { failures++; console.error("  FAIL - " + msg); }
}
async function settle() { await new Promise((r) => setTimeout(r, 10)); }

// ---------------- stub DOM / browser environment (same shape as
//                  test-config-backup.cjs, trimmed to what demo tests need) --

function makeElement(elements) {
  const el = {
    _tc: "", _ih: "", _children: [], _listeners: {}, _id: "",
    style: {}, dataset: {}, value: "",
    checked: false, disabled: false, className: "", hidden: false,
    files: [],
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
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

// Zone minimums sit at i*50, so each step's posted value is min + 10.
function configDoc(zoneCount) {
  return {
    controlSource: "power", ftp: 250, smoothing: 30, powerTimeout: 5000,
    hysteresis: 5, zoneCount,
    zones: Array.from({ length: zoneCount }, (_, i) => ({
      name: "Z" + (i + 1) + " · Zone", min: i * 50,
      max: i < zoneCount - 1 ? i * 50 + 49 : -1, color: "#123456" })),
    hrMax: 190, hrZonesCustom: false,
    hrZones: Array.from({ length: 5 }, (_, i) => ({
      name: "Z" + (i + 1) + " · HR", min: 90 + i * 25, max: 0, color: "#654321" })),
    ledPin: 5, ledCount: 60, brightness: 80, ledType: "WS2812B", ledEffect: 0,
    autoReconnect: true, debug: false, wifiSsid: "HomeNet", theme: "dark",
    sourceAddr: "02:aa", sourceName: "Power Meter",
    hrSourceAddr: "02:bb", hrSourceName: "HR Strap",
  };
}

function makeContext(zoneCount) {
  const elements = {};
  const posts = [];
  const documentStub = {
    documentElement: makeElement(elements),
    body: makeElement(elements),
    getElementById: (id) => (elements[id] = elements[id] || makeElement(elements)),
    createElement: () => makeElement(elements),
    querySelectorAll: () => [],
    addEventListener() {},
  };

  let now = 0, nextId = 1;
  const timers = new Map();
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

  const cfg = configDoc(zoneCount);
  const fetchStub = (url, opts) => {
    opts = opts || {};
    const u = String(url);
    if (opts.method === "POST") {
      posts.push({ url: u, body: opts.body || null });
      return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
    }
    if (u === "/api/config") return Promise.resolve({ ok: true, json: async () => cfg });
    return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
  };

  const ctx = {
    document: documentStub,
    window: { matchMedia: () => ({ matches: false, addEventListener() {} }) },
    localStorage: (() => { const m = new Map(); return {
      getItem: (k) => (m.has(k) ? m.get(k) : null),
      setItem: (k, v) => m.set(k, String(v)),
      removeItem: (k) => m.delete(k) }; })(),
    location: { protocol: "http:", host: "10.0.2.2:8080" },
    fetch: fetchStub,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    setInterval: clock.setInterval,
    clearInterval: clock.clearInterval,
    console,
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(APP_JS, "utf-8"), ctx, { filename: "app.js" });
  return { ctx, elements, posts, clock };
}

function postsTo(posts, url) {
  return posts.filter((p) => p.url === url)
    .map((p) => { try { return JSON.parse(p.body); } catch (_) { return null; } })
    .filter((d) => d !== null);
}
function valuePosts(sim) {
  return sim.filter((d) => d.watts !== undefined).map((d) => d.watts);
}
function expectedSequence(n) {
  const up = [];
  for (let i = 0; i < n; i++) up.push(i * 50 + 10);
  return up.concat(up.slice(0, -1).reverse());
}

async function main() {
  console.log("hub UI Lighting Test sequence (one automatic cycle)");

  // ---- 1. Exact sequence for 5, 6 and 7 configured zones ----
  for (const n of [5, 6, 7]) {
    const env = makeContext(n);
    await env.ctx.getConfig();
    await env.ctx.startDemo();            // the dashboard "Test Lighting" button path
    await settle();
    assert(env.elements.demoBanner.hidden === false,
      n + " zones: banner visible while the test runs");
    env.clock.advance(STEP_MS * (2 * n));  // more than one full cycle
    await settle();

    const sim = postsTo(env.posts, "/api/simulation");
    const vals = valuePosts(sim);
    const exp = expectedSequence(n);
    assert(sim[0].enabled === true, n + " zones: test enables simulation first");
    assert(vals.length === 2 * n - 1,
      n + " zones: one cycle posts exactly " + (2 * n - 1) + " values (got " + vals.length + ")");
    assert(JSON.stringify(vals) === JSON.stringify(exp),
      n + " zones: exact Z1..Z" + n + "..Z1 sequence, ending at Z1");
    assert(vals[0] === 10, n + " zones: cycle starts at Z1");
    assert(vals[n - 1] === (n - 1) * 50 + 10 && vals[n] === (n - 2) * 50 + 10,
      n + " zones: highest zone Z" + n + " appears exactly once (no repeat on reversal)");
    assert(vals[vals.length - 1] === 10 && vals[vals.length - 2] === 60,
      n + " zones: ends at Z1 without repeating it");
    assert(sim[sim.length - 1].enabled === false,
      n + " zones: test stops automatically after the final Z1 step");
    assert(env.elements.demoBanner.hidden === true,
      n + " zones: banner hides when the automatic cycle completes");
  }

  // ---- 2. Manual early stop (Stop test button) ----
  {
    const env = makeContext(7);
    await env.ctx.getConfig();
    await env.ctx.startDemo();
    await settle();
    env.clock.advance(STEP_MS * 3);       // mid-cycle: 4 of 13 values posted
    await settle();
    await env.ctx.stopDemo();             // the "Stop test" button
    await settle();

    const sim = postsTo(env.posts, "/api/simulation");
    const vals = valuePosts(sim);
    assert(vals.length === 4,
      "manual stop works mid-cycle (4 of 13 values posted)");
    assert(vals[0] === 10, "cycle had started at Z1 before the manual stop");
    assert(sim[sim.length - 1].enabled === false,
      "manual stop disables simulation (existing cleanup path)");
    assert(env.elements.demoBanner.hidden === true, "banner hides on manual stop");

    const before = env.posts.length;
    env.clock.advance(STEP_MS * 20);
    await settle();
    assert(env.posts.length === before, "no further test ticks after manual stop");
  }

  // ---- 3. Restart after automatic completion starts again at Z1 ----
  {
    const env = makeContext(5);
    await env.ctx.getConfig();
    await env.ctx.startDemo();
    await settle();
    env.clock.advance(STEP_MS * 10);       // full 5-zone cycle + stop tick
    await settle();
    assert(env.elements.demoBanner.hidden === true,
      "first run auto-completed before the restart test");

    await env.ctx.startDemo();            // immediately start another test
    await settle();
    assert(env.elements.demoBanner.hidden === false,
      "a new test can be started right after completion");
    env.clock.advance(STEP_MS * 10);
    await settle();

    const sim = postsTo(env.posts, "/api/simulation");
    const vals = valuePosts(sim);
    assert(vals.length === 18,
      "two complete 5-zone cycles posted 9 values each (got " + vals.length + ")");
    const second = vals.slice(9);
    assert(second[0] === 10, "restarted test begins again at Z1");
    assert(JSON.stringify(second) === JSON.stringify(expectedSequence(5)),
      "restarted test runs the same complete single cycle");
    assert(sim[sim.length - 1].enabled === false,
      "restarted test also stops automatically");
    assert(env.elements.demoBanner.hidden === true,
      "banner hides after the restarted cycle completes");
  }

  console.log("");
  console.log(failures === 0 ? "ALL " + count + " CHECKS PASSED" : failures + " / " + count + " CHECKS FAILED");
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });