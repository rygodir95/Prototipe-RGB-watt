#pragma once
#include <Arduino.h>
#include <vector>
#include <string>

class NimBLEClient;

struct BLEDeviceInfo {
  std::string address;
  std::string name;
  int         rssi;
};

// BLE Cycling Power Service (CPS) client. Scans for, connects to and receives
// notifications from any device exposing service 0x1818 / characteristic 0x2A63.
class BLEPower {
public:
  static BLEPower *instance;

  BLEPower();
  void begin();
  void update();                                   // call from loop(); non-blocking driver

  void startScan(int seconds = 6);
  bool isScanning() const { return _scanning; }
  std::vector<BLEDeviceInfo> getDevices();

  void connectToAddress(const std::string &addr, const std::string &name);
  void disconnect();
  void forget();

  void setAutoReconnect(bool v) { _autoReconnect = v; }

  bool     isConnected() const { return _connected; }
  float    getPower()    const { return _power; }
  uint32_t getPowerTime() const { return _powerTime; }

  // callbacks invoked from NimBLE tasks / free callbacks
  void onDeviceFound(const std::string &addr, const std::string &name, int rssi);
  void onScanEnd();
  void onNotify(const uint8_t *data, size_t len);
  void onClientConnect();
  void onClientDisconnect();

private:
  bool connectInternal(const std::string &addr);
  void scheduleReconnect();

  NimBLEClient *_client = nullptr;

  volatile float    _power     = 0;
  volatile uint32_t _powerTime = 0;

  bool _scanning     = false;
  bool _connected    = false;
  bool _desired      = false;   // user wants a connection to _targetAddr
  bool _autoReconnect = true;
  bool _doConnect    = false;   // deferred connect flag (executed in update())

  std::string _targetAddr;
  std::string _targetName;

  uint32_t _lastReconnectAttempt = 0;
  std::vector<BLEDeviceInfo> _devices;
};
