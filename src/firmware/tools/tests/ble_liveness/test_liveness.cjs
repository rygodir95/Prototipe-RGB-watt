// BLE liveness regression tests for the packaged Hub UI and its BLE adapter.
//
// Covers the parts of the "Connection to Hub lost" / About-disagrees-with-banner
// failure that do not need hardware:
//   * an idle but healthy link keeps arriving frames inside the 6 s watchdog,
//   * a status frame is available to a subscriber that arrives late,
//   * a real disconnect moves the banner AND About to the same state,
//   * "the synthetic socket object exists" is never taken as proof of a link.
//
// Runs in plain Node (no browser): the canonical data/web/app.js and the BLE
// adapter are executed against a minimal fake DOM.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const FIRMWARE = path.resolve(__dirname, '..', '..', '..');
const read = (relative) => fs.readFileSync(path.join(FIRMWARE, relative), 'utf8');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const HEARTBEAT_MS = 2000;   // HubBleStatusHeartbeat.h
const SILENCE_MS = 6000;     // app.js WS_SILENCE_MS / adapter STALE_MS

function fakeElement(id) {
  return {
    id,
    textContent: id === 'hubBanner' ? 'Connection to Hub lost \u2014 reconnecting\u2026' : '',
    hidden: true,
    style: {},
    className: '',
    classList: { add() {}, remove() {}, toggle() {} },
    querySelector() { return fakeElement(id + '-child'); },
    appendChild() {},
    addEventListener() {},
    setAttribute() {},
  };
}
function createDocument() {
  const elements = {};
  const get = (id) => { if (!elements[id]) elements[id] = fakeElement(id); return elements[id]; };
  return {
    getElementById: get,
    querySelectorAll: () => [],
    createElement: (tag) => fakeElement(tag),
    addEventListener() {},
    head: { appendChild() {} },
    body: { appendChild() {}, removeChild() {} },
    documentElement: { setAttribute() {} },
    elements,
  };
}

// Minimal bridge: the adapter only needs api()/subscribeTelemetry().
function createBridge() {
  const listeners = [];
  return {
    api: () => Promise.resolve({}),
    subscribeTelemetry(listener) {
      listeners.push(listener);
      return () => { const index = listeners.indexOf(listener); if (index >= 0) listeners.splice(index, 1); };
    },
    push(frame) { listeners.slice().forEach((listener) => listener(frame)); },
    drop() { listeners.slice().forEach((listener) => listener(null)); },
  };
}

function statusFrame(overrides) {
  return Object.assign({
    mode: 'power', state: 'DISCONNECTED', connected: false, hasData: false, sim: false,
    raw: 0, smoothed: 0, hr: 0, hrRaw: 0, hrMax: 190, zone: 0,
    zoneName: 'Z1 \u00b7 Recovery', color: '#111111', source: '',
  }, overrides || {});
}

// Load the real adapter and the real UI into one browser-like context.
function load() {
  const document = createDocument();
  const bridge = createBridge();
  const context = {
    document,
    parent: { HubBleBridge: bridge },
    location: { protocol: 'http:', host: 'localhost' },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    fetch: () => Promise.reject(new Error('no network in this test')),
    Promise, Date, JSON, Math, setTimeout, clearTimeout, console,
    DOMException: class extends Error {},
    Response: class { constructor(body, init) { this.body = body; this.status = (init && init.status) || 200; } json() { return Promise.resolve(JSON.parse(this.body)); } },
  };
  context.window = context;             // browser-like: window IS the global
  vm.createContext(context);
  vm.runInContext(read('tools/ble_web_api.js'), context);
  context.ZoneGlowTransport = {};
  const api = vm.runInContext(
    read('data/web/app.js') +
    '\n;({ fillAbout: fillAbout, wsStatusText: wsStatusText, initWs: initWs,' +
    ' bannerShown: function () { return document.getElementById("hubBanner").hidden === false; },' +
    ' setView: function (value) { activeView = value; },' +
    ' setConfig: function (value) { config = value; } })',
    context
  );
  api.setConfig({ controlSource: 'power', zones: [{ name: 'Z1', color: '#111111' }], hrZones: [], ftp: 200, hrMax: 190, sourceName: '', hrSourceName: '' });
  return { api, bridge, document, window: context };
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('client silence window is wider than the firmware heartbeat', () => {
  const adapter = read('tools/ble_web_api.js');
  assert.ok(/var STALE_MS = 6000;/.test(adapter), 'adapter stale window must be 6 s');
  assert.ok(read('include/HubBleStatusHeartbeat.h').includes('HUB_BLE_STATUS_HEARTBEAT_MS = 2000;'));
  assert.ok(HEARTBEAT_MS < SILENCE_MS);
});

test('initial status: socket is not "connected" until a real frame arrives', () => {
  const { api, bridge } = load();
  assert.equal(api.wsStatusText(), 'not started');
  api.initWs();
  assert.equal(api.wsStatusText(), 'connecting', 'an existing socket object proves nothing');
  assert.equal(api.bannerShown(), false);
  bridge.push(statusFrame());
  assert.equal(api.wsStatusText(), 'connected');
  assert.equal(api.bannerShown(), false, 'first frame must not show the loss banner');
});

test('idle hub with heartbeat: no false connection-loss banner over 8 s', async () => {
  const { api, bridge } = load();
  api.initWs();
  bridge.push(statusFrame());
  for (let beat = 0; beat < 4; beat++) {
    await sleep(HEARTBEAT_MS);
    bridge.push(statusFrame());
    assert.equal(api.bannerShown(), false, 'healthy link must not report a loss');
    assert.equal(api.wsStatusText(), 'connected');
  }
});

test('silence past the window: banner and About agree it is not connected', async () => {
  const { api, bridge, document } = load();
  api.setView('about');
  api.initWs();
  bridge.push(statusFrame());
  assert.equal(api.wsStatusText(), 'connected');
  await sleep(SILENCE_MS + 1000);
  assert.equal(api.bannerShown(), true, 'stale telemetry must raise the banner');
  assert.notEqual(api.wsStatusText(), 'connected', 'About must not claim a live link');
  assert.equal(document.getElementById('diagWs').textContent, 'reconnecting\u2026');
});

test('real BLE disconnect updates banner and About together', () => {
  const { api, bridge, document } = load();
  api.setView('about');
  api.initWs();
  bridge.push(statusFrame());
  api.fillAbout();
  assert.equal(document.getElementById('diagWs').textContent, 'connected');
  assert.equal(api.bannerShown(), false);

  bridge.drop();   // what HubBleBridge.setConnected(false) emits

  assert.equal(api.bannerShown(), true);
  assert.equal(api.wsStatusText(), 'disconnected');
  assert.equal(document.getElementById('diagWs').textContent, 'reconnecting\u2026');
});

test('bridge replays a fresh status to a late subscriber, never a stale one', async () => {
  const context = { TextEncoder, Promise, setTimeout, clearTimeout, console, Date, JSON, module: {} };
  vm.createContext(context);
  const bridge = vm.runInContext(read('tools/ble_web_host.js') + '\n;HubBleBridge;', context);
  bridge.configure({ command: () => Promise.resolve() });
  bridge.setConnected(true);
  bridge.receiveStatus({ source: 'power', state: 'DISCONNECTED', value: 0, zone: 0, color: '#000000' });

  const late = [];
  bridge.subscribeTelemetry((frame) => late.push(frame));
  await sleep(30);
  assert.equal(late.length, 1, 'the current frame is replayed immediately');
  assert.equal(late[0].state, 'DISCONNECTED');

  // A disconnect clears the cache and notifies subscribers.
  bridge.setConnected(false);
  assert.equal(late[late.length - 1], null, 'subscribers learn about the disconnect');

  // After reconnecting, a stale frame from the previous session is not replayed.
  bridge.setConnected(true);
  const afterReconnect = [];
  bridge.subscribeTelemetry((frame) => afterReconnect.push(frame));
  await sleep(30);
  assert.equal(afterReconnect.length, 0, 'stale status must not be replayed as live');
});

(async () => {
  let failed = 0;
  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log('ok    ' + name);
    } catch (error) {
      failed++;
      console.error('FAIL  ' + name + '\n      ' + (error && error.message ? error.message : error));
    }
  }
  console.log(tests.length + ' liveness checks, ' + failed + ' failures');
  // The UI retries its socket forever after a close (by design), so leftover
  // timers would keep this process alive. Exit explicitly with the result.
  process.exit(failed ? 1 : 0);
})();
