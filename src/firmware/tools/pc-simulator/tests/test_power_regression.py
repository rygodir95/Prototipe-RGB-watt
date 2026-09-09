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
    s.processor.set_smoothing(0)
    # Zones configured (0 = "not set" at factory default): behaviour tests
    # exercise the pipeline, not the unset-default gating.
    fw.apply_config_patch(s.cfg, {"ftp": 221})
    return s


class TestPowerPipeline(unittest.TestCase):
    def test_defaults(self):
        c = fw.AppConfig()
        self.assertEqual(c.ftp, 0)          # 0 = "not set" until configured
        self.assertEqual(c.zone_count, 7)
        self.assertEqual(c.control_source, fw.SRC_POWER)
        # Unset FTP keeps trivial placeholder boundaries (monotonic, inert).
        self.assertEqual([c.zones[i].min_watts for i in range(7)],
                         [0, 1, 2, 3, 4, 5, 6])

    def test_zone_boundaries(self):
        c = fw.AppConfig()
        fw.apply_config_patch(c, {"ftp": 221})   # first real FTP regenerates
        # 7-zone default mins: 0,124,168,201,234,267,334 (56%..151% of 221 W)
        self.assertEqual([c.zones[i].min_watts for i in range(7)],
                         [0, 124, 168, 201, 234, 267, 334])
        self.assertEqual(fw.zone_index(c, 0, 0, False), 0)
        self.assertEqual(fw.zone_index(c, 124, 0, False), 1)
        self.assertEqual(fw.zone_index(c, 150, 0, False), 1)   # Endurance
        self.assertEqual(fw.zone_index(c, 999, 0, False), 6)

    def test_hysteresis(self):
        c = fw.AppConfig()
        fw.apply_config_patch(c, {"ftp": 221})
        c.hysteresis = 5   # absolute field applies to HR only; Power is FTP-relative
        # Power margin = 1.5 % of FTP = ~3.3 W (NOT the absolute 5).
        # Moving up requires clearing the entered zone's lower bound by the margin.
        self.assertEqual(fw.zone_index(c, 124, 0, True), 0)   # exactly at boundary: held
        self.assertEqual(fw.zone_index(c, 126, 0, True), 0)   # within +3.3 margin: held
        self.assertEqual(fw.zone_index(c, 130, 0, True), 1)   # cleared 124+3.3: enter
        # Moving down requires dropping below the current zone's bound by the margin.
        self.assertEqual(fw.zone_index(c, 122, 1, True), 1)   # above 124-3.3: held
        self.assertEqual(fw.zone_index(c, 115, 1, True), 0)  # below 124-3.3: leave
        # FTP unset (0): no margin - hysteresis is a no-op for Power.
        c0 = fw.AppConfig()
        self.assertEqual(fw.zone_index(c0, 500, 0, True),
                         fw.zone_index(c0, 500, 0, False))

    def test_color_interpolation(self):
        c = fw.AppConfig()
        fw.apply_config_patch(c, {"ftp": 221})
        c.zone_count = 7
        # Boundary Z1/Z2 (124 W): the exact colour midpoint (plateau spec).
        r, g, b = fw.color_for(c, 124.0)
        self.assertEqual((r, g, b),
                         ((c.zones[0].r + c.zones[1].r) // 2,
                          (c.zones[0].g + c.zones[1].g) // 2,
                          (c.zones[0].b + c.zones[1].b) // 2))
        r, g, b = fw.color_for(c, 10000)               # last zone: solid
        self.assertEqual((r, g, b), (c.zones[6].r, c.zones[6].g, c.zones[6].b))
        r, g, b = fw.color_for(c, -5)                  # below first: first colour
        self.assertEqual((r, g, b), (c.zones[0].r, c.zones[0].g, c.zones[0].b))

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
        fw.apply_config_patch(c, {"ftp": 250})
        self.assertEqual(c.ftp, 250)
        self.assertEqual(c.zones[1].min_watts, 140)    # 56% of 250

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
        self.assertEqual(c2.ftp, 0)          # factory default: not set

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
        self.assertEqual(tel["ftp"], 221)

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