#pragma once
#include <ESPAsyncWebServer.h>
#include <pgmspace.h>

// Only pass static-lifetime embedded arrays: the asynchronous response keeps
// a pointer, never a String/heap copy of the complete asset.
template <size_t N>
void sendEmbeddedAsset(AsyncWebServerRequest *request, const char *mime,
                       const char (&asset)[N]) {
  static_assert(N > 1, "Embedded asset must not be empty");
  const char *data = asset;
  const size_t length = N - 1;  // Bytes, excluding only the terminating NUL.
  request->send(request->beginResponse(mime, length,
    [data, length](uint8_t *buffer, size_t maxLen, size_t index) -> size_t {
      if (index >= length) return 0;
      const size_t remaining = length - index;
      const size_t count = maxLen < remaining ? maxLen : remaining;
      if (count) memcpy_P(buffer, data + index, count);
      return count;
    }, nullptr));  // No template processing: preserve CSS '%' and JS verbatim.
}
