#include "PowerZones.h"

// The zone/colour algorithms are identical for Power and Heart Rate; only the
// boundary/colour arrays differ. Generic internal helpers implement the
// behaviour once, the public namespaces map the respective config onto them.

namespace {

inline uint8_t lerp8(float a, float b, float t) {
  return (uint8_t)lroundf(a + (b - a) * t);
}

int zoneIndexG(const int *mins, int n, float v, int prevZone, bool useHysteresis, float hys) {
  int z = 0;
  for (int i = 0; i < n; i++) {
    if (v >= mins[i]) z = i;
  }
  if (useHysteresis && prevZone >= 0 && prevZone < n && z != prevZone) {
    if (z > prevZone) {
      // moving up: require clearing the entered zone's lower bound by margin
      if (v < mins[z] + hys) z = prevZone;
    } else {
      // moving down: require dropping below current zone's lower bound by margin
      if (v > mins[prevZone] - hys) z = prevZone;
    }
  }
  return z;
}

void colorForG(const int *mins, const uint8_t *rs, const uint8_t *gs, const uint8_t *bs,
               int n, float v, uint8_t &r, uint8_t &g, uint8_t &b, int activeZone) {
  if (n <= 0) { r = g = b = 0; return; }

  // Use the detected logical zone, including any hysteresis retention.
  // Callers without a detected zone retain value-based selection.
  int i = activeZone;
  if (i < 0 || i >= n) {
    i = 0;
    for (int k = 0; k < n; k++) {
      if (v >= mins[k]) i = k;
    }
  }

  // Last (open-ended) zone: solid colour.
  if (i >= n - 1) {
    r = rs[n - 1]; g = gs[n - 1]; b = bs[n - 1];
    return;
  }

  // Central 20% stays solid. In the outer 40% on either side, blend
  // at most 10% of the neighbour: the logical zone always dominates.
  float lo = mins[i];
  float hi = mins[i + 1];
  float t = (hi > lo) ? (v - lo) / (hi - lo) : 0.0f;
  if (t < 0) t = 0;
  if (t > 1) t = 1;
  int neighbour = i;
  float weight = 0;
  if (t < 0.4f) {
    neighbour = (i > 0) ? i - 1 : i;
    weight = 0.1f * (1.0f - t / 0.4f);
  } else if (t > 0.6f) {
    neighbour = i + 1;
    weight = 0.1f * ((t - 0.6f) / 0.4f);
  }
  r = lerp8(rs[i], rs[neighbour], weight);
  g = lerp8(gs[i], gs[neighbour], weight);
  b = lerp8(bs[i], bs[neighbour], weight);
}

} // namespace

namespace PowerZones {

int zoneIndex(const AppConfig &c, float watts, int prevZone, bool useHysteresis) {
  int mins[MAX_ZONES];
  for (int i = 0; i < c.zoneCount; i++) mins[i] = c.zones[i].minWatts;
  // Power hysteresis is FTP-relative: 1.5 % of FTP (0 while FTP is unset).
  return zoneIndexG(mins, c.zoneCount, watts, prevZone, useHysteresis,
                    (c.ftp > 0) ? 0.015f * (float)c.ftp : 0.0f);
}

void colorFor(const AppConfig &c, float watts, uint8_t &r, uint8_t &g, uint8_t &b, int activeZone) {
  int mins[MAX_ZONES];
  uint8_t rs[MAX_ZONES], gs[MAX_ZONES], bs[MAX_ZONES];
  for (int i = 0; i < c.zoneCount; i++) {
    mins[i] = c.zones[i].minWatts;
    rs[i] = c.zones[i].r; gs[i] = c.zones[i].g; bs[i] = c.zones[i].b;
  }
  colorForG(mins, rs, gs, bs, c.zoneCount, watts, r, g, b, activeZone);
}

} // namespace PowerZones

namespace HRZones {

int zoneIndex(const AppConfig &c, float bpm, int prevZone, bool useHysteresis) {
  int mins[MAX_HR_ZONES];
  for (int i = 0; i < MAX_HR_ZONES; i++) mins[i] = c.hrZones[i].minBpm;
  return zoneIndexG(mins, MAX_HR_ZONES, bpm, prevZone, useHysteresis, (float)c.hysteresis);
}

void colorFor(const AppConfig &c, float bpm, uint8_t &r, uint8_t &g, uint8_t &b, int activeZone) {
  int mins[MAX_HR_ZONES];
  uint8_t rs[MAX_HR_ZONES], gs[MAX_HR_ZONES], bs[MAX_HR_ZONES];
  for (int i = 0; i < MAX_HR_ZONES; i++) {
    mins[i] = c.hrZones[i].minBpm;
    rs[i] = c.hrZones[i].r; gs[i] = c.hrZones[i].g; bs[i] = c.hrZones[i].b;
  }
  colorForG(mins, rs, gs, bs, MAX_HR_ZONES, bpm, r, g, b, activeZone);
}

} // namespace HRZones