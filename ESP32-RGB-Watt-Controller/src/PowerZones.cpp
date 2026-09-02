#include "PowerZones.h"

namespace PowerZones {

static inline uint8_t lerp8(uint8_t a, uint8_t b, float t) {
  return (uint8_t)lroundf(a + (b - a) * t);
}

int zoneIndex(const AppConfig &c, float watts, int prevZone, bool useHysteresis) {
  int n = c.zoneCount;
  int z = 0;
  for (int i = 0; i < n; i++) {
    if (watts >= c.zones[i].minWatts) z = i;
  }
  if (useHysteresis && prevZone >= 0 && prevZone < n && z != prevZone) {
    float hys = (float)c.hysteresis;
    if (z > prevZone) {
      // moving up: require clearing the entered zone's lower bound by margin
      if (watts < c.zones[z].minWatts + hys) z = prevZone;
    } else {
      // moving down: require dropping below current zone's lower bound by margin
      if (watts > c.zones[prevZone].minWatts - hys) z = prevZone;
    }
  }
  return z;
}

void colorFor(const AppConfig &c, float watts, uint8_t &r, uint8_t &g, uint8_t &b) {
  int n = c.zoneCount;
  if (n <= 0) { r = g = b = 0; return; }

  // Below the first boundary -> first zone colour.
  if (watts <= c.zones[0].minWatts) {
    r = c.zones[0].r; g = c.zones[0].g; b = c.zones[0].b;
    return;
  }

  // Find the zone containing the wattage.
  int i = 0;
  for (int k = 0; k < n; k++) {
    if (watts >= c.zones[k].minWatts) i = k;
  }

  // Last (open-ended) zone: solid colour.
  if (i >= n - 1) {
    r = c.zones[n - 1].r; g = c.zones[n - 1].g; b = c.zones[n - 1].b;
    return;
  }

  // Interpolate from zone i colour towards zone i+1 colour across zone i span.
  float lo = c.zones[i].minWatts;
  float hi = c.zones[i + 1].minWatts;
  float t  = (hi > lo) ? (watts - lo) / (hi - lo) : 0.0f;
  if (t < 0) t = 0; if (t > 1) t = 1;

  r = lerp8(c.zones[i].r, c.zones[i + 1].r, t);
  g = lerp8(c.zones[i].g, c.zones[i + 1].g, t);
  b = lerp8(c.zones[i].b, c.zones[i + 1].b, t);
}

} // namespace PowerZones
