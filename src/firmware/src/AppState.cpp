#include "AppState.h"

Telemetry g_tel;

const char *deviceStateName(DeviceState s) {
  switch (s) {
    case DeviceState::STARTING:        return "STARTING";
    case DeviceState::SCANNING:        return "SCANNING";
    case DeviceState::CONNECTING:      return "CONNECTING";
    case DeviceState::CONNECTED:       return "CONNECTED";
    case DeviceState::RECEIVING_POWER: return "RECEIVING_POWER";
    case DeviceState::DISCONNECTED:    return "DISCONNECTED";
    case DeviceState::RECONNECTING:    return "RECONNECTING";
    case DeviceState::ERROR:           return "ERROR";
  }
  return "UNKNOWN";
}

// ---- Teardown-settle gate ----------------------------------------------------
// See AppState.h. A local terminate always ends in a host DISCONNECT event,
// but should that event ever be lost, the bounded fallback below lets the
// held single connect attempt proceed after BLE_TEARDOWN_TIMEOUT_MS instead
// of hanging forever. Non-blocking: the gate only reads and clears state.

static const uint32_t BLE_TEARDOWN_TIMEOUT_MS = 5000;

static portMUX_TYPE g_teardownMux = portMUX_INITIALIZER_UNLOCKED;
static LinkProbe s_teardownProbe = nullptr;
static uint32_t s_teardownStartMs = 0;

void bleNoteTeardown(LinkProbe probe) {
  portENTER_CRITICAL(&g_teardownMux);
  s_teardownProbe   = probe;
  s_teardownStartMs = millis();
  portEXIT_CRITICAL(&g_teardownMux);
}

bool bleTeardownSettling() {
  portENTER_CRITICAL(&g_teardownMux);
  LinkProbe probe  = s_teardownProbe;
  uint32_t started = s_teardownStartMs;
  portEXIT_CRITICAL(&g_teardownMux);
  if (!probe) return false;                        // gate open: nothing to wait for
  if (probe() && millis() - started < BLE_TEARDOWN_TIMEOUT_MS) return true;
  // Old link gone (or the bounded fallback expired): open and disarm the
  // gate - the held one-shot connect proceeds exactly once, no retry.
  portENTER_CRITICAL(&g_teardownMux);
  s_teardownProbe = nullptr;
  portEXIT_CRITICAL(&g_teardownMux);
  return false;
}