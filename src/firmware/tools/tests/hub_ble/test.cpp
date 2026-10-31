// Host test for the Hub BLE paged-transfer state machine.
//
// Compiles with a plain C++ compiler: HubBleTransfer / HubBleAdvertising have
// no Arduino, NimBLE or FreeRTOS dependency, so the exact logic that runs on the
// ESP32 is exercised here without hardware.
//
// Run with: python tools/test_hub_ble.py
#include <cstdio>
#include <string>

#include "../../../include/HubBleAdvertising.h"
#include "../../../include/HubBleTransfer.h"

static int g_checks = 0;

#define CHECK(cond)                                                        \
  do {                                                                     \
    ++g_checks;                                                            \
    if (!(cond)) {                                                         \
      std::fprintf(stderr, "FAIL %s:%d  %s\n", __FILE__, __LINE__, #cond); \
      return 1;                                                            \
    }                                                                      \
  } while (0)

static std::string payload(size_t length, char seed) {
  std::string out;
  out.reserve(length);
  for (size_t i = 0; i < length; ++i) out.push_back((char)(seed + (char)(i % 26)));
  return out;
}

static HubBleTransfer::Status statusOf(const HubBleTransfer &transfer, HubBleTransfer::Kind kind,
                                       int32_t index, int32_t token, uint32_t now) {
  const char *chunk = nullptr;
  uint16_t length = 0;
  return transfer.page(kind, index, token, now, chunk, length);
}

static std::string pageText(const HubBleTransfer &transfer, HubBleTransfer::Kind kind,
                            int32_t index, int32_t token, uint32_t now) {
  const char *chunk = nullptr;
  uint16_t length = 0;
  if (transfer.page(kind, index, token, now, chunk, length) != HubBleTransfer::STATUS_OK) return "<error>";
  return std::string(chunk, length);
}

static std::string readAll(const HubBleTransfer &transfer, HubBleTransfer::Kind kind,
                           int32_t token, uint32_t now) {
  std::string out;
  for (uint16_t i = 0; i < transfer.pages(kind); ++i) out += pageText(transfer, kind, (int32_t)i, token, now);
  return out;
}

// 1. Configuration transfer spanning multiple pages.
static int testConfigMultiPage() {
  HubBleTransfer transfer;
  const std::string config = "{\"ftp\":240,\"pad\":\"" + payload(200, 'a') + "\"}";
  CHECK(transfer.begin(HubBleTransfer::CONFIG, config.c_str(), 1000) == HubBleTransfer::STATUS_OK);
  CHECK(transfer.pages(HubBleTransfer::CONFIG) == 4);
  CHECK(readAll(transfer, HubBleTransfer::CONFIG, -1, 1000) == config);
  for (int32_t i = 0; i < (int32_t)transfer.pages(HubBleTransfer::CONFIG); ++i) {
    CHECK(pageText(transfer, HubBleTransfer::CONFIG, i, -1, 1000).size() <= HubBleTransfer::kChunkSize);
  }
  return 0;
}

// 2. Device-list transfer spanning multiple pages.
static int testDevicesMultiPage() {
  HubBleTransfer transfer;
  const std::string devices = "{\"scanning\":false,\"devices\":[\"" + payload(400, 'A') + "\"]}";
  CHECK(transfer.begin(HubBleTransfer::DEVICES, devices.c_str(), 2000) == HubBleTransfer::STATUS_OK);
  CHECK(transfer.pages(HubBleTransfer::DEVICES) == 6);
  CHECK(readAll(transfer, HubBleTransfer::DEVICES, -1, 2000) == devices);
  return 0;
}

// 3. Interleaved config and device-list reads: one never overwrites the other.
static int testInterleaved() {
  HubBleTransfer transfer;
  const std::string config = "{\"ftp\":250,\"pad\":\"" + payload(300, 'c') + "\"}";
  const std::string devices = "{\"devices\":[\"" + payload(300, 'd') + "\"]}";
  CHECK(transfer.begin(HubBleTransfer::CONFIG, config.c_str(), 3000) == HubBleTransfer::STATUS_OK);
  CHECK(transfer.begin(HubBleTransfer::DEVICES, devices.c_str(), 3000) == HubBleTransfer::STATUS_OK);
  CHECK(transfer.active(HubBleTransfer::CONFIG));                       // not invalidated
  CHECK(transfer.pages(HubBleTransfer::CONFIG) == 4);
  CHECK(pageText(transfer, HubBleTransfer::CONFIG, 1, -1, 3000).size() == HubBleTransfer::kChunkSize);
  CHECK(pageText(transfer, HubBleTransfer::DEVICES, 2, -1, 3000).size() == HubBleTransfer::kChunkSize);
  CHECK(readAll(transfer, HubBleTransfer::CONFIG, -1, 3000) == config);
  CHECK(readAll(transfer, HubBleTransfer::DEVICES, -1, 3000) == devices);
  const uint32_t configToken = transfer.token(HubBleTransfer::CONFIG);
  CHECK(transfer.begin(HubBleTransfer::CONFIG, config.c_str(), 3100) == HubBleTransfer::STATUS_OK);
  CHECK(transfer.token(HubBleTransfer::CONFIG) == configToken + 1);     // new transfer token
  CHECK(transfer.pages(HubBleTransfer::DEVICES) == 4);                  // other slot untouched
  return 0;
}

// 4. Repeated final-page reads stay valid until expiry or a new page 0.
static int testRepeatedFinalPage() {
  HubBleTransfer transfer;
  const std::string config = "{\"pad\":\"" + payload(200, 'e') + "\"}";
  CHECK(transfer.begin(HubBleTransfer::CONFIG, config.c_str(), 4000) == HubBleTransfer::STATUS_OK);
  const int32_t last = (int32_t)transfer.pages(HubBleTransfer::CONFIG) - 1;
  const std::string finalPage = pageText(transfer, HubBleTransfer::CONFIG, last, -1, 4000);
  for (int repeat = 0; repeat < 5; ++repeat) {
    CHECK(pageText(transfer, HubBleTransfer::CONFIG, last, -1, 4000) == finalPage);
    CHECK(readAll(transfer, HubBleTransfer::CONFIG, -1, 4000) == config);
  }
  CHECK(transfer.active(HubBleTransfer::CONFIG));
  return 0;
}

// 5. Expiry protection, stale tokens and empty slots.
static int testExpired() {
  HubBleTransfer transfer;
  CHECK(statusOf(transfer, HubBleTransfer::DEVICES, 0, -1, 5000) == HubBleTransfer::STATUS_EXPIRED);
  CHECK(transfer.begin(HubBleTransfer::CONFIG, "{\"ftp\":200}", 6000) == HubBleTransfer::STATUS_OK);
  CHECK(statusOf(transfer, HubBleTransfer::CONFIG, 0, -1, 6000) == HubBleTransfer::STATUS_OK);
  CHECK(statusOf(transfer, HubBleTransfer::CONFIG, 0, -1, 6000 + HubBleTransfer::kExpiryMs) == HubBleTransfer::STATUS_OK);
  CHECK(statusOf(transfer, HubBleTransfer::CONFIG, 0, -1, 6000 + HubBleTransfer::kExpiryMs + 1) == HubBleTransfer::STATUS_EXPIRED);
  // The other kind was never started, so it stays expired.
  CHECK(statusOf(transfer, HubBleTransfer::DEVICES, 0, -1, 6000) == HubBleTransfer::STATUS_EXPIRED);
  // Stale transfer token (a page from a previous transfer).
  CHECK(transfer.begin(HubBleTransfer::DEVICES, "{\"devices\":[]}", 7000) == HubBleTransfer::STATUS_OK);
  const uint32_t token = transfer.token(HubBleTransfer::DEVICES);
  CHECK(statusOf(transfer, HubBleTransfer::DEVICES, 0, (int32_t)token, 7000) == HubBleTransfer::STATUS_OK);
  CHECK(statusOf(transfer, HubBleTransfer::DEVICES, 0, (int32_t)token - 1, 7000) == HubBleTransfer::STATUS_EXPIRED);
  return 0;
}

// 6. Invalid page indices.
static int testInvalidPage() {
  HubBleTransfer transfer;
  CHECK(transfer.begin(HubBleTransfer::CONFIG, "{\"ftp\":200}", 8000) == HubBleTransfer::STATUS_OK);
  const int32_t parts = (int32_t)transfer.pages(HubBleTransfer::CONFIG);
  CHECK(statusOf(transfer, HubBleTransfer::CONFIG, parts, -1, 8000) == HubBleTransfer::STATUS_INVALID_PAGE);
  CHECK(statusOf(transfer, HubBleTransfer::CONFIG, 999, -1, 8000) == HubBleTransfer::STATUS_INVALID_PAGE);
  CHECK(statusOf(transfer, HubBleTransfer::CONFIG, -1, -1, 8000) == HubBleTransfer::STATUS_INVALID_PAGE);
  // Oversized payloads are refused without destroying a stored transfer.
  CHECK(transfer.begin(HubBleTransfer::CONFIG, payload(HubBleTransfer::kMaxPayload, 'x').c_str(), 8100) ==
        HubBleTransfer::STATUS_TOO_LARGE);
  CHECK(statusOf(transfer, HubBleTransfer::CONFIG, 0, -1, 8200) == HubBleTransfer::STATUS_OK);
  return 0;
}

// 8. Advertising policy (testable part of the advertising lifecycle).
static int testAdvertisingPolicy() {
  CHECK(hubBleAdvertisingWanted(0));
  CHECK(!hubBleAdvertisingWanted(1));
  CHECK(!hubBleAdvertisingWanted(2));
  return 0;
}

int main() {
  struct Case { const char *name; int (*fn)(); } cases[] = {
    {"config multi-page", testConfigMultiPage},
    {"devices multi-page", testDevicesMultiPage},
    {"interleaved", testInterleaved},
    {"repeated final page", testRepeatedFinalPage},
    {"expired", testExpired},
    {"invalid page", testInvalidPage},
    {"advertising policy", testAdvertisingPolicy},
  };
  int failures = 0;
  for (const auto &item : cases) {
    const int result = item.fn();
    std::printf("%-22s %s\n", item.name, result == 0 ? "ok" : "FAILED");
    failures += result;
  }
  std::printf("%d case groups, %d checks, %d failures\n",
              (int)(sizeof(cases) / sizeof(cases[0])), g_checks, failures);
  return failures == 0 ? 0 : 1;
}
