#pragma once
#include "LightingMailbox.h"

// Diagnostic counters only: do not change connection policy or callback ownership.
struct NetworkHealth {
  uint32_t sampleMs=0, active=0, timeWait=0, synReceived=0, established=0, closing=0;
  uint32_t retransmitting=0, maxRetries=0, unacked=0, unsent=0, zeroWindow=0;
  uint32_t sampleDrops=0, dispatches=0, closed=0, dispatchMaxUs=0, lifetimeMaxMs=0;
  uint32_t wsOpened=0, wsClosed=0, wsErrors=0, wsActive=0;
};
NetworkHealth networkHealth();
void serviceNetworkDiagnostics();
void networkDispatch(uint32_t us);
void networkRequestClosed(uint32_t lifetimeMs);
void networkWebSocketEvent(bool opened, bool closed, bool error);
