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
assert.match(source, /"sensor_connect"/);
assert.match(source, /"devices_read"/);
assert.match(source, /"factory_reset"/);
assert.match(source, /scheduleRuntimeConfig\(g_config\)/);
console.log('PASS: BLE Lighting Test, configuration, sensor management and reset commands are available');

