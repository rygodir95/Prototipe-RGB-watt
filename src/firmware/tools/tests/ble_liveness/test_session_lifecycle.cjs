// Executable boundary tests. The watchdog input trace MUST come from the
// production Rust session workers, not hand-written/injected UI frames.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '../../..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
const tick = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
function deferred() { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b; }); return { promise, resolve, reject }; }
function nativeHost(invoke, registration, identity = 'test-client') {
  const events = {}, calls = [];
  const context = { Promise, JSON, console, TextEncoder, Date, setTimeout, clearTimeout };
  context.window = context;
  context.crypto = { randomUUID: () => identity };
  context.__TAURI__ = {
    core: { invoke(name, args) { calls.push({ name, args }); return invoke(name, args); } },
    event: { listen(name, callback) { events[name] = callback; return registration ? registration.promise : Promise.resolve(() => {}); } }
  };
  vm.createContext(context); vm.runInContext(read('desktop/src/ble-transport.js'), context);
  return { context, transport: context.HubBleTransport, calls,
    emit(name, payload) { if (events[name]) events[name]({ payload }); } };
}
function element(id) {
  return { id, textContent: '', hidden: true, disabled: false, value: '', style: {}, dataset: {}, children: [], events: {},
    classList: { add() {}, remove() {}, toggle() {} }, querySelector() { return element(id+'-child'); },
    appendChild(child) { this.children.push(child); }, addEventListener(name, callback) { this.events[name] = callback; },
    setAttribute() {} };
}
function document() {
  const elements = {};
  return { elements, getElementById(id) { return elements[id] || (elements[id] = element(id)); },
    querySelectorAll: () => [], createElement: element, addEventListener() {},
    head: { appendChild() {} }, body: { dataset: {}, appendChild() {}, removeChild() {} }, documentElement: { setAttribute() {} } };
}
function shell() {
  const events = {}, pending = deferred(), config = deferred(), doc = document(), bridgeStates = [];
  const context = { document: doc, Promise, JSON, console,
    setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1,
    ZoneGlowTransport: { getUrl: () => 'http://localhost:8080', probe: () => Promise.reject(new Error('offline')) },
    HubBleBridge: { configure() {}, setConnected(value) { bridgeStates.push(value); }, receiveStatus() {},
      api: p => p === '/api/config' ? config.promise : Promise.resolve({}) },
    HubBleTransport: { available: () => true, listen(name, cb) { events[name] = cb; return Promise.resolve(); },
      connect: () => pending.promise, disconnect: () => Promise.resolve(), command: () => Promise.resolve() } };
  context.window = context; vm.createContext(context);
  const source = read('desktop/src/shell.js').replace(/\}\)\(\);\s*$/, 'window.testShell = { connect: connectBle, leave: leaveBle }; })();');
  vm.runInContext(source, context);
  return { context, doc, events, pending, config, bridgeStates };
}
function clock() {
  let now = 0, next = 1; const timers = new Map();
  return { now: () => now,
    Date: class extends Date { static now() { return 100000 + now; } },
    setTimeout(fn, delay) { const id = next++; timers.set(id, { at: now + Number(delay || 0), fn }); return id; },
    clearTimeout(id) { timers.delete(id); },
    advance(to) {
      for (;;) {
        const due = [...timers.entries()].filter(([,t]) => t.at <= to).sort((a,b) => a[1].at-b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]); now = due[1].at; due[1].fn();
      }
      now = to;
    } };
}
const tests = []; const test = (name, fn) => tests.push({ name, fn });
test('native subscriptions complete before invoking connect', async () => {
  const ready = deferred(); const host = nativeHost(() => Promise.resolve(1), ready);
  host.transport.listen('ble-connection', () => {});
  const connecting = host.transport.connect('hub'); await tick(); assert.equal(host.calls.length, 0);
  ready.resolve(() => {}); await connecting; assert.equal(host.calls[0].name, 'ble_connect');
});
test('native generation and client token reject queued obsolete events', async () => {
  let generation = 0; const seen = [];
  const host = nativeHost(name => Promise.resolve(name === 'ble_connect' ? ++generation : undefined));
  await host.transport.listen('ble-status', value => seen.push(value));
  await host.transport.connect('one'); const old = host.calls[0].args.clientId;
  host.emit('ble-status', { clientId: old, session: 1, value: 'old-before' });
  await host.transport.disconnect(); await host.transport.connect('two');
  const current = host.calls.filter(c => c.name === 'ble_connect')[1].args.clientId;
  host.emit('ble-status', { clientId: old, session: 1, value: 'old-after' });
  host.emit('ble-status', { clientId: current, session: 1, value: 'wrong-generation' });
  host.emit('ble-status', { clientId: current, session: 2, value: 'current' });
  assert.deepEqual(seen, ['old-before', 'current']);
});
test('reloaded shell rejects events from an earlier frontend instance', async () => {
  const before = nativeHost(() => Promise.resolve(1), null, 'before-reload');
  await before.transport.connect('hub'); const oldToken = before.calls[0].args.clientId;
  const pending = deferred(), seen = [];
  const after = nativeHost(() => pending.promise, null, 'after-reload');
  await after.transport.listen('ble-status', value => seen.push(value));
  const connecting = after.transport.connect('hub'); await tick();
  after.emit('ble-status', { clientId: oldToken, session: 1, value: 'obsolete' });
  assert.deepEqual(seen, []); pending.resolve(2); await connecting;
  after.emit('ble-status', { clientId: after.calls[0].args.clientId, session: 2, value: 'current' });
  assert.deepEqual(seen, ['current']);
});
test('native rejects duplicate connection attempts', async () => {
  const pending = deferred(); const host = nativeHost(() => pending.promise);
  const first = host.transport.connect('one'); await tick();
  await assert.rejects(host.transport.connect('two'), /already/);
  pending.resolve(1); await first;
  await assert.rejects(host.transport.connect('three'), /already/);
});
test('disconnect rejects a late native startup completion', async () => {
  const pending = deferred(); const host = nativeHost(name => name === 'ble_connect' ? pending.promise : Promise.resolve());
  const first = host.transport.connect('one'); await tick(); await host.transport.disconnect();
  pending.resolve(1); await assert.rejects(first, /cancelled/);
});
test('shell handles physical loss before bleMode becomes true', async () => {
  const h = shell(); h.context.testShell.connect('hub'); await tick();
  h.events['ble-connection'](false); h.pending.resolve(1); h.config.resolve({}); await tick();
  assert.equal(h.bridgeStates[h.bridgeStates.length-1], false);
  assert.equal(h.doc.elements.uiFrame.src, 'about:blank'); assert.equal(h.doc.body.dataset.state, 'disconnected');
  assert.equal(h.doc.elements.bleShellDisconnect.hidden, true);
});
test('shell cannot reactivate after disconnect during configuration startup', async () => {
  const h = shell(); h.context.testShell.connect('hub'); h.pending.resolve(1); await tick();
  h.events['ble-connection'](false); h.config.resolve({}); await tick();
  assert.equal(h.doc.elements.uiFrame.src, 'about:blank'); assert.equal(h.bridgeStates.at(-1), false);
});
test('actual Rust fallback output keeps the real UI watchdog alive', async () => {
  const tracePath = process.argv[2]; assert.ok(tracePath, 'pass BLE_LIFECYCLE_TRACE generated by cargo test');
  const trace = JSON.parse(fs.readFileSync(tracePath, 'utf8'));
  assert.ok(trace.filter(e => e.name === 'ble-status').length >= 8, 'production workers must generate a sustained trace');
  assert.ok(trace.some(e => e.name === 'ble-notifications' && e.payload.value === false), 'trace must include actual notification EOF');
  assert.ok(!trace.some(e => e.name === 'ble-connection' && e.payload.value === false));
  const time = clock(); const host = nativeHost(() => Promise.resolve(trace[0].payload.session));
  Object.assign(host.context, { Date: time.Date, setTimeout: time.setTimeout, clearTimeout: time.clearTimeout, module: {} });
  vm.runInContext(read('tools/ble_web_host.js'), host.context);
  const bridge = host.context.HubBleBridge;
  await host.transport.listen('ble-status', value => bridge.receiveStatus(value));
  await host.transport.listen('ble-connection', value => { if (!value) bridge.setConnected(false); });
  bridge.configure(host.transport); bridge.setConnected(true); await host.transport.connect('hub');
  const doc = document();
  const ui = { document: doc, parent: { HubBleBridge: bridge }, location: { protocol: 'http:', host: 'localhost' },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    fetch: () => Promise.reject(new Error('no network')), Promise, Date: time.Date, JSON, Math, console, TextEncoder,
    setTimeout: time.setTimeout, clearTimeout: time.clearTimeout, DOMException: class extends Error {},
    Response: class { constructor(body) { this.body=body; } json() { return Promise.resolve(JSON.parse(this.body)); } } };
  ui.window = ui; vm.createContext(ui); vm.runInContext(read('tools/ble_web_api.js'), ui); ui.ZoneGlowTransport = {};
  const api = vm.runInContext(read('data/web/app.js') + '\n;({initWs,wsStatusText,setConfig:v=>{config=v;}})', ui);
  api.setConfig({ controlSource: 'power', zones: [{ name: 'Z1', color: '#111111' }], hrZones: [], ftp: 200, hrMax: 190, sourceName: '', hrSourceName: '' });
  api.initWs();
  for (const event of trace) {
    time.advance(event.at); host.emit(event.name, event.payload); await tick();
    if (event.name === 'ble-status') {
      assert.equal(api.wsStatusText(), 'connected'); assert.equal(doc.getElementById('hubBanner').hidden, true);
    }
  }
  assert.ok(time.now() >= 20000);
  // Negative control: the SAME unmodified watchdog still detects real silence.
  time.advance(time.now() + 6001); await tick();
  assert.equal(doc.getElementById('hubBanner').hidden, false);
  assert.equal(api.wsStatusText(), 'disconnected');
});
(async () => {
  let failed = 0;
  for (const { name, fn } of tests) {
    try { await fn(); console.log('ok    ' + name); }
    catch (error) { failed++; console.error('FAIL  ' + name + '\n' + error.stack); }
  }
  console.log(`${tests.length} session boundary/watchdog tests, ${failed} failures`); process.exit(failed ? 1 : 0);
})();