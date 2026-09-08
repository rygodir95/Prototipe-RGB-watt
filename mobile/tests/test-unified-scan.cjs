// ZoneGlow firmware - unified BLE discovery scan contract.
//
// Guards the architecture change "one Scan discovers BOTH sensor categories":
//   * POST /api/scan starts ONE finite unified scan regardless of the active
//     control source (no controlSource branch in the handler),
//   * exactly ONE advertised-device callback registration owner exists in
//     the whole firmware (BleScanRouter) - the drivers no longer overwrite
//     each other's callbacks on the shared NimBLEScan instance,
//   * the router refuses re-entry and hands NimBLE exactly one timed scan,
//   * GET /api/devices returns BOTH the Power and Heart Rate result sets
//     (merged) with the category values the UI filters on, and its scanning
//     flag comes from the router,
//   * the 6 s scan duration is preserved,
//   * no update()/loop path anywhere can restart a scan (finite lifecycle).
//
// Run: node mobile/tests/test-unified-scan.cjs

"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..");
const FW = path.join(ROOT, "src", "firmware");
const SRC = {
  router:  fs.readFileSync(path.join(FW, "src", "BleScanRouter.cpp"), "utf-8"),
  routerH: fs.readFileSync(path.join(FW, "include", "BleScanRouter.h"), "utf-8"),
  ble:     fs.readFileSync(path.join(FW, "src", "BLEPower.cpp"), "utf-8"),
  hr:      fs.readFileSync(path.join(FW, "src", "HRSensor.cpp"), "utf-8"),
  web:     fs.readFileSync(path.join(FW, "src", "WebInterface.cpp"), "utf-8"),
  main:    fs.readFileSync(path.join(FW, "src", "main.cpp"), "utf-8"),
};

let failures = 0;
let count = 0;
function assert(cond, msg) {
  count++;
  if (cond) console.log("  ok   - " + msg);
  else { failures++; console.error("  FAIL - " + msg); }
}

function bodyOf(src, signature) {
  const start = src.indexOf(signature);
  if (start === -1) return null;
  const open = src.indexOf("{", start);
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return null;
}

function main() {
  console.log("firmware unified BLE scan contract");

  // ---- /api/scan: one unified scan, no controlSource branch ----
  console.log("  -- POST /api/scan --");
  const scanStart = SRC.web.indexOf('server.on("/api/scan"');
  const scanEnd = SRC.web.indexOf('server.on("/api/devices"');
  assert(scanStart !== -1 && scanEnd > scanStart, "firmware has the /api/scan handler");
  const scanRegion = SRC.web.slice(scanStart, scanEnd);
  assert(/bleScan\.startScan\(6\);/.test(scanRegion),
    "an explicit Scan starts exactly ONE unified router scan");
  assert((scanRegion.match(/startScan/g) || []).length === 1,
    "the /api/scan handler triggers no extra scans");
  assert(scanRegion.indexOf("controlSource") === -1 &&
         scanRegion.indexOf("SRC_HEART_RATE") === -1,
    "the /api/scan handler has NO controlSource branch (discovery is mode-independent)");

  // ---- single callback owner on the shared NimBLEScan instance ----
  console.log("  -- callback ownership --");
  const allCpp = ["router", "ble", "hr", "web", "main"].map((k) => SRC[k]).join("\n");
  const cbHits = allCpp.match(/setAdvertisedDeviceCallbacks/g) || [];
  assert(cbHits.length === 1,
    "exactly ONE advertised-device callback registration in the firmware (got " + cbHits.length + ")");
  assert(SRC.router.includes("s->setAdvertisedDeviceCallbacks(&g_routerScanCB, false);"),
    "the single registration lives in BleScanRouter (the scan owner)");
  assert(["ble", "hr", "web", "main"].every((k) => SRC[k].indexOf("setAdvertisedDeviceCallbacks") === -1),
    "neither driver nor the web layer registers scan callbacks any more");
  assert((allCpp.match(/:\s*public NimBLEAdvertisedDeviceCallbacks/g) || []).length === 1 &&
         /:\s*public NimBLEAdvertisedDeviceCallbacks/.test(SRC.router),
    "the only NimBLEAdvertisedDeviceCallbacks subclass is the router's");
  const getScanFiles = ["ble", "hr", "web", "main"].filter((k) => SRC[k].indexOf("NimBLEDevice::getScan") !== -1);
  assert(getScanFiles.length === 0,
    "only the router touches the shared NimBLEScan object (getScan)");

  // ---- router: one finite timed scan, no restarts ----
  console.log("  -- BleScanRouter lifecycle --");
  const rStart = bodyOf(SRC.router, "void BleScanRouter::startScan(int seconds)");
  assert(!!rStart, "router startScan present");
  assert(/if \(_scanning\) return;/.test(rStart),
    "router startScan refuses to restart while a scan is running");
  assert((rStart.match(/s->start\(seconds, routerScanCompleteCB, false\)/g) || []).length === 1,
    "router startScan hands NimBLE exactly one timed scan");
  assert(/_scanning = true;/.test(rStart), "router startScan marks scanning active");
  assert(/if \(!_scanning\) return;/.test(bodyOf(SRC.router, "void BleScanRouter::onScanEnd()") || ""),
    "router onScanEnd guards against a double fan-out (stop() may fire it too)");
  assert(/_scanning = false;/.test(bodyOf(SRC.router, "void BleScanRouter::onScanEnd()") || ""),
    "router onScanEnd clears the scanning state");
  assert((SRC.router.match(/startScan\s*\(/g) || []).length === 1,
    "the router contains only its own startScan definition - it never calls/restarts a scan");
  assert(!/void (update|loop)\(/.test(SRC.router) && !/void (update|loop)\(/.test(SRC.routerH),
    "the router has no update()/loop() that could ever restart scanning");

  // ---- router routes EVERY advertiser to both drivers ----
  const rResult = bodyOf(SRC.router, "void BleScanRouter::onScanResult(NimBLEAdvertisedDevice *dev)");
  assert(!!rResult, "router onScanResult present");
  assert(rResult.includes("_power->onScanResult(dev);") && rResult.includes("_hr->onScanResult(dev);"),
    "router forwards every advertiser to BOTH drivers");
  assert(rResult.indexOf("isAdvertisingService") === -1,
    "the router itself never classifies (gates stay inside the drivers)");

  // ---- /api/devices: both result sets merged ----
  console.log("  -- GET /api/devices --");
  const devStart = SRC.web.indexOf('server.on("/api/devices"');
  const devEnd = SRC.web.indexOf('attachJsonPost("/api/connect"');
  assert(devStart !== -1 && devEnd > devStart, "firmware has the /api/devices handler");
  const devRegion = SRC.web.slice(devStart, devEnd);
  assert(/ble\.getDevices\(\)/.test(devRegion) && /hrBle\.getDevices\(\)/.test(devRegion),
    "/api/devices merges the Power AND Heart Rate result sets");
  assert(/doc\["scanning"\] = bleScan\.isScanning\(\);/.test(devRegion),
    "the scanning flag reflects the unified scan");
  assert(/o\["category"\]\s*=\s*"power";/.test(devRegion) &&
         /o\["category"\]\s*=\s*"hr";/.test(devRegion),
    "/api/devices still tags categories (power / hr) for the UI");
  assert(devRegion.indexOf("g_config.controlSource == SRC_HEART_RATE") === -1,
    "/api/devices no longer branches on the active control source");

  // ---- drivers delegate scanning to the router ----
  console.log("  -- driver delegation --");
  for (const [label, src, cls] of [["BLEPower", SRC.ble, "BLEPower"], ["HRSensor", SRC.hr, "HRSensor"]]) {
    const s = bodyOf(src, "void " + cls + "::startScan(int seconds)");
    assert(!!s, label + "::startScan present");
    assert(s.includes("BleScanRouter::unifiedScan(seconds);"),
      label + "::startScan delegates to the unified router scan");
    assert(s.indexOf("setActiveScan") === -1 && s.indexOf("setAdvertisedDeviceCallbacks") === -1 &&
           s.indexOf("clearResults") === -1 && !/s->start\(/.test(s),
      label + "::startScan touches no NimBLE scan API");
    const upd = bodyOf(src, "void " + cls + "::update()");
    assert(!!upd && !/startScan\s*\(/.test(upd),
      label + "::update() still cannot start a scan");
  }

  // ---- wiring + duration ----
  console.log("  -- wiring + duration --");
  assert(SRC.main.includes("BleScanRouter  bleScan;") &&
         SRC.main.includes("bleScan.begin(&ble, &hrBle);"),
    "main.cpp owns and wires the router exactly once");
  assert(SRC.routerH.includes("void startScan(int seconds = 6);"),
    "the 6 s unified scan duration is preserved");

  console.log("");
  console.log(failures === 0
    ? "ALL " + count + " CHECKS PASSED"
    : failures + " / " + count + " CHECKS FAILED");
  process.exit(failures === 0 ? 0 : 1);
}

main();