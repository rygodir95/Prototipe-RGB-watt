#pragma once
#include <Arduino.h>

// Lightweight Exponential Moving Average smoothing for instantaneous power.
class PowerProcessor {
public:
  void  setSmoothing(int strength0to100);
  void  reset();
  float update(float raw);   // feed a new raw sample, returns smoothed value
  float value() const { return _init ? _v : 0.0f; }

private:
  float _alpha = 0.3f;
  float _v     = 0.0f;
  bool  _init  = false;
};
