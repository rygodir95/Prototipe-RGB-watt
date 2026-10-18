#include "BLEPower.h"
#include "AppState.h"
#include "Config.h"
#include <NimBLEDevice.h>
#include "BleScanRouter.h"
#include <map>
#include <freertos/semphr.h>

BLEPower *BLEPower::instance = nullptr;

// Standard Bluetooth SIG Cycling Power Service UUIDs.
static const NimBLEUUID CPS_SERVICE((uint16_t)0x1818);
static const NimBLEUUID CPS_MEASURE((uint16_t)0x2A63);
// Fitness Machine Service (FTMS) for smart trainers not exposing CPS.
static const NimBLEUUID FTMS_SERVICE((uint16_t)0x1826);
static const NimBLEUUID FTMS_INDOOR_BIKE((uint16_t)0x2AD2);

// Shared-data lock. These sections guard STL containers (std::map / std::vector)
// whose inserts and clears allocate on the heap. A portMUX spinlock is the wrong
// primitive there: allocating inside a critical section stalls the other core and
// risks a watchdog reset. A FreeRTOS mutex may block instead of spinning, so it is
// safe to hold across an allocating operation. Created in begin() before any
// callback or web task can reach the data.
static SemaphoreHandle_t g_dataMutex = nullptr;

static inline void dataLock() {
  if (g_dataMutex) xSemaphoreTake(g_dataMutex, portMAX_DELAY);
}

static inline void dataUnlock() {
  if (g_dataMutex) xSemaphoreGive(g_dataMutex);
}

// Readiness predicate: this module may only touch the shared state above while
// its mutex exists. Set once in begin(); if creation failed the module stays
// inert - every entry point returns before touching shared state - instead of
// running unprotected. g_tel.state alone is NOT the mechanism: setup() and the
// main loop rewrite it, so it cannot carry this fault.
static inline bool dataReady() { return g_dataMutex != nullptr; }

static std::map<std::string, NimBLEAddress> g_addrMap;

// ---- Free callbacks ---------------------------------------------------------

static void notifyCB(NimBLERemoteCharacteristic *chr, uint8_t *data, size_t len, bool isNotify) {
  (void)chr; (void)isNotify;
  if (BLEPower::instance) BLEPower::instance->onNotify(data, len);
}

// BLE scanning (callbacks, timing and the single advertised-device
// registration) is owned by BleScanRouter: its one physical scan forwards
// every advertiser to BLEPower::onScanResult() below.

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
  // Created here, before the unified scan or the web task can touch the data.
  if (!g_dataMutex) g_dataMutex = xSemaphoreCreateMutex();
  if (!g_dataMutex) {
    // Fail safe, never silently continue: dataReady() keeps every entry point
    // out of the shared state, so the module never scans or connects. The
    // ERROR state below is only a courtesy signal - it is overwritten by
    // setup() and the main loop, so it cannot be the mechanism.
    Serial.println("[BLE] FATAL: shared-data mutex creation failed - power sensing disabled");
    g_tel.state = DeviceState::ERROR;
    return;
  }
  Serial.println("[BLE] Initialised");
}

void BLEPower::startScan(int seconds) {
  // Scanning is owned by the unified BleScanRouter: one physical finite
  // scan feeds every supported sensor category (Power + Heart Rate). The
  // re-entry guard and the single timed NimBLE scan live there.
  BleScanRouter::unifiedScan(seconds);
}

void BLEPower::onScanStart() {
  if (!dataReady()) return;   // no mutex: never touch shared state
  // Scan preparation invoked by the router before the shared scan starts:
  // drop stale results from the previous discovery run.
  dataLock();
  g_addrMap.clear();
  _devices.clear();
  dataUnlock();
  _scanning = true;
  if (!_connected) g_tel.state = DeviceState::SCANNING;
  Serial.println("[BLE] Scanning...");
}

void BLEPower::onScanResult(NimBLEAdvertisedDevice *dev) {
  if (!dataReady()) return;   // no mutex: never touch shared state
  // Unchanged CPS/FTMS classification (moved verbatim from the driver's old
  // private NimBLEAdvertisedDeviceCallbacks): the router forwards every
  // advertiser of the unified scan, and only power devices pass this gate.
  bool cps  = dev->isAdvertisingService(CPS_SERVICE);
  bool ftms = dev->isAdvertisingService(FTMS_SERVICE);
  if (!cps && !ftms) return;
  std::string addr = dev->getAddress().toString();
  std::string name = dev->getName();
  if (name.empty()) name = "Unknown Power Source";
  std::string type = cps ? "CPS" : "FTMS";   // prefer CPS when both advertised
  dataLock();
  g_addrMap[addr] = dev->getAddress();
  dataUnlock();
  onDeviceFound(addr, name, type, dev->getRSSI());
}

std::vector<BLEDeviceInfo> BLEPower::getDevices() {
  if (!dataReady()) return {};   // no mutex: never touch shared state
  std::vector<BLEDeviceInfo> copy;
  dataLock();
  copy = _devices;
  dataUnlock();
  return copy;
}

void BLEPower::onDeviceFound(const std::string &addr, const std::string &name, const std::string &type, int rssi) {
  if (!dataReady()) return;   // no mutex: never touch shared state
  dataLock();
  for (auto &d : _devices) {
    if (d.address == addr) { d.rssi = rssi; if (d.name.empty()) d.name = name; dataUnlock(); return; }
  }
  _devices.push_back({addr, name, type, rssi});
  dataUnlock();
  Serial.printf("[BLE] Found %s (%s) [%s]\n", name.c_str(), addr.c_str(), type.c_str());
}

void BLEPower::onScanEnd() {
  if (!dataReady()) return;   // no mutex: never touch shared state
  _scanning = false;
  Serial.println("[BLE] Scan complete");
  if (_desired && !_connected) {
    // Snapshot the target under the lock: the web task may reassign or clear
    // it at any moment (connectToAddress / forget / shutdown), and the
    // emptiness test and the lookup must see one consistent value.
    std::string target;
    dataLock();
    target = _targetAddr;
    bool have = !target.empty() && g_addrMap.find(target) != g_addrMap.end();
    dataUnlock();
    if (have) _doConnect = true;
  }
  // The finite scan window is over: the scanning state must never linger
  // in telemetry, no matter who started the scan. When an explicit Connect
  // found its target, update() moves on to the connecting state next tick.
  if (!_connected) g_tel.state = DeviceState::DISCONNECTED;
}

void BLEPower::connectToAddress(const std::string &addr, const std::string &name) {
  if (!dataReady()) return;   // no mutex: never touch shared state
  // Target strings FIRST, then _desired: BleScanRouter::stop() below can end
  // the scan synchronously and re-enter onScanEnd(), which must never observe
  // _desired == true paired with a stale target.
  dataLock();
  _targetAddr = addr;
  _targetName = name;
  dataUnlock();
  _desired    = true;
  if (_scanning) { BleScanRouter::stop(); _scanning = false; }
  dataLock();
  bool have = g_addrMap.find(addr) != g_addrMap.end();
  dataUnlock();
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
  if (!dataReady()) return;   // no mutex: never touch shared state
  disconnect();
  dataLock();
  _targetAddr.clear();
  _targetName.clear();
  dataUnlock();
  // Cancel any pending one-shot connect. Without this, update() would still
  // consume the request on the next tick - a harmless no-op only because the
  // target string happens to be empty.
  _doConnect = false;
}

void BLEPower::shutdown() {
  if (!dataReady()) return;   // no mutex: never touch shared state
  // Full stop used when switching control source: no scan, no connection,
  // no reconnect attempts, no cached devices.
  disconnect();
  if (_scanning) { BleScanRouter::stop(); _scanning = false; }
  _doConnect = false;
  dataLock();
  _targetAddr.clear();
  _targetName.clear();
  g_addrMap.clear();
  _devices.clear();
  dataUnlock();
}

bool BLEPower::isLinkActive() const {
  // Read-only NimBLE state (NOT the _connected flag): true while the link is
  // still on the air, including the async terminate window after
  // disconnect() until the host has processed the DISCONNECT event.
  return _client && _client->isConnected();
}

bool BLEPower::connectInternal(const std::string &addr) {
  dataLock();
  auto it = g_addrMap.find(addr);
  bool have = it != g_addrMap.end();
  NimBLEAddress bleAddr = have ? it->second : NimBLEAddress();
  dataUnlock();
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
  if (svc) {
    NimBLERemoteCharacteristic *chr = svc->getCharacteristic(CPS_MEASURE);
    if (!chr) { Serial.println("[BLE] CPS measurement characteristic missing"); _client->disconnect(); return false; }
    if (chr->canNotify()) chr->subscribe(true, notifyCB);
    _ftms = false;
    Serial.println("[BLE] Connected (Cycling Power Service)");
    return true;
  }

  // Fall back to FTMS Indoor Bike Data for smart trainers without CPS.
  svc = _client->getService(FTMS_SERVICE);
  if (svc) {
    NimBLERemoteCharacteristic *chr = svc->getCharacteristic(FTMS_INDOOR_BIKE);
    if (!chr) { Serial.println("[BLE] FTMS Indoor Bike Data characteristic missing"); _client->disconnect(); return false; }
    if (chr->canNotify()) chr->subscribe(true, notifyCB);
    _ftms = true;
    Serial.println("[BLE] Connected (Fitness Machine Service)");
    return true;
  }

  Serial.println("[BLE] No compatible power service (CPS/FTMS) found");
  _client->disconnect();
  return false;
}

void BLEPower::scheduleReconnect() {
  _lastReconnectAttempt = millis();
}

void BLEPower::update() {
  if (!dataReady()) return;   // no mutex: never touch shared state
  // One-shot connect executor ONLY. The automatic reconnect loop that used
  // to live here restarted a BLE scan roughly every 7 seconds while the
  // desired sensor was not connected - the root cause of the endless
  // rescan storm (hub-side, so it continued with every client closed).
  // That loop is temporarily removed for the hardware-validation phase:
  // update() must never start a scan. A proper bounded/backoff reconnect
  // strategy will be implemented separately once the basic sensor
  // connection path is hardware-verified.
  if (_doConnect) {
    // Teardown-settle gate (AppState.h): after a category switch the OLD
    // source's link may still be terminating (NimBLE disconnect is
    // asynchronous; with MAX_CONNECTIONS=1 an attempt started now fails
    // with rc=6/BLE_HS_ENOMEM). Hold the single pending attempt WITHOUT
    // consuming it until the old link is gone - one Connect action still
    // produces exactly one connection attempt. Without a pending teardown
    // the gate is open (direct connects stay immediate).
    if (bleTeardownSettling()) return;
    _doConnect = false;
    // Snapshot under the lock: connectInternal() takes the address by const
    // reference and reads it again after its own lock is released, so it must
    // never be handed the live member. The blocking connect below runs with
    // no lock held.
    std::string target, targetName;
    dataLock();
    target     = _targetAddr;
    targetName = _targetName;
    dataUnlock();
    if (connectInternal(target)) {
      _connected = true;
      strncpy(g_tel.sourceName, targetName.c_str(), sizeof(g_tel.sourceName) - 1);
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

void BLEPower::onNotify(const uint8_t *data, size_t len) {
  int16_t p;
  if (_ftms) {
    // FTMS Indoor Bike Data (0x2AD2): flags then conditional fields.
    if (len < 4) return;
    uint16_t flags = (uint16_t)(data[0] | (data[1] << 8));
    size_t off = 2;
    if (!(flags & 0x0001)) off += 2;   // Instantaneous Speed (present when bit0 == 0)
    if (flags & 0x0002)   off += 2;    // Average Speed
    if (flags & 0x0004)   off += 2;    // Instantaneous Cadence
    if (flags & 0x0008)   off += 2;    // Average Cadence
    if (flags & 0x0010)   off += 3;    // Total Distance (uint24)
    if (flags & 0x0020)   off += 2;    // Resistance Level
    if (!(flags & 0x0040)) return;     // Instantaneous Power not present
    if (off + 2 > len) return;
    p = (int16_t)(data[off] | (data[off + 1] << 8));
  } else {
    // CPS Measurement (0x2A63): [flags:2][instantaneous power:int16 LE] ...
    if (len < 4) return;
    p = (int16_t)(data[2] | (data[3] << 8));
  }
  if (p < 0)    p = 0;
  if (p > 3000) return;   // reject implausible values
  _power     = (float)p;
  _powerTime = millis();
}

void BLEPower::onClientConnect() {
  _connected = true;
}

void BLEPower::onClientDisconnect() {
  _connected = false;
  Serial.println("[BLE] Disconnected");
  // No reconnect attempt is scheduled anymore (see update()), so the hub
  // settles into the disconnected state instead of lingering in a
  // reconnecting state that would never resolve.
  g_tel.state = DeviceState::DISCONNECTED;
  scheduleReconnect();   // inert today; hook for the future bounded strategy
}