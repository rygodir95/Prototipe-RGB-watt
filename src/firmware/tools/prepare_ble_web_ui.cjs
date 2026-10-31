// Package the SAME Web UI files used by ESP32, with a local BLE API adapter.
// Generated copies are not edited: data/web remains the single UI source.
const fs = require('node:fs');
const path = require('node:path');

const firmware = path.resolve(__dirname, '..');
const source = path.join(firmware, 'data', 'web');
const targets = [
  path.join(firmware, 'desktop', 'src'),
  path.resolve(firmware, '..', '..', 'mobile', 'capacitor', 'www'),
].filter((target) => fs.existsSync(path.dirname(target)) || fs.existsSync(target));

let html = fs.readFileSync(path.join(source, 'index.html'), 'utf8');
if (html.includes('href="/style.css"')) {
  html = html.replace('href="/style.css"', 'href="./style.css"');
} else if (!html.includes('href="style.css"') && !html.includes('href="./style.css"')) {
  throw new Error('Web UI entry changed; update the BLE packaging adapter (style.css)');
}
const appTag = ['<script src="/app.js"></script>', '<script src="app.js"></script>', '<script src="./app.js"></script>']
  .find((tag) => html.includes(tag));
if (!appTag) throw new Error('Web UI entry changed; update the BLE packaging adapter (app.js)');
html = html.replace(appTag, '<script src="./ble-web-api.js"></script>\n  ' + appTag.replace('/app.js', './app.js'));

for (const target of targets) {
  const ui = path.join(target, 'hub-ui');
  fs.mkdirSync(ui, { recursive: true });
  fs.writeFileSync(path.join(ui, 'index.html'), html);
  for (const file of ['app.js', 'style.css']) fs.copyFileSync(path.join(source, file), path.join(ui, file));
  fs.copyFileSync(path.join(__dirname, 'ble_web_api.js'), path.join(ui, 'ble-web-api.js'));
  fs.copyFileSync(path.join(__dirname, 'ble_web_host.js'), path.join(target, 'ble-web-host.js'));
  console.log('Prepared canonical Hub UI for ' + path.relative(process.cwd(), target));
}
