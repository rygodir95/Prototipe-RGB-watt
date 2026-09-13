#pragma once
#include <cstddef>
#include <cstdint>
#include <functional>
#include <map>
#include <memory>
#include <string>

using AwsResponseFiller = std::function<size_t(uint8_t *, size_t, size_t)>;
struct AsyncWebServerResponse {
  std::string mime;
  size_t contentLength;
  AwsResponseFiller fill;
};
class AsyncWebServerRequest {
public:
  std::unique_ptr<AsyncWebServerResponse> response;
  // Only the fixed-length, no-template overload is supported by this double.
  // Reintroducing the old send(200, mime, char*) route fails compilation.
  AsyncWebServerResponse *beginResponse(const char *mime, size_t length,
                                        AwsResponseFiller fill, std::nullptr_t) {
    return new AsyncWebServerResponse{mime, length, fill};
  }
  void send(AsyncWebServerResponse *value) { response.reset(value); }
};
static const int HTTP_GET = 1;
struct TestServer {
  std::map<std::string, std::function<void(AsyncWebServerRequest *)>> routes;
  void on(const char *path, int, std::function<void(AsyncWebServerRequest *)> handler) {
    routes[path] = handler;
  }
};
