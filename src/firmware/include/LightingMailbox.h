#pragma once
#include <Arduino.h>
#ifndef ESP32
#include <mutex>
#endif

// Protect only small state copies. Never perform LED, network, allocation or
// logging work inside access(). No request waits for the LED/RMT driver.
template<class T> class LightingMailbox {
public:
  template<class F> void access(F fn) const {
#ifdef ESP32
    portENTER_CRITICAL(&_mux);
    fn(_value);
    portEXIT_CRITICAL(&_mux);
#else
    std::lock_guard<std::mutex> lock(_mux);
    fn(_value);
#endif
  }
  T read() const { T value; access([&](T &v) { value = v; }); return value; }
private:
  mutable T _value{};
#ifdef ESP32
  mutable portMUX_TYPE _mux = portMUX_INITIALIZER_UNLOCKED;
#else
  mutable std::mutex _mux;
#endif
};
