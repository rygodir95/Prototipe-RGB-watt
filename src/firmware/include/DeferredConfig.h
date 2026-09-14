#pragma once
#include "Config.h"
#include "LightingMailbox.h"

// Single-slot latest-wins mailbox. No storage/runtime calls while locked, and
// no heap allocation per save. A request arriving during apply stays pending.
class DeferredConfig {
public:
  void publish(const AppConfig &config) {
    _pending.access([&](Pending &p) { p.config = config; p.dirty = true; });
  }
  bool take(AppConfig &config) {
    bool found = false;
    _pending.access([&](Pending &p) {
      if (p.dirty) { config = p.config; p.dirty = false; found = true; }
    });
    return found;
  }
private:
  struct Pending { AppConfig config{}; bool dirty = false; };
  LightingMailbox<Pending> _pending;
};
