// Client-side paged-transfer recovery tests for tools/ble_web_host.js.
//
// The fake Hub implements the firmware contract: independent config/device
// slots, a transfer token issued per page-0 request, the final page kept
// readable, and explicit correlated errors. Every response is delivered as a
// GATT notification, exactly like the Windows shell does, and a command only
// settles after its response arrived - so the in-flight counter below measures
// real serialization.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const CONFIG = JSON.stringify({ ftp: 240, pad: 'x'.repeat(420) });
const DEVICES = JSON.stringify({ scanning: false, devices: [{ address: 'AA:BB', name: 'Assioma' }] });
const CHUNK = 80;
const pagesOf = (data) => Math.ceil(data.length / CHUNK);
const payloadFor = (op) => (op === 'config_read' ? CONFIG : DEVICES);
const kindOf = (op) => (op === 'config_read' ? 'config' : 'devices');

function loadBridge() {
  return vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, 'ble_web_host.js'), 'utf8') + '\nHubBleBridge;',
    { TextEncoder, Promise, setTimeout, clearTimeout, console, queueMicrotask }
  );
}

// Fake Hub: failPage (0-based) fails once when failOnce is set, always when not.
function createHub(options) {
  const settings = Object.assign({ failPage: null, failOnce: 0, rejectReads: null }, options || {});
  const slots = {};
  const log = [];
  let token = 0;

  function respond(request, bridge) {
    const { op, id, part } = request;
    log.push(request);
    if (op !== 'config_read' && op !== 'devices_read') {
      bridge.receiveResult({ v: 1, id, ok: true });
      return;
    }
    const kind = kindOf(op);
    const data = payloadFor(op);
    const parts = pagesOf(data);

    if (settings.rejectReads) {
      bridge.receiveResult({ v: 1, id, ok: false, error: settings.rejectReads });
      return;
    }
    if (part === 0) {
      token++;
      slots[kind] = { token, data };
      bridge.receiveResult({ v: 1, id, ok: true, type: kind, part: 0, parts, t: token, data: data.slice(0, CHUNK) });
      return;
    }
    const failPage = settings.failPage !== null && part === settings.failPage &&
      (settings.failOnce > 0 || settings.alwaysFailPage);
    if (failPage) {
      slots[kind] = null;                     // the slot was replaced/expired
      if (settings.failOnce > 0) settings.failOnce--;
      bridge.receiveResult({ v: 1, id, ok: false, error: kind + ' transfer expired' });
      return;
    }
    const slot = slots[kind];
    if (!slot) {
      bridge.receiveResult({ v: 1, id, ok: false, error: kind + ' transfer expired' });
      return;
    }
    if (request.t !== undefined && request.t !== slot.token) {
      bridge.receiveResult({ v: 1, id, ok: false, error: kind + ' transfer expired' });
      return;
    }
    bridge.receiveResult({
      v: 1, id, ok: true, type: kind, part, parts, t: slot.token,
      data: data.slice(part * CHUNK, (part + 1) * CHUNK),
    });
  }

  return { log, respond, starts: (op) => log.filter((item) => item.op === op && item.part === 0) };
}

// One connected session; counts how many commands were ever in flight at once.
function session(hub) {
  const bridge = loadBridge();
  let inFlight = 0;
  let maxInFlight = 0;
  bridge.configure({
    command: (raw) => new Promise((resolve) => {
      const request = JSON.parse(raw);
      inFlight++;
      if (inFlight > maxInFlight) maxInFlight = inFlight;
      queueMicrotask(() => {
        hub.respond(request, bridge);
        inFlight--;
        resolve(undefined);            // response already delivered as a notification
      });
    }),
  });
  bridge.setConnected(true);
  return { bridge, stats: () => ({ maxInFlight }) };
}

(async () => {
  // 1. Multi-page configuration read, with the transfer token echoed per page.
  {
    const hub = createHub();
    const { bridge, stats } = session(hub);
    const config = await bridge.api('/api/config', 'GET');
    assert.equal(config.ftp, 240);
    const reads = hub.log.filter((item) => item.op === 'config_read');
    assert.equal(reads.length, pagesOf(CONFIG));
    assert(reads.slice(1).every((item) => Number.isInteger(item.t)), 'later pages must echo the transfer token');
    assert.equal(hub.starts('config_read').length, 1, 'no retry when nothing failed');
    assert.equal(stats().maxInFlight, 1, 'requests must stay serialized');
  }

  // 2. Interleaved read: the config transfer is invalidated mid-way, the client
  //    restarts exactly once from page 0 with a fresh request id.
  {
    const hub = createHub({ failPage: 2, failOnce: 1 });
    const { bridge } = session(hub);
    const config = await bridge.api('/api/config', 'GET');
    assert.equal(config.ftp, 240);
    const starts = hub.starts('config_read');
    assert.equal(starts.length, 2, 'exactly one retry from page 0');
    assert.notEqual(starts[0].id, starts[1].id, 'the retry must use a fresh request id');
  }

  // 3. A transfer that keeps failing: one retry, then the error surfaces.
  {
    const hub = createHub({ failPage: 1, alwaysFailPage: true });
    const { bridge } = session(hub);
    await assert.rejects(() => bridge.api('/api/config', 'GET'), /transfer expired/);
    assert.equal(hub.starts('config_read').length, 2, 'never retries more than once');
  }

  // 4. Unrelated errors are never retried.
  {
    const hub = createHub({ rejectReads: 'Hub rejected the command' });
    const { bridge } = session(hub);
    await assert.rejects(() => bridge.api('/api/config', 'GET'), /Hub rejected the command/);
    assert.equal(hub.starts('config_read').length, 1, 'a rejected command must not be retried');
  }

  // 5. Device-list transfer retries on an expired transfer too.
  {
    const hub = createHub({ failPage: 1, failOnce: 1 });
    const { bridge } = session(hub);
    const devices = await bridge.api('/api/devices', 'GET');
    assert.equal(devices.devices[0].address, 'AA:BB');
    assert.equal(hub.starts('devices_read').length, 2);
  }

  // 6. Repeated final page: two consecutive reads each open their own transfer
  //    and need no retry at all (the Hub keeps the final page readable).
  {
    const hub = createHub();
    const { bridge } = session(hub);
    await bridge.api('/api/config', 'GET');
    await bridge.api('/api/config', 'GET');
    const starts = hub.starts('config_read');
    assert.equal(starts.length, 2, 'each read starts its own transfer, no retry');
    assert.notEqual(starts[0].id, starts[1].id);
    assert.equal(hub.log.filter((item) => item.op === 'config_read').length, pagesOf(CONFIG) * 2);
  }

  console.log('ble transfer retry tests passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
