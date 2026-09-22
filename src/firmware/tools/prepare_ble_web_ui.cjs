// Package the SAME Web UI files used by ESP32, with a local BLE API adapter.
// Generated copies are not edited: data/web remains the single UI source.
const fs = require('node:fs');
const path = require('node:path');

const firmware = path.resolve(__dirname, '..');
const source = path.join(firmware, 'data', 'web');
const targets = [
  path.join(firmware, 'desktop', 'src'),
  path.resolve(firmware, '..', '..', 'mobile', 'capacitor', 'www'),
];
let html = fs.readFileSync(path.join(source, 'index.html'), 'utf8');
if (!html.includes('href="/style.css"') || !html.includes('<script src="/app.js"></script>')) {
  throw new Error('Web UI entry changed; update the BLE packaging adapter');
}
html = html.replace('href="/style.css"', 'href="./style.css"')
  .replace('<script src="/app.js"></script>',
    '<script src="./ble-web-api.js"></script>\n  <script src="./app.js"></script>');

for (const target of targets) {
  const ui = path.join(target, 'hub-ui');
  fs.mkdirSync(ui, { recursive: true });
  fs.writeFileSync(path.join(ui, 'index.html'), html);
  for (const file of ['app.js', 'style.css']) fs.copyFileSync(path.join(source, file), path.join(ui, file));
  fs.copyFileSync(path.join(__dirname, 'ble_web_api.js'), path.join(ui, 'ble-web-api.js'));
  fs.copyFileSync(path.join(__dirname, 'ble_web_host.js'), path.join(target, 'ble-web-host.js'));
  console.log('Prepared canonical Hub UI for ' + path.relative(process.cwd(), target));
}

