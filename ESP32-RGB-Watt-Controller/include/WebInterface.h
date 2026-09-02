#pragma once
#include <Arduino.h>

// Async web server + WebSocket for the configuration UI and live telemetry.
class WebInterface {
public:
  void begin();
  void loop();                 // periodic housekeeping + telemetry broadcast
  size_t clientCount() const;

private:
  void setupRoutes();
  void broadcastTelemetry();
  uint32_t _lastBroadcast = 0;
  uint32_t _lastCleanup   = 0;
};

// Implemented in main.cpp: re-applies runtime-affecting config to subsystems.
void applyRuntimeConfig();
// Implemented in main.cpp: schedules a device reboot after `ms`.
void scheduleReboot(uint32_t ms);
