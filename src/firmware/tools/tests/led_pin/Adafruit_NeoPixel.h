#pragma once
#include <cstdint>
#include <vector>
#include <map>
#include <string>
#include <functional>
static const int NEO_GRBW = 1, NEO_GRB = 2, NEO_KHZ800 = 0;
extern std::vector<int> driverPins;
struct StripEvent { std::string op; int pin; size_t count; };
inline std::vector<StripEvent>& stripEvents() { static std::vector<StripEvent> v; return v; }
inline std::map<int,std::vector<uint32_t>>& physicalLeds() { static std::map<int,std::vector<uint32_t>> v; return v; }
inline std::function<void()>& showHook() { static std::function<void()> fn; return fn; }
class Adafruit_NeoPixel {
  int _pin;
  std::vector<uint32_t> _pixels;
public:
  Adafruit_NeoPixel(int count, int pin, uint16_t) : _pin(pin), _pixels(count) { driverPins.push_back(pin); }
  ~Adafruit_NeoPixel() { stripEvents().push_back({"delete", _pin, _pixels.size()}); }
  uint16_t numPixels() const { return _pixels.size(); }
  void begin() {}
  void clear() { std::fill(_pixels.begin(), _pixels.end(), 0); }
  void show() {
    stripEvents().push_back({"show", _pin, _pixels.size()});
    auto &physical = physicalLeds()[_pin];
    if (physical.size() < _pixels.size()) physical.resize(_pixels.size());
    std::copy(_pixels.begin(), _pixels.end(), physical.begin());
    if (showHook()) showHook()();
  }
  uint32_t Color(uint8_t r, uint8_t g, uint8_t b, uint8_t w = 0) { return (uint32_t(w)<<24)|(uint32_t(r)<<16)|(uint32_t(g)<<8)|b; }
  void fill(uint32_t c, int, int) { std::fill(_pixels.begin(), _pixels.end(), c); }
  void setPixelColor(int i, uint32_t c) { _pixels.at(i)=c; }
};
