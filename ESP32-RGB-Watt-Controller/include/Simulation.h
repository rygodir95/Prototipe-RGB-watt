#pragma once
#include <Arduino.h>

// Simulation mode: injects a user-defined value into the exact same
// processing pipeline as real BLE data. In Power mode the value is watts,
// in Heart Rate mode it is bpm.
class Simulation {
public:
  void set(bool enabled, float watts)   { _enabled = enabled; _watts = watts; }
  void setHr(bool enabled, float bpm)  { _enabled = enabled; _bpm = bpm; }
  void setWatts(float watts)           { _watts = watts; }
  void setBpm(float bpm)               { _bpm = bpm; }

  bool  enabled() const { return _enabled; }
  float watts()   const { return _watts; }
  float bpm()     const { return _bpm; }

private:
  bool  _enabled = false;
  float _watts   = 0.0f;
  float _bpm     = 0.0f;
};