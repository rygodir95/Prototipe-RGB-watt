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

// ---- Teardown-settle gate (control-source switching) ------------------------
// NimBLEClient::disconnect() is asynchronous: the link stays on the air
// until the host has processed the DISCONNECT event. With
// CONFIG_BT_NIMBLE_MAX_CONNECTIONS=1 a new source's connect attempt that
// starts before the OLD source's link is actually gone fails with
// BLE_HS_ENOMEM (rc=6). On every category switch, setControlSource()
// registers the old module's link probe here when its link was still
// active; the new source's one-shot connect executor
// (BLEPower::update / HRSensor::update) then holds its single pending
// attempt - WITHOUT consuming it - until bleTeardownSettling() reports the
// old link gone. No scans, no retries, no blocking: one Connect action still
// produces exactly one connection attempt, just sequenced after the old
// disconnect completes. Without a registration the gate is open (direct
// same-category connects stay immediate).

typedef bool (*LinkProbe)();               // live link state of the old module
void bleNoteTeardown(LinkProbe probe);      // register at switch time
bool bleTeardownSettling();                 // true while the old link is still terminating