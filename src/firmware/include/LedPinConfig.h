#pragma once
#include <ArduinoJson.h>
#include "LedPin.h"

inline void applyLedPinConfig(JsonObjectConst doc, int &pin) {
  JsonVariantConst value = doc["ledPin"];
  if (value.isUnbound()) return;  // An omitted field leaves the pin unchanged.
  if (!value.is<int>()) {
    Serial.printf("[API] Invalid ledPin (expected integer GPIO); falling back to GPIO%d\n",
                  DEFAULT_LED_PIN);
    pin = DEFAULT_LED_PIN;
    return;
  }
  pin = sanitizeLedPin(value.as<int>(), "API");
}
