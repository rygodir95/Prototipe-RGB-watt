// ZoneGlow hub firmware - HR scan diagnostics regression.
//
// Guards the dev-only per-advertiser diagnostic dump added to
// HRScanCallbacks::onResult() for the Wahoo ELEMNT RIVAL investigation:
//   * classification gate (isAdvertisingService(0x180D)) unchanged and still
//     the single early return,
//   * the dump runs BEFORE the gate and only during an active HR scan,
//   * it is gated to BUILD_DEV,
//   * it logs address, RSSI, connectable, name, service UUIDs, manufacturer
//     data, service data (with UUIDs) and the raw payload (NimBLE 1.4.x API),
//   * scan start/timing/duration and connect/subscribe logic unchanged,
//   * BLEPower untouched.
//
// Run: node mobile/tests/test-hr-scan-diagnostics.cjs

"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..");
const HR_CPP = fs.readFileSync(path.join(ROOT, "src", "firmware", "src", "HRSensor.cpp"), "utf-8");
const HR_H = fs.readFileSync(path.join(ROOT, "src", "firmware", "include", "HRSensor.h"), "utf-8");
const BLEPOWER_CPP = fs.readFileSync(path.join(ROOT, "src", "firmware", "src", "BLEPower.cpp"), "utf-8");

let failures = 0;
let count = 0;
function assert(cond, msg) {
  count++;
  if (cond) { console.log("  ok   - " + msg); }
  else { failures++; console.error("  FAIL - " + msg); }
}

const GATE = "if (!dev->isAdvertisingService(HRS_SERVICE)) return;";
const onResultStart = HR_CPP.indexOf("void onResult(NimBLEAdvertisedDevice *dev) override {");
const gatePos = HR_CPP.indexOf(GATE);
const dumpPos = HR_CPP.indexOf("hrLogAdvertiser(dev);");

function main() {
  console.log("HR scan diagnostics contract");

  // ---- classification gate unchanged ----
  assert(HR_CPP.indexOf(GATE) !== -1, "0x180D gate line intact");
  assert((HR_CPP.match(/isAdvertisingService\(/g) || []).length === 1,
    "exactly one isAdvertisingService call (no extra filtering added)");
  assert(gatePos > onResultStart && onResultStart !== -1, "gate lives in onResult");

  // ---- dump position: before the gate, inside onResult ----
  assert(dumpPos !== -1 && dumpPos > onResultStart && dumpPos < gatePos,
    "diag dump executes BEFORE the HRS classification gate");

  // ---- dev-build only ----
  assert(HR_CPP.includes("#if defined(BUILD_DEV)"),
    "diagnostics compiled only in dev builds (BUILD_DEV)");

  // ---- only during an active HR scan ----
  assert(/isScanning\(\)\) \{[\s\S]{0,120}?g_hrAdvSeen\+\+/.test(HR_CPP),
    "dump + counter guarded by an active HR scan (isScanning)");

  // ---- logged fields ----
  const DIAG = "[HR][diag]";
  assert(HR_CPP.includes(DIAG + " adv addr=") && /rssi=%d/.test(HR_CPP),
    "logs address and RSSI");
  assert(/connectable=%d/.test(HR_CPP) && HR_CPP.includes("isConnectable()"),
    "logs connectable state (scannable not in NimBLE 1.4.x API - omitted)");
  assert(HR_CPP.includes('"<none>"') && HR_CPP.includes("haveName()"),
    "logs name or <none> for name-less advertisers");
  assert(HR_CPP.includes("getServiceUUIDCount") && HR_CPP.includes("getServiceUUID(i)"),
    "logs advertised service UUID count and every UUID");
  assert(HR_CPP.includes("getManufacturerData") && HR_CPP.includes("haveManufacturerData"),
    "logs manufacturer data (hex)");
  assert(HR_CPP.includes("getServiceDataCount") && HR_CPP.includes("getServiceDataUUID(i)") &&
         HR_CPP.includes("getServiceData(i)"),
    "logs service data hex with associated UUID");
  assert(HR_CPP.includes("getPayload()") && HR_CPP.includes("getPayloadLength()"),
    "logs raw advertisement payload (getPayload/getPayloadLength, NimBLE 1.4.x)");

  // ---- scan-end totals ----
  assert(/g_hrAdvSeen = 0;/.test(HR_CPP) && /g_hrAdvMatched = 0;/.test(HR_CPP),
    "counters reset at scan start");
  assert(HR_CPP.includes("matchedHRS=") &&
         HR_CPP.indexOf("scan end: advertisers=") < HR_CPP.indexOf("[HR] Scan complete"),
    "scan end logs observed advertisers + matched HRS count");
  assert(/g_hrAdvMatched\+\+[\s\S]{0,200}?return;/.test(HR_CPP) === false &&
         /if \(!dev->isAdvertisingService\(HRS_SERVICE\)\) return;[\s\S]{0,40}g_hrAdvMatched\+\+/.test(HR_CPP),
    "match counter increments only after the gate passes (classified devices)");

  // ---- no behavior change ----
  assert(HR_H.includes("void startScan(int seconds = 6);"), "scan duration default unchanged (6 s)");
  assert(HR_CPP.includes("s->start(seconds, hrScanCompleteCB, false);"), "scan start invocation unchanged");
  assert(HR_CPP.includes("s->setInterval(100);") && HR_CPP.includes("s->setWindow(99);") &&
         HR_CPP.includes("s->setActiveScan(true);"), "scan timing settings unchanged");
  assert(HR_CPP.includes("svc->getCharacteristic(HRS_MEASURE)") &&
         HR_CPP.includes("chr->canNotify()) chr->subscribe(true, hrNotifyCB)"),
    "connect/subscription logic untouched");
  assert(HR_CPP.includes("if (bpm == 0 || bpm > 250) return;"), "HR parsing untouched");
  assert(!BLEPOWER_CPP.includes("[HR][diag]"), "BLEPower untouched");

  console.log("");
  console.log(failures === 0 ? "ALL " + count + " CHECKS PASSED" : failures + " / " + count + " CHECKS FAILED");
  process.exit(failures === 0 ? 0 : 1);
}

main();