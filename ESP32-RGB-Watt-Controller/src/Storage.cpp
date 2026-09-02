#include "Storage.h"

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
      configSanitizeZones(c);
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
  if (!_prefs.begin(NS, false)) {          // read-write
    Serial.println("[STORE] NVS open failed on save");
    return;
  }
  _prefs.putBytes(KEY, &c, sizeof(AppConfig));
  _prefs.end();
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
