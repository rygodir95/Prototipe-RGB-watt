#pragma once
#include <Arduino.h>
#include "FirmwareVersion.h"

// Build-aware logging. Verbose logs are compiled out in production; all logging
// additionally respects the runtime debug flag. NEVER log secrets/keys.
extern bool g_logEnabled;

#if defined(BUILD_PROD)
  #define LOG_VERBOSE_ENABLED 0
#else
  #define LOG_VERBOSE_ENABLED 1
#endif

// Always-available informational log (gated by runtime debug flag).
#define LOGI(fmt, ...)  do { if (g_logEnabled) Serial.printf(fmt "\n", ##__VA_ARGS__); } while (0)

// Verbose/debug log (compiled out entirely in production builds).
#if LOG_VERBOSE_ENABLED
  #define LOGV(fmt, ...) do { if (g_logEnabled) Serial.printf(fmt "\n", ##__VA_ARGS__); } while (0)
#else
  #define LOGV(fmt, ...) do {} while (0)
#endif
