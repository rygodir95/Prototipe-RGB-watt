// ZoneGlow hub web UI - OTA update feedback regression tests.
//
// The OTA flow must report progress through: Uploading -> Installing ->
// Hub restarting -> Reconnecting -> Update successful. A successful POST
// /api/ota is NOT success on its own: the Hub reboots and the UI may only
// show "Update successful" once /api/info answers again. If the Hub does
// not come back within the polling budget, a clear failure message is
// shown instead. Controls stay disabled during the whole flow and are
// restored after success or failure. The expected WebSocket disconnect
// (handled by the normal connection banner) must not leak any OTA
// failure feedback into the OTA status.
//
// Run: node mobile/tests/test-ota-feedback.cjs

"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const APP_JS = path.join(__dirname, "..", "..", "src", "firmware", "data", "web", "app.js");
const STEP_MS = 2000;   // must match OTA_POLL_MS in app.js

let failures = 0;
let count = 0;
function assert(cond, msg) {
  count++;
  if (cond) { console.log("  ok   - " + msg); }
  else { failures++; console.error("  FAIL - " + msg); }
}
async function settle() { await new Promise((r) => setTimeout(r, 10)); }

// ---------------- stub DOM / browser environment ----------------

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
  return el;
}

// infoPlan: one boolean per /api/info fetch, in call order; the last entry
// repeats once the plan is exhausted (true = Hub reachable).
// otaOutcome: {ok:true} (accepted), {ok:false} (rejected) or {error:true}
// (upload itself fails).
function makeContext(opts) {
  opts = opts || {};
  const elements = {};
  const posts = [];
  const scenario = {
    infoCalls: 0,
    infoPlan: opts.infoPlan || [],
    otaOutcome: opts.otaOutcome || { ok: true },
  };

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
  };

  function infoAlive() {
    scenario.infoCalls++;
    const plan = scenario.infoPlan;
    if (!plan.length) return true;
    return scenario.infoCalls <= plan.length ? plan[scenario.infoCalls - 1] : plan[plan.length - 1];
  }
  const fetchStub = (url, o) => {
    const u = String(url);
    if (u.indexOf("/api/info") !== -1) {
      if (!infoAlive()) return Promise.reject(new Error("hub unreachable"));
      return Promise.resolve({
        ok: true,
        json: async () => ({ version: "1.0.0-dev", deviceId: "esp32-424242", build: "test" }),
      });
    }
    if (o && o.method === "POST") {
      posts.push({ url: u, body: o.body || null });
      return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
    }
    return Promise.resolve({ ok: true, json: async () => ({}) });
  };

  class FormDataStub {
    constructor() { this.fields = {}; }
    append(k, v, name) { this.fields[k] = { value: v, name: name }; }
  }
  function XMLHttpRequestStub() {
    const self = this;
    self.upload = {};
    self.responseText = "";
    self.open = (m, u) => { self._url = String(u); };
    self.send = (fd) => {
      const fw = fd && fd.fields && fd.fields.firmware ? fd.fields.firmware : null;
      posts.push({ url: self._url, ota: true, fileName: fw ? (fw.name || "?") : "?" });
      clock.setTimeout(() => {
        if (scenario.otaOutcome.error) { if (self.onerror) self.onerror(); }
        else {
          self.responseText = JSON.stringify({ ok: !!scenario.otaOutcome.ok });
          if (self.onload) self.onload();
        }
      }, 5);
    };
  }

  const ctx = {
    document: documentStub,
    window: { matchMedia: () => ({ matches: false, addEventListener() {} }) },
    localStorage: (() => { const m = new Map(); return {
      getItem: (k) => (m.has(k) ? m.get(k) : null),
      setItem: (k, v) => m.set(k, String(v)),
      removeItem: (k) => m.delete(k) }; })(),
    location: { protocol: "http:", host: "10.0.2.2:8080" },
    fetch: fetchStub,
    FormData: FormDataStub,
    XMLHttpRequest: XMLHttpRequestStub,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    setInterval: clock.setInterval,
    clearInterval: clock.clearInterval,
    console,
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(APP_JS, "utf-8"), ctx, { filename: "app.js" });
  // The user has picked firmware.bin before pressing Upload & Flash.
  ctx.document.getElementById("otaFile").files = [{ name: "firmware.bin" }];
  return { ctx, elements, posts, clock, scenario };
}

function statusOf(env) { return env.elements.otaStatus ? env.elements.otaStatus.textContent : ""; }
function clsOf(env) { return env.elements.otaStatus ? env.elements.otaStatus.className : ""; }
// One poll iteration of the OTA reconnect wait per step. Statuses are
// sampled both right after the clock jump and after the microtask flush,
// because "Hub restarting…" only shows between the two.
async function drive(env, steps, seen) {
  for (let i = 0; i < steps; i++) {
    env.clock.advance(STEP_MS);
    seen.add(statusOf(env));
    await settle();
    seen.add(statusOf(env));
  }
}
function otaPosts(env) { return env.posts.filter((p) => p.ota); }

async function main() {
  console.log("hub UI OTA update feedback");

  // ---- 1. Upload accepted -> temporary disconnect -> successful reconnect ----
  {
    const seen = new Set();
    const env = makeContext({ otaOutcome: { ok: true }, infoPlan: [true, true, false, false, true] });
    env.ctx.otaUpload();
    await settle();
    assert(statusOf(env) === "Uploading firmware…", "status shows 'Uploading firmware…' during upload");
    assert(env.elements.otaBtn.disabled === true, "upload button disabled during update");
    assert(env.elements.otaFile.disabled === true, "file input disabled during update");
    assert(otaPosts(env).length === 1 && otaPosts(env)[0].fileName === "firmware.bin",
      "firmware.bin is sent to /api/ota");

    env.clock.advance(5);   // POST /api/ota acknowledgement arrives
    await settle();
    assert(statusOf(env) === "Installing update…",
      "POST accepted only moves to 'Installing update…' - not success");
    assert(statusOf(env).indexOf("Update successful") === -1,
      "no 'Update successful' merely because POST /api/ota returned ok");

    await drive(env, 10, seen);
    assert(seen.has("Hub restarting…"), "'Hub restarting…' shown while the Hub is down");
    assert(seen.has("Reconnecting to Hub…"), "'Reconnecting to Hub…' shown while polling /api/info");
    assert(statusOf(env).indexOf("Update successful ✓") === 0,
      "'Update successful ✓' only after the Hub answers /api/info again");
    assert(statusOf(env).indexOf("running firmware 1.0.0-dev") !== -1,
      "success reports the running firmware version");
    assert(statusOf(env).indexOf("different Hub device ID") === -1,
      "same device ID before/after update - no mismatch note");
    assert(clsOf(env) === "ota-status ok", "success status uses the ok style");
    assert(env.elements.otaBar.style.width === "100%", "progress bar full after success");
    assert(env.elements.otaBtn.disabled === false, "controls re-enabled after success");
    assert(env.elements.otaFile.disabled === false, "file input re-enabled after success");
  }

  // ---- 2. Delayed reconnect: several failed polls before the Hub returns ----
  {
    const seen = new Set();
    const env = makeContext({ otaOutcome: { ok: true }, infoPlan: [true, false, false, false, false, false, false, false, true] });
    env.ctx.otaUpload();
    await settle();
    env.clock.advance(5);
    await settle();
    await drive(env, 4, seen);
    assert(statusOf(env) === "Reconnecting to Hub…",
      "still 'Reconnecting to Hub…' after several failed polls");
    assert(env.elements.otaBtn.disabled === true, "controls still disabled while reconnecting");

    // The expected reboot also drops the WebSocket; the normal connection
    // banner reacts, but must not leak any OTA failure feedback.
    env.ctx.showHubBanner(true);
    assert(env.elements.hubBanner.hidden === false, "connection banner shows during the expected reboot");
    assert(statusOf(env) === "Reconnecting to Hub…" && clsOf(env).indexOf("err") === -1,
      "WS disconnect (banner) does not produce OTA failure feedback");
    env.ctx.showHubBanner(false);
    assert(env.elements.hubBanner.hidden === true, "banner hides again on reconnect");

    await drive(env, 6, seen);
    assert(statusOf(env).indexOf("Update successful ✓") === 0,
      "delayed reconnect still ends in success");
    assert(env.elements.otaBtn.disabled === false, "controls re-enabled after the delayed success");
  }

  // ---- 3. Reconnect timeout: the Hub never comes back ----
  {
    const env = makeContext({ otaOutcome: { ok: true }, infoPlan: [true, false] });
    env.ctx.otaUpload();
    await settle();
    env.clock.advance(5);
    await settle();
    const seen = new Set();
    await drive(env, 50, seen);   // exhausts the ~90 s reconnect budget
    assert(statusOf(env).indexOf("did not come back") !== -1,
      "timeout shows a clear failure message, not success");
    assert(statusOf(env).indexOf("Update successful") === -1,
      "no success when the Hub does not return");
    assert(clsOf(env) === "ota-status err", "timeout status uses the err style");
    assert(env.elements.otaBtn.disabled === false, "controls re-enabled after timeout failure");
    assert(env.elements.otaFile.disabled === false, "file input re-enabled after timeout failure");
  }

  // ---- 4. OTA POST failure: rejected file ----
  {
    const env = makeContext({ otaOutcome: { ok: false }, infoPlan: [true] });
    env.ctx.otaUpload();
    await settle();
    env.clock.advance(5);
    await settle();
    assert(statusOf(env).indexOf("Update failed") === 0, "rejected upload shows 'Update failed'");
    assert(clsOf(env) === "ota-status err", "rejected upload uses the err style");
    assert(env.elements.otaBtn.disabled === false, "controls re-enabled after rejection");
    assert(env.elements.otaFile.disabled === false, "file input re-enabled after rejection");
    assert(env.scenario.infoCalls === 1,
      "no reconnect polling after a rejected upload (only the pre-update /api/info)");
  }

  // ---- 5. OTA POST failure: network error during upload ----
  {
    const env = makeContext({ otaOutcome: { error: true }, infoPlan: [true] });
    env.ctx.otaUpload();
    await settle();
    env.clock.advance(5);
    await settle();
    assert(statusOf(env).indexOf("Upload error") === 0, "upload network error shows 'Upload error'");
    assert(clsOf(env) === "ota-status err", "upload error uses the err style");
    assert(env.elements.otaBtn.disabled === false, "controls re-enabled after upload error");
  }

  console.log("");
  console.log(failures === 0 ? "ALL " + count + " CHECKS PASSED" : failures + " / " + count + " CHECKS FAILED");
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });