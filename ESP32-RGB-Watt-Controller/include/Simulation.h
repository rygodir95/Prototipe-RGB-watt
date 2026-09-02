#pragma once
#include <Arduino.h>

// Simulation mode: injects a user-defined wattage into the exact same
// processing pipeline as real BLE power data.
class Simulation {
public:
  void set(bool enabled, float watts) { _enabled = enabled; _watts = watts; }
  void setWatts(float watts)          { _watts = watts; }
  bool  enabled() const { return _enabled; }
  float watts()   const { return _watts; }

private:
  bool  _enabled = false;
  float _watts   = 0.0f;
};
