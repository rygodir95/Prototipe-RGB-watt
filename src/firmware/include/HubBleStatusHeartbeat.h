#pragma once

#include <stdint.h>

// Status-publication cadence for the Hub BLE control link.
//
// The client proves a live link from the STATUS characteristic alone: its
// silence watchdog only re-arms when a status frame actually arrives. The Hub
// therefore keeps change-based publishing AND repeats an unchanged value as a
// heartbeat while a control client is attached, so a healthy idle link can
// never look dead. The interval must stay clearly below the client's silence
// window (6000 ms in data/web/app.js and in tools/ble_web_api.js).
//
// Pure logic: no Arduino/NimBLE dependency, so the cadence rule is host
// testable (see tools/tests/hub_ble/test.cpp).

static const uint32_t HUB_BLE_STATUS_HEARTBEAT_MS = 2000;

// One decision per HubBleLink::publishStatus() call.
//   forced          - immediate publish (connect, disconnect, explicit refresh)
//   changed         - serialized status differs from the last published one
//   clientConnected - a control client is attached to the GATT server
//   now / last      - millis() timestamps (wrap-safe unsigned difference)
inline bool hubBleStatusPublishDue(bool forced, bool changed, bool clientConnected,
                                   uint32_t now, uint32_t lastPublishedAt) {
  if (forced || changed) return true;
  if (!clientConnected) return false;   // nobody to notify: no needless traffic
  return (uint32_t)(now - lastPublishedAt) >= HUB_BLE_STATUS_HEARTBEAT_MS;
}
