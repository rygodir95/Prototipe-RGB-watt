#pragma once
#include <Arduino.h>

// Device state machine.
enum class DeviceState : uint8_t {
  STARTING = 0,
  SCANNING,
  CONNECTING,
  CONNECTED,
  RECEIVING_POWER,
  DISCONNECTED,
  RECONNECTING,
  ERROR
};

const char *deviceStateName(DeviceState s);

// Live telemetry shared between the processing pipeline and the web layer.
struct Telemetry {
  DeviceState state       = DeviceState::STARTING;
  bool        connected   = false;
  bool        hasData     = false;   // valid, fresh power available
  bool        simMode     = false;
  float       rawPower     = 0;
  float       smoothedPower = 0;
  int         zone         = 0;      // 0-based zone index
  uint8_t     r = 0, g = 0, b = 0;   // current interpolated colour
  char        sourceName[40] = "";
};

extern Telemetry g_tel;
