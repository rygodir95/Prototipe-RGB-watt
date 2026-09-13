#pragma once
#include <cstdint>
#include <vector>
static const int NEO_GRBW = 1, NEO_GRB = 2, NEO_KHZ800 = 0;
extern std::vector<int> driverPins;
class Adafruit_NeoPixel {
public:
  Adafruit_NeoPixel(int, int pin, uint16_t) { driverPins.push_back(pin); }
  void begin() {}
  void clear() {}
  void show() {}
  uint32_t Color(uint8_t, uint8_t, uint8_t, uint8_t = 0) { return 0; }
  void fill(uint32_t, int, int) {}
  void setPixelColor(int, uint32_t) {}
};
