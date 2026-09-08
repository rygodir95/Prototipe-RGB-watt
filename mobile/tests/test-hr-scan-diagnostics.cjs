// ZoneGlow hub firmware - HR scan diagnostics regression.
//
// Guards the dev-only per-advertiser diagnostic dump for the Wahoo ELEMNT
// RIVAL investigation, now hosted in HRSensor::onScanResult() (the unified
// BleScanRouter forwards EVERY advertiser of the one physical scan):
//   * classification gate (isAdvertisingService(0x180D)) unchanged and still
//     the single early return,
//   * the dump runs BEFORE the gate, for every advertiser of the unified
//     scan regardless of the active control source, only while scanning,
//   * it is gated to BUILD_DEV (production binaries carry no diag strings),
//   * it logs address, RSSI, connectable, name, service UUIDs, manufacturer
//     data, service data (with UUIDs) and the raw payload (NimBLE 1.4.x API),
//   * scan start/timing/duration (owned by BleScanRouter) and
//     connect/subscribe logic unchanged,
//   * BLEPower untouched by the diagnostics.
//
// Run: node mobile/tests/test-hr-scan-diagnostics.cjs

"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..");
const FW = path.join(ROOT, "src", "firmware");
const HR_CPP = fs.readFileSync(path.join(FW, "src", "HRSensor.cpp"), "utf-8");
const HR_H = fs.readFileSync(path.join(FW, "include", "HRSensor.h"), "utf-8");
const ROUTER_CPP = fs.readFileSync(path.join(FW, "src", "BleScanRouter.cpp"), "utf-8");
const BLEPOWER_CPP = fs.readFileSync(path.join(FW, "src", "BLEPower.cpp"), "utf-8");

let failures = 0;
let count = 0;
function assert(cond, msg) {
  count++;
  if (cond) { console.log("  ok   - " + msg); }
  else { failures++; console.error("  FAIL - " + msg); }
}

const GATE = "if (!dev->isAdvertisingService(HRS_SERVICE)) return;";
const onResultStart = HR_CPP.indexOf("void HRSensor::onScanResult(NimBLEAdvertisedDevice *dev) {");
const gatePos = HR_CPP.indexOf(GATE);
const dumpPos = HR_CPP.indexOf("hrLogAdvertiser(dev);");

function main() {
  console.log("HR scan diagnostics contract");

  // ---- classification gate unchanged, now inside the driver method ----
  assert(HR_CPP.indexOf(GATE) !== -1, "0x180D gate line intact");
  assert((HR_CPP.match(/isAdvertisingService\(/g) || []).length === 1,
    "exactly one isAdvertisingService call (no extra filtering added)");
  assert(gatePos > onResultStart && onResultStart !== -1, "gate lives in HRSensor::onScanResult");

  // ---- dump position: before the gate, inside onScanResult ----
  assert(dumpPos !== -1 && dumpPos > onResultStart && dumpPos < gatePos,
    "diag dump executes BEFORE the HRS classification gate");

  // ---- dev-build only ----
  assert(HR_CPP.includes("#if defined(BUILD_DEV)"),
    "diagnostics compiled only in dev builds (BUILD_DEV)");

  // ---- only while a scan is active ----
  assert(/isScanning\(\)\) \{[\s\S]{0,120}?g_hrAdvSeen\+\+/.test(HR_CPP),
    "dump + counter guarded by an active scan (isScanning)");

  // ---- every advertiser of the unified scan reaches the dump ----
  const fwd = ROUTER_CPP.indexOf("void BleScanRouter::onScanResult(NimBLEAdvertisedDevice *dev)");
  assert(fwd !== -1 &&
         ROUTER_CPP.indexOf("_hr->onScanResult(dev);") > fwd &&
         ROUTER_CPP.indexOf("_hr->onScanResult(dev);") < ROUTER_CPP.indexOf("}", ROUTER_CPP.lastIndexOf("_power->onScanResult(dev);")),
    "the router forwards every advertiser to the HR dump path (mode-independent)");

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
    "counters reset at scan start (onScanStart)");
  assert(HR_CPP.indexOf("onScanStart") !== -1 &&
         HR_CPP.indexOf("g_hrAdvSeen = 0;") > HR_CPP.indexOf("void HRSensor::onScanStart()"),
    "counter reset lives in the scan preparation hook");
  assert(HR_CPP.includes("matchedHRS=") &&
         HR_CPP.indexOf("scan end: advertisers=") < HR_CPP.indexOf("[HR] Scan complete"),
    "scan end logs observed advertisers + matched HRS count");
  const matchedPos = HR_CPP.indexOf("g_hrAdvMatched++;", gatePos);
  assert(matchedPos !== -1 && matchedPos < gatePos + 200 &&
         matchedPos > gatePos,
    "match counter increments only after the gate passes (classified devices)");

  // ---- no behavior change ----
  assert(HR_H.includes("void startScan(int seconds = 6);"), "scan duration default unchanged (6 s)");
  assert(ROUTER_CPP.includes("s->start(seconds, routerScanCompleteCB, false);"),
    "scan start invocation unchanged (single owner: the router)");
  assert(ROUTER_CPP.includes("s->setInterval(100);") && ROUTER_CPP.includes("s->setWindow(99);") &&
         ROUTER_CPP.includes("s->setActiveScan(true);"),
    "scan timing settings unchanged (moved with the scan to the router)");
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