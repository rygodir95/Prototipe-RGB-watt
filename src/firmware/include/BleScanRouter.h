#pragma once
#include <Arduino.h>

class BLEPower;
class HRSensor;
class NimBLEAdvertisedDevice;

// Single owner of the shared NimBLEScan instance. One user Scan action
// produces exactly ONE physical finite scan; every advertiser is forwarded
// to all supported sensor drivers for classification (Power CPS/FTMS via
// BLEPower, Heart Rate HRS via HRSensor). This is the ONLY place in the
// firmware that registers an advertised-device callback, so the previous
// hazard - each driver's startScan() silently overwriting the other's
// callback on the shared scan object - is structurally impossible now.
class BleScanRouter {
public:
  static BleScanRouter *instance;

  BleScanRouter();

  void begin(BLEPower *power, HRSensor *hr);   // called once from setup()

  // One finite unified scan (default 6 s). Re-entry while a scan is running
  // is refused; nothing here ever restarts a scan by itself.
  void startScan(int seconds = 6);
  bool isScanning() const { return _scanning; }
  void stopScan();

  // Invoked from NimBLE tasks via the router's free callbacks.
  void onScanResult(NimBLEAdvertisedDevice *dev);
  void onScanEnd();

  // Driver-facing helpers (the drivers hold no router reference).
  static void unifiedScan(int seconds) { if (instance) instance->startScan(seconds); }
  static void stop()                   { if (instance) instance->stopScan(); }

private:
  BLEPower *_power    = nullptr;
  HRSensor *_hr       = nullptr;
  bool     _scanning  = false;
};