#include "BleScanRouter.h"
#include "BLEPower.h"
#include "HRSensor.h"
#include <NimBLEDevice.h>

BleScanRouter *BleScanRouter::instance = nullptr;

// ---- Free callbacks (NimBLE task context) ------------------------------------

static void routerScanCompleteCB(NimBLEScanResults results) {
  (void)results;
  if (BleScanRouter::instance) BleScanRouter::instance->onScanEnd();
}

// The ONLY advertised-device callback registration in the firmware.
class ScanRouterCallbacks : public NimBLEAdvertisedDeviceCallbacks {
  void onResult(NimBLEAdvertisedDevice *dev) override {
    if (BleScanRouter::instance) BleScanRouter::instance->onScanResult(dev);
  }
};
static ScanRouterCallbacks g_routerScanCB;

// ---- BleScanRouter -----------------------------------------------------------

BleScanRouter::BleScanRouter() { instance = this; }

void BleScanRouter::begin(BLEPower *power, HRSensor *hr) {
  _power = power;
  _hr    = hr;
}

void BleScanRouter::startScan(int seconds) {
  if (_scanning) return;                 // one Scan action = one finite scan
  NimBLEScan *s = NimBLEDevice::getScan();
  s->setAdvertisedDeviceCallbacks(&g_routerScanCB, false);   // single owner
  s->setActiveScan(true);
  s->setInterval(100);
  s->setWindow(99);
  s->clearResults();
  // Both drivers prepare (drop stale results, mark scanning); the same
  // physical scan then feeds both categories' classification.
  if (_power) _power->onScanStart();
  if (_hr)    _hr->onScanStart();
  _scanning = true;
  Serial.println("[SCAN] Scanning for power and heart rate sensors...");
  s->start(seconds, routerScanCompleteCB, false);
}

void BleScanRouter::stopScan() {
  if (!_scanning) return;
  _scanning = false;
  NimBLEDevice::getScan()->stop();   // may synchronously fire the complete callback
  // The fan-out below is the same one onScanEnd performs; the _scanning
  // guard there keeps it from running twice.
  if (_power) _power->onScanEnd();
  if (_hr)    _hr->onScanEnd();
}

void BleScanRouter::onScanResult(NimBLEAdvertisedDevice *dev) {
  // Route EVERY advertiser to both drivers; each applies its own unchanged
  // classification gate (CPS/FTMS for power, 0x180D for heart rate). The
  // router itself never classifies.
  if (_power) _power->onScanResult(dev);
  if (_hr)    _hr->onScanResult(dev);
}

void BleScanRouter::onScanEnd() {
  // Guard: NimBLEScan::stop() can fire the complete callback synchronously,
  // and stopScan() fans out itself - the fan-out must run exactly once.
  if (!_scanning) return;
  _scanning = false;
  if (_power) _power->onScanEnd();
  if (_hr)    _hr->onScanEnd();
}