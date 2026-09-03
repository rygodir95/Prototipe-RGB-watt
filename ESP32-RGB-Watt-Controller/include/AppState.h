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
  bool        hasData     = false;   // valid, fresh measurement available
  bool        simMode     = false;
  uint8_t     controlSource = 0;     // mirrors g_config.controlSource

  // Power pipeline values (valid in Power mode)
  float       rawPower     = 0;
  float       smoothedPower = 0;

  // Heart Rate pipeline values (valid in Heart Rate mode)
  float       rawBpm      = 0;
  float       smoothedBpm = 0;

  int         zone         = 0;      // 0-based index of the ACTIVE source's zone
  uint8_t     r = 0, g = 0, b = 0;   // current interpolated colour (active source)
  char        sourceName[40] = "";
};

extern Telemetry g_tel;