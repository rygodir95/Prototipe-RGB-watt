#pragma once
#include <ESPAsyncWebServer.h>
#include <pgmspace.h>
#include "FirmwareVersion.h"

// A response scoped to the three embedded assets. Count bytes accepted by TCP,
// not bytes read from flash, and finish only after the last byte is acknowledged.
// This avoids depending on AsyncAbstractResponse's intermediate-buffer lifecycle.
class EmbeddedAssetResponse final : public AsyncWebServerResponse {
public:
  EmbeddedAssetResponse(const char *mime, const char *data, size_t length)
    : _data(data) {
    _code = 200;
    _contentType = mime;
    _contentLength = length;
    _sendContentLength = true;
    _chunked = false;
    addHeader("Connection", "close");
    addHeader("X-Firmware-Build", FW_BUILD_SHA);
  }

  bool _sourceValid() const override { return _data != nullptr; }

  void _respond(AsyncWebServerRequest *request) override {
    _assembleHead(_wireHeader, request->version());
    _state = RESPONSE_HEADERS;
    pump(request);
  }

  size_t _ack(AsyncWebServerRequest *request, size_t length, uint32_t) override {
    _ackedLength += length;
    return pump(request);
  }

private:
  const char *_data;
  String _wireHeader;
  size_t _headerOffset = 0;

  size_t pump(AsyncWebServerRequest *request) {
    auto *client = request->client();
    const size_t before = _writtenLength;
    if (_state == RESPONSE_HEADERS) {
      const size_t pending = _wireHeader.length() - _headerOffset;
      const size_t count = client->add(_wireHeader.c_str() + _headerOffset,
                                      pending, ASYNC_WRITE_FLAG_COPY);
      _headerOffset += count;
      _writtenLength += count;
      if (_headerOffset == _wireHeader.length()) {
        _wireHeader = String();
        _state = RESPONSE_CONTENT;
      }
    }
    // Bounded stack usage and work per event; each request has its own cursor.
    uint8_t buffer[512];
    for (unsigned batch = 0; batch < 4 && _state == RESPONSE_CONTENT; ++batch) {
      const size_t remaining = _contentLength - _sentLength;
      if (!remaining) { _state = RESPONSE_WAIT_ACK; break; }
      size_t count = remaining < sizeof(buffer) ? remaining : sizeof(buffer);
      const size_t space = client->space();
      if (count > space) count = space;
      if (!count) break;
      memcpy_P(buffer, _data + _sentLength, count);
      const size_t accepted = client->add(reinterpret_cast<const char *>(buffer),
                                          count, ASYNC_WRITE_FLAG_COPY);
      _sentLength += accepted;
      _writtenLength += accepted;
      if (accepted < count) break;  // Retry the unaccepted bytes on ACK/poll.
    }
    if (_state == RESPONSE_CONTENT && _sentLength == _contentLength) {
      _state = RESPONSE_WAIT_ACK;
    }
    // add() owns/copies accepted data even if send() temporarily fails. Retrying
    // send() must not rewind the cursor or enqueue duplicate bytes.
    if (_writtenLength > _ackedLength) client->send();
    if (_state == RESPONSE_WAIT_ACK && _ackedLength == _writtenLength) {
      _state = RESPONSE_END;
    }
    return _writtenLength - before;
  }
};

// Arrays must have static lifetime. Never create a String containing the asset.
template <size_t N>
void sendEmbeddedAsset(AsyncWebServerRequest *request, const char *mime,
                       const char (&asset)[N]) {
  static_assert(N > 1, "Embedded asset must not be empty");
  request->send(new EmbeddedAssetResponse(mime, asset, N - 1));
}
