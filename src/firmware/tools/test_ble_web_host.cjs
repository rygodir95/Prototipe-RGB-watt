const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const mobileDir = path.resolve(__dirname, '../../../mobile/capacitor');
const mobilePackage = JSON.parse(fs.readFileSync(path.join(mobileDir, 'package.json'), 'utf8'));
for (const script of ['prepare:ui', 'prebuild:debug', 'prebuild:release']) {
  const command = mobilePackage.scripts[script];
  assert.match(command, /^node\s+\S+$/);
  assert(fs.existsSync(path.resolve(mobileDir, command.split(/\s+/)[1])), `${script} must point to the UI packager`);
}
require('./prepare_ble_web_ui.cjs');
const canonical = fs.readFileSync(path.join(__dirname, '../data/web/app.js'), 'utf8');
for (const target of ['../desktop/src/hub-ui', '../../../mobile/capacitor/www/hub-ui']) {
  const folder = path.join(__dirname, target);
  assert.equal(fs.readFileSync(path.join(folder, 'app.js'), 'utf8'), canonical);
  assert.match(fs.readFileSync(path.join(folder, 'index.html'), 'utf8'), /ble-web-api\.js/);
}
const bridge = vm.runInNewContext(
  fs.readFileSync(path.join(__dirname, 'ble_web_host.js'), 'utf8') + '\nHubBleBridge;',
  { TextEncoder, Promise, setTimeout, clearTimeout, console }
);

const config = {
  ftp: 240, hrMax: 190, controlSource: 'power', sourceName: 'Power meter',
  hrSourceName: 'Heart rate', zoneCount: 1,
  zones: [{ name: 'Easy', min: 0, color: '#ffffff' }],
  hrZones: [{ name: 'Recovery', min: 95, color: '#112233' }],
};
const sent = [];
let staged;
function response(id, body) { queueMicrotask(() => bridge.receiveResult(Object.assign({ v: 1, id, ok: true }, body))); }
bridge.configure({ command: async (raw) => {
  const command = JSON.parse(raw);
  sent.push(command);
  if (command.op === 'config_read' || command.op === 'devices_read') {
    const data = JSON.stringify(command.op === 'config_read' ? config : { scanning: false, devices: [] });
    const part = command.part;
    response(command.id, { type: command.op === 'config_read' ? 'config' : 'devices',
      part, parts: Math.ceil(data.length / 80), data: data.slice(part * 80, (part + 1) * 80) });
  } else if (command.op === 'config_write') {
    Object.assign(config, command.patch); response(command.id, {});
  } else if (command.op === 'zone_begin') {
    staged = { source: command.source, zones: [] }; response(command.id, {});
  } else if (command.op === 'zone_stage') {
    staged.zones[command.zone.index] = { name: command.zone.name, min: command.zone.min, color: command.zone.color };
    response(command.id, {});
  } else if (command.op === 'zone_commit') {
    config[staged.source === 'hr' ? 'hrZones' : 'zones'] = staged.zones;
    response(command.id, {});
  } else if (command.op === 'info') response(command.id, { version: '1.0.0-dev', buildId: 'test' });
  else response(command.id, {});
} });
bridge.setConnected(true);

(async () => {
  const initial = await bridge.api('/api/config', 'GET');
  assert.equal(initial.ftp, 240);
  assert.equal(initial.zones[0].name, 'Easy');
  const updated = await bridge.api('/api/config', 'POST', {
    ftp: 250, zones: [{ name: 'Steady', min: 0, color: '#123456' }],
  });
  assert.equal(updated.ftp, 250);
  assert.equal(updated.zones[0].color, '#123456');
  assert(sent.some((item) => item.op === 'zone_begin' && item.source === 'power'));
  assert(sent.some((item) => item.op === 'zone_stage' && item.zone.source === 'power'));
  assert(sent.some((item) => item.op === 'zone_commit'));
  assert(sent.filter((item) => item.op === 'config_read').every((item) => Number.isInteger(item.part)));
  await bridge.api('/api/simulation', 'POST', { watts: 180 });
  assert.deepEqual(sent.at(-1), { id: sent.at(-1).id, op: 'simulation', value: 180 });
  assert.equal((await bridge.api('/api/info', 'GET')).version, '1.0.0-dev');
  let frame;
  const stop = bridge.subscribeTelemetry((value) => { frame = value; });
  bridge.receiveStatus({ source: 'power', state: 'RECEIVING_POWER', connected: true,
    data: true, value: 182, zone: 0, color: '#123456', sim: false });
  assert.equal(frame.zoneName, 'Steady');
  assert.equal(frame.smoothed, 182);
  stop();
  const frameWindow = { parent: { HubBleBridge: bridge }, fetch: () => { throw new Error('Network fetch used'); } };
  const frameDocument = { addEventListener: () => {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'ble_web_api.js'), 'utf8'),
    { window: frameWindow, document: frameDocument, Response, DOMException, Promise, setTimeout });
  const infoResponse = await frameWindow.fetch('/api/info');
  assert.equal((await infoResponse.json()).buildId, 'test');
  const readbackBridge = vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, 'ble_web_host.js'), 'utf8') + '\nHubBleBridge;',
    { TextEncoder, Promise, setTimeout, clearTimeout, console }
  );
  readbackBridge.configure({ command: async (raw) => {
    const request = JSON.parse(raw);
    return JSON.stringify({ v: 1, id: request.id, ok: true, version: 'readback' });
  } });
  readbackBridge.setConnected(true);
  assert.equal((await readbackBridge.api('/api/info', 'GET')).version, 'readback');
  readbackBridge.setConnected(false);
  let missingBridgeNotice;
  const missingBridgeDocument = {
    body: { appendChild: (element) => { missingBridgeNotice = element; } },
    getElementById: () => null,
    createElement: () => ({ setAttribute: () => {}, style: {}, textContent: '' }),
    addEventListener: (event, callback) => { if (event === 'DOMContentLoaded') callback(); },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'ble_web_api.js'), 'utf8'),
    { window: { parent: {} }, document: missingBridgeDocument });
  assert.match(missingBridgeNotice.textContent, /Bluetooth bridge is unavailable/);
  const socket = new frameWindow.WebSocket('ws://localhost/ws');
  await new Promise((resolve) => setTimeout(resolve, 1));
  let message;
  socket.onmessage = (event) => { message = JSON.parse(event.data); };
  bridge.receiveStatus({ source: 'power', state: 'CONNECTED', connected: true,
    data: true, value: 200, zone: 0, color: '#123456', sim: false });
  assert.equal(message.smoothed, 200);
  socket.close();
  await assert.rejects(bridge.api('/api/wifi', 'POST', { ssid: 'test' }), /not available/);
  bridge.setConnected(false);
  console.log('PASS: canonical Web UI BLE bridge routes config, zones, telemetry and commands');
})().catch((error) => { console.error(error); process.exitCode = 1; });

