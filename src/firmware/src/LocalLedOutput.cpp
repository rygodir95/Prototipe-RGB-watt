#include "LocalLedOutput.h"

void LocalLedOutput::apply(const LightingState& state) {
  _pending.access([&](Pending &p) { p.state = state; });
}

void LocalLedOutput::update() {
  Pending next;
  _pending.access([&](Pending &p) { next = p; p.reconfigure = false; });
  // No locks are held across allocation, show(), or RMT driver operations.
  if (next.reconfigure) {
    _leds.reconfigure(next.pin, next.count, next.type);
    const bool ok = _leds.isOk();
    _pending.access([&](Pending &p) { p.available = ok; });
  }
  _leds.setBrightnessPct(next.state.brightness);
  _leds.setEffect(next.state.effect);
  _leds.setColor(next.state.r, next.state.g, next.state.b);
  _leds.setActive(next.enabled && next.state.active);
  _leds.update();
}
