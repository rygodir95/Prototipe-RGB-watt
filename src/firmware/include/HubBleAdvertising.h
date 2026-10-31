#pragma once

#include <stdint.h>

// Advertising policy for the Hub control GATT service.
//
// The Hub accepts exactly one local control client (a phone or the Windows
// app). While a client is attached the service stays silent; after the client
// disconnects advertising is restarted, and every start path reports whether
// the controller actually accepted it.
inline bool hubBleAdvertisingWanted(uint8_t connectedClients) {
  return connectedClients == 0;
}
