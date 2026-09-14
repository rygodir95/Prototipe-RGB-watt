#pragma once
#include <ArduinoJson.h>
#include <ESPAsyncWebServer.h>
#include <cstdlib>
#include <cstring>

struct JsonPostBody {
  size_t total;
  size_t received;
  char bytes[1];
};

// AsyncWebServer frees _tempObject with free() on disconnect. Keep the entire
// accumulator in ONE malloc block, not a new std::string with a leaked buffer.
template<class Handler>
void receiveJsonBody(AsyncWebServerRequest *req, const uint8_t *data,
                     size_t len, size_t index, size_t total, Handler handler) {
  if (req->getResponse()) return;  // Ignore later chunks after an error response.
  if (index == 0 && req->_tempObject == nullptr) {
    if (!total || total > 16 * 1024) {
      req->send(413, "application/json", "{\"ok\":false,\"error\":\"body too large or empty\"}");
      return;
    }
    auto *body = static_cast<JsonPostBody *>(malloc(sizeof(JsonPostBody) + total));
    if (!body) {
      req->send(503, "application/json", "{\"ok\":false,\"error\":\"out of memory\"}");
      return;
    }
    body->total = total;
    body->received = 0;
    req->_tempObject = body;
  }
  auto *body = static_cast<JsonPostBody *>(req->_tempObject);
  if (!body || total != body->total || index != body->received ||
      index > total || len > total - index) {
    free(body);
    req->_tempObject = nullptr;
    req->send(400, "application/json", "{\"ok\":false,\"error\":\"bad body sequence\"}");
    return;
  }
  if (len) memcpy(body->bytes + index, data, len);
  body->received += len;
  if (body->received != total) return;
  JsonDocument doc;
  // Const input makes ArduinoJson own its strings before the buffer is freed.
  auto error = deserializeJson(doc, static_cast<const char *>(body->bytes), total);
  free(body);
  req->_tempObject = nullptr;
  if (error) {
    req->send(400, "application/json", "{\"ok\":false,\"error\":\"bad json\"}");
    return;
  }
  handler(req, doc);
}
