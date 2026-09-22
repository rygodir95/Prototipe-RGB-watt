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
console.log('PASS: BLE Lighting Test advances through configured zone values');

