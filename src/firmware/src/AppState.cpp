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
