#pragma once
#include "LightingOutput.h"

#define LIGHTING_OUTPUT_MAX 4   // hub-local strip today + future light nodes

// Owns the registered lighting outputs and distributes the calculated
// LightingState to all of them. The Zone Engine talks ONLY to this manager -
// never to a concrete driver - so remote Light Nodes can be registered later
// without touching zone logic.
class LightingOutputManager {
public:
  LightingOutputManager();

  // -- registration ----------------------------------------------------------
  bool registerOutput(LightingOutput* out);   // false: full / duplicate id
  bool unregisterOutput(const char* id);
  LightingOutput* find(const char* id);
  int  count() const { return _count; }

  // -- state distribution (Zone Engine entry points) ------------------------
  void applyState(const LightingState& state);          // store + distribute
  void applyConfig(uint8_t brightness, uint8_t effect); // config fields only
  void clearActive();                                   // immediate fade-out
  const LightingState& state() const { return _state; }

  // -- lifecycle --------------------------------------------------------------
  void update();                          // non-blocking refresh of all outputs

  // -- status ----------------------------------------------------------------
  int status(LightingDevice* devices, int maxDevices) const;  // writes count

private:
  void distribute();

  LightingOutput* _outputs[LIGHTING_OUTPUT_MAX];
  int             _count;
  LightingState   _state;
};