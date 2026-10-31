#pragma once

#include <stddef.h>
#include <stdint.h>
#include <string.h>

// Paged-transfer state for the Hub BLE control link.
//
// config_read and devices_read each own an INDEPENDENT slot (payload, kind,
// timestamp, page count). Starting one transfer can therefore never invalidate
// the other, which was the root cause of the "config transfer expired" failure.
//
// The final page is NOT cleared after it is served: a transfer stays readable
// until it expires (kExpiryMs) or a new page-0 request replaces it, so a
// client that repeats the last page (or a duplicated ATT write) still succeeds.
//
// Pure logic: no Arduino/NimBLE dependency, so the state machine is host
// testable (see tools/tests/hub_ble/test.cpp).
class HubBleTransfer {
public:
  static const uint16_t kChunkSize  = 80;     // payload bytes per page
  static const uint16_t kMaxPages   = 128;    // protocol bound (client mirrors it)
  static const uint32_t kExpiryMs   = 60000;  // a transfer older than this is gone
  static const uint16_t kMaxPayload = 2048;   // bounded slot: never grows at runtime

  enum Kind : uint8_t { CONFIG = 0, DEVICES = 1, KIND_COUNT = 2 };

  enum Status : uint8_t {
    STATUS_OK = 0,
    STATUS_EXPIRED,       // no transfer stored, expired, or stale transfer token
    STATUS_INVALID_PAGE,  // page index outside 0..parts-1
    STATUS_TOO_LARGE      // payload does not fit a bounded transfer
  };

  // Page 0 of a transfer: store the payload and restart this kind's clock.
  // Only this kind's slot is touched.
  inline Status begin(Kind kind, const char *payload, uint32_t now) {
    if (!validKind(kind)) return STATUS_INVALID_PAGE;
    const size_t length = payload ? strlen(payload) : 0;
    if (length == 0 || length >= kMaxPayload) return STATUS_TOO_LARGE;
    const uint32_t pages = (uint32_t)((length + kChunkSize - 1) / kChunkSize);
    if (pages == 0 || pages > kMaxPages) return STATUS_TOO_LARGE;

    Slot &slot = _slots[kind];
    memcpy(slot.payload, payload, length);
    slot.payload[length] = '\0';
    slot.length   = (uint16_t)length;
    slot.pages    = (uint16_t)pages;
    slot.storedAt = now;
    slot.active   = true;
    ++slot.token;   // every page-0 request starts a new transfer token
    return STATUS_OK;
  }

  // Look up one page. Never mutates the slot.
  // token < 0 skips the token check (legacy clients that do not send one).
  inline Status page(Kind kind, int32_t pageIndex, int32_t token, uint32_t now,
                     const char *&chunk, uint16_t &chunkLength) const {
    chunk = nullptr;
    chunkLength = 0;
    if (!validKind(kind)) return STATUS_INVALID_PAGE;
    const Slot &slot = _slots[kind];
    if (!slot.active) return STATUS_EXPIRED;
    if ((uint32_t)(now - slot.storedAt) > kExpiryMs) return STATUS_EXPIRED;   // wrap safe
    if (token >= 0 && (uint32_t)token != slot.token) return STATUS_EXPIRED;   // stale transfer
    if (pageIndex < 0 || (uint32_t)pageIndex >= slot.pages) return STATUS_INVALID_PAGE;

    const uint32_t offset = (uint32_t)pageIndex * kChunkSize;
    if (offset >= slot.length) return STATUS_INVALID_PAGE;
    const uint32_t remaining = (uint32_t)slot.length - offset;
    chunk = slot.payload + offset;
    chunkLength = (uint16_t)(remaining > kChunkSize ? kChunkSize : remaining);
    return STATUS_OK;
  }

  inline uint16_t pages(Kind kind) const { return validKind(kind) ? _slots[kind].pages : 0; }
  inline uint32_t token(Kind kind) const { return validKind(kind) ? _slots[kind].token : 0; }
  inline bool active(Kind kind) const { return validKind(kind) && _slots[kind].active; }

  inline void clear(Kind kind) {
    if (!validKind(kind)) return;
    Slot &slot = _slots[kind];
    slot.length = 0;
    slot.pages = 0;
    slot.storedAt = 0;
    slot.active = false;
    slot.payload[0] = '\0';
  }
  inline void clearAll() { clear(CONFIG); clear(DEVICES); }

  static inline const char *kindName(Kind kind) {
    return kind == DEVICES ? "devices" : "config";
  }

private:
  struct Slot {
    char     payload[kMaxPayload];
    uint16_t length;
    uint16_t pages;
    uint32_t storedAt;
    uint32_t token;
    bool     active;
  };

  static inline bool validKind(Kind kind) { return kind == CONFIG || kind == DEVICES; }

  Slot _slots[KIND_COUNT] = {};
};
