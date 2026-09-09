// ZoneGlow firmware - lighting-logic feature contract regression.
//
// Pins the source properties of the lighting-logic feature batch:
//   1. Power hysteresis is FTP-relative (1.5 % of FTP, 0 while FTP is
//      unset); the config.hysteresis field remains an absolute bpm margin
//      used ONLY by the Heart Rate zones.
//   2. Colour interpolation uses a 20 % center plateau: the zone's exact
//      colour across the central 20 % of its span, blending towards the
//      neighbouring zone across the outer 40 % on each side, hitting the
//      exact colour midpoint at each boundary.
//   3. Factory defaults ship with FTP = 0 and Max HR = 0 ("not set"), with
//      safe handling: sanitize keeps 0, /api/config accepts 0, and the first
//      real value regenerates the percentage template instead of scaling
//      the trivial unset boundaries.
//   4. The short Git commit SHA is injected as FW_BUILD_SHA at build time
//      (platformio.ini extra_scripts -> tools/build_id.py), with a local
//      fallback, and is exposed via /api/info as "buildId".
//   5. The PC simulator port (pipeline.py / simulator.py) mirrors 1-3 and
//      the buildId field, and the web UI accepts 0 as "not set".
//
// Run: node mobile/tests/test-lighting-logic.cjs

"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..");
const FW = path.join(ROOT, "src", "firmware");

function read(...parts) {
  return fs.readFileSync(path.join(...parts), "utf-8");
}

const SRC = {
  powerZones: read(FW, "src", "PowerZones.cpp"),
  powerZonesH: read(FW, "include", "PowerZones.h"),
  config: read(FW, "src", "Config.cpp"),
  configH: read(FW, "include", "Config.h"),
  web: read(FW, "src", "WebInterface.cpp"),
  main: read(FW, "src", "main.cpp"),
  fwVersion: read(FW, "include", "FirmwareVersion.h"),
  platformio: read(FW, "platformio.ini"),
  buildId: read(FW, "tools", "build_id.py"),
  pipeline: read(FW, "tools", "pc-simulator", "pipeline.py"),
  simulator: read(FW, "tools", "pc-simulator", "simulator.py"),
  appJs: read(FW, "data", "web", "app.js"),
  indexHtml: read(FW, "data", "web", "index.html"),
  webContent: read(FW, "include", "WebContent.h"),
  committedContent: read(FW, "tools", "pc-simulator", "_WebContent_committed.h"),
  genAppJs: read(FW, "desktop", "src-tauri", "generated-web", "app.js"),
  genIndexHtml: read(FW, "desktop", "src-tauri", "generated-web", "index.html"),
};

let failures = 0;
let count = 0;
function assert(cond, msg) {
  count++;
  if (cond) console.log("  ok   - " + msg);
  else { failures++; console.error("  FAIL - " + msg); }
}

console.log("1. FTP-relative Power hysteresis (1.5 % of FTP)");
{
  assert(SRC.powerZones.includes("0.015f * (float)c.ftp"),
    "PowerZones::zoneIndex computes the margin as 1.5 % of FTP");
  assert(SRC.powerZones.includes("(c.ftp > 0) ? 0.015f * (float)c.ftp : 0.0f"),
    "unset FTP (0) yields a zero margin (no unsafe value)");
  assert(SRC.powerZones.includes("zoneIndexG(mins, MAX_HR_ZONES, bpm, prevZone, useHysteresis, (float)c.hysteresis)"),
    "HR zones still use the absolute config.hysteresis margin");
  assert(SRC.pipeline.includes("hys = 0.015 * cfg.ftp if cfg.ftp > 0 else 0.0"),
    "simulator zone_index mirrors the FTP-relative margin");
  assert(SRC.pipeline.includes("hys = float(cfg.hysteresis)"),
    "simulator hr_zone_index keeps the absolute bpm margin");
}

console.log("2. 20 % center plateau colour interpolation");
{
  assert(SRC.powerZones.includes("if (t < 0.4f)") &&
         SRC.powerZones.includes("} else if (t <= 0.6f) {"),
    "firmware colorForG splits each zone span into lower/plateau/upper thirds");
  assert(SRC.powerZones.includes("(pr + rs[i]) / 2") &&
         SRC.powerZones.includes("(rs[i] + rs[i + 1]) / 2"),
    "boundaries blend to the exact midpoint of the two zone colours");
  assert(SRC.powerZones.includes("(i > 0) ? rs[i - 1] : rs[i]"),
    "zone 0 has no lower neighbour: its colour extends");
  assert(SRC.powerZonesH.includes("central 20 %"),
    "PowerZones.h documents the plateau semantics");
  assert(SRC.pipeline.includes("def _plateau_color(zones, i, t):") &&
         SRC.pipeline.includes("if t <= 0.4:") && SRC.pipeline.includes("if t <= 0.6:"),
    "simulator _plateau_color mirrors the firmware plateau");
  assert(SRC.pipeline.includes("(prev.r + cur.r) // 2") &&
         SRC.pipeline.includes("(cur.r + nxt.r) // 2"),
    "simulator plateau hits the same colour midpoints at boundaries");
}

console.log("3. Zero-safe FTP / Max HR defaults");
{
  assert(SRC.config.includes("c.ftp            = 0;") &&
         SRC.config.includes("c.hrMax          = 0;"),
    "factory defaults are 0 = not set");
  assert(SRC.config.includes("if (c.hrMax != 0) {"),
    "configSanitizeHrZones keeps hrMax = 0 instead of clamping it up");
  assert(SRC.pipeline.includes("self.ftp = 0") &&
         SRC.pipeline.includes("self.hr_max = 0"),
    "simulator defaults mirror 0 = not set");
  assert(SRC.pipeline.includes("if self.hr_max != 0:"),
    "simulator sanitize_hr_zones keeps hr_max = 0");
  assert(SRC.web.includes('if (newMax != 0) newMax = constrain(newMax, 100, 230);   // 0 = not set'),
    "/api/config accepts hrMax = 0 (not clamped up)");
  assert(SRC.web.includes("if (oldFtp <= 0 && newFtp > 0) {") &&
         SRC.web.includes("configApplyDefaultZones(g_config);"),
    "first real FTP regenerates the zone template");
  assert(SRC.web.includes("if (oldMax <= 0 && newMax > 0) configApplyDefaultHrZones(g_config);"),
    "first real Max HR regenerates the HR zone template");
  assert(SRC.web.includes("configScaleZones(g_config, oldFtp, newFtp);"),
    "set -> set FTP changes still scale proportionally");
  assert(SRC.pipeline.includes("if old_ftp <= 0 and new_ftp > 0:") &&
         SRC.pipeline.includes("if new_max != 0:"),
    "simulator apply_config_patch mirrors the regeneration semantics");
}

console.log("4. Build ID (short Git commit SHA)");
{
  assert(SRC.fwVersion.includes('#define FW_BUILD_SHA "local"') &&
         SRC.fwVersion.includes("#ifndef FW_BUILD_SHA"),
    "FirmwareVersion.h defines an FW_BUILD_SHA fallback for local builds");
  assert(SRC.platformio.includes("extra_scripts = pre:tools/build_id.py"),
    "platformio.ini wires the build-id script into every build (incl. CI)");
  assert(SRC.buildId.includes('env.Append(CPPDEFINES=[("FW_BUILD_SHA",') &&
         SRC.buildId.includes('"local"'),
    "tools/build_id.py injects the short SHA as a string define");
  assert(SRC.web.includes('doc["buildId"]        = FW_BUILD_SHA;'),
    "/api/info exposes the build ID");
  assert(SRC.main.includes("FW_VERSION_FULL, FW_BUILD_TYPE, FW_BUILD_SHA"),
    "boot log prints the build ID");
  assert(SRC.simulator.includes('"buildId": "sim",'),
    "simulator /api/info carries the same buildId field (API parity)");
}

console.log("5. Web UI accepts 0 = not set and stays in sync");
{
  assert(SRC.appJs.includes("const ftp = int(c.ftp, 0, 1000);"),
    "backup import accepts FTP = 0");
  assert(SRC.appJs.includes("const hrMax = int(c.hrMax, 0, 230);"),
    "backup import accepts Max HR = 0");
  assert(SRC.indexHtml.includes('id="ftpInput" data-testid="ftp-input" min="0" max="1000"'),
    "FTP input allows 0");
  assert(SRC.indexHtml.includes('id="hrMaxInput" data-testid="hr-max-input" min="0" max="230"'),
    "Max HR input allows 0");
  assert(SRC.indexHtml.includes('<span id="hysUnit">BPM</span>'),
    "hysteresis is labelled BPM (HR-only; Power is FTP-relative)");
  assert(SRC.appJs.includes('$("hysUnit").textContent = "BPM";'),
    "fillForms always labels hysteresis in BPM");
  assert(SRC.webContent.includes('id="statFtp">0<') &&
         SRC.webContent.includes('id="ftpInput" data-testid="ftp-input" min="0" max="1000"'),
    "embedded WebContent.h was regenerated from data/web");
  assert(SRC.webContent === SRC.committedContent,
    "simulator _WebContent_committed.h matches include/WebContent.h");
  assert(SRC.appJs === SRC.genAppJs && SRC.indexHtml === SRC.genIndexHtml,
    "desktop generated-web copies match data/web");
}

console.log("");
if (failures) {
  console.error("FAILED: " + failures + " / " + count + " assertions failed");
  process.exit(1);
}
console.log("PASSED: all " + count + " assertions passed");