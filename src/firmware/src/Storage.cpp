#include "Storage.h"
#include "LedPin.h"

static const char *NS  = "rgbwatt";
static const char *KEY = "cfg";

void Storage::begin() {
  // Preferences opens per-operation; nothing persistent required here.
}

void Storage::load(AppConfig &c) {
  configLoadDefaults(c);
  if (!_prefs.begin(NS, true)) {           // read-only
    Serial.println("[STORE] NVS open failed, using defaults");
    return;
  }
  size_t sz = _prefs.getBytesLength(KEY);
  if (sz == sizeof(AppConfig)) {
    AppConfig tmp;
    _prefs.getBytes(KEY, &tmp, sizeof(AppConfig));
    if (tmp.version == CONFIG_VERSION) {
      c = tmp;
      c.ledPin = sanitizeLedPin(c.ledPin, "STORE");
      if (c.controlSource != SRC_POWER && c.controlSource != SRC_HEART_RATE) c.controlSource = SRC_POWER;
      configSanitizeZones(c);
      configSanitizeHrZones(c);
      Serial.println("[STORE] Configuration loaded");
    } else {
      Serial.println("[STORE] Config version mismatch, using defaults");
    }
  } else if (sz > 0) {
    Serial.println("[STORE] Config size mismatch, using defaults");
  } else {
    Serial.println("[STORE] No stored config, using defaults");
  }
  _prefs.end();
}

void Storage::save(const AppConfig &c) {
  // Saves can now originate from loop(); do not share an open Preferences
  // handle with other routes which persist their own settings.
  Preferences prefs;
  if (!prefs.begin(NS, false)) {          // read-write
    Serial.println("[STORE] NVS open failed on save");
    return;
  }
  prefs.putBytes(KEY, &c, sizeof(AppConfig));
  prefs.end();
  Serial.println("[STORE] Configuration saved");
}

void Storage::factoryReset(AppConfig &c) {
  if (_prefs.begin(NS, false)) {
    _prefs.clear();
    _prefs.end();
  }
  configLoadDefaults(c);
  save(c);
  Serial.println("[STORE] Factory reset complete");
}
