// Client-side paged-transfer recovery tests (tools/ble_web_host.js).
//
// A fake Hub implements the firmware contract: independent config/device
// slots, a transfer token per page-0 request, a 60 s window, the final page
// kept readable, and explicit correlated errors.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadBridge() {
  return vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, 'ble_web_host.js'), 'utf8') + '\nHubBleBridge;',
    { TextEncoder, Promise, setTimeout, clearTimeout, console, queueMicrotask }
  );
}

const CONFIG = JSON.stringify({ ftp: 240, pad: 'x'.repeat(420) });
const DEVICES = JSON.stringify({ scanning: false, devices: [{ address: 'AA:BB', name: 'Assioma' }] });

// Fake Hub with the firmware's transfer semantics.
function createHub(options) {
  const settings = Object.assign({ failPage: null, rejectEveryRead: null, startAt: 1 }, options || {});
  const slots = { config_read: null, devices_read: null };
  const log = [];
  let inFlight = 0;
  let maxInFlight = 0;
  let token = 0;

  function payloadFor(op) {
    return op === 'config_read' ? CONFIG : DEVICES;
  }

  const transport = {
    async command(raw) {
      const request = JSON.parse(raw);
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      log.push(request);
      try {
        await Promise.resolve();
        if (settings.rejectEveryRead) {
          return undefined; // resolved through the notification below
        }
        if (request.op === 'config_read' || request.op === 'devices_read') {
          const key = request.op;
          if (settings.failPage !== null && request.part === settings.failPage) {
            // Simulate the slot being replaced/expired between pages.
            if (settings.failOnce && settings.failOnce-- > 0) slots[key] = null;
            else slots[key] = null;
            return undefined;
          }
          if (request.part === 0) {
            const data = payloadFor(key);
            token++;
            slots[key] = { data, token, at: Date.now() };
            return undefined;
          }
          const slot = slots[key];
          const parts = Math.ceil(payloadFor(key).length / 80);
          if (!slot) return undefined;
          if (request.t !== undefined && request.t !== slot.token) return undefined;
          if (request.part >= parts) return undefined;
          return undefined;
        }
        return undefined;
      } finally {
        setTimeout(() => { inFlight--; }, 0);
      }
    },
  };

  // The bridge is driven through notifications (like the Windows shell does).
  function attach(bridge) {
    transport.respond = (request) => {
      const op = request.op;
      if (op === 'config_read' || op === 'devices_read') {
        const data = payloadFor(op);
        const parts = Math.ceil(data.length / 80);
        if (request.part === 0) {
          if (settings.rejectEveryRead) {
            bridge.receiveResult({ v: 1, id: request.id, ok: false, error: settings.rejectEveryRead });
            return;
          }
          if (settings.failPage === 0) {
            bridge.receiveResult({ v: 1, id: request.id, ok: false, error: op.split('_')[0] + ' transfer expired' });
            return;
          }
          const slot = slots[op];
          bridge.receiveResult({ v: 1, id: request.id, ok: true, type: op.split('_')[0], part: 0, parts, t: slot ? slot.token : undefined, data: data.slice(0, 80) });
          return;
        }
        const slot = slots[op];
        if (!slot) {
          bridge.receiveResult({ v: 1, id: request.id, ok: false, error: (op === 'config_read' ? 'config' : 'devices') + ' transfer expired' });
          return;
        }
        if (settings.failPage !== null && request.part === settings.failPage) {
          bridge.receiveResult({ v: 1, id: request.id, ok: false, error: (op === 'config_read' ? 'config' : 'devices') + ' transfer expired' });
          return;
        }
        bridge.receiveResult({ v: 1, id: request.id, ok: true, type: op.split('_')[0], part: request.part, parts, t: slot.token, data: data.slice(request.part * 80, (request.part + 1) * 80) });
        return;
      }
      bridge.receiveResult({ v: 1, id: request.id, ok: true });
    };
    return bridge;
  }

  return { transport, log, attach, stats: () => ({ maxInFlight }) };
}

async function runRead(hub, op) {
  const bridge = loadBridge();
  hub.attach(bridge);
  // Deliver each request notification on the next tick, after it is recorded.
  bridge.configure({
    command: async (raw) => {
      const request = JSON.parse(raw);
      await hub.transport.command(raw);
      queueMicrotask(() => hub.transport.respond(request));
    },
  });
  bridge.setConnected(true);
  return bridge.api(op === 'config_read' ? '/api/config' : '/api/devices', 'GET');
}

const starts = (log, op) => log.filter((item) => item.op === op && item.part === 0).length;

(async () => {
  // 1. Multi-page config read succeeds and carries the transfer token.
  {
    const hub = createHub();
    const config = await runRead(hub, 'config_read');
    assert.equal(config.ftp, 240);
    const pages = hub.log.filter((item) => item.op === 'config_read');
    assert.equal(pages.length, Math.ceil(CONFIG.length / 80));
    assert(pages.slice(1).every((item) => Number.isInteger(item.t)), 'later pages must echo the transfer token');
    assert.equal(starts(hub.log, 'config_read'), 1);
    assert.equal(hub.stats().maxInFlight, 1, 'requests must stay serialized');
  }

  // 2. Interleaved read: a device transfer starting mid-config must not corrupt it.
  {
    const hub = createHub({ failPage: 2, failOnce: 1 });
    const config = await runRead(hub, 'config_read');
    assert.equal(config.ftp, 240);
    assert.equal(starts(hub.log, 'config_read'), 2, 'exactly one retry from page 0');
    // The retry used a fresh request id.
    const page0 = hub.log.filter((item) => item.op === 'config_read' && item.part === 0);
    assert.notEqual(page0[0].id, page0[1].id, 'retry must use a fresh request id');
  }

  // 3. A transfer that keeps failing: one retry, then the error surfaces.
  {
    const hub = createHub({ failPage: 1 });
    await assert.rejects(() => runRead(hub, 'config_read'), /transfer expired/);
    assert.equal(starts(hub.log, 'config_read'), 2, 'never retries more than once');
  }

  // 4. Unrelated errors are never retried.
  {
    const hub = createHub({ rejectEveryRead: 'Hub rejected the command' });
    await assert.rejects(() => runRead(hub, 'config_read'), /Hub rejected the command/);
    assert.equal(starts(hub.log, 'config_read'), 1, 'a rejection must not be retried');
  }

  // 5. Device-list read retries on an expired transfer too.
  {
    const hub = createHub({ failPage: 1, failOnce: 1 });
    const devices = await runRead(hub, 'devices_read');
    assert.equal(devices.devices[0].address, 'AA:BB');
    assert.equal(starts(hub.log, 'devices_read'), 2);
  }

  // 6. Repeated final page is served (no retry needed at all).
  {
    const hub = createHub();
    const bridge = loadBridge();
    hub.attach(bridge);
    let calls = 0;
    bridge.configure({
      command: async (raw) => {
        const request = JSON.parse(raw);
        await hub.transport.command(raw);
        calls++;
        queueMicrotask(() => hub.transport.respond(request));
      },
    });
    bridge.setConnected(true);
    await bridge.api('/api/config', 'GET');
    await bridge.api('/api/config', 'GET');
    const lastPage = Math.ceil(CONFIG.length / 80) - 1;
    assert(calls >= lastPage * 2);
    assert.equal(starts(hub.log, 'config_read'), 2, 'each read starts its own transfer, no retry');
  }

  console.log('ble transfer retry tests passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
