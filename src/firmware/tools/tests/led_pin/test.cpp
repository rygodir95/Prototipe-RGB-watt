#include <cassert>
#include <climits>
#include <iostream>
#include "Storage.h"
#include "LEDController.h"
#include "LedPinConfig.h"

TestSerial Serial;
std::vector<unsigned char> storedConfig;
std::vector<int> driverPins;

static void expectFallbackLog(const char *source) {
  assert(Serial.log.find(std::string("[") + source + "] Invalid ledPin") != std::string::npos);
  assert(Serial.log.find("falling back to GPIO5") != std::string::npos);
}

static void checkPin(int input, int expected) {
  Storage storage;
  AppConfig saved, loaded;
  configLoadDefaults(saved);
  saved.ledPin = input;
  saved.ledCount = 81;
  saved.brightness = 37;
  storage.save(saved);
  Serial.log.clear();
  storage.load(loaded);
  assert(loaded.ledPin == expected);
  assert(loaded.ledCount == 81 && loaded.brightness == 37);
  if (input != expected) expectFallbackLog("STORE");

  JsonDocument doc;
  doc["ledPin"] = input;
  int pin = 18;
  Serial.log.clear();
  applyLedPinConfig(doc.as<JsonObjectConst>(), pin);
  assert(pin == expected);
  if (input != expected) expectFallbackLog("API");
  // The API value is safe before save and stays safe after reboot.
  loaded.ledPin = pin;
  storage.save(loaded);
  storage.load(loaded);
  assert(loaded.ledPin == expected);

  LEDController leds;
  Serial.log.clear();
  assert(leds.begin(input, 60, 0, 100));
  assert(driverPins.back() == expected);
  if (input != expected) expectFallbackLog("RGB");
  leds.reconfigure(18, 60, 0);
  Serial.log.clear();
  leds.reconfigure(input, 61, 1);
  assert(driverPins.back() == expected);
  if (input != expected) expectFallbackLog("RGB");
}

int main() {
  const int valid[] = {0,1,2,3,4,5,12,13,14,15,16,17,18,19,21,22,23,25,26,27,32,33};
  for (int pin = -10; pin <= 300; ++pin) {
    bool allowed = std::find(std::begin(valid), std::end(valid), pin) != std::end(valid);
    assert(ledPinIsValid(pin) == allowed);
    checkPin(pin, allowed ? pin : 5);
  }
  checkPin(INT_MIN, 5);
  checkPin(INT_MAX, 5);
  // No integer coercion/truncation/wraparound from malformed JSON values.
  for (const char *json : {"null", "true", "false", "\"5\"", "\"bad\"",
                           "5.5", "[]", "{}", "2147483648", "4294967301",
                           "-2147483649", "1e100"}) {
    JsonDocument doc;
    std::string body = std::string("{\"ledPin\":") + json + "}";
    assert(!deserializeJson(doc, body));
    int pin = 18;
    Serial.log.clear();
    applyLedPinConfig(doc.as<JsonObjectConst>(), pin);
    assert(pin == 5);
    expectFallbackLog("API");
  }
  JsonDocument omitted;
  assert(!deserializeJson(omitted, "{\"brightness\":42}"));
  int pin = 18;
  Serial.log.clear();
  applyLedPinConfig(omitted.as<JsonObjectConst>(), pin);
  assert(pin == 18 && Serial.log.empty());
  for (int driverPin : driverPins) assert(ledPinIsValid(driverPin));
  std::cout << "LED pin regression tests passed (storage, API, driver begin/reconfigure)\n";
}
