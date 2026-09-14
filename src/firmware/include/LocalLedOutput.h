#pragma once
#include "LightingOutput.h"
#include "LEDController.h"
#include "LightingMailbox.h"

// Hub-local lighting output: wraps the existing WS2812B/SK6812 strip driver
// behind the LightingOutput interface. Driver behaviour is unchanged - only
// the call path goes through the LightingOutputManager now.
class LocalLedOutput : public LightingOutput {
public:
  // Hub-local hardware lifecycle (outside the LightingOutput contract).
  bool begin(int pin, int count, int type, int brightnessPct) {
    const bool ok = _leds.begin(pin, count, type, brightnessPct);
    _pending.access([&](Pending &p) { p.available = ok; });
    return ok;
  }
  void reconfigure(int pin, int count, int type) {
    _pending.access([&](Pending &p) {
      p.pin = pin; p.count = count; p.type = type; p.reconfigure = true;
    });
  }

  const char* id()   const override { return "local-led"; }
  const char* name() const override { return "Hub LED Strip"; }
  bool isLocal()     const override { return true; }
  bool isAvailable() const override { return _pending.read().available; }
  bool isEnabled()   const override { return _pending.read().enabled; }
  void setEnabled(bool on) override {
    _pending.access([&](Pending &p) { p.enabled = on; });
  }
  void apply(const LightingState& state) override;
  void update() override;  // loop-task owner of all driver calls after begin()

private:
  LEDController _leds;
  struct Pending {
    LightingState state{};
    int pin = 5, count = 60, type = 0;
    bool reconfigure = false, enabled = true, available = false;
  };
  LightingMailbox<Pending> _pending;
};
