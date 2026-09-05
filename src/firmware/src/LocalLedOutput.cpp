#include "LocalLedOutput.h"

void LocalLedOutput::apply(const LightingState& state) {
  // Same driver calls the pipeline used to make directly. The setters are
  // idempotent, so re-applying brightness/effect each tick is free.
  _leds.setBrightnessPct(state.brightness);
  _leds.setEffect(state.effect);
  _leds.setColor(state.r, state.g, state.b);
  _leds.setActive(state.active);
}