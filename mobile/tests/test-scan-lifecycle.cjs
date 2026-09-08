// ZoneGlow firmware - BLE scan lifecycle regression.
//
// Root-cause guard for the hardware-confirmed bug: after a failed
// connection attempt the hub kept restarting BLE scans endlessly
// (serial showed "[BLE] Scanning..." / "Scan complete" cycling every
// ~7 s, continuing with every client closed). Root cause: the automatic
// reconnect loop in BLEPower::update() / HRSensor::update() called
// startScan(6) whenever the desired sensor was not connected.
//
// The firmware is C++ and cannot be executed inside this Node suite, so
// this uses the same source-contract approach as the /api/devices
// category guard in test-devices-render.cjs: it pins the exact code
// properties the fix requires, at the real call sites. Since the unified
// BleScanRouter now OWNS the one physical scan, the finiteness contract
// is pinned there (see also test-unified-scan.cjs).
//
// Verifies:
//   1. one explicit Scan = one finite scan (the router guards re-entry
//      and hands NimBLE exactly one timed scan; each driver's onScanEnd
//      clears its _scanning flag),
//   2. a failed Connect settles into DISCONNECTED and schedules nothing,
//   3. update() in BOTH drivers can never start a scan,
//   4. no repeated scan even with autoReconnect=true (the option still
//      exists and is still applied, but nothing consumes it to rescan),
//   5. the only remaining scan call sites are the explicit POST /api/scan
//      handler (unified router scan) and the one finite locate scan of an
//      explicit Connect (connectToAddress), which stops an active scan
//      first via the router,
//   6. an explicit Scan still works again afterwards (no scanning latch
//      outside the router / driver onScanStart),
//   7. telemetry state never lingers on RECONNECTING: neither driver
//      assigns it anymore, and onClientDisconnect / onScanEnd / the
//      failed-connect branch all settle on DISCONNECTED,
//   8. the boot-time saved-source restore path is untouched (it uses the
//      same finite connectToAddress one-shot).
//
// Run: node mobile/tests/test-scan-lifecycle.cjs

"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..");
const FW = path.join(ROOT, "src", "firmware");
const SRC = {
  ble: fs.readFileSync(path.join(FW, "src", "BLEPower.cpp"), "utf-8"),
  hr: fs.readFileSync(path.join(FW, "src", "HRSensor.cpp"), "utf-8"),
  router: fs.readFileSync(path.join(FW, "src", "BleScanRouter.cpp"), "utf-8"),
  web: fs.readFileSync(path.join(FW, "src", "WebInterface.cpp"), "utf-8"),
  main: fs.readFileSync(path.join(FW, "src", "main.cpp"), "utf-8"),
  config: fs.readFileSync(path.join(FW, "src", "Config.cpp"), "utf-8"),
  bleHeader: fs.readFileSync(path.join(FW, "include", "BLEPower.h"), "utf-8"),
  hrHeader: fs.readFileSync(path.join(FW, "include", "HRSensor.h"), "utf-8"),
};

let failures = 0;
let count = 0;
function assert(cond, msg) {
  count++;
  if (cond) console.log("  ok   - " + msg);
  else { failures++; console.error("  FAIL - " + msg); }
}

// Extract a full C++ function (brace-balanced) starting at `signature`.
// Safe for the extracted driver functions: none of their bodies contain
// unbalanced braces inside string literals.
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
      if (depth === 0) return { text: src.slice(start, i + 1), start, end: i + 1 };
    }
  }
  return null;
}

function allIndexes(src, re) {
  const out = [];
  const r = new RegExp(re.source, "g");
  let m;
  while ((m = r.exec(src)) !== null) out.push(m.index);
  return out;
}

function main() {
  console.log("firmware BLE scan lifecycle (source-contract guards)");

  for (const [label, src, cls] of [
    ["BLEPower", SRC.ble, "BLEPower"],
    ["HRSensor", SRC.hr, "HRSensor"],
  ]) {
    console.log("  -- " + label + " --");
    const update = bodyOf(src, "void " + cls + "::update()");
    const startScan = bodyOf(src, "void " + cls + "::startScan(int seconds)");
    const onScanStart = bodyOf(src, "void " + cls + "::onScanStart()");
    const onScanEnd = bodyOf(src, "void " + cls + "::onScanEnd()");
    const connectTo = bodyOf(src, "void " + cls + "::connectToAddress(");
    const onDisc = bodyOf(src, "void " + cls + "::onClientDisconnect()");
    const shutdown = bodyOf(src, "void " + cls + "::shutdown()");
    assert(!!(update && startScan && onScanStart && onScanEnd && connectTo && onDisc && shutdown),
      label + ": update/startScan/onScanStart/onScanEnd/connectToAddress/onClientDisconnect/shutdown all present");

    // (3) update() can never start a scan (covers "no repeated scan even
    //     with autoReconnect=true": the loop that consumed the option is gone)
    assert(!/startScan\s*\(/.test(update.text),
      label + "::update() contains no startScan call (comments included)");
    assert(update.text.indexOf("RECONNECTING") === -1,
      label + "::update() never mentions or sets a reconnecting state");

    // (2) a failed one-shot connect settles, schedules nothing
    assert(update.text.indexOf("g_tel.state = DeviceState::DISCONNECTED;") !== -1,
      label + "::update() failed connect settles into DISCONNECTED");

    // (1) the driver delegates to the router's single finite scan
    assert(/BleScanRouter::unifiedScan\(seconds\);/.test(startScan.text),
      label + "::startScan delegates to the unified router scan");
    assert(startScan.text.indexOf("NimBLEDevice") === -1,
      label + "::startScan never touches the NimBLE scan object directly");
    assert(/_scanning = false;/.test(onScanEnd.text),
      label + "::onScanEnd clears the scanning state");

    // (7) no dangling reconnecting state anywhere
    assert(src.indexOf("DeviceState::RECONNECTING") === -1,
      label + " never assigns DeviceState::RECONNECTING");
    assert(/g_tel\.state = DeviceState::DISCONNECTED;/.test(onDisc.text),
      label + "::onClientDisconnect settles into DISCONNECTED");
    assert(/if \(!_connected\) g_tel\.state = DeviceState::DISCONNECTED;/.test(onScanEnd.text),
      label + "::onScanEnd settles the state once the finite scan is over");

    // (5) connectToAddress: stop any active scan first, exactly one locate scan
    assert(/BleScanRouter::stop\(\);/.test(connectTo.text) &&
           /_scanning = false;/.test(connectTo.text),
      label + "::connectToAddress stops the active unified scan before connecting");
    assert((connectTo.text.match(/startScan\(6\)/g) || []).length === 1,
      label + "::connectToAddress keeps exactly one finite locate scan");
    assert(/_desired\s*=\s*true;/.test(connectTo.text),
      label + "::connectToAddress locate scan is tied to an explicit request only");

    // (6) no scanning latch outside onScanStart -> a later Scan works again
    const latches = allIndexes(src, /_scanning\s*=\s*true;/);
    assert(latches.length === 1 &&
           latches[0] >= onScanStart.start && latches[0] < onScanStart.end,
      label + ": _scanning is only ever set inside onScanStart (invoked by the router)");
    assert(/BleScanRouter::stop\(\);/.test(shutdown.text),
      label + "::shutdown still stops an in-flight scan (via the router)");

    // (2)+(5) failed Connect schedules no scan: the only startScan tokens in
    // the whole driver are the definition and the explicit-connect locate scan
    const defIdx = src.indexOf("void " + cls + "::startScan") + ("void " + cls + "::").length;
    const calls = allIndexes(src, /startScan\s*\(/);
    assert(calls.length === 2,
      label + ": exactly two startScan tokens in the file (definition + locate scan)");
    assert(calls.every((i) =>
      (i >= connectTo.start && i < connectTo.end) || i === defIdx),
      label + ": no scan can be started from anywhere except an explicit request path");
  }

  // ---- the unified router owns the one finite scan ----
  console.log("  -- BleScanRouter --");
  const rStart = bodyOf(SRC.router, "void BleScanRouter::startScan(int seconds)");
  const rEnd = bodyOf(SRC.router, "void BleScanRouter::onScanEnd()");
  assert(!!rStart && !!rEnd, "router startScan/onScanEnd present");
  assert(/if \(_scanning\) return;/.test(rStart.text),
    "router refuses to restart while a scan is running");
  assert((rStart.text.match(/s->start\(seconds, routerScanCompleteCB, false\)/g) || []).length === 1,
    "router hands NimBLE exactly one timed scan");
  assert(/if \(!_scanning\) return;/.test(rEnd.text),
    "router scan-end fans out exactly once (guards NimBLE's synchronous stop callback)");
  assert((SRC.router.match(/startScan\s*\(/g) || []).length === 1,
    "the router never calls startScan itself (nothing can restart a scan from it)");

  // ---- explicit user scan entry point ----
  console.log("  -- POST /api/scan (WebInterface) --");
  const scanStart = SRC.web.indexOf('server.on("/api/scan"');
  const scanEnd = SRC.web.indexOf('server.on("/api/devices"');
  assert(scanStart !== -1 && scanEnd > scanStart, "firmware has the /api/scan handler");
  const scanRegion = SRC.web.slice(scanStart, scanEnd);
  assert(/bleScan\.startScan\(6\);/.test(scanRegion),
    "an explicit Scan request starts exactly ONE unified scan");
  assert((scanRegion.match(/startScan/g) || []).length === 1,
    "the /api/scan handler triggers no extra scans");

  // ---- autoReconnect: option preserved, only the behaviour disabled ----
  console.log("  -- autoReconnect option preserved --");
  assert(/c\.autoReconnect\s*=\s*true;/.test(SRC.config),
    "autoReconnect keeps its stored default (true) in Config.cpp");
  assert(SRC.bleHeader.indexOf("setAutoReconnect") !== -1 &&
         SRC.hrHeader.indexOf("setAutoReconnect") !== -1,
    "both drivers still expose setAutoReconnect (option not removed)");
  assert(/ble\.setAutoReconnect\(g_config\.autoReconnect\);/.test(SRC.main) &&
         /hrBle\.setAutoReconnect\(g_config\.autoReconnect\);/.test(SRC.main),
    "applyRuntimeConfig still applies the option (inert until reconnect is redesigned)");

  // ---- boot restore path untouched (same finite one-shot) ----
  console.log("  -- boot restore path --");
  assert(/ble\.connectToAddress\(g_config\.sourceAddr, g_config\.sourceName\);/.test(SRC.main) &&
         /hrBle\.connectToAddress\(g_config\.hrSourceAddr, g_config\.hrSourceName\);/.test(SRC.main),
    "boot-time saved-source restore still uses the finite one-shot connect");

  console.log("");
  console.log(failures === 0
    ? "ALL " + count + " CHECKS PASSED"
    : failures + " / " + count + " CHECKS FAILED");
  process.exit(failures === 0 ? 0 : 1);
}

main();