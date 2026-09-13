#include <array>
#include <fstream>
#include <iostream>
#include "EmbeddedAssetResponse.h"
#include "WebContent.h"
size_t flashReads = 0;
TestServer server;
#include "asset_routes.h"

int main(int argc, char **argv) {
  assert(argc == 2);
  registerAssetRoutes();
  const char *paths[] = {"/", "/style.css", "/app.js"};
  const char *names[] = {"index.html", "style.css", "app.js"};
  const char *assets[] = {INDEX_HTML, STYLE_CSS, APP_JS};
  const size_t lengths[] = {sizeof(INDEX_HTML)-1, sizeof(STYLE_CSS)-1, sizeof(APP_JS)-1};
  for (size_t capacity : {size_t(1), size_t(7), size_t(1460), size_t(4096), size_t(65536)}) {
    std::array<AsyncWebServerRequest, 6> requests;
    for (size_t i = 0; i < requests.size(); ++i) {
      auto &request = requests[i];
      request.httpVersion = i < 3 ? 1 : 0;
      request.tcp.capacity = capacity;
      request.tcp.maxAdd = std::max(size_t(1), capacity / 3);
      request.tcp.blocked = true;
      size_t reads = flashReads;
      server.routes.at(paths[i % 3])(&request);
      assert(flashReads == reads); // No full-asset copy before writable TCP.
      assert(!request.response->_finished());
      request.tcp.blocked = false;
    }
    bool pending = true;
    for (size_t step = 0; pending && step < 200000; ++step) {
      pending = false;
      for (size_t i = 0; i < requests.size(); ++i) {
        auto &request = requests[i];
        if (request.response->_finished()) continue;
        pending = true;
        // Poll-only events must not count as ACKs. Pause windows intermittently.
        request.tcp.blocked = step % 11 == 0;
        size_t ack = step % 4 ? request.tcp.ack(97 + i) : 0;
        request.response->_ack(&request, ack, 0);
        if (request.response->_finished()) {
          assert(request.tcp.pending.empty());
          assert(request.tcp.acknowledged == request.tcp.wire.size());
          auto split = request.tcp.wire.find("\r\n\r\n");
          assert(split != std::string::npos);
          assert(request.tcp.wire.substr(split + 4) == std::string(assets[i % 3], lengths[i % 3]));
        }
      }
    }
    assert(!pending);
    for (size_t i = 0; i < requests.size(); ++i) {
      auto &request = requests[i];
      assert(request.response->_finished());
      if (i < 3) {
        std::ofstream out(std::string(argv[1]) + "/" + names[i] + ".http", std::ios::binary);
        out << request.tcp.wire;
        assert(out.good());
      }
    }
  }
  // An abandoned transfer owns no global cursor: a later request starts at 0.
  AsyncWebServerRequest aborted;
  server.routes.at("/app.js")(&aborted);
  aborted.response.reset();
  std::cout << "Web asset transport tests passed: short/zero writes, send failures, ACK/poll, HTTP/1.0+1.1, concurrency\n";
}
