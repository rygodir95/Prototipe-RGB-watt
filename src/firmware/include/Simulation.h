#pragma once
#include <Arduino.h>
#include "LightingMailbox.h"

// Simulation mode: injects a user-defined value into the exact same
// processing pipeline as real BLE data. In Power mode the value is watts,
// in Heart Rate mode it is bpm.
class Simulation {
public:
  struct State { bool enabled = false; bool lightingTest = false; float watts = 0; float bpm = 0; };
  State snapshot() const { return _state.read(); }
  void set(bool enabled, float watts) { _state.access([&](State &s) { s.enabled = enabled; s.lightingTest = false; s.watts = watts; }); }
  void setHr(bool enabled, float bpm) { _state.access([&](State &s) { s.enabled = enabled; s.lightingTest = false; s.bpm = bpm; }); }
  void setWatts(float watts) { _state.access([&](State &s) { s.watts = watts; }); }
  void setBpm(float bpm) { _state.access([&](State &s) { s.bpm = bpm; }); }
  void patch(bool hr, bool hasEnabled, bool enabled, bool hasValue, float value,
             bool hasLightingTest = false, bool lightingTest = false) {
    _state.access([&](State &s) {
      // Explicit enables from ordinary simulation must not inherit test mode.
      if (hasEnabled) { s.enabled = enabled; s.lightingTest = false; }
      if (hasLightingTest) s.lightingTest = lightingTest;
      if (!s.enabled) s.lightingTest = false;
      if (hasValue) { if (hr) s.bpm = value; else s.watts = value; }
    });
  }

  bool enabled() const { return snapshot().enabled; }
  float watts() const { return snapshot().watts; }
  float bpm() const { return snapshot().bpm; }

private:
  LightingMailbox<State> _state;
};
