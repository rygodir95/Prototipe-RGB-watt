#include "HRSensor.h"
#include "AppState.h"
#include "Config.h"
#include <NimBLEDevice.h>
#include <map>

HRSensor *HRSensor::instance = nullptr;

// Standard Bluetooth SIG Heart Rate Service UUIDs.
static const NimBLEUUID HRS_SERVICE((uint16_t)0x180D);
static const NimBLEUUID HRS_MEASURE((uint16_t)0x2A37);

static portMUX_TYPE g_hrMux = portMUX_INITIALIZER_UNLOCKED;
static std::map<std::string, NimBLEAddress> g_hrAddrMap;

#if defined(BUILD_DEV)
// ---- HR scan diagnostics (dev builds only) ---------------------------------
// Prints one entry per BLE advertiser DURING an active HR scan, BEFORE the
// HRS filter, so devices that fail the 0x180D classification (e.g. the Wahoo
// ELEMNT RIVAL investigation) are visible with their advertised name,
// service UUIDs, manufacturer data, service data and raw payload.
// Pure logging: classification, scan timing and connection logic unchanged.
static uint32_t g_hrAdvSeen    = 0;   // advertisers observed this scan
static uint32_t g_hrAdvMatched = 0;   // advertisers classified as HRS

static std::string hrHex(const std::string &s) {
  static const char *kHex = "0123456789abcdef";
  std::string out;
  out.reserve(s.size() * 2);
  for (unsigned char c : s) { out += kHex[c >> 4]; out += kHex[c & 0x0f]; }
  return out;
}

static void hrLogAdvertiser(NimBLEAdvertisedDevice *dev) {
  Serial.printf("[HR][diag] adv addr=%s rssi=%d connectable=%d name=%s\n",
                dev->getAddress().toString().c_str(), dev->getRSSI(),
                dev->isConnectable() ? 1 : 0,
                dev->haveName() ? dev->getName().c_str() : "<none>");
  Serial.printf("[HR][diag]   svcUuids=%u",
                dev->haveServiceUUID() ? dev->getServiceUUIDCount() : 0);
  if (dev->haveServiceUUID()) {
    for (uint8_t i = 0; i < dev->getServiceUUIDCount(); i++)
      Serial.printf(" %s", dev->getServiceUUID(i).toString().c_str());
  }
  Serial.println();
  if (dev->haveManufacturerData()) {
    Serial.printf("[HR][diag]   mfgData=%s\n",
                  hrHex(dev->getManufacturerData()).c_str());
  }
  if (dev->haveServiceData()) {
    for (uint8_t i = 0; i < dev->getServiceDataCount(); i++) {
      Serial.printf("[HR][diag]   svcData uuid=%s data=%s\n",
                    dev->getServiceDataUUID(i).toString().c_str(),
                    hrHex(dev->getServiceData(i)).c_str());
    }
  }
  Serial.printf("[HR][diag]   payload(%u)=%s\n",
                (unsigned)dev->getPayloadLength(),
                hrHex(std::string((const char *)dev->getPayload(),
                                  dev->getPayloadLength())).c_str());
}
#endif

// ---- Free callbacks ---------------------------------------------------------

static void hrNotifyCB(NimBLERemoteCharacteristic *chr, uint8_t *data, size_t len, bool isNotify) {
  (void)chr; (void)isNotify;
  if (HRSensor::instance) HRSensor::instance->onNotify(data, len);
}

static void hrScanCompleteCB(NimBLEScanResults results) {
  (void)results;
  if (HRSensor::instance) HRSensor::instance->onScanEnd();
}

class HRScanCallbacks : public NimBLEAdvertisedDeviceCallbacks {
  void onResult(NimBLEAdvertisedDevice *dev) override {
#if defined(BUILD_DEV)
    // Dev-only per-advertiser dump, BEFORE the HRS gate below.
    if (HRSensor::instance && HRSensor::instance->isScanning()) {
      g_hrAdvSeen++;
      hrLogAdvertiser(dev);
    }
#endif
    if (!dev->isAdvertisingService(HRS_SERVICE)) return;
#if defined(BUILD_DEV)
    g_hrAdvMatched++;
#endif
    std::string addr = dev->getAddress().toString();
    std::string name = dev->getName();
    if (name.empty()) name = "Unknown HR Sensor";
    portENTER_CRITICAL(&g_hrMux);
    g_hrAddrMap[addr] = dev->getAddress();
    portEXIT_CRITICAL(&g_hrMux);
    if (HRSensor::instance) HRSensor::instance->onDeviceFound(addr, name, "HRS", dev->getRSSI());
  }
};
static HRScanCallbacks g_hrScanCB;

class HRClientCallbacks : public NimBLEClientCallbacks {
  void onConnect(NimBLEClient *c) override {
    (void)c;
    if (HRSensor::instance) HRSensor::instance->onClientConnect();
  }
  void onDisconnect(NimBLEClient *c) override {
    (void)c;
    if (HRSensor::instance) HRSensor::instance->onClientDisconnect();
  }
};
static HRClientCallbacks g_hrClientCB;

// ---- HRSensor ----------------------------------------------------------------

HRSensor::HRSensor() { instance = this; }

void HRSensor::begin() {
  // NimBLE is initialised once by BLEPower::begin(); nothing to do here.
  Serial.println("[HR] Heart Rate sensor module ready");
}

void HRSensor::startScan(int seconds) {
  if (_scanning) return;
  NimBLEScan *s = NimBLEDevice::getScan();
  s->setAdvertisedDeviceCallbacks(&g_hrScanCB, false);
  s->setActiveScan(true);
  s->setInterval(100);
  s->setWindow(99);
  s->clearResults();
  portENTER_CRITICAL(&g_hrMux);
  g_hrAddrMap.clear();
  _devices.clear();
  portEXIT_CRITICAL(&g_hrMux);
#if defined(BUILD_DEV)
  g_hrAdvSeen = 0;
  g_hrAdvMatched = 0;
#endif
  _scanning = true;
  if (!_connected) g_tel.state = DeviceState::SCANNING;
  Serial.println("[HR] Scanning...");
  s->start(seconds, hrScanCompleteCB, false);
}

std::vector<HRDeviceInfo> HRSensor::getDevices() {
  std::vector<HRDeviceInfo> copy;
  portENTER_CRITICAL(&g_hrMux);
  copy = _devices;
  portEXIT_CRITICAL(&g_hrMux);
  return copy;
}

void HRSensor::onDeviceFound(const std::string &addr, const std::string &name, const std::string &type, int rssi) {
  portENTER_CRITICAL(&g_hrMux);
  for (auto &d : _devices) {
    if (d.address == addr) { d.rssi = rssi; if (d.name.empty()) d.name = name; portEXIT_CRITICAL(&g_hrMux); return; }
  }
  _devices.push_back({addr, name, type, rssi});
  portEXIT_CRITICAL(&g_hrMux);
  Serial.printf("[HR] Found %s (%s) [%s]\n", name.c_str(), addr.c_str(), type.c_str());
}

void HRSensor::onScanEnd() {
  _scanning = false;
#if defined(BUILD_DEV)
  Serial.printf("[HR][diag] scan end: advertisers=%u matchedHRS=%u\n",
                (unsigned)g_hrAdvSeen, (unsigned)g_hrAdvMatched);
#endif
  Serial.println("[HR] Scan complete");
  if (_desired && !_connected && !_targetAddr.empty()) {
    portENTER_CRITICAL(&g_hrMux);
    bool have = g_hrAddrMap.find(_targetAddr) != g_hrAddrMap.end();
    portEXIT_CRITICAL(&g_hrMux);
    if (have) _doConnect = true;
  }
  // The finite scan window is over: the scanning state must never linger
  // in telemetry, no matter who started the scan. When an explicit Connect
  // found its target, update() moves on to the connecting state next tick.
  if (!_connected) g_tel.state = DeviceState::DISCONNECTED;
}

void HRSensor::connectToAddress(const std::string &addr, const std::string &name) {
  _targetAddr = addr;
  _targetName = name;
  _desired    = true;
  if (_scanning) { NimBLEDevice::getScan()->stop(); _scanning = false; }
  portENTER_CRITICAL(&g_hrMux);
  bool have = g_hrAddrMap.find(addr) != g_hrAddrMap.end();
  portEXIT_CRITICAL(&g_hrMux);
  if (have) _doConnect = true;
  else      startScan(6);   // not seen yet -> scan then connect
}

void HRSensor::disconnect() {
  _desired = false;
  if (_client && _client->isConnected()) _client->disconnect();
  _connected = false;
  g_tel.state = DeviceState::DISCONNECTED;
}

void HRSensor::forget() {
  disconnect();
  _targetAddr.clear();
  _targetName.clear();
}

void HRSensor::shutdown() {
  // Full stop used when switching control source: no scan, no connection,
  // no reconnect attempts, no cached devices.
  disconnect();
  if (_scanning) { NimBLEDevice::getScan()->stop(); _scanning = false; }
  _doConnect = false;
  _targetAddr.clear();
  _targetName.clear();
  portENTER_CRITICAL(&g_hrMux);
  g_hrAddrMap.clear();
  _devices.clear();
  portEXIT_CRITICAL(&g_hrMux);
}

bool HRSensor::connectInternal(const std::string &addr) {
  portENTER_CRITICAL(&g_hrMux);
  auto it = g_hrAddrMap.find(addr);
  bool have = it != g_hrAddrMap.end();
  NimBLEAddress bleAddr = have ? it->second : NimBLEAddress();
  portEXIT_CRITICAL(&g_hrMux);
  if (!have) return false;

  g_tel.state = DeviceState::CONNECTING;
  Serial.printf("[HR] Connecting to %s...\n", addr.c_str());

  if (!_client) {
    _client = NimBLEDevice::createClient();
    _client->setClientCallbacks(&g_hrClientCB, false);
    _client->setConnectionParams(12, 12, 0, 200);
    _client->setConnectTimeout(8);
  }

  if (!_client->connect(bleAddr)) {
    Serial.println("[HR] Connect failed");
    return false;
  }

  NimBLERemoteService *svc = _client->getService(HRS_SERVICE);
  if (!svc) {
    Serial.println("[HR] Heart Rate Service missing");
    _client->disconnect();
    return false;
  }
  NimBLERemoteCharacteristic *chr = svc->getCharacteristic(HRS_MEASURE);
  if (!chr) { Serial.println("[HR] Heart Rate Measurement characteristic missing"); _client->disconnect(); return false; }
  if (chr->canNotify()) chr->subscribe(true, hrNotifyCB);
  Serial.println("[HR] Connected (Heart Rate Service)");
  return true;
}

void HRSensor::scheduleReconnect() {
  _lastReconnectAttempt = millis();
}

void HRSensor::update() {
  // One-shot connect executor ONLY. The automatic reconnect loop that used
  // to live here restarted a BLE scan roughly every 7 seconds while the
  // desired sensor was not connected - the root cause of the endless
  // rescan storm (hub-side, so it continued with every client closed).
  // That loop is temporarily removed for the hardware-validation phase:
  // update() must never start a scan. A proper bounded/backoff reconnect
  // strategy will be implemented separately once the basic sensor
  // connection path is hardware-verified.
  if (_doConnect) {
    _doConnect = false;
    if (connectInternal(_targetAddr)) {
      _connected = true;
      strncpy(g_tel.sourceName, _targetName.c_str(), sizeof(g_tel.sourceName) - 1);
      g_tel.sourceName[sizeof(g_tel.sourceName) - 1] = '\0';
      g_tel.state = DeviceState::CONNECTED;
    } else {
      // Failed one-shot attempt: settle into the disconnected/no-source
      // state. No retry, no rescan.
      _connected = false;
      g_tel.state = DeviceState::DISCONNECTED;
      scheduleReconnect();   // inert today; hook for the future bounded strategy
    }
  }
}

void HRSensor::onNotify(const uint8_t *data, size_t len) {
  // Heart Rate Measurement (0x2A37): [flags:1][HR:1|2 LE][optional fields...]
  //   flags bit0: HR value format (0 = uint8, 1 = uint16 LE)
  //   flags bit1/2: sensor contact, bit3: energy expended, bit4: RR intervals
  if (len < 2) return;
  uint16_t bpm;
  if (data[0] & 0x01) {
    if (len < 3) return;                       // 16-bit format needs 3 bytes
    bpm = (uint16_t)(data[1] | (data[2] << 8));
  } else {
    bpm = data[1];                             // 8-bit format
  }
  if (bpm == 0 || bpm > 250) return;            // reject implausible values
  _bpm     = (float)bpm;
  _bpmTime = millis();
}

void HRSensor::onClientConnect() {
  _connected = true;
}

void HRSensor::onClientDisconnect() {
  _connected = false;
  Serial.println("[HR] Disconnected");
  // No reconnect attempt is scheduled anymore (see update()), so the hub
  // settles into the disconnected state instead of lingering in a
  // reconnecting state that would never resolve.
  g_tel.state = DeviceState::DISCONNECTED;
  scheduleReconnect();   // inert today; hook for the future bounded strategy
}