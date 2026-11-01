// Tauri v2 ACL check for the ZoneGlow desktop shell.
//
// The Windows build shipped without any capability file, so every core/plugin
// command was denied ("Command plugin:event|listen not allowed by ACL") while
// the app's own commands (ble_scan/ble_connect/...) kept working, because
// tauri::Builder::invoke_handler commands are allowed to all windows by default.
//
// This check pins the intended, minimal contract:
//   * the packaged window label is explicit and matches the capability,
//   * the capability grants only core:event:allow-listen / allow-unlisten,
//   * no broad permission (core:default, core:event:default, *) and no remote
//     API access is granted,
//   * the frontend only ever reaches the event API it was granted.
"use strict";

const fs = require("fs");
const path = require("path");

const firmwareDir = path.resolve(__dirname, "../../..");
const tauriDir = path.join(firmwareDir, "desktop/src-tauri");
const frontendDir = path.join(firmwareDir, "desktop/src");

const GRANTED = ["core:event:allow-listen", "core:event:allow-unlisten"];
const BRIDGE_NEEDS = "core:event:allow-listen";

let failures = 0;
function check(condition, message, detail) {
  if (condition) {
    console.log("  PASS  " + message);
    return true;
  }
  failures += 1;
  console.log("  FAIL  " + message + (detail ? "\n        " + detail : ""));
  return false;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

// 1. The window the packaged app really opens.
console.log("tauri.conf.json");
const conf = readJson(path.join(tauriDir, "tauri.conf.json"));
const windows = (conf.app && conf.app.windows) || [];
check(windows.length === 1, "exactly one application window is declared", "found " + windows.length);
const windowLabel = (windows[0] && windows[0].label) || "main";
check(windowLabel === "main", "window label resolves to 'main'", "resolved " + JSON.stringify(windowLabel));
check(
  windows[0] && typeof windows[0].label === "string",
  "window label is declared explicitly (not left to the default)",
  "add \"label\": \"main\" to app.windows[0]"
);
check(
  conf.app && conf.app.withGlobalTauri === true,
  "withGlobalTauri is enabled (the bridge uses window.__TAURI__)",
  "window.__TAURI__ is undefined without it"
);

// 2. The capability that must match that label.
console.log("capabilities/");
const capabilitiesDir = path.join(tauriDir, "capabilities");
check(fs.existsSync(capabilitiesDir), "capabilities directory exists", "no capability was shipped: every core command is denied");
const files = fs.existsSync(capabilitiesDir)
  ? fs.readdirSync(capabilitiesDir).filter((name) => name.endsWith(".json"))
  : [];
check(files.length > 0, "at least one capability file is present");

let permissions = [];
let matched = [];
for (const name of files) {
  const file = path.join(capabilitiesDir, name);
  let capability;
  try {
    capability = readJson(file);
  } catch (error) {
    check(false, name + " is valid JSON", error.message);
    continue;
  }
  check(typeof capability.identifier === "string" && capability.identifier.length > 0, name + " declares an identifier");
  const targets = Array.isArray(capability.windows) ? capability.windows : [];
  const applies = targets.includes(windowLabel) || targets.includes("*");
  console.log("        " + name + " -> windows " + JSON.stringify(targets) + (applies ? "  (applies)" : "  (does not apply)"));
  if (applies) {
    matched.push(name);
    permissions = permissions.concat(Array.isArray(capability.permissions) ? capability.permissions : []);
    check(
      !capability.remote,
      name + " grants no remote API access",
      "only bundled code (frontendDist ../src) needs the bridge"
    );
  }
}

// 3. The exact event permission the failing call needed.
check(matched.length > 0, "a capability applies to window '" + windowLabel + "'", "the BLE bridge runs in that window");
check(
  permissions.includes(BRIDGE_NEEDS),
  BRIDGE_NEEDS + " is granted for '" + windowLabel + "'",
  "plugin:event|listen is denied without it - this is the reported Windows error"
);
check(
  permissions.includes("core:event:allow-unlisten"),
  "core:event:allow-unlisten is granted for '" + windowLabel + "'",
  "the paired event command; listeners are torn down with it"
);

// 4. Minimality: nothing broad, nothing unrelated.
console.log("minimality/");
const broad = permissions.filter((entry) => {
  const value = typeof entry === "string" ? entry : JSON.stringify(entry);
  return value === "*" || value === "core:default" || value === "core:event:default" || value.startsWith("core:event:*");
});
check(broad.length === 0, "no broad permission is granted", broad.join(", "));
const unexpected = permissions.filter((entry) => GRANTED.indexOf(entry) === -1);
check(unexpected.length === 0, "only the two event permissions are granted", unexpected.join(", "));

// 5. The frontend only touches the APIs those permissions cover.
console.log("frontend usage/");
const used = new Set();
for (const name of ["shell.js", "transport.js", "ble-transport.js", "ble-web-host.js"]) {
  const file = path.join(frontendDir, name);
  if (!fs.existsSync(file)) continue; // ble-web-host.js is generated by prepare_ble_web_ui.cjs
  const source = fs.readFileSync(file, "utf8");
  const matches = source.match(/__TAURI__(?:\.[A-Za-z0-9_]+)*/g) || [];
  matches.forEach((symbol) => used.add(symbol.replace(/^__TAURI__/, "") || "(namespace)"));
}
const symbols = Array.from(used).sort();
console.log("        " + (symbols.length ? symbols.join(", ") : "(none)"));
const allowed = ["(namespace)", ".core", ".core.invoke", ".event", ".event.listen", ".event.unlisten"];
const unsupported = symbols.filter((symbol) => allowed.indexOf(symbol) === -1);
check(unsupported.length === 0, "frontend only uses __TAURI__.core (app commands) and __TAURI__.event.listen", unsupported.join(", "));
check(symbols.indexOf(".event.listen") !== -1 || symbols.length === 0, "the BLE bridge registers its listeners through __TAURI__.event.listen");

console.log(
  failures === 0
    ? "\nTauri ACL check: OK (" + files.length + " capability file(s), " + permissions.length + " permission(s))"
    : "\nTauri ACL check: " + failures + " failure(s)"
);
process.exit(failures === 0 ? 0 : 1);