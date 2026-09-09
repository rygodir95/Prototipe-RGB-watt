#include "PowerZones.h"

// The zone/colour algorithms are identical for Power and Heart Rate; only the
// boundary/colour arrays differ. Generic internal helpers implement the
// behaviour once, the public namespaces map the respective config onto them.

namespace {

inline uint8_t lerp8(uint8_t a, uint8_t b, float t) {
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
               int n, float v, uint8_t &r, uint8_t &g, uint8_t &b) {
  if (n <= 0) { r = g = b = 0; return; }

  // Below the first boundary -> first zone colour.
  if (v <= mins[0]) {
    r = rs[0]; g = gs[0]; b = bs[0];
    return;
  }

  // Find the zone containing the value.
  int i = 0;
  for (int k = 0; k < n; k++) {
    if (v >= mins[k]) i = k;
  }

  // Last (open-ended) zone: solid colour.
  if (i >= n - 1) {
    r = rs[n - 1]; g = gs[n - 1]; b = bs[n - 1];
    return;
  }

  // Smooth interpolation with a 20 % center plateau: each zone shows its own
  // exact colour across the central 20 % of its span (t in [0.4, 0.6]) and
  // blends linearly towards the neighbouring zone's colour across the outer
  // 40 % on each side, reaching the exact midpoint of the two colours at the
  // boundary itself - continuous across boundaries, with a clearly visible
  // plateau of each zone colour at its center.
  float lo = mins[i];
  float hi = mins[i + 1];
  float t  = (hi > lo) ? (v - lo) / (hi - lo) : 0.0f;
  if (t < 0) t = 0; if (t > 1) t = 1;

  if (t < 0.4f) {
    // Lower transition: midpoint(prev, cur) at the boundary -> cur at 0.4.
    // Zone 0 has no lower neighbour: its colour simply extends.
    uint8_t pr = (i > 0) ? rs[i - 1] : rs[i];
    uint8_t pg = (i > 0) ? gs[i - 1] : gs[i];
    uint8_t pb = (i > 0) ? bs[i - 1] : bs[i];
    float u = t / 0.4f;
    r = lerp8((uint8_t)((pr + rs[i]) / 2), rs[i], u);
    g = lerp8((uint8_t)((pg + gs[i]) / 2), gs[i], u);
    b = lerp8((uint8_t)((pb + bs[i]) / 2), bs[i], u);
  } else if (t <= 0.6f) {
    // Center plateau: the zone's own colour.
    r = rs[i]; g = gs[i]; b = bs[i];
  } else {
    // Upper transition: cur at 0.6 -> midpoint(cur, next) at the boundary.
    float u = (t - 0.6f) / 0.4f;
    r = lerp8(rs[i], (uint8_t)((rs[i] + rs[i + 1]) / 2), u);
    g = lerp8(gs[i], (uint8_t)((gs[i] + gs[i + 1]) / 2), u);
    b = lerp8(bs[i], (uint8_t)((bs[i] + bs[i + 1]) / 2), u);
  }
}

} // namespace

namespace PowerZones {

int zoneIndex(const AppConfig &c, float watts, int prevZone, bool useHysteresis) {
  int mins[MAX_ZONES];
  for (int i = 0; i < c.zoneCount; i++) mins[i] = c.zones[i].minWatts;
  // Power hysteresis is FTP-relative: 1.5 % of FTP (0 while FTP is unset).
  float hys = (c.ftp > 0) ? 0.015f * (float)c.ftp : 0.0f;
  return zoneIndexG(mins, c.zoneCount, watts, prevZone, useHysteresis, hys);
}

void colorFor(const AppConfig &c, float watts, uint8_t &r, uint8_t &g, uint8_t &b) {
  int mins[MAX_ZONES];
  uint8_t rs[MAX_ZONES], gs[MAX_ZONES], bs[MAX_ZONES];
  for (int i = 0; i < c.zoneCount; i++) {
    mins[i] = c.zones[i].minWatts;
    rs[i] = c.zones[i].r; gs[i] = c.zones[i].g; bs[i] = c.zones[i].b;
  }
  colorForG(mins, rs, gs, bs, c.zoneCount, watts, r, g, b);
}

} // namespace PowerZones

namespace HRZones {

int zoneIndex(const AppConfig &c, float bpm, int prevZone, bool useHysteresis) {
  int mins[MAX_HR_ZONES];
  for (int i = 0; i < MAX_HR_ZONES; i++) mins[i] = c.hrZones[i].minBpm;
  // HR hysteresis stays an absolute bpm margin (config.hysteresis).
  return zoneIndexG(mins, MAX_HR_ZONES, bpm, prevZone, useHysteresis, (float)c.hysteresis);
}

void colorFor(const AppConfig &c, float bpm, uint8_t &r, uint8_t &g, uint8_t &b) {
  int mins[MAX_HR_ZONES];
  uint8_t rs[MAX_HR_ZONES], gs[MAX_HR_ZONES], bs[MAX_HR_ZONES];
  for (int i = 0; i < MAX_HR_ZONES; i++) {
    mins[i] = c.hrZones[i].minBpm;
    rs[i] = c.hrZones[i].r; gs[i] = c.hrZones[i].g; bs[i] = c.hrZones[i].b;
  }
  colorForG(mins, rs, gs, bs, MAX_HR_ZONES, bpm, r, g, b);
}

} // namespace HRZones