#pragma once
#include "Config.h"
#include <Preferences.h>

// Persists AppConfig to NVS (Preferences). Falls back to factory defaults when
// no valid/compatible configuration is stored.
class Storage {
public:
  void begin();
  void load(AppConfig &c);
  void save(const AppConfig &c);
  void factoryReset(AppConfig &c);

private:
  Preferences _prefs;
};
