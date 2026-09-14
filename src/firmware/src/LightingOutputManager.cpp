#include "LightingOutputManager.h"
#include <string.h>

LightingOutputManager::LightingOutputManager() : _count(0) {
  _state.access([](LightingState &state) {
    state.brightness = 100;
    state.effect = LED_EFFECT_SOLID;
    state.zone = -1;
  });
}

bool LightingOutputManager::registerOutput(LightingOutput* out) {
  if (!out || _count >= LIGHTING_OUTPUT_MAX) return false;
  if (find(out->id()) != nullptr) return false;         // duplicate id
  _outputs[_count++] = out;
  out->apply(_state.read());   // bring the new output up to the current state
  return true;
}

bool LightingOutputManager::unregisterOutput(const char* id) {
  for (int i = 0; i < _count; i++) {
    if (strcmp(_outputs[i]->id(), id) == 0) {
      _count--;
      for (int j = i; j < _count; j++) _outputs[j] = _outputs[j + 1];
      return true;
    }
  }
  return false;
}

LightingOutput* LightingOutputManager::find(const char* id) {
  for (int i = 0; i < _count; i++)
    if (strcmp(_outputs[i]->id(), id) == 0) return _outputs[i];
  return nullptr;
}

void LightingOutputManager::applyState(const LightingState& state) {
  _state.access([&](LightingState &current) { current = state; });
  distribute();
}

void LightingOutputManager::applyConfig(uint8_t brightness, uint8_t effect) {
  _state.access([&](LightingState &state) { state.brightness = brightness; state.effect = effect; });
  distribute();
}

void LightingOutputManager::clearActive() {
  _state.access([](LightingState &state) { state.active = false; });
  distribute();
}

void LightingOutputManager::distribute() {
  LightingState next;
  const uint32_t now = millis();
  _state.access([&](LightingState &state) {
    state.version++;
    state.timestampMs = now;
    next = state;
  });
  // Output callbacks run after releasing the state-copy lock.
  for (int i = 0; i < _count; i++)
    if (_outputs[i]->isEnabled())
      _outputs[i]->apply(next);
}

void LightingOutputManager::update() {
  for (int i = 0; i < _count; i++)
    _outputs[i]->update();
}

int LightingOutputManager::status(LightingDevice* devices, int maxDevices) const {
  int n = 0;
  for (int i = 0; i < _count && n < maxDevices; i++) {
    LightingOutput* o = _outputs[i];
    strncpy(devices[n].id, o->id(), sizeof(devices[n].id) - 1);
    devices[n].id[sizeof(devices[n].id) - 1] = '\0';
    strncpy(devices[n].name, o->name(), sizeof(devices[n].name) - 1);
    devices[n].name[sizeof(devices[n].name) - 1] = '\0';
    devices[n].enabled   = o->isEnabled();
    devices[n].available = o->isAvailable();
    devices[n].local     = o->isLocal();
    n++;
  }
  return n;
}
