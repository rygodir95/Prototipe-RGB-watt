// ZoneGlow firmware - automatic control-source switching contract.
//
// Guards the plug-and-play control-source behaviour:
//   * /api/connect derives the target source from the selected device's
//     CATEGORY (power -> SRC_POWER, hr -> SRC_HEART_RATE),
//   * older clients that omit the category fall back to the discovered
//     device lists (address lookup in BOTH drivers' results),
//   * a category change uses setControlSource(target, false) - the existing
//     teardown - and only when the source actually differs,
//   * the saved source address/name is persisted and the right driver
//     connects,
//   * POST /api/config can no longer switch the source: applyConfigPatch
//     never touches controlSource (a supplied field is accepted + ignored),
//   * the web UI has NO manual selector: no sourceSeg in the Settings HTML,
//     no initSourceSeg / postConfig({controlSource...}) in app.js, and the
//     onboarding wizard has no source-selection step (read-only status
//     display keeps working off config.controlSource),
//   * simulator parity: /api/connect stays category-driven and /api/config
//     ignores controlSource there too.
//
// Run: node mobile/tests/test-connect-source-switch.cjs

"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..");
const FW = path.join(ROOT, "src", "firmware");
const WEB_CPP   = fs.readFileSync(path.join(FW, "src", "WebInterface.cpp"), "utf-8");
const WEB_H     = fs.readFileSync(path.join(FW, "include", "WebInterface.h"), "utf-8");
const MAIN_CPP  = fs.readFileSync(path.join(FW, "src", "main.cpp"), "utf-8");
const APP_JS    = fs.readFileSync(path.join(FW, "data", "web", "app.js"), "utf-8");
const INDEX_HTML = fs.readFileSync(path.join(FW, "data", "web", "index.html"), "utf-8");
const SIMULATOR = fs.readFileSync(path.join(FW, "tools", "pc-simulator", "simulator.py"), "utf-8");

let failures = 0;
let count = 0;
function assert(cond, msg) {
  count++;
  if (cond) console.log("  ok   - " + msg);
  else { failures++; console.error("  FAIL - " + msg); }
}

function main() {
  console.log("firmware automatic control-source switching contract");

  // ---- /api/connect: category drives the target source ----
  console.log("  -- POST /api/connect --");
  const cStart = WEB_CPP.indexOf('attachJsonPost("/api/connect"');
  const cEnd = WEB_CPP.indexOf('server.on("/api/disconnect"');
  assert(cStart !== -1 && cEnd > cStart, "firmware has the /api/connect handler");
  const connect = WEB_CPP.slice(cStart, cEnd);
  assert(/strcmp\(cat, "hr"\) == 0/.test(connect) && connect.includes("target = SRC_HEART_RATE;"),
    "category hr selects the Heart Rate source");
  assert(/strcmp\(cat, "power"\) == 0/.test(connect) && connect.includes("target = SRC_POWER;"),
    "category power selects the Power source");
  assert(/for \(auto &d : ble\.getDevices\(\)\)/.test(connect) &&
         /for \(auto &d : hrBle\.getDevices\(\)\)/.test(connect),
    "older clients without category fall back to the discovered device lists");
  assert(connect.includes("if (target != g_config.controlSource) setControlSource(target, false);"),
    "a category change switches via the existing teardown (setControlSource, no auto-restore)");
  assert((connect.match(/setControlSource\s*\(/g) || []).length === 1,
    "the switch happens exactly once and only when the source differs");
  assert(connect.includes("g_config.hrSourceAddr") && connect.includes("hrBle.connectToAddress(addr, name);"),
    "HR connect persists the saved source and connects through HRSensor");
  assert(connect.includes("g_config.sourceAddr") && connect.includes("ble.connectToAddress(addr, name);"),
    "Power connect persists the saved source and connects through BLEPower");

  // ---- POST /api/config: manual switching removed, field accepted ----
  console.log("  -- POST /api/config --");
  const pStart = WEB_CPP.indexOf("static void applyConfigPatch(JsonDocument &doc)");
  const pEnd = WEB_CPP.indexOf("// Generic JSON body accumulator");
  assert(pStart !== -1 && pEnd > pStart, "applyConfigPatch present");
  const patch = WEB_CPP.slice(pStart, pEnd);
  assert(patch.indexOf("setControlSource(") === -1,
    "applyConfigPatch can no longer switch the control source");
  assert(patch.indexOf('doc["controlSource"]') === -1,
    "applyConfigPatch never reads the controlSource field (a supplied field is ignored)");

  // ---- setControlSource: restore=false hook for explicit connects ----
  assert(MAIN_CPP.includes("void setControlSource(uint8_t src, bool restore)") &&
         MAIN_CPP.includes("if (restore && g_config.autoReconnect)"),
    "setControlSource supports restore=false (explicit connect follows the switch)");
  assert(WEB_H.includes("void setControlSource(uint8_t src, bool restore = true);"),
    "the restore default keeps boot/other callers unchanged");

  // ---- web UI: no manual selector, read-only status kept ----
  console.log("  -- web UI --");
  assert(INDEX_HTML.indexOf("sourceSeg") === -1 && INDEX_HTML.indexOf("LED Control") === -1,
    "Settings has no manual LED Control selector");
  assert(APP_JS.indexOf("initSourceSeg") === -1 && APP_JS.indexOf("sourceSeg") === -1,
    "the manual source-segment code is gone from app.js");
  assert(!/postConfig\(\{\s*controlSource/.test(APP_JS),
    "app.js never POSTs a controlSource patch any more");
  assert(APP_JS.indexOf("Select control source") === -1,
    "onboarding no longer asks for a manual source selection");
  assert(/isHrMode\(\)/.test(APP_JS) && APP_JS.indexOf('tMode = t.mode || (config && config.controlSource)') !== -1,
    "the UI still READS controlSource for units/zones/state (read-only)");
  const ob = APP_JS.slice(APP_JS.indexOf('} else if (s === 3) {'), APP_JS.indexOf("async function obScan"));
  assert(ob.indexOf("Configure zones") !== -1,
    "onboarding renumbered: the zones step directly follows the sensor step");

  // ---- simulator parity ----
  console.log("  -- simulator parity --");
  const simConnect = SIMULATOR.slice(SIMULATOR.indexOf('if path == "/api/connect"'),
                                      SIMULATOR.indexOf('if path == "/api/disconnect"'));
  assert(simConnect.includes("doc.get(\"category\")") && simConnect.includes("sim.connect_device"),
    "simulator /api/connect stays category-driven");
  const simCfg = SIMULATOR.slice(SIMULATOR.indexOf('if path == "/api/config"'),
                                  SIMULATOR.indexOf('if path == "/api/scan"'));
  assert(simCfg.includes("doc.pop(\"controlSource\", None)") && simCfg.indexOf("switch_source(") === -1,
    "simulator /api/config ignores controlSource exactly like the firmware");

  // ---- simulator parity: teardown-settle gate on category switches ----
  console.log("  -- simulator settle-gate parity --");
  assert(SIMULATOR.indexOf("def teardown_settling") !== -1 &&
         SIMULATOR.indexOf("TEARDOWN_SETTLE_S") !== -1,
    "simulator models the teardown-settle gate (async old-link terminate)");
  const sw = SIMULATOR.slice(SIMULATOR.indexOf("def switch_source"),
                             SIMULATOR.indexOf("def teardown_settling"));
  const capIdx = sw.indexOf("old_link = self.hr_connected");
  const shutIdx = sw.indexOf("self.hr_shutdown()");
  assert(capIdx !== -1 && shutIdx > capIdx,
    "simulator switch_source captures the old link state BEFORE the teardown");
  assert(sw.indexOf("if old_link:") !== -1,
    "simulator registers a pending teardown only when the old link was connected");

  console.log("");
  console.log(failures === 0
    ? "ALL " + count + " CHECKS PASSED"
    : failures + " / " + count + " CHECKS FAILED");
  process.exit(failures === 0 ? 0 : 1);
}

main();