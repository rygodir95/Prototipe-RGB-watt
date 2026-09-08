#pragma once
#include <Arduino.h>
#include <vector>
#include <string>

class NimBLEClient;
class NimBLEAdvertisedDevice;

struct HRDeviceInfo {
  std::string address;
  std::string name;
  std::string type;   // "HRS"
  int         rssi;
};

// BLE Heart Rate Service (HRS) client. Classifies unified-scan results,
// connects to and receives notifications from any device exposing service
// 0x180D / characteristic 0x2A37. Physical scanning is owned by BleScanRouter;
// connecting/processing stay mutually exclusive with BLEPower: only the module
// matching the active ControlSource ever connects or runs.
class HRSensor {
public:
  static HRSensor *instance;

  HRSensor();
  void begin();      // registers NimBLE callbacks; NimBLE init is owned by BLEPower
  void update();     // call from loop() when HR is the active source

  void startScan(int seconds = 6);   // delegates to the unified BleScanRouter
  bool isScanning() const { return _scanning; }

  // Unified-scan hooks, invoked by BleScanRouter (the single scan owner):
  void onScanStart();                                // drop stale results, mark scanning
  void onScanResult(NimBLEAdvertisedDevice *dev);    // unchanged HRS classification (+ dev diag)
  std::vector<HRDeviceInfo> getDevices();

  void connectToAddress(const std::string &addr, const std::string &name);
  void disconnect();
  void forget();
  void shutdown();   // full stop: scan, connection, reconnect desire, device list

  void setAutoReconnect(bool v) { _autoReconnect = v; }

  bool     isConnected() const { return _connected; }
  float    getBpm()      const { return _bpm; }
  uint32_t getBpmTime()  const { return _bpmTime; }

  // callbacks invoked from NimBLE tasks / free callbacks
  void onDeviceFound(const std::string &addr, const std::string &name, const std::string &type, int rssi);
  void onScanEnd();
  void onNotify(const uint8_t *data, size_t len);
  void onClientConnect();
  void onClientDisconnect();

private:
  bool connectInternal(const std::string &addr);
  void scheduleReconnect();

  NimBLEClient *_client = nullptr;

  volatile float    _bpm     = 0;
  volatile uint32_t _bpmTime = 0;

  bool _scanning      = false;
  bool _connected     = false;
  bool _desired        = false;   // user wants a connection to _targetAddr
  bool _autoReconnect = true;
  bool _doConnect     = false;    // deferred connect flag (executed in update())

  std::string _targetAddr;
  std::string _targetName;

  uint32_t _lastReconnectAttempt = 0;
  std::vector<HRDeviceInfo> _devices;
};