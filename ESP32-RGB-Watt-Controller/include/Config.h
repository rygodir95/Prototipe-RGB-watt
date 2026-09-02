#pragma once
#include <Arduino.h>

// Persistent configuration model for the RGB Watt Controller.
// A single flat struct is stored to NVS via Preferences.putBytes for robustness.

static const int   MAX_ZONES        = 7;
static const int   MIN_ZONES        = 5;
static const uint32_t CONFIG_VERSION = 0x52474204; // 'RGB' + version 4

enum LedType : uint8_t {
  LED_WS2812B = 0,
  LED_SK6812  = 1,
};

enum LedEffect : uint8_t {
  EFFECT_SOLID     = 0,
  EFFECT_BREATHING = 1,
  EFFECT_COMET     = 2,
};

struct Zone {
  char    name[24];
  int     minWatts;   // inclusive lower bound of the zone
  uint8_t r, g, b;    // representative colour of the zone
};

struct AppConfig {
  uint32_t version;

  // --- Power ---
  int ftp;             // Functional Threshold Power (W)
  int smoothing;       // 0..100 smoothing strength (EMA)
  int powerTimeoutMs;  // stale-data timeout before LEDs fade out
  int hysteresis;      // W of hysteresis around zone boundaries

  // --- Zones ---
  int  zoneCount;      // 5, 6 or 7
  Zone zones[MAX_ZONES];

  // --- LED ---
  int ledPin;
  int ledCount;
  int brightness;      // 0..100 %
  int ledType;         // LedType
  int ledEffect;       // LedEffect

  // --- BLE ---
  char sourceAddr[24];
  char sourceName[40];
  bool autoReconnect;

  // --- WiFi ---
  char wifiSsid[33];
  char wifiPass[65];

  // --- UI ---
  char theme[8];       // "light" | "dark" | "system"

  bool debug;
};

extern AppConfig g_config;

// Populate a config with factory defaults (FTP 221, 7 zones, GPIO5/60 WS2812B).
void configLoadDefaults(AppConfig &c);

// Regenerate the zones array for the current zoneCount from FTP-based defaults
// (names, boundaries and the default colour progression).
void configApplyDefaultZones(AppConfig &c);

// Proportionally rescale existing zone boundaries when FTP changes, preserving
// user-customised names and colours.
void configScaleZones(AppConfig &c, int oldFtp, int newFtp);

// Ensure zone boundaries are monotonically increasing and non-negative.
void configSanitizeZones(AppConfig &c);
