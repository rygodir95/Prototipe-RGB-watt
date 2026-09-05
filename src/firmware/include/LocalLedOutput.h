#pragma once
#include "LightingOutput.h"
#include "LEDController.h"

// Hub-local lighting output: wraps the existing WS2812B/SK6812 strip driver
// behind the LightingOutput interface. Driver behaviour is unchanged - only
// the call path goes through the LightingOutputManager now.
class LocalLedOutput : public LightingOutput {
public:
  // Hub-local hardware lifecycle (outside the LightingOutput contract).
  bool begin(int pin, int count, int type, int brightnessPct) {
    return _leds.begin(pin, count, type, brightnessPct);
  }
  void reconfigure(int pin, int count, int type) {
    _leds.reconfigure(pin, count, type);
  }

  const char* id()   const override { return "local-led"; }
  const char* name() const override { return "Hub LED Strip"; }
  bool isLocal()     const override { return true; }
  bool isAvailable() const override { return _leds.isOk(); }
  bool isEnabled()   const override { return _enabled; }
  void setEnabled(bool on) override {
    _enabled = on;
    if (!on) _leds.setActive(false);   // a disabled output fades out
  }
  void apply(const LightingState& state) override;
  void update() override { _leds.update(); }

private:
  LEDController _leds;
  bool          _enabled = true;
};