#include <algorithm>
#include <array>
#include <cassert>
#include <fstream>
#include <iostream>
#include <limits>
#include <vector>
#include "EmbeddedAssetResponse.h"
#include "WebContent.h"

size_t flashReads = 0;
TestServer server;
#include "asset_routes.h"  // The actual three handlers from WebInterface.cpp.

int main(int argc, char **argv) {
  assert(argc == 2);
  registerAssetRoutes();
  const char *paths[] = {"/", "/style.css", "/app.js"};
  const char *mimes[] = {"text/html", "text/css", "application/javascript"};
  const char *names[] = {"index.html", "style.css", "app.js"};
  const char *assets[] = {INDEX_HTML, STYLE_CSS, APP_JS};
  const size_t lengths[] = {sizeof(INDEX_HTML)-1, sizeof(STYLE_CSS)-1, sizeof(APP_JS)-1};
  // One-byte chunks, irregular chunks, TCP-sized chunks, and oversized buffers.
  for (size_t capacity : {size_t(1), size_t(7), size_t(1460), size_t(4096), size_t(65536)}) {
    std::array<AsyncWebServerRequest, 6> requests;
    std::array<std::vector<uint8_t>, 6> bodies;
    const size_t initialReads = flashReads;
    for (size_t i = 0; i < requests.size(); ++i) {
      server.routes.at(paths[i % 3])(&requests[i]);
      assert(requests[i].response->contentLength == lengths[i % 3]);
      assert(requests[i].response->mime == mimes[i % 3]);
    }
    assert(flashReads == initialReads);  // No complete asset read/copy at setup.
    bool pending;
    do {
      pending = false;
      for (size_t i = 0; i < requests.size(); ++i) {
        auto &response = *requests[i].response;
        auto &body = bodies[i];
        if (body.size() == response.contentLength) continue;
        pending = true;
        const size_t offset = body.size();
        // Vary the TCP capacity independently across simultaneous requests.
        const size_t maxLen = std::max(size_t(1), capacity - i % capacity);
        std::vector<uint8_t> buffer(maxLen + 2, 0xa5);
        const size_t count = response.fill(buffer.data() + 1, maxLen, offset);
        assert(count == std::min(maxLen, response.contentLength - offset));
        assert(buffer.front() == 0xa5 && buffer[count + 1] == 0xa5);
        assert(std::memcmp(buffer.data() + 1, assets[i % 3] + offset, count) == 0);
        body.insert(body.end(), buffer.begin() + 1, buffer.begin() + 1 + count);
      }
    } while (pending);
    for (size_t i = 0; i < requests.size(); ++i) {
      auto &response = *requests[i].response;
      uint8_t sentinel = 0xa5;
      assert(response.fill(&sentinel, 1, response.contentLength) == 0);
      assert(response.fill(&sentinel, 1, std::numeric_limits<size_t>::max()) == 0);
      assert(response.fill(&sentinel, 0, 0) == 0 && sentinel == 0xa5);
      assert(bodies[i].size() == response.contentLength);
      // Repeated offset is deterministic; no shared/global read cursor.
      assert(response.fill(&sentinel, 1, 0) == 1 && sentinel == uint8_t(assets[i % 3][0]));
      if (i < 3) {
        std::ofstream out(std::string(argv[1]) + "/" + names[i], std::ios::binary);
        out.write(reinterpret_cast<const char *>(bodies[i].data()), bodies[i].size());
        assert(out.good());
      }
    }
  }
  std::cout << "Web asset callbacks passed: exact lengths, bounded flash reads, concurrent requests\n";
}
