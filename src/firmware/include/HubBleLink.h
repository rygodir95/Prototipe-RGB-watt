#pragma once

#include <Arduino.h>
#include "Config.h"
#include "LightingMailbox.h"

class NimBLECharacteristic;

// Local BLE control link. The Hub remains the only BLE client of the training
// sensors; a phone or PC connects to this GATT server for telemetry and a
// deliberately small set of control commands.
class HubBleLink {
public:
  void begin();
  void loop();
  size_t clientCount() const;

  // Called by NimBLE callback adapters. They only enqueue bounded work; all
  // application state changes happen later on the Arduino loop task.
  void onWrite(NimBLECharacteristic *characteristic);
  void onConnect();
  void onDisconnect();

private:
  enum class CommandType : uint8_t { LightingTest, Simulation, Source, Diagnostics, Info, ConfigRead, ConfigWrite, ZoneWrite, ZoneBegin, ZoneStage, ZoneCommit, Scan, DevicesRead, SensorConnect, SensorDisconnect, SensorForget, FactoryReset };
  struct Command {
    CommandType type;
    uint32_t id;
    bool enabled;
    bool hasEnabled;
    bool hasValue;
    bool lightingTest;
    bool hasLightingTest;
    float value;
    uint8_t source;
    int16_t part;
    bool ackOnly;
    char patch[200];
  };
  struct Queue { Command items[8]; uint8_t head = 0, size = 0; };

  bool enqueue(const Command &command);
  bool take(Command &command);
  void sendResult(uint32_t id, bool ok, const char *error = nullptr);
  void sendConfig(uint32_t id, int16_t part = -1);
  void sendDevices(uint32_t id, int16_t part = -1);
  void publishStatus(bool force = false);
  void advanceLightingTest();

  NimBLECharacteristic *_status = nullptr;
  NimBLECharacteristic *_result = nullptr;
  LightingMailbox<Queue> _queue;
  uint32_t _lastStatus = 0;
  uint32_t _lastLightingTestStep = 0;
  String _previousStatus;
  uint8_t _clients = 0;
  uint8_t _lightingTestStep = 0;
  bool _lightingTestRunning = false;
  Zone _stagedPower[MAX_ZONES];
  HRZone _stagedHr[MAX_HR_ZONES];
  uint8_t _stageSource = SRC_POWER;
  uint8_t _stageExpected = 0;
  uint8_t _stageMask = 0;
  bool _stageActive = false;
  String _transferPayload;
  uint32_t _transferAt = 0;
  uint8_t _transferType = 0;
};

