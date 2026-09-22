// Regression guard for the local BLE Lighting Test command. The command must
// advance through configured zone values instead of leaving the strip at its
// initial Z1 (white) value.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '../src/HubBleLink.cpp'), 'utf8');
assert.match(source, /void HubBleLink::advanceLightingTest\(\)/);
assert.match(source, /_lightingTestStep\+\+ % count/);
assert.match(source, /sim\.patch\(hr, true, true, true, value, true, true\)/);
assert.match(source, /if \(command\.enabled\) \{\s*advanceLightingTest\(\);/);
assert.match(source, /advanceLightingTest\(\);\s*if \(millis\(\) - _lastStatus/);
assert.match(source, /"config_read"/);
assert.match(source, /"config_write"/);
assert.match(source, /"zone_write"/);
assert.match(source, /"zone_begin"/);
assert.match(source, /"zone_stage"/);
assert.match(source, /"zone_commit"/);
assert.match(source, /_stageMask != static_cast<uint8_t>\(\(1u << _stageExpected\) - 1u\)/);
assert.match(source, /strcmp\(source, "power"\) != 0 && strcmp\(source, "hr"\) != 0/);
assert.match(source, /zone\["color"\]/);
assert.match(source, /"sensor_connect"/);
assert.match(source, /"devices_read"/);
assert.match(source, /"factory_reset"/);
assert.match(source, /scheduleRuntimeConfig\(g_config\)/);
for (const client of ['../desktop/src/shell.js', '../../../mobile/capacitor/www/shell.js']) {
  const ui = fs.readFileSync(path.join(__dirname, client), 'utf8');
  assert.match(ui, /op: "zone_write"/);
  assert.match(ui, /renderBleZones\(config\)|renderBleZones\(data\)/);
}
console.log('PASS: BLE Lighting Test, configuration, zone editing, sensor management and reset commands are available');

