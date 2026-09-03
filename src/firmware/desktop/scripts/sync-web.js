// ZoneGlow desktop - build-time web UI staging step.
//
// The desktop shell bundles the EXISTING ZoneGlow web UI locally so it renders
// even when the backend is offline. data/web/ (the firmware's embedded UI)
// stays the single source of truth: this script stages a byte-identical copy
// into src-tauri/generated-web/, which is git-ignored and never edited by
// hand. `tauri dev` / `tauri build` run it automatically (before*Command in
// tauri.conf.json) and the staged copy ships inside ZoneGlow.exe.
/* global require, process, console, __dirname */
"use strict";

const fs = require("fs");
const path = require("path");

const SOURCE = path.resolve(__dirname, "..", "..", "data", "web"); // src/firmware/data/web
const TARGET = path.resolve(__dirname, "..", "src-tauri", "generated-web");

if (!fs.existsSync(path.join(SOURCE, "index.html"))) {
  console.error("sync-web: source UI not found at " + SOURCE);
  console.error("sync-web: expected the firmware's data/web (single source of truth).");
  process.exit(1);
}

fs.rmSync(TARGET, { recursive: true, force: true });
fs.mkdirSync(TARGET, { recursive: true });

const files = fs
  .readdirSync(SOURCE)
  .filter((f) => fs.statSync(path.join(SOURCE, f)).isFile());

for (const f of files) {
  fs.copyFileSync(path.join(SOURCE, f), path.join(TARGET, f));
}

if (!files.includes("index.html")) {
  console.error("sync-web: data/web has no index.html - refusing to stage.");
  process.exit(1);
}

console.log("sync-web: staged " + files.length + " file(s) data/web -> src-tauri/generated-web:");
files.forEach((f) => console.log("  - " + f));