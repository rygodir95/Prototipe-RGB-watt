#include "NetworkDiagnostics.h"
#include <lwip/tcpip.h>
#include <lwip/priv/tcp_priv.h>

namespace {
LightingMailbox<NetworkHealth> health;
LightingMailbox<bool> pending;
uint32_t lastSample=0;

void sample(void *) {
  // PCB lists belong exclusively to the lwIP task. Never walk them from loop
  // or AsyncTCP, and never retain PCB pointers after this callback.
  NetworkHealth result;
  result.sampleMs=millis();
  for(auto *pcb=tcp_active_pcbs; pcb; pcb=pcb->next) {
    ++result.active;
    if(pcb->state==SYN_RCVD) ++result.synReceived;
    else if(pcb->state==ESTABLISHED) ++result.established;
    else ++result.closing;
    if(pcb->nrtx) ++result.retransmitting;
    if(pcb->nrtx>result.maxRetries) result.maxRetries=pcb->nrtx;
    if(pcb->unacked) ++result.unacked;
    if(pcb->unsent) ++result.unsent;
    if(!pcb->rcv_wnd) ++result.zeroWindow;
  }
  for(auto *pcb=tcp_tw_pcbs; pcb; pcb=pcb->next) ++result.timeWait;
  health.access([&](NetworkHealth &h) {
    h.sampleMs=result.sampleMs; h.active=result.active; h.timeWait=result.timeWait;
    h.synReceived=result.synReceived; h.established=result.established; h.closing=result.closing;
    h.retransmitting=result.retransmitting; h.maxRetries=result.maxRetries;
    h.unacked=result.unacked; h.unsent=result.unsent; h.zeroWindow=result.zeroWindow;
  });
  pending.access([](bool &p) { p=false; });
}
}
NetworkHealth networkHealth() { return health.read(); }
void serviceNetworkDiagnostics() {
  const uint32_t now=millis();
  if(now-lastSample<1000) return;
  lastSample=now;
  bool enqueue=false;
  pending.access([&](bool &p) { if(!p) { p=true; enqueue=true; } });
  // At most one outstanding sample. A full TCP/IP mailbox is diagnostic data,
  // not a reason to block the application or add another queued callback.
  if(enqueue && tcpip_try_callback(sample,nullptr)!=ERR_OK) {
    pending.access([](bool &p) { p=false; });
    health.access([](NetworkHealth &h) { ++h.sampleDrops; });
  }
}
void networkDispatch(uint32_t us) {
  health.access([&](NetworkHealth &h) { ++h.dispatches; if(us>h.dispatchMaxUs) h.dispatchMaxUs=us; });
}
void networkRequestClosed(uint32_t ms) {
  health.access([&](NetworkHealth &h) { ++h.closed; if(ms>h.lifetimeMaxMs) h.lifetimeMaxMs=ms; });
}
void networkWebSocketEvent(bool opened, bool closed, bool error) {
  health.access([&](NetworkHealth &h) {
    if(opened) { ++h.wsOpened; ++h.wsActive; }
    if(closed) { ++h.wsClosed; if(h.wsActive) --h.wsActive; }
    if(error) ++h.wsErrors;
  });
}
