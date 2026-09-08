// ZoneGlow firmware - control-source teardown-settle gate regression.
//
// Root-cause guard for the hardware-confirmed source-switch connection
// failure: a category switch (connected HR -> connect a Power device) tore
// down the old source's BLE connection and started the new driver's connect
// attempt milliseconds later, while NimBLE's ASYNCHRONOUS disconnect had
// not completed yet. With CONFIG_BT_NIMBLE_MAX_CONNECTIONS=1 the old link
// still occupied the only connection slot, so the new attempt failed
// deterministically:
//   E NimBLEClient: Failed to connect to <addr>, rc=6;   (BLE_HS_ENOMEM)
//   I NimBLEClient: disconnect; reason=534;              (HCI 0x16, local host)
//   [HR] Disconnected                                    (AFTER the failure)
//
// The fix (source-contract pins, same approach as test-scan-lifecycle.cjs):
//   * a shared teardown-settle coordinator in AppState - setControlSource()
//     registers the OLD module's NimBLE link probe when its link was still
//     active (captured BEFORE shutdown()),
//   * both drivers expose isLinkActive() backed by NimBLEClient::
//     isConnected() (never the driver's _connected flag, which disconnect()
//     clears synchronously and therefore cannot see the terminate window),
//   * both one-shot connect executors hold their single pending attempt -
//     WITHOUT consuming _doConnect - until the old link is actually gone,
//   * no blocking anywhere in the switch path, update() still never starts
//     a scan, and one Connect action still produces exactly one attempt,
//   * direct same-category connects and switches with an already
//     disconnected old source stay immediate (gate open, nothing registered),
//   * simulator parity: switch_source captures the old link before the
//     teardown and the connect executors mirror the same hold semantics.
//
// Run: node mobile/tests/test-source-switch-settle.cjs

"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..");
const FW = path.join(ROOT, "src", "firmware");
const SRC = {
  ble: fs.readFileSync(path.join(FW, "src", "BLEPower.cpp"), "utf-8"),
  hr: fs.readFileSync(path.join(FW, "src", "HRSensor.cpp"), "utf-8"),
  bleHeader: fs.readFileSync(path.join(FW, "include", "BLEPower.h"), "utf-8"),
  hrHeader: fs.readFileSync(path.join(FW, "include", "HRSensor.h"), "utf-8"),
  appStateH: fs.readFileSync(path.join(FW, "include", "AppState.h"), "utf-8"),
  appStateCpp: fs.readFileSync(path.join(FW, "src", "AppState.cpp"), "utf-8"),
  main: fs.readFileSync(path.join(FW, "src", "main.cpp"), "utf-8"),
  web: fs.readFileSync(path.join(FW, "src", "WebInterface.cpp"), "utf-8"),
  pio: fs.readFileSync(path.join(FW, "platformio.ini"), "utf-8"),
  simulator: fs.readFileSync(path.join(FW, "tools", "pc-simulator", "simulator.py"), "utf-8"),
};

let failures = 0;
let count = 0;
function assert(cond, msg) {
  count++;
  if (cond) console.log("  ok   - " + msg);
  else { failures++; console.error("  FAIL - " + msg); }
}

// Extract a full C++ function (brace-balanced) starting at `signature`.
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

function main() {
  console.log("control-source teardown-settle gate (source-contract guards)");

  // ---- 1. shared coordinator lives in AppState ----
  console.log("  -- AppState coordinator --");
  assert(SRC.appStateH.includes("typedef bool (*LinkProbe)();"),
    "AppState declares the LinkProbe type");
  assert(SRC.appStateH.includes("void bleNoteTeardown(LinkProbe probe);") &&
         SRC.appStateH.includes("bool bleTeardownSettling();"),
    "AppState declares the teardown-settle coordinator API");
  const settling = bodyOf(SRC.appStateCpp, "bool bleTeardownSettling()");
  assert(!!settling, "AppState implements bleTeardownSettling()");
  assert(settling.text.includes("if (!probe) return false;"),
    "the gate is OPEN without a registration (direct connects stay immediate)");
  assert(/if \(probe\(\) && millis\(\) - started < BLE_TEARDOWN_TIMEOUT_MS\) return true;/.test(settling.text),
    "the gate holds ONLY while the old module's live link is still connected");
  assert(settling.text.indexOf("s_teardownProbe = nullptr;") >
         settling.text.indexOf("probe()"),
    "the gate clears its registration once the old link is gone (self-disarming)");
  assert(SRC.appStateCpp.includes("BLE_TEARDOWN_TIMEOUT_MS = 5000"),
    "bounded non-blocking timeout fallback prevents a permanent gate");
  assert(!/delay\s*\(|vTaskDelay/.test(SRC.appStateCpp),
    "AppState never blocks (no delay()/vTaskDelay)");

  // ---- 2. both drivers expose isLinkActive() backed by NimBLE ----
  console.log("  -- drivers: isLinkActive --");
  for (const [label, src, header, cls] of [
    ["BLEPower", SRC.ble, SRC.bleHeader, "BLEPower"],
    ["HRSensor", SRC.hr, SRC.hrHeader, "HRSensor"],
  ]) {
    assert(header.includes("bool isLinkActive() const;"),
      label + " declares isLinkActive() const");
    const def = bodyOf(src, "bool " + cls + "::isLinkActive() const");
    assert(!!def, label + " defines isLinkActive()");
    assert(/return _client && _client->isConnected\(\);/.test(def.text),
      label + "::isLinkActive() reads the underlying NimBLEClient state");
    // Strip // comments first: the doc comment mentions _connected by design;
    // the CODE must not read the flag.
    const defCode = def.text.replace(/\/\/[^\n]*/g, "");
    assert(!/\b_connected\b/.test(defCode),
      label + "::isLinkActive() code does NOT use the driver's _connected flag");
  }

  // ---- 3. setControlSource: capture before teardown, register conditionally
  console.log("  -- setControlSource --");
  const scs = bodyOf(SRC.main, "void setControlSource(uint8_t src, bool restore)");
  assert(!!scs, "setControlSource present");
  for (const [mod, shut] of [["hrBle", "hrBle.shutdown()"], ["ble", "ble.shutdown()"]]) {
    const cap = scs.text.indexOf(mod + ".isLinkActive()");
    const sh = scs.text.indexOf(shut);
    assert(cap !== -1 && sh !== -1 && cap < sh,
      "old " + mod + " link state captured BEFORE shutdown()");
  }
  assert((scs.text.match(/bleNoteTeardown\(/g) || []).length === 2,
    "both switch branches can register a pending teardown");
  assert(/if \(oldLinkUp\) bleNoteTeardown/.test(scs.text),
    "registration happens ONLY when the old link was active");
  assert(scs.text.includes("g_config.controlSource = src;") &&
         scs.text.includes("storage.save(g_config);"),
    "existing switch behavior and persistence preserved");
  assert(!/delay\s*\(|vTaskDelay/.test(scs.text),
    "setControlSource never blocks");

  // ---- 4. both update() paths gate the one-shot connect executor ----
  console.log("  -- drivers: update() gate --");
  for (const [label, src, cls] of [
    ["BLEPower", SRC.ble, "BLEPower"],
    ["HRSensor", SRC.hr, "HRSensor"],
  ]) {
    const update = bodyOf(src, "void " + cls + "::update()");
    assert(!!update, label + "::update() present");
    const gate = update.text.indexOf("if (bleTeardownSettling()) return;");
    const consume = update.text.indexOf("_doConnect = false;");
    assert(gate !== -1,
      label + "::update() gates the connect executor on the settle check");
    assert(consume !== -1 && gate < consume,
      label + ": _doConnect is NOT cleared while teardown is settling (held, not lost)");
    assert((update.text.match(/_doConnect = false;/g) || []).length === 1,
      label + ": _doConnect is consumed exactly once (one action -> one attempt)");
    assert(!/startScan\s*\(/.test(update.text),
      label + "::update() still never starts a scan");
    assert(!/delay\s*\(|vTaskDelay/.test(update.text),
      label + "::update() never blocks");
  }

  // ---- 5. immediacy preserved where no teardown is pending ----
  console.log("  -- immediacy --");
  const cStart = SRC.web.indexOf('attachJsonPost("/api/connect"');
  const cEnd = SRC.web.indexOf('server.on("/api/disconnect"');
  const connect = SRC.web.slice(cStart, cEnd);
  assert(connect.includes("if (target != g_config.controlSource) setControlSource(target, false);"),
    "same-category connects skip the switch (and therefore the gate) entirely");
  assert(SRC.pio.includes("CONFIG_BT_NIMBLE_MAX_CONNECTIONS=1"),
    "CONFIG_BT_NIMBLE_MAX_CONNECTIONS untouched (still 1)");

  // ---- 6. simulator parity ----
  console.log("  -- simulator parity --");
  assert(SRC.simulator.includes("TEARDOWN_SETTLE_S"),
    "simulator models the asynchronous terminate window");
  const swStart = SRC.simulator.indexOf("def switch_source");
  const swEnd = SRC.simulator.indexOf("def teardown_settling");
  assert(swStart !== -1 && swEnd > swStart,
    "simulator has switch_source + teardown_settling");
  const sw = SRC.simulator.slice(swStart, swEnd);
  const capIdx = sw.indexOf("old_link = self.hr_connected");
  const shutIdx = sw.indexOf("self.hr_shutdown()");
  assert(capIdx !== -1 && shutIdx > capIdx,
    "simulator captures the old link state BEFORE the old-module shutdown");
  assert(sw.indexOf("if old_link:") !== -1,
    "simulator registers a pending teardown ONLY when the old link was connected");
  const gatePower = SRC.simulator.slice(SRC.simulator.indexOf("def _start_connecting"),
                                        SRC.simulator.indexOf("def disconnect"));
  assert(gatePower.indexOf("if self.teardown_settling(now):") !== -1 &&
         gatePower.indexOf("self._connect_pending = True") !== -1,
    "simulator power connect holds the ONE pending attempt behind the gate");
  const gateHr = SRC.simulator.slice(SRC.simulator.indexOf("def _hr_start_connecting"),
                                     SRC.simulator.indexOf("def hr_disconnect"));
  assert(gateHr.indexOf("if self.teardown_settling(now):") !== -1 &&
         gateHr.indexOf("self._hr_connect_pending = True") !== -1,
    "simulator HR connect path mirrors the same gate");
  const bleShutdown = SRC.simulator.slice(SRC.simulator.indexOf("def ble_shutdown"),
                                          SRC.simulator.indexOf("def hr_shutdown"));
  assert(bleShutdown.includes("self._connect_pending = False"),
    "simulator module teardown clears a held attempt (firmware shutdown parity)");

  console.log("");
  console.log(failures === 0
    ? "ALL " + count + " CHECKS PASSED"
    : failures + " / " + count + " CHECKS FAILED");
  process.exit(failures === 0 ? 0 : 1);
}

main();