#pragma once

#include <Arduino.h>
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
  enum class CommandType : uint8_t { LightingTest, Simulation, Source, Diagnostics };
  struct Command {
    CommandType type;
    uint32_t id;
    bool enabled;
    float value;
    uint8_t source;
  };
  struct Queue { Command items[8]; uint8_t head = 0, size = 0; };

  bool enqueue(const Command &command);
  bool take(Command &command);
  void sendResult(uint32_t id, bool ok, const char *error = nullptr);
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
};

