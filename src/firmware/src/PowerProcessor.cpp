#include "PowerProcessor.h"

void PowerProcessor::setSmoothing(int strength) {
  if (strength < 0)   strength = 0;
  if (strength > 100) strength = 100;
  // strength 0 -> alpha 1.0 (no smoothing); 100 -> alpha 0.05 (heavy smoothing)
  _alpha = 1.0f - (strength / 100.0f) * 0.95f;
}

void PowerProcessor::reset() {
  _init = false;
  _v    = 0.0f;
}

float PowerProcessor::update(float raw) {
  if (!_init) {
    _v    = raw;
    _init = true;
  } else {
    _v = _alpha * raw + (1.0f - _alpha) * _v;
  }
  return _v;
}
