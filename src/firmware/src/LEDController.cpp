#include "LEDController.h"
#include "LedPin.h"
#include "RuntimeMetrics.h"

bool LEDController::ownsDriver() const {
#ifdef ESP32
  if (_ownerTask != xTaskGetCurrentTaskHandle()) {
    Runtime::record(Runtime::WrongLedTask);
    return false;
  }
#endif
  return true;
}

void LEDController::show() {
  Runtime::Scope timing(Runtime::LedShow);
  _strip->show();
  _lastShow = millis();
}

static uint16_t neoType(int type) {
  // SK6812 (RGBW) vs WS2812B (RGB), both 800kHz.
  return (type == 1) ? (NEO_GRBW + NEO_KHZ800) : (NEO_GRB + NEO_KHZ800);
}

void LEDController::rebuild() {
  Runtime::Scope timing(Runtime::LedRebuild);
  _pin = sanitizeLedPin(_pin, "RGB");
  if (_count < 1)   _count = 1;
  if (_count > 1000) _count = 1000;
  if (_strip) {
    if (_count < _strip->numPixels()) {
      _strip->clear();
      show();  // Clock zeros through the OLD length before deleting it.
    }
    delete _strip;
    _strip = nullptr;
  }
  _hasSolidFrame = false;
  _strip = new Adafruit_NeoPixel(_count, _pin, neoType(_type));
  if (_strip) {
    _strip->begin();
    _strip->clear();
    show();
    _ok = true;
  } else {
    _ok = false;
    Serial.println("[RGB] LED init failed (out of memory)");
  }
}

bool LEDController::begin(int pin, int count, int type, int brightnessPct) {
#ifdef ESP32
  if (!_ownerTask) _ownerTask = xTaskGetCurrentTaskHandle();
#endif
  if (!ownsDriver()) return false;
  _pin        = pin;
  _count      = count;
  _type       = type;
  _brightness = constrain(brightnessPct, 0, 100);
  rebuild();
  return _ok;
}

void LEDController::reconfigure(int pin, int count, int type) {
  if (!ownsDriver()) return;
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
  if (!ownsDriver()) return;
  uint32_t now = millis();
  // At most 30 FPS; long strips get at least as much idle time as wire time.
  const uint32_t wireMs = (_count * (_type == 1 ? 40u : 30u) + 999u) / 1000u;
  const uint32_t interval = max(33u, wireMs * 2u);
  if (now - _lastUpdate < interval || now - _lastShow < 10) return;
  float dt = (now - _lastUpdate) / 1000.0f;
  _lastUpdate = now;
  if (!_ok || !_strip) return;

  // Advance fade towards target (~600ms full fade).
  float step = dt / 0.6f;
  if (_fade < _fadeTarget) _fade = min(_fadeTarget, _fade + step);
  else if (_fade > _fadeTarget) _fade = max(_fadeTarget, _fade - step);

  float base = (_brightness / 100.0f) * _fade;   // 0..1 master scale
  bool rgbw = (_type == 1);

  // An inactive/black animation does not need repeated RMT transfers.
  if (base == 0 || (_r == 0 && _g == 0 && _b == 0)) {
    if (!_hasSolidFrame || _lastSolidFrame != 0) { _strip->clear(); show(); }
    _hasSolidFrame = true; _lastSolidFrame = 0;
    return;
  }

  if (_effect == 1) {                            // ---- BREATHING ----
    _hasSolidFrame = false;
    _animPhase += dt * 2.0f;                     // ~3.1s period
    if (_animPhase > TWO_PI) _animPhase -= TWO_PI;
    float breath = 0.25f + 0.75f * (0.5f + 0.5f * sinf(_animPhase));
    uint8_t r = (uint8_t)lroundf(_r * base * breath);
    uint8_t g = (uint8_t)lroundf(_g * base * breath);
    uint8_t b = (uint8_t)lroundf(_b * base * breath);
    uint32_t c = rgbw ? _strip->Color(r, g, b, 0) : _strip->Color(r, g, b);
    _strip->fill(c, 0, _count);
    show();
    return;
  }

  if (_effect == 2) {                            // ---- COMET ----
    _hasSolidFrame = false;
    float tail = max(3.0f, _count / 6.0f);
    _cometPos += dt * (_count * 0.6f + 4.0f);    // head speed (leds/sec)
    if (_count > 0) { while (_cometPos >= _count) _cometPos -= _count; }
    for (int i = 0; i < _count; i++) {
      float d = _cometPos - i;
      if (d < 0) d += _count;                    // distance behind head
      float inten = (d < tail) ? (1.0f - d / tail) : 0.0f;
      inten = inten * inten;                     // sharper tail
      float amb = 0.06f;                         // faint ambient trail colour
      float f = base * max(inten, amb);
      uint8_t r = (uint8_t)lroundf(_r * f);
      uint8_t g = (uint8_t)lroundf(_g * f);
      uint8_t b = (uint8_t)lroundf(_b * f);
      _strip->setPixelColor(i, rgbw ? _strip->Color(r, g, b, 0) : _strip->Color(r, g, b));
    }
    show();
    return;
  }

  // ---- SOLID (default) ----
  uint8_t r = (uint8_t)lroundf(_r * base);
  uint8_t g = (uint8_t)lroundf(_g * base);
  uint8_t b = (uint8_t)lroundf(_b * base);
  uint32_t color = rgbw ? _strip->Color(r, g, b, 0) : _strip->Color(r, g, b);
  if (_hasSolidFrame && color == _lastSolidFrame) return;
  _strip->fill(color, 0, _count);
  show();
  _lastSolidFrame = color;
  _hasSolidFrame = true;
}
