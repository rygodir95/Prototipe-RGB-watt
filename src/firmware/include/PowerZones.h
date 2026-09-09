#pragma once
#include "Config.h"

// Zone calculation and continuous colour interpolation (Power zones).
namespace PowerZones {

// Returns the 0-based zone index for a given wattage. When useHysteresis is
// true, prevZone is used to avoid flicker on zone boundaries.
int zoneIndex(const AppConfig &c, float watts, int prevZone, bool useHysteresis);

// Computes the smoothly interpolated colour for a given wattage: the zone's
// exact colour across the central 20 % of its span (plateau), blending
// towards the neighbouring zone's colour across the outer 40 % on each side
// and hitting the exact colour midpoint at each boundary.
void colorFor(const AppConfig &c, float watts, uint8_t &r, uint8_t &g, uint8_t &b);

} // namespace PowerZones

// Heart-rate zone equivalents, operating on the separately stored HR zone
// configuration (identical boundary + hysteresis + interpolation semantics).
namespace HRZones {

int  zoneIndex(const AppConfig &c, float bpm, int prevZone, bool useHysteresis);
void colorFor(const AppConfig &c, float bpm, uint8_t &r, uint8_t &g, uint8_t &b);

} // namespace HRZones