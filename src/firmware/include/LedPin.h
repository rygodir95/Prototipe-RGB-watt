#pragma once
#include <Arduino.h>

static constexpr int DEFAULT_LED_PIN = 5;

// Classic ESP32 (esp32dev): only existing, output-capable GPIOs, excluding
// GPIO6-11 used by SPI flash. Strapping pins remain configurable.
inline bool ledPinIsValid(int pin) {
  return (pin >= 0 && pin <= 5) || (pin >= 12 && pin <= 19) ||
         (pin >= 21 && pin <= 23) || (pin >= 25 && pin <= 27) ||
         (pin >= 32 && pin <= 33);
}

inline int sanitizeLedPin(int pin, const char *source) {
  if (ledPinIsValid(pin)) return pin;
  Serial.printf("[%s] Invalid ledPin %d; falling back to GPIO%d\n",
                source, pin, DEFAULT_LED_PIN);
  return DEFAULT_LED_PIN;
}
