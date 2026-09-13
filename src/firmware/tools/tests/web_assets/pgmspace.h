#pragma once
#include <cstring>
#define PROGMEM
extern size_t flashReads;
inline void *memcpy_P(void *dst, const void *src, size_t n) {
  ++flashReads;
  return std::memcpy(dst, src, n);
}
