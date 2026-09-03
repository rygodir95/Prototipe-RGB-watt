#pragma once
#include <Arduino.h>

// Persistent configuration model for the RGB Watt Controller.
// A single flat struct is stored to NVS via Preferences.putBytes for robustness.

static const int   MAX_ZONES        = 7;
static const int   MIN_ZONES        = 5;
static const int   MAX_HR_ZONES     = 5;
static const uint32_t CONFIG_VERSION = 0x52474205; // 'RGB' + version 5

enum LedType : uint8_t {
  LED_WS2812B = 0,
  LED_SK6812  = 1,
};

enum LedEffect : uint8_t {
  EFFECT_SOLID     = 0,
  EFFECT_BREATHING = 1,
  EFFECT_COMET     = 2,
};

// Active control source. Exactly ONE of these is active at any time; the
// firmware never scans, connects to or processes the other source.
enum ControlSource : uint8_t {
  SRC_POWER      = 0,
  SRC_HEART_RATE = 1,
};

struct Zone {
  char    name[24];
  int     minWatts;   // inclusive lower bound of the zone
  uint8_t r, g, b;    // representative colour of the zone
};

struct HRZone {
  char    name[24];
  int     minBpm;     // inclusive lower bound of the zone
  uint8_t r, g, b;    // representative colour of the zone
};

struct AppConfig {
  uint32_t version;

  // --- Control source (mutually exclusive operating modes) ---
  uint8_t controlSource;   // ControlSource: 0 = Power, 1 = Heart Rate

  // --- Power ---
  int ftp;             // Functional Threshold Power (W)
  int smoothing;       // 0..100 smoothing strength (EMA)
  int powerTimeoutMs;  // stale-data timeout before LEDs fade out
  int hysteresis;      // W (power) / bpm (HR) of hysteresis at zone boundaries

  // --- Power zones ---
  int  zoneCount;      // 5, 6 or 7
  Zone zones[MAX_ZONES];

  // --- Heart Rate ---
  int     hrMax;      // maximum heart rate (bpm), default 190
  HRZone  hrZones[MAX_HR_ZONES];

  // --- LED ---
  int ledPin;
  int ledCount;
  int brightness;      // 0..100 %
  int ledType;         // LedType
  int ledEffect;       // LedEffect

  // --- BLE (saved sources are kept separate per mode) ---
  char sourceAddr[24];     // saved Power source
  char sourceName[40];
  char hrSourceAddr[24];    // saved Heart Rate source
  char hrSourceName[40];
  bool autoReconnect;

  // --- WiFi ---
  char wifiSsid[33];
  char wifiPass[65];

  // --- UI ---
  char theme[8];       // "light" | "dark" | "system"

  bool debug;
};

extern AppConfig g_config;

// Populate a config with factory defaults (FTP 221, 7 zones, GPIO5/60 WS2812B,
// Max HR 190 with 5 percentage-based HR zones, Power as control source).
void configLoadDefaults(AppConfig &c);

// Regenerate the power zones array for the current zoneCount from FTP-based
// defaults (names, boundaries and the default colour progression).
void configApplyDefaultZones(AppConfig &c);

// Proportionally rescale existing zone boundaries when FTP changes, preserving
// user-customised names and colours.
void configScaleZones(AppConfig &c, int oldFtp, int newFtp);

// Ensure zone boundaries are monotonically increasing and non-negative.
void configSanitizeZones(AppConfig &c);

// HR zone equivalents: 5 zones from 50/60/70/80/90 % of Max HR.
void configApplyDefaultHrZones(AppConfig &c);
void configScaleHrZones(AppConfig &c, int oldMax, int newMax);
void configSanitizeHrZones(AppConfig &c);