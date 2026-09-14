#pragma once
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <string>
using std::min;
using std::max;
template<typename T> T constrain(T x, T lo, T hi) { return min(max(x, lo), hi); }
static constexpr float TWO_PI = 6.28318530718f;
inline uint32_t &testMillis() { static uint32_t value = 0; return value; }
inline uint32_t millis() { return testMillis(); }
inline uint32_t micros() { return testMillis() * 1000; }
struct TestSerial {
  std::string log;
  void println(const char *s) { log += std::string(s) + "\n"; }
  template<typename... T> void printf(const char *fmt, T... args) {
    char buffer[256];
    std::snprintf(buffer, sizeof(buffer), fmt, args...);
    log += buffer;
  }
};
extern TestSerial Serial;
