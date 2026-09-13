#pragma once
#include <algorithm>
#include <cassert>
#include <cstddef>
#include <cstdint>
#include <functional>
#include <map>
#include <memory>
#include <string>
using String = std::string;
static const uint8_t ASYNC_WRITE_FLAG_COPY = 1;
static const int HTTP_GET = 1;
enum WebResponseState { RESPONSE_SETUP, RESPONSE_HEADERS, RESPONSE_CONTENT,
                        RESPONSE_WAIT_ACK, RESPONSE_END, RESPONSE_FAILED };
class AsyncWebServerRequest;

// Model copy-mode TCP with finite windows, short/zero adds, delayed ACKs and
// temporary tcp_output failure. Accepted bytes remain queued when send fails.
struct AsyncClient {
  size_t capacity = 1460, maxAdd = 1460, acknowledged = 0, calls = 0, sends = 0;
  bool blocked = false;
  std::string pending, wire;
  size_t space() const { return blocked ? 0 : capacity - (wire.size() + pending.size() - acknowledged); }
  size_t add(const char *data, size_t size, uint8_t flags) {
    assert(flags == ASYNC_WRITE_FLAG_COPY);
    if (++calls % 7 == 0) return 0;
    size_t accepted = std::min(std::min(size, space()), maxAdd);
    pending.append(data, accepted);
    return accepted;
  }
  bool send() {
    if (++sends % 5 == 0) return false;
    wire += pending;
    pending.clear();
    return true;
  }
  size_t ack(size_t limit) {
    size_t count = std::min(limit, wire.size() - acknowledged);
    acknowledged += count;
    return count;
  }
};
class AsyncWebServerResponse {
protected:
  int _code = 0;
  String _contentType;
  size_t _contentLength = 0, _headLength = 0, _sentLength = 0, _ackedLength = 0, _writtenLength = 0;
  bool _sendContentLength = true, _chunked = false;
  WebResponseState _state = RESPONSE_SETUP;
  std::map<std::string, std::string> headers;
public:
  virtual ~AsyncWebServerResponse() {}
  void addHeader(const char *name, const char *value) { headers[name] = value; }
  void _assembleHead(String &out, uint8_t version) {
    out = "HTTP/1." + std::to_string(version) + " " + std::to_string(_code) + " OK\r\n";
    if (_sendContentLength) headers["Content-Length"] = std::to_string(_contentLength);
    if (_chunked) headers["Transfer-Encoding"] = "chunked";
    headers["Content-Type"] = _contentType;
    for (const auto &header : headers) out += header.first + ": " + header.second + "\r\n";
    out += "\r\n";
    _headLength = out.size();
  }
  virtual bool _sourceValid() const { return false; }
  virtual bool _finished() const { return _state > RESPONSE_WAIT_ACK; }
  virtual void _respond(AsyncWebServerRequest *) = 0;
  virtual size_t _ack(AsyncWebServerRequest *, size_t, uint32_t) = 0;
};
class AsyncWebServerRequest {
public:
  AsyncClient tcp;
  uint8_t httpVersion = 1;
  std::unique_ptr<AsyncWebServerResponse> response;
  AsyncClient *client() { return &tcp; }
  uint8_t version() const { return httpVersion; }
  // No String/basic response overload: old routes fail compilation.
  void send(AsyncWebServerResponse *value) {
    response.reset(value);
    assert(response->_sourceValid());
    response->_respond(this);
  }
};
struct TestServer {
  std::map<std::string, std::function<void(AsyncWebServerRequest *)>> routes;
  void on(const char *path, int, std::function<void(AsyncWebServerRequest *)> handler) { routes[path] = handler; }
};
