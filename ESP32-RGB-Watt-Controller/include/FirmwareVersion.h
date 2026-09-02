#pragma once

// Semantic firmware version. Update on every release.
#define FW_VERSION       "1.0.0"
#define FW_VERSION_MAJOR 1
#define FW_VERSION_MINOR 0
#define FW_VERSION_PATCH 0
// Monotonic version code used for anti-rollback comparisons (10000*major + 100*minor + patch).
#define FW_VERSION_CODE  (10000 * FW_VERSION_MAJOR + 100 * FW_VERSION_MINOR + FW_VERSION_PATCH)

// Build type is selected by the PlatformIO environment (see platformio.ini).
//   esp32dev-dev  -> BUILD_DEV   (USB flashing, verbose logs, unsigned OTA allowed)
//   esp32dev-prod -> BUILD_PROD  (reduced logs, signed OTA enforced)
#if defined(BUILD_PROD)
  #define FW_BUILD_TYPE  "production"
  #define FW_VERSION_FULL FW_VERSION
#else
  #ifndef BUILD_DEV
    #define BUILD_DEV 1
  #endif
  #define FW_BUILD_TYPE  "development"
  #define FW_VERSION_FULL FW_VERSION "-dev"
#endif
