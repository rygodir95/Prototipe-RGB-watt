#include "Config.h"
#include "FirmwareVersion.h"

AppConfig g_config;

// Coggan-style zone lower bounds as a percentage of FTP for 5/6/7 zone models.
static const int PCT_7[7] = { 0, 56, 76, 91, 106, 121, 151 };
static const int PCT_6[6] = { 0, 56, 76, 91, 106, 121 };
static const int PCT_5[5] = { 0, 56, 76, 91, 106 };

static const char *NAMES_7[7] = {
  "Z1 · Recovery", "Z2 · Endurance", "Z3 · Tempo", "Z4 · Threshold",
  "Z5 · VO₂ Max", "Z6 · Anaerobic", "Z7 · Neuromuscular"
};
static const char *NAMES_6[6] = {
  "Z1 · Recovery", "Z2 · Endurance", "Z3 · Tempo", "Z4 · Threshold",
  "Z5 · VO₂ Max", "Z6 · Anaerobic"
};
static const char *NAMES_5[5] = {
  "Z1 · Recovery", "Z2 · Endurance", "Z3 · Tempo", "Z4 · Threshold", "Z5 · VO₂ Max"
};

struct RGB { uint8_t r, g, b; };
// Blue -> Cyan -> Green -> Yellow -> Orange -> Red -> Deep Red
static const RGB COLORS_7[7] = {
  {  0,  90, 255}, {  0, 200, 200}, {  0, 220,  70}, {255, 220,   0},
  {255, 120,   0}, {255,  25,   0}, {150,   0,   0}
};
static const RGB COLORS_6[6] = {
  {  0,  90, 255}, {  0, 200, 200}, {  0, 220,  70}, {255, 220,   0},
  {255, 120,   0}, {255,  25,   0}
};
static const RGB COLORS_5[5] = {
  {  0,  90, 255}, {  0, 200, 200}, {  0, 220,  70}, {255, 140,   0},
  {255,  25,   0}
};

// Heart-rate zones: lower bounds at 50/60/70/80/90 % of Max HR
// (Z1 spans everything below 60 %, Z5 everything at or above 90 %).
static const int HR_PCT[MAX_HR_ZONES]     = { 50, 60, 70, 80, 90 };
static const char *HR_NAMES[MAX_HR_ZONES] = {
  "Z1 · Recovery", "Z2 · Endurance", "Z3 · Tempo", "Z4 · Threshold", "Z5 · Maximum"
};
static const RGB HR_COLORS[MAX_HR_ZONES] = {
  {120, 130, 255}, {  0, 190, 255}, {  0, 230, 120},
  {255, 200,   0}, {255,  40,  40}
};

void configApplyDefaultZones(AppConfig &c) {
  const int *pct;
  const char **names;
  const RGB *colors;
  switch (c.zoneCount) {
    case 5:  pct = PCT_5; names = NAMES_5; colors = COLORS_5; break;
    case 6:  pct = PCT_6; names = NAMES_6; colors = COLORS_6; break;
    default: c.zoneCount = 7; pct = PCT_7; names = NAMES_7; colors = COLORS_7; break;
  }
  for (int i = 0; i < c.zoneCount; i++) {
    strncpy(c.zones[i].name, names[i], sizeof(c.zones[i].name) - 1);
    c.zones[i].name[sizeof(c.zones[i].name) - 1] = '\0';
    c.zones[i].minWatts = (int)lroundf(pct[i] / 100.0f * c.ftp);
    c.zones[i].r = colors[i].r;
    c.zones[i].g = colors[i].g;
    c.zones[i].b = colors[i].b;
  }
  configSanitizeZones(c);
}

void configScaleZones(AppConfig &c, int oldFtp, int newFtp) {
  if (oldFtp <= 0 || newFtp <= 0) return;
  float ratio = (float)newFtp / (float)oldFtp;
  for (int i = 0; i < c.zoneCount; i++) {
    c.zones[i].minWatts = (int)lroundf(c.zones[i].minWatts * ratio);
  }
  configSanitizeZones(c);
}

void configSanitizeZones(AppConfig &c) {
  if (c.zoneCount < MIN_ZONES) c.zoneCount = MIN_ZONES;
  if (c.zoneCount > MAX_ZONES) c.zoneCount = MAX_ZONES;
  if (c.zones[0].minWatts < 0) c.zones[0].minWatts = 0;
  for (int i = 1; i < c.zoneCount; i++) {
    if (c.zones[i].minWatts <= c.zones[i - 1].minWatts) {
      c.zones[i].minWatts = c.zones[i - 1].minWatts + 1;
    }
  }
}

void configApplyDefaultHrZones(AppConfig &c) {
  for (int i = 0; i < MAX_HR_ZONES; i++) {
    strncpy(c.hrZones[i].name, HR_NAMES[i], sizeof(c.hrZones[i].name) - 1);
    c.hrZones[i].name[sizeof(c.hrZones[i].name) - 1] = '\0';
    c.hrZones[i].minBpm = (int)lroundf(HR_PCT[i] / 100.0f * c.hrMax);
    c.hrZones[i].r = HR_COLORS[i].r;
    c.hrZones[i].g = HR_COLORS[i].g;
    c.hrZones[i].b = HR_COLORS[i].b;
  }
  configSanitizeHrZones(c);
}

void configScaleHrZones(AppConfig &c, int oldMax, int newMax) {
  if (oldMax <= 0 || newMax <= 0) return;
  float ratio = (float)newMax / (float)oldMax;
  for (int i = 0; i < MAX_HR_ZONES; i++) {
    c.hrZones[i].minBpm = (int)lroundf(c.hrZones[i].minBpm * ratio);
  }
  configSanitizeHrZones(c);
}

void configSanitizeHrZones(AppConfig &c) {
  if (c.hrMax < 100) c.hrMax = 100;
  if (c.hrMax > 230) c.hrMax = 230;
  if (c.hrZones[0].minBpm < 0) c.hrZones[0].minBpm = 0;
  for (int i = 1; i < MAX_HR_ZONES; i++) {
    if (c.hrZones[i].minBpm <= c.hrZones[i - 1].minBpm) {
      c.hrZones[i].minBpm = c.hrZones[i - 1].minBpm + 1;
    }
  }
}

void configLoadDefaults(AppConfig &c) {
  memset(&c, 0, sizeof(AppConfig));
  c.version        = CONFIG_VERSION;

  c.controlSource  = SRC_POWER;

  c.ftp            = 221;
  c.smoothing      = 45;
  c.powerTimeoutMs = 5000;
  c.hysteresis     = 5;

  c.zoneCount      = 7;

  c.hrMax          = 190;

  c.ledPin         = 5;
  c.ledCount       = 60;
  c.brightness     = 100;
  c.ledType        = LED_WS2812B;
  c.ledEffect      = EFFECT_SOLID;

  c.sourceAddr[0]  = '\0';
  c.sourceName[0]  = '\0';
  c.hrSourceAddr[0]  = '\0';
  c.hrSourceName[0]  = '\0';
  c.autoReconnect  = true;

  c.wifiSsid[0]    = '\0';
  c.wifiPass[0]    = '\0';

  strncpy(c.theme, "dark", sizeof(c.theme) - 1);
#if defined(BUILD_PROD)
  c.debug          = false;   // production reduces logging by default
#else
  c.debug          = true;
#endif

  configApplyDefaultZones(c);
  configApplyDefaultHrZones(c);
}