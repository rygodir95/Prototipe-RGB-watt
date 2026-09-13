#pragma once
#include <cstring>
#include <vector>
extern std::vector<unsigned char> storedConfig;
class Preferences {
public:
  bool begin(const char *, bool) { return true; }
  size_t getBytesLength(const char *) { return storedConfig.size(); }
  size_t getBytes(const char *, void *dst, size_t size) {
    std::memcpy(dst, storedConfig.data(), size);
    return size;
  }
  size_t putBytes(const char *, const void *src, size_t size) {
    const auto *bytes = static_cast<const unsigned char *>(src);
    storedConfig.assign(bytes, bytes + size);
    return size;
  }
  void clear() { storedConfig.clear(); }
  void end() {}
};
