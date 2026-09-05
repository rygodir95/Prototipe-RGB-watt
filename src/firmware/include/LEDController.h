#pragma once
#include <Arduino.h>
#include <Adafruit_NeoPixel.h>

// Drives an addressable RGB strip (WS2812B / SK6812). Supports runtime
// reconfiguration of pin/count/type, brightness, and smooth fade in/out for
// the inactive (no-power) state.
class LEDController {
public:
  bool begin(int pin, int count, int type, int brightnessPct);
  void reconfigure(int pin, int count, int type);
  void setBrightnessPct(int pct);
  void setEffect(int effect) { _effect = effect; }
  void setColor(uint8_t r, uint8_t g, uint8_t b);
  void setActive(bool active);   // controls fade target (1=on, 0=off)
  void update();                 // non-blocking: advances fade + refreshes
  void getColor(uint8_t &r, uint8_t &g, uint8_t &b) const { r = _r; g = _g; b = _b; }
  bool isOk() const { return _ok; }   // hardware initialised (LightingOutput::isAvailable)

private:
  void rebuild();

  Adafruit_NeoPixel *_strip = nullptr;
  int      _pin        = 5;
  int      _count      = 60;
  int      _type       = 0;
  int      _brightness = 100;   // %
  int      _effect     = 0;     // LedEffect
  uint8_t  _r = 0, _g = 0, _b = 0;
  float    _fade       = 0.0f;  // current fade multiplier
  float    _fadeTarget = 0.0f;  // desired fade multiplier
  float    _animPhase  = 0.0f;  // breathing phase (radians)
  float    _cometPos   = 0.0f;  // comet head position
  uint32_t _lastUpdate = 0;
  bool     _ok         = false;
};