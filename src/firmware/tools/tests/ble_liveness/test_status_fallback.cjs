// Regression tests for the Windows-side STATUS liveness fallback.
//
// The Hub notifies STATUS every 2 s, but notification delivery is not proven on
// every Windows stack while GATT reads are. main.rs therefore READS STATUS when
// no notification has arrived for a while, and shell.js marks the bridge
// connected BEFORE the connect command so the first STATUS read is not thrown
// away. These checks pin the contracts that keep the UI alive:
//   * the initial STATUS frame survives connection setup,
//   * an unchanged frame is never deduplicated (identical frames ARE the heartbeat),
//   * a fallback-paced frame stream keeps the real UI watchdog quiet,
//   * the 6 s UI window, the heartbeat and the Hub UUIDs are unchanged,
//   * main.rs keeps the notification stream and claims each fallback read.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const FIRMWARE = path.resolve(__dirname, '..', '..', '..');
const read = (relative) => fs.readFileSync(path.join(FIRMWARE, relative), 'utf8');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const NL = String.fromCharCode(10);

const FALLBACK_MS = 2500;   // status_fallback.rs STATUS_FALLBACK_AFTER_MS
const SILENCE_MS = 6000;    // app.js WS_SILENCE_MS
const STATUS_JSON = '{"source":"power","state":"IDLE","connected":true,"data":false,"sim":false,"raw":0,"value":0,"zone":0,"color":"#112233"}';

function fakeElement(id) {
  return {
    id,
    textContent: '',
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
    zoneName: 'Z1 Recovery', color: '#111111', source: '',
  }, overrides || {});
}
// The real adapter and the real UI, in one browser-like context.
function loadUi() {
  const document = createDocument();
  const bridge = createBridge();
  const context = {
    document,
    parent: { HubBleBridge: bridge },
    location: { protocol: 'http:', host: 'localhost' },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    fetch: () => Promise.reject(new Error('no network in this test')),
    Promise, Date, JSON, Math, setTimeout, clearTimeout, console, TextEncoder,
    DOMException: class extends Error {},
    Response: class { constructor(body, init) { this.body = body; this.status = (init && init.status) || 200; } json() { return Promise.resolve(JSON.parse(this.body)); } },
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(read('tools/ble_web_api.js'), context);
  context.ZoneGlowTransport = {};
  const api = vm.runInContext(
    read('data/web/app.js') + NL +
    ';({ wsStatusText: wsStatusText, initWs: initWs,' +
    ' setConfig: function (value) { config = value; },' +
    ' bannerShown: function () { return document.getElementById("hubBanner").hidden === false; } })',
    context
  );
  api.setConfig({ controlSource: 'power', zones: [{ name: 'Z1', color: '#111111' }], hrZones: [], ftp: 200, hrMax: 190, sourceName: '', hrSourceName: '' });
  return { api, bridge, document };
}
// The real BLE adapter on its own (no UI).
function loadBridge() {
  const context = { TextEncoder, Promise, setTimeout, clearTimeout, console, Date, JSON, module: {} };
  vm.createContext(context);
  return vm.runInContext(read('tools/ble_web_host.js') + NL + ';HubBleBridge;', context);
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('initial STATUS frame survives connection setup', async () => {
  // What shell.js now does: bridge configured and connected, THEN the connect
  // command emits its initial STATUS read.
  const bridge = loadBridge();
  bridge.configure({ command: () => Promise.resolve() });
  bridge.setConnected(true);
  bridge.receiveStatus(STATUS_JSON);

  const frames = [];
  bridge.subscribeTelemetry((frame) => frames.push(frame));
  await sleep(30);
  assert.equal(frames.length, 1, 'the iframe must receive the initial STATUS frame');
  assert.equal(frames[0].state, 'IDLE');

  // The old order threw it away: nothing to replay, nothing on screen.
  const discarded = loadBridge();
  discarded.configure({ command: () => Promise.resolve() });
  discarded.receiveStatus(STATUS_JSON);
  discarded.setConnected(true);
  const late = [];
  discarded.subscribeTelemetry((frame) => late.push(frame));
  await sleep(30);
  assert.equal(late.length, 0, 'this is the loss the ordering fix removes');
});

test('shell marks the bridge connected before the connect command', () => {
  const shell = read('desktop/src/shell.js');
  const connected = shell.indexOf('HubBleBridge.setConnected(true)');
  const connect = shell.indexOf('HubBleTransport.connect(address)');
  assert.ok(connected >= 0 && connect >= 0, 'both calls must exist');
  assert.ok(connected < connect, 'the bridge must be connected before the connect command');
  assert.ok(shell.indexOf('HubBleBridge.setConnected(false)') > connect, 'the failure path still disconnects the bridge');
  assert.ok(shell.indexOf('HubBleTransport.disconnect()') > connect, 'the failure path still tears the GATT link down');
});

test('identical STATUS frames are never deduplicated', () => {
  const bridge = loadBridge();
  bridge.configure({ command: () => Promise.resolve() });
  bridge.setConnected(true);
  const frames = [];
  bridge.subscribeTelemetry((frame) => frames.push(frame));
  bridge.receiveStatus(STATUS_JSON);
  bridge.receiveStatus(STATUS_JSON);
  bridge.receiveStatus(STATUS_JSON);
  assert.equal(frames.length, 3, 'an unchanged frame IS the heartbeat and must reach the UI');
});

test('fallback-paced STATUS frames keep the UI watchdog quiet', async () => {
  const { api, bridge } = loadUi();
  api.initWs();
  bridge.push(statusFrame());
  for (let beat = 0; beat < 3; beat++) {
    await sleep(FALLBACK_MS);
    bridge.push(statusFrame());
    assert.equal(api.bannerShown(), false, 'a read-paced link must not report a loss');
    assert.equal(api.wsStatusText(), 'connected');
  }
});

test('fallback cadence sits above the heartbeat and inside the UI window', () => {
  const policy = read('desktop/src-tauri/src/status_fallback.rs');
  const numberAfter = (marker) => {
    const at = policy.indexOf(marker);
    assert.ok(at >= 0, marker + ' must exist');
    const digits = policy.slice(at + marker.length).match(/[0-9]+/);
    return Number(digits[0]);
  };
  const after = numberAfter('STATUS_FALLBACK_AFTER_MS: u64 = ');
  const retry = numberAfter('STATUS_FALLBACK_RETRY_MS: u64 = ');
  assert.ok(after > 2000, 'must not read while the 2 s Hub heartbeat is healthy');
  assert.ok(after < SILENCE_MS / 2, 'must read well inside the 6 s UI window');
  assert.equal(retry, after, 'a failed read is retried on the same interval');
});

test('6 s UI window, heartbeat and Hub UUIDs are unchanged', () => {
  assert.ok(read('data/web/app.js').includes('const WS_SILENCE_MS = 6000;'));
  assert.ok(read('tools/ble_web_api.js').includes('var STALE_MS = 6000;'));
  assert.ok(read('include/HubBleStatusHeartbeat.h').includes('HUB_BLE_STATUS_HEARTBEAT_MS = 2000;'));
  const main = read('desktop/src-tauri/src/main.rs');
  ['5ca90000', '5ca90001', '5ca90002', '5ca90003'].forEach((prefix) => {
    assert.ok(main.includes(prefix + '-6d75-4ca5-b4d6-3f9e6c5b0001'), prefix + ' UUID must be unchanged');
  });
});

test('main.rs keeps the notification stream and claims each fallback read', () => {
  const main = read('desktop/src-tauri/src/main.rs');
  assert.ok(main.includes('mod status_fallback;'), 'the fallback rule lives in its own module');
  assert.ok(main.includes('while let Some(notification) = notifications.next().await'),
    'the notification subscription must stay the primary path');
  assert.ok(main.includes('.read(&fallback_status).await'), 'the fallback must READ the STATUS characteristic');
  assert.ok(main.includes('event_app.emit("ble-status"'), 'notifications still emit ble-status');
  assert.ok(main.includes('fallback_app.emit("ble-status"'), 'the fallback emits the same ble-status event');
  assert.ok(main.includes('state.should_read(now_ms()) && state.begin_read()'),
    'the read slot is claimed before the read (no overlap)');
  assert.ok(main.includes('state.finish_read(now_ms(), ok)'), 'a finished read releases the slot');
  assert.ok(main.includes('notification_alive.store(false, Ordering::SeqCst)'),
    'the fallback stops when the notification stream ends');
});

(async () => {
  let failed = 0;
  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log('ok    ' + name);
    } catch (error) {
      failed++;
      console.error('FAIL  ' + name + NL + '      ' + (error && error.message ? error.message : error));
    }
  }
  console.log(tests.length + ' STATUS fallback checks, ' + failed + ' failures');
  process.exit(failed ? 1 : 0);
})();
