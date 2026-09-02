#include "BLEPower.h"
#include "AppState.h"
#include "Config.h"
#include <NimBLEDevice.h>
#include <map>

BLEPower *BLEPower::instance = nullptr;

// Standard Bluetooth SIG Cycling Power Service UUIDs.
static const NimBLEUUID CPS_SERVICE((uint16_t)0x1818);
static const NimBLEUUID CPS_MEASURE((uint16_t)0x2A63);

static portMUX_TYPE g_mux = portMUX_INITIALIZER_UNLOCKED;
static std::map<std::string, NimBLEAddress> g_addrMap;

// ---- Free callbacks ---------------------------------------------------------

static void notifyCB(NimBLERemoteCharacteristic *chr, uint8_t *data, size_t len, bool isNotify) {
  (void)chr; (void)isNotify;
  if (BLEPower::instance) BLEPower::instance->onNotify(data, len);
}

static void scanCompleteCB(NimBLEScanResults results) {
  (void)results;
  if (BLEPower::instance) BLEPower::instance->onScanEnd();
}

class ScanCallbacks : public NimBLEAdvertisedDeviceCallbacks {
  void onResult(NimBLEAdvertisedDevice *dev) override {
    if (!dev->isAdvertisingService(CPS_SERVICE)) return;
    std::string addr = dev->getAddress().toString();
    std::string name = dev->getName();
    if (name.empty()) name = "Unknown Power Source";
    portENTER_CRITICAL(&g_mux);
    g_addrMap[addr] = dev->getAddress();
    portEXIT_CRITICAL(&g_mux);
    if (BLEPower::instance) BLEPower::instance->onDeviceFound(addr, name, dev->getRSSI());
  }
};
static ScanCallbacks g_scanCB;

class ClientCallbacks : public NimBLEClientCallbacks {
  void onConnect(NimBLEClient *c) override {
    (void)c;
    if (BLEPower::instance) BLEPower::instance->onClientConnect();
  }
  void onDisconnect(NimBLEClient *c) override {
    (void)c;
    if (BLEPower::instance) BLEPower::instance->onClientDisconnect();
  }
};
static ClientCallbacks g_clientCB;

// ---- BLEPower ---------------------------------------------------------------

BLEPower::BLEPower() { instance = this; }

void BLEPower::begin() {
  NimBLEDevice::init("");
  NimBLEDevice::setPower(ESP_PWR_LVL_P9);
  Serial.println("[BLE] Initialised");
}

void BLEPower::startScan(int seconds) {
  if (_scanning) return;
  NimBLEScan *s = NimBLEDevice::getScan();
  s->setAdvertisedDeviceCallbacks(&g_scanCB, false);
  s->setActiveScan(true);
  s->setInterval(100);
  s->setWindow(99);
  s->clearResults();
  portENTER_CRITICAL(&g_mux);
  g_addrMap.clear();
  _devices.clear();
  portEXIT_CRITICAL(&g_mux);
  _scanning = true;
  if (!_connected) g_tel.state = DeviceState::SCANNING;
  Serial.println("[BLE] Scanning...");
  s->start(seconds, scanCompleteCB, false);
}

std::vector<BLEDeviceInfo> BLEPower::getDevices() {
  std::vector<BLEDeviceInfo> copy;
  portENTER_CRITICAL(&g_mux);
  copy = _devices;
  portEXIT_CRITICAL(&g_mux);
  return copy;
}

void BLEPower::onDeviceFound(const std::string &addr, const std::string &name, int rssi) {
  portENTER_CRITICAL(&g_mux);
  for (auto &d : _devices) {
    if (d.address == addr) { d.rssi = rssi; if (d.name.empty()) d.name = name; portEXIT_CRITICAL(&g_mux); return; }
  }
  _devices.push_back({addr, name, rssi});
  portEXIT_CRITICAL(&g_mux);
  Serial.printf("[BLE] Found %s (%s)\n", name.c_str(), addr.c_str());
}

void BLEPower::onScanEnd() {
  _scanning = false;
  Serial.println("[BLE] Scan complete");
  if (_desired && !_connected && !_targetAddr.empty()) {
    portENTER_CRITICAL(&g_mux);
    bool have = g_addrMap.find(_targetAddr) != g_addrMap.end();
    portEXIT_CRITICAL(&g_mux);
    if (have) _doConnect = true;
    else if (!_connected) g_tel.state = DeviceState::DISCONNECTED;
  }
}

void BLEPower::connectToAddress(const std::string &addr, const std::string &name) {
  _targetAddr = addr;
  _targetName = name;
  _desired    = true;
  if (_scanning) { NimBLEDevice::getScan()->stop(); _scanning = false; }
  portENTER_CRITICAL(&g_mux);
  bool have = g_addrMap.find(addr) != g_addrMap.end();
  portEXIT_CRITICAL(&g_mux);
  if (have) _doConnect = true;
  else      startScan(6);   // not seen yet -> scan then connect
}

void BLEPower::disconnect() {
  _desired = false;
  if (_client && _client->isConnected()) _client->disconnect();
  _connected = false;
  g_tel.state = DeviceState::DISCONNECTED;
}

void BLEPower::forget() {
  disconnect();
  _targetAddr.clear();
  _targetName.clear();
}

bool BLEPower::connectInternal(const std::string &addr) {
  portENTER_CRITICAL(&g_mux);
  auto it = g_addrMap.find(addr);
  bool have = it != g_addrMap.end();
  NimBLEAddress bleAddr = have ? it->second : NimBLEAddress();
  portEXIT_CRITICAL(&g_mux);
  if (!have) return false;

  g_tel.state = DeviceState::CONNECTING;
  Serial.printf("[BLE] Connecting to %s...\n", addr.c_str());

  if (!_client) {
    _client = NimBLEDevice::createClient();
    _client->setClientCallbacks(&g_clientCB, false);
    _client->setConnectionParams(12, 12, 0, 200);
    _client->setConnectTimeout(8);
  }

  if (!_client->connect(bleAddr)) {
    Serial.println("[BLE] Connect failed");
    return false;
  }

  NimBLERemoteService *svc = _client->getService(CPS_SERVICE);
  if (!svc) {
    Serial.println("[BLE] Cycling Power Service not found");
    _client->disconnect();
    return false;
  }
  NimBLERemoteCharacteristic *chr = svc->getCharacteristic(CPS_MEASURE);
  if (!chr) {
    Serial.println("[BLE] Power Measurement characteristic not found");
    _client->disconnect();
    return false;
  }
  if (chr->canNotify()) {
    chr->subscribe(true, notifyCB);
  }
  Serial.println("[BLE] Connected");
  return true;
}

void BLEPower::scheduleReconnect() {
  _lastReconnectAttempt = millis();
}

void BLEPower::update() {
  uint32_t now = millis();

  if (_doConnect) {
    _doConnect = false;
    if (connectInternal(_targetAddr)) {
      _connected = true;
      strncpy(g_tel.sourceName, _targetName.c_str(), sizeof(g_tel.sourceName) - 1);
      g_tel.sourceName[sizeof(g_tel.sourceName) - 1] = '\0';
      g_tel.state = DeviceState::CONNECTED;
    } else {
      _connected = false;
      g_tel.state = DeviceState::DISCONNECTED;
      scheduleReconnect();
    }
  }

  // Automatic reconnect loop.
  if (_desired && _autoReconnect && !_connected && !_scanning && !_targetAddr.empty()) {
    if (now - _lastReconnectAttempt > 7000) {
      _lastReconnectAttempt = now;
      g_tel.state = DeviceState::RECONNECTING;
      Serial.println("[BLE] Attempting reconnect...");
      startScan(6);
    }
  }
}

void BLEPower::onNotify(const uint8_t *data, size_t len) {
  if (len < 4) return;
  // CPS Measurement: [flags:2][instantaneous power:int16 LE] ...
  int16_t p = (int16_t)(data[2] | (data[3] << 8));
  if (p < 0)     p = 0;
  if (p > 3000)  return;   // reject implausible values
  _power     = (float)p;
  _powerTime = millis();
}

void BLEPower::onClientConnect() {
  _connected = true;
}

void BLEPower::onClientDisconnect() {
  _connected = false;
  Serial.println("[BLE] Disconnected");
  g_tel.state = (_desired && _autoReconnect) ? DeviceState::RECONNECTING
                                             : DeviceState::DISCONNECTED;
  scheduleReconnect();
}
