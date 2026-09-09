"""Power-mode regression tests (must keep passing unchanged after HR work).

Covers the unchanged Power pipeline: zones, hysteresis, colour interpolation,
EMA smoothing, config patch semantics, storage round-trip and telemetry.
Run from tools/pc-simulator/:  python -m unittest discover -s tests
"""

import json
import os
import sys
import tempfile
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import pipeline as fw                                    # noqa: E402
import simulator as sim_mod                             # noqa: E402

METER = sim_mod.VIRTUAL_METERS[0]["address"]


def make_sim():
    cfg_path = os.path.join(tempfile.mkdtemp(), "c.json")
    s = sim_mod.Simulator(cfg_path=cfg_path)
    s.cfg.smoothing = 0
    s.cfg.hysteresis = 0
    # Factory defaults ship with FTP unset (0); configure a realistic one so
    # the behavioural pipeline tests below stay meaningful.
    fw.apply_config_patch(s.cfg, {"ftp": 250})
    s.processor.set_smoothing(0)
    return s


class TestPowerPipeline(unittest.TestCase):
    def test_defaults(self):
        c = fw.AppConfig()
        self.assertEqual(c.ftp, 0)        # 0 = not set
        self.assertEqual(c.hr_max, 0)    # 0 = not set
        self.assertEqual(c.zone_count, 7)
        self.assertEqual(c.control_source, fw.SRC_POWER)
        # Unset FTP: boundaries stay trivial (sanitize keeps them ascending).
        self.assertEqual([c.zones[i].min_watts for i in range(7)],
                         [0, 1, 2, 3, 4, 5, 6])

    def test_zone_boundaries(self):
        c = fw.AppConfig()
        # First real FTP regenerates the template zones.
        fw.apply_config_patch(c, {"ftp": 221})
        # 7-zone default mins: 0,124,168,201,234,267,334 (56%..151% of 221 W)
        self.assertEqual([c.zones[i].min_watts for i in range(7)],
                         [0, 124, 168, 201, 234, 267, 334])
        self.assertEqual(fw.zone_index(c, 0, 0, False), 0)
        self.assertEqual(fw.zone_index(c, 124, 0, False), 1)
        self.assertEqual(fw.zone_index(c, 150, 0, False), 1)   # Endurance
        self.assertEqual(fw.zone_index(c, 999, 0, False), 6)

    def test_hysteresis(self):
        # Power hysteresis is FTP-relative: 1.5 % of FTP (0.015 * 200 = 3 W).
        c = fw.AppConfig()
        fw.apply_config_patch(c, {"ftp": 200})   # Z1/Z2 boundary: 56 % = 112 W
        # Moving up requires clearing the entered zone's lower bound by the margin.
        self.assertEqual(fw.zone_index(c, 112, 0, True), 0)   # exactly at boundary: held
        self.assertEqual(fw.zone_index(c, 114, 0, True), 0)   # within +3 margin: held
        self.assertEqual(fw.zone_index(c, 116, 0, True), 1)   # cleared 112+3: enter
        # Moving down requires dropping below the current zone's bound by the margin.
        self.assertEqual(fw.zone_index(c, 110, 1, True), 1)   # above 112-3: held
        self.assertEqual(fw.zone_index(c, 108, 1, True), 0)   # below 112-3: leave
        # c.hysteresis is an HR-only setting now: it must not affect Power zones.
        c.hysteresis = 50
        self.assertEqual(fw.zone_index(c, 112, 0, True), 0)
        # Unset FTP (0) -> no hysteresis margin at all.
        c.ftp = 0
        self.assertEqual(fw.zone_index(c, 112, 0, True), 1)

    def test_color_interpolation(self):
        c = fw.AppConfig()
        fw.apply_config_patch(c, {"ftp": 221})        # Z1/Z2 boundary: 124 W
        z1 = (c.zones[0].r, c.zones[0].g, c.zones[0].b)
        # 20 % center plateau: the zone's exact colour at its center.
        r, g, b = fw.color_for(c, 62.0)               # center of Z1 [0, 124)
        self.assertEqual((r, g, b), z1)
        # Boundary: the exact midpoint of the two adjacent zone colours.
        r, g, b = fw.color_for(c, 124)
        self.assertEqual((r, g, b), ((z1[0] + c.zones[1].r) // 2,
                                     (z1[1] + c.zones[1].g) // 2,
                                     (z1[2] + c.zones[1].b) // 2))
        # Continuous across the boundary (midpoint from both sides).
        lo = fw.color_for(c, 123.999)
        hi = fw.color_for(c, 124.001)
        for a, bb in zip(lo, hi):
            self.assertLessEqual(abs(a - bb), 1)
        # Zone 0 has no lower neighbour: its colour extends below the plateau.
        r, g, b = fw.color_for(c, 1)
        self.assertEqual((r, g, b), z1)
        r, g, b = fw.color_for(c, 10000)               # last zone: solid
        self.assertEqual((r, g, b), (c.zones[6].r, c.zones[6].g, c.zones[6].b))
        r, g, b = fw.color_for(c, -5)                  # below first: first colour
        self.assertEqual((r, g, b), z1)

    def test_ema_smoothing(self):
        p = fw.PowerProcessor()
        p.set_smoothing(0)                              # alpha 1 -> no smoothing
        self.assertEqual(p.update(100.0), 100.0)
        p.set_smoothing(100)                            # alpha 0.05
        p.reset()
        v = p.update(100.0)
        self.assertEqual(v, 100.0)
        v = p.update(200.0)
        self.assertAlmostEqual(v, 0.05 * 200 + 0.95 * 100)


class TestPowerConfig(unittest.TestCase):
    def test_patch_ftp_scales_zones(self):
        c = fw.AppConfig()
        fw.apply_config_patch(c, {"ftp": 250})   # unset -> set: regenerate
        self.assertEqual(c.ftp, 250)
        self.assertEqual(c.zones[1].min_watts, 140)    # 56% of 250
        fw.apply_config_patch(c, {"ftp": 300})         # set -> set: scale
        self.assertEqual(c.zones[1].min_watts, 168)    # 56% of 300

    def test_patch_zone_count_regenerates(self):
        c = fw.AppConfig()
        fw.apply_config_patch(c, {"zoneCount": 5, "ftp": 221})
        self.assertEqual(c.zone_count, 5)
        self.assertEqual(c.zones[4].name, "Z5 · VO₂ Max")

    def test_patch_explicit_zones(self):
        c = fw.AppConfig()
        fw.apply_config_patch(c, {"zones": [{"name": "Custom", "min": 10,
                                            "color": "#123456"}]})
        self.assertEqual(c.zones[0].name, "Custom")
        self.assertEqual((c.zones[0].r, c.zones[0].g, c.zones[0].b),
                         (0x12, 0x34, 0x56))

    def test_storage_roundtrip(self):
        c = fw.AppConfig()
        c.ftp = 300
        c.zones[1].min_watts = 111
        c2 = fw.AppConfig()
        self.assertTrue(c2.from_storage(json.loads(json.dumps(c.to_storage()))))
        self.assertEqual(c2.ftp, 300)
        self.assertEqual(c2.zones[1].min_watts, 111)

    def test_storage_version_guard(self):
        c = fw.AppConfig()
        d = json.loads(json.dumps(c.to_storage()))
        d["version"] += 1
        c2 = fw.AppConfig()
        self.assertFalse(c2.from_storage(d))
        self.assertEqual(c2.ftp, 0)   # factory default: not set

    def test_config_json_shape(self):
        doc = fw.build_config_json(fw.AppConfig())
        self.assertEqual(doc["controlSource"], "power")
        self.assertEqual(len(doc["zones"]), 7)
        self.assertEqual(doc["zoneCount"], 7)


class TestPowerSimulator(unittest.TestCase):
    def test_connect_flow_and_telemetry(self):
        s = make_sim()
        now = time.time()
        s.cfg.source_addr = METER
        s.cfg.source_name = "Virtual Trainer"
        s.connect_to(METER, "Virtual Trainer", now)
        t0 = s._scan_start
        s._tick_ble(t0 + 1.5)
        s._tick_ble(t0 + 6.5)
        s._tick_ble(t0 + 8.0)
        self.assertTrue(s.ble_connected)
        s._tick_pipeline(t0 + 8.5, 0.1)
        tel = s.telemetry_json()
        self.assertEqual(tel["mode"], "power")
        self.assertEqual(tel["state"], "RECEIVING_POWER")
        self.assertEqual(tel["smoothed"], 150)
        self.assertEqual(tel["zoneName"], "Z2 · Endurance")
        self.assertEqual(tel["ftp"], 250)

    def test_timeout_fades_and_demotes_state(self):
        s = make_sim()
        now = time.time()
        s.cfg.source_addr = METER
        s.connect_to(METER, "Virtual Trainer", now)
        t0 = s._scan_start
        s._tick_ble(t0 + 1.5)
        s._tick_ble(t0 + 6.5)
        s._tick_ble(t0 + 8.0)
        s._tick_pipeline(t0 + 8.5, 0.1)
        self.assertEqual(s.tel["state"], "RECEIVING_POWER")
        # Stop the virtual meter's notifications -> after powerTimeoutMs it fades.
        s.sending = False
        s._tick_pipeline(t0 + 8.5 + s.cfg.power_timeout_ms / 1000.0 + 0.5, 0.1)
        self.assertEqual(s.tel["state"], "CONNECTED")
        self.assertFalse(s.tel["hasData"])
        self.assertEqual(s.tel["rawPower"], 0.0)


if __name__ == "__main__":
    unittest.main()