#pragma once
#include "LightingMailbox.h"

namespace Runtime {
enum Metric { Loop, Web, LedShow, LedRebuild, ConfigApply, JsonRequest,
              SimulationRequest, ConfigRead, WsSent, WsSkipped, WrongLedTask, Count };
struct Timing { uint32_t calls=0, maxUs=0; };
struct Metrics { Timing values[Count]; };
inline LightingMailbox<Metrics> &mailbox() { static LightingMailbox<Metrics> value; return value; }
inline void record(Metric metric, uint32_t us=0) {
  mailbox().access([&](Metrics &m) {
    auto &v=m.values[metric]; ++v.calls; if(us>v.maxUs) v.maxUs=us;
  });
}
inline Metrics snapshot() { return mailbox().read(); }
class Scope {
public:
  explicit Scope(Metric metric):_metric(metric),_start(micros()) {}
  ~Scope() { record(_metric, micros()-_start); }
private:
  Metric _metric; uint32_t _start;
};
}
