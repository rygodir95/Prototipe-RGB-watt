#pragma once

#include <Arduino.h>

#include "Config.h"
#include "HubBleTransfer.h"

class NimBLECharacteristic;
class NimBLEServer;

// Local BLE control link (GATT server). The Hub stays the only BLE CENTRAL of
// the training sensors; a phone or PC connects to this server for telemetry and
// a deliberately small set of control commands.
//
// The server coexists with the sensor central role: one connection for the
// selected sensor, one for the control client
// (CONFIG_BT_NIMBLE_MAX_CONNECTIONS = 2).
class HubBleLink {
public:
  // Creates the service/characteristics and starts advertising.
  // Returns false when the service or advertising could not be created; the
  // caller reports that instead of assuming success.
  bool begin();
  void loop();
  size_t clientCount() const { return _clients; }
  bool advertising() const { return _advertising; }
  const char *advertisedName() const { return ADVERTISED_NAME; }

  // Called by the NimBLE callback adapters. They only enqueue bounded work;
  // every application state change happens later on the Arduino loop task.
  void onWrite(NimBLECharacteristic *characteristic);
  void onConnect();
  void onDisconnect();

  static constexpr const char *ADVERTISED_NAME = "Training Hub";

private:
  enum class CommandType : uint8_t {
    Simulation, Diagnostics, Info, ConfigRead, ConfigWrite,
    ZoneBegin, ZoneStage, ZoneCommit, Scan, DevicesRead,
    SensorConnect, SensorDisconnect, SensorForget, FactoryReset
  };
  struct Command {
    CommandType type;
    uint32_t id;
    bool enabled;
    bool hasEnabled;
    float value;
    uint8_t source;
    int16_t part;
    int32_t transfer;
    bool ackOnly;
    char patch[200];
  };
  struct Queue {
    Command items[8];
    uint8_t head = 0;
    uint8_t size = 0;
  };

  bool enqueue(const Command &command);
  bool take(Command &command);

  void sendResult(uint32_t id, bool ok, const char *error = nullptr);
  void sendPaged(uint32_t id, HubBleTransfer::Kind kind, const char *payload,
                 int32_t part, int32_t transfer);
  void sendPage(uint32_t id, HubBleTransfer::Kind kind, int32_t part, int32_t transfer);
  void sendConfig(uint32_t id, int32_t part, int32_t transfer);
  void sendDevices(uint32_t id, int32_t part, int32_t transfer);

  void configureAdvertising();
  bool startAdvertising(bool restart);
  void publishStatus(bool force = false);
  void handleCommand(const Command &command);

  NimBLECharacteristic *_status = nullptr;
  NimBLECharacteristic *_result = nullptr;
  NimBLEServer         *_server = nullptr;

  uint32_t _lastStatus = 0;
  String   _previousStatus;
  uint8_t  _clients = 0;
  bool     _advertising = false;

  // Independent paged-transfer slots: config_read and devices_read never
  // share state (see HubBleTransfer).
  HubBleTransfer _transfer;

  Zone     _stagedPower[MAX_ZONES];
  HRZone   _stagedHr[MAX_HR_ZONES];
  uint8_t  _stageSource = SRC_POWER;
  uint8_t  _stageExpected = 0;
  uint8_t  _stageMask = 0;
  bool     _stageActive = false;

  // Producers run in the NimBLE task, the consumer in the Arduino loop task:
  // the queue is only ever touched inside this critical section.
  Queue _queue;
  portMUX_TYPE _queueMux = portMUX_INITIALIZER_UNLOCKED;
};
