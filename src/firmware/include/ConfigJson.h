#pragma once

#include <ArduinoJson.h>

// Configuration JSON shared by the HTTP API (WebInterface) and the BLE control
// link (HubBleLink). Both transports therefore expose the same document shape
// and apply patches with the same rules - the BLE link never re-implements
// configuration policy.
void buildConfigJson(JsonDocument &doc);
void applyConfigPatch(JsonDocument &doc);
