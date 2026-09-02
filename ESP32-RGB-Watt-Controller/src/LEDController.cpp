#include "LEDController.h"

static uint16_t neoType(int type) {
  // SK6812 (RGBW) vs WS2812B (RGB), both 800kHz.
  return (type == 1) ? (NEO_GRBW + NEO_KHZ800) : (NEO_GRB + NEO_KHZ800);
}

void LEDController::rebuild() {
  if (_strip) { delete _strip; _strip = nullptr; }
  if (_count < 1)   _count = 1;
  if (_count > 1000) _count = 1000;
  _strip = new Adafruit_NeoPixel(_count, _pin, neoType(_type));
  if (_strip) {
    _strip->begin();
    _strip->clear();
    _strip->show();
    _ok = true;
  } else {
    _ok = false;
    Serial.println("[RGB] LED init failed (out of memory)");
  }
}

bool LEDController::begin(int pin, int count, int type, int brightnessPct) {
  _pin        = pin;
  _count      = count;
  _type       = type;
  _brightness = constrain(brightnessPct, 0, 100);
  rebuild();
  return _ok;
}

void LEDController::reconfigure(int pin, int count, int type) {
  if (pin == _pin && count == _count && type == _type && _strip) return;
  _pin   = pin;
  _count = count;
  _type  = type;
  rebuild();
}

void LEDController::setBrightnessPct(int pct) {
  _brightness = constrain(pct, 0, 100);
}

void LEDController::setColor(uint8_t r, uint8_t g, uint8_t b) {
  _r = r; _g = g; _b = b;
}

void LEDController::setActive(bool active) {
  _fadeTarget = active ? 1.0f : 0.0f;
}

void LEDController::update() {
  uint32_t now = millis();
  if (now - _lastUpdate < 16) return;   // ~60 FPS cap
  float dt = (now - _lastUpdate) / 1000.0f;
  _lastUpdate = now;
  if (!_ok || !_strip) return;

  // Advance fade towards target (~600ms full fade).
  float step = dt / 0.6f;
  if (_fade < _fadeTarget) _fade = min(_fadeTarget, _fade + step);
  else if (_fade > _fadeTarget) _fade = max(_fadeTarget, _fade - step);

  float eff = (_brightness / 100.0f) * _fade;
  uint8_t r = (uint8_t)lroundf(_r * eff);
  uint8_t g = (uint8_t)lroundf(_g * eff);
  uint8_t b = (uint8_t)lroundf(_b * eff);

  uint32_t color = (_type == 1)
    ? _strip->Color(r, g, b, 0)
    : _strip->Color(r, g, b);
  _strip->fill(color, 0, _count);
  _strip->show();
}
