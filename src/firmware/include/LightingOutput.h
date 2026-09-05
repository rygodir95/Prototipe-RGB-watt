#pragma once
#include <Arduino.h>

// ---- Lighting output architecture (hub-ready) ------------------------------
// The Zone Engine computes a transport-independent LightingState and hands
// it to the LightingOutputManager, which distributes it to every registered
// LightingOutput. Today the only registered output is the hub's local LED
// strip (LocalLedOutput); future remote Light Nodes register behind the
// same interface without any Zone Engine change.

// Effect identifiers (mirror the ledEffect config values 0/1/2).
enum LedEffectId : uint8_t {
  LED_EFFECT_SOLID     = 0,
  LED_EFFECT_BREATHING = 1,
  LED_EFFECT_COMET     = 2,
};

// Transport-independent lighting state produced by the Zone Engine and
// distributed to all registered lighting outputs.
struct LightingState {
  bool     active;         // fresh data -> zone colour on; false -> fade out
  uint8_t  r, g, b;        // interpolated zone colour
  uint8_t  brightness;     // 0..100 %
  uint8_t  effect;         // LedEffectId
  int8_t   zone;           // 0-based active zone index, -1 = none
  uint8_t  controlSource;  // SRC_POWER / SRC_HEART_RATE (Config.h values)
  uint32_t version;        // bumped by the manager on every distribution
  uint32_t timestampMs;    // millis() of the last distribution
};

// Descriptor reported for each registered output (status/debug).
struct LightingDevice {
  char id[24];
  char name[32];
  bool enabled;    // currently receiving state distributions
  bool available;  // hardware/transport initialised OK
  bool local;      // true: hub-local strip, false: remote node (future)
};

// Common interface for lighting targets. Implementations must not block;
// the manager stores raw pointers, so registered objects must outlive it.
class LightingOutput {
public:
  virtual ~LightingOutput() {}
  virtual const char* id()   const = 0;
  virtual const char* name() const = 0;
  virtual bool isLocal()     const = 0;   // hub-local strip vs remote node
  virtual bool isAvailable() const = 0;   // hardware initialised OK
  virtual bool isEnabled()   const = 0;   // currently receiving state
  virtual void setEnabled(bool on) = 0;
  virtual void apply(const LightingState& state) = 0;  // target the new state
  virtual void update() = 0;   // non-blocking refresh (fade, effects)
};