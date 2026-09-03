"""Heart Rate mode tests: HRS packet parsing, HR zones/config, mutual exclusion
and teardown-before-swap source switching, persistence, telemetry.

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

METER = sim_mod.VIRTUAL_METERS[0]
STRAP = sim_mod.VIRTUAL_HR_SENSORS[0]


def make_sim():
    cfg_path = os.path.join(tempfile.mkdtemp(), "c.json")
    s = sim_mod.Simulator(cfg_path=cfg_path)
    s.cfg.smoothing = 0
    s.cfg.hysteresis = 0
    s.processor.set_smoothing(0)
    return s


def connect_power(s, now):
    s.cfg.source_addr = METER["address"]
    s.cfg.source_name = METER["name"]
    s.connect_to(METER["address"], METER["name"], now)
    t0 = s._scan_start
    s._tick_ble(t0 + 1.5)
    s._tick_ble(t0 + 6.5)
    s._tick_ble(t0 + 8.0)
    s._tick_pipeline(t0 + 8.5, 0.1)
    return t0


def connect_hr(s, now):
    s.cfg.hr_source_addr = STRAP["address"]
    s.cfg.hr_source_name = STRAP["name"]
    s.hr_connect_to(STRAP["address"], STRAP["name"], now)
    t0 = s._scan_start
    s._tick_ble(t0 + 1.3)
    s._tick_ble(t0 + 6.5)
    s._tick_ble(t0 + 8.0)
    s._tick_pipeline(t0 + 8.6, 0.1)
    return t0


class TestHrPacketParsing(unittest.TestCase):
    def test_uint8_format(self):
        self.assertEqual(fw.parse_hr_measurement(bytes([0x00, 0x7D])), 125)

    def test_uint16_format(self):
        # flags bit0 set -> uint16 LE; plausible values only (bpm <= 250).
        self.assertEqual(fw.parse_hr_measurement(bytes([0x01, 0x96, 0x00])), 150)
        self.assertIsNone(fw.parse_hr_measurement(bytes([0x01, 0xD0, 0x07])))  # 2000: invalid

    def test_invalid_packets(self):
        self.assertIsNone(fw.parse_hr_measurement(bytes([])))
        self.assertIsNone(fw.parse_hr_measurement(bytes([0x01, 0x2C])))  # short uint16
        self.assertIsNone(fw.parse_hr_measurement(bytes([0x00, 0x00])))  # bpm 0
        self.assertIsNone(fw.parse_hr_measurement(bytes([0x00, 0xFF])))  # bpm 255


class TestHrZones(unittest.TestCase):
    def test_defaults_generated_from_hr_max(self):
        c = fw.AppConfig()
        self.assertEqual(c.hr_max, 190)
        # 50/60/70/80/90 % of 190, contiguous: Z1 95-114, Z2 115-133, Z3 134-152,
        # Z4 153-171, Z5 172-190
        self.assertEqual([z.min_bpm for z in c.hr_zones], [95, 115, 134, 153, 172])
        self.assertEqual(fw.hr_zone_index(c, 100, 0, False), 0)   # Very Light (>=95)
        self.assertEqual(fw.hr_zone_index(c, 114, 0, False), 0)   # upper edge of Z1
        self.assertEqual(fw.hr_zone_index(c, 115, 0, False), 1)   # lower edge of Z2
        self.assertEqual(fw.hr_zone_index(c, 120, 0, False), 1)   # Light (>=115)
        self.assertEqual(fw.hr_zone_index(c, 175, 0, False), 4)   # Maximum (>=172)
        self.assertEqual(fw.hr_zone_index(c, 60, 0, False), 0)    # below 95 -> Z1
        self.assertEqual(fw.hr_zone_index(c, 999, 0, False), 4)   # Z5 ends at Max HR

    def test_hrmax_patch_recalculates_zones(self):
        c = fw.AppConfig()
        fw.apply_config_patch(c, {"hrMax": 200})
        # 50/60/70/80/90 % of 200: 100, 120+1, 140+1, 160+1, 180+1
        self.assertEqual([z.min_bpm for z in c.hr_zones], [100, 121, 141, 161, 181])

    def test_custom_zones_survive_hrmax_change(self):
        c = fw.AppConfig()
        fw.apply_config_patch(c, {"hrZones": [{"min": 100}, {"min": 120},
                                              {"min": 140}, {"min": 160}, {"min": 180}]})
        self.assertTrue(c.hr_zones_custom)                       # explicit edit
        mins = [z.min_bpm for z in c.hr_zones]
        fw.apply_config_patch(c, {"hrMax": 210})
        self.assertEqual([z.min_bpm for z in c.hr_zones], mins)  # kept untouched
        # Reset restores the generated defaults and clears the custom flag.
        fw.apply_config_patch(c, {"hrZonesReset": True})
        self.assertFalse(c.hr_zones_custom)
        self.assertEqual([z.min_bpm for z in c.hr_zones], [105, 127, 148, 169, 190])

    def test_hrmax_clamped(self):
        c = fw.AppConfig()
        fw.apply_config_patch(c, {"hrMax": 50})
        self.assertEqual(c.hr_max, 100)
        fw.apply_config_patch(c, {"hrMax": 999})
        self.assertEqual(c.hr_max, 230)

    def test_hr_color_interpolation(self):
        c = fw.AppConfig()
        r, g, b = fw.hr_color_for(c, 999)
        self.assertEqual((r, g, b), (255, 40, 40))               # Maximum, solid
        r, g, b = fw.hr_color_for(c, 50)
        self.assertEqual((r, g, b), (120, 130, 255))             # below first

    def test_config_json_hr_section(self):
        doc = fw.build_config_json(fw.AppConfig())
        self.assertEqual(len(doc["hrZones"]), fw.MAX_HR_ZONES)
        self.assertEqual(doc["hrZones"][0]["name"], "Very Light")
        self.assertFalse(doc["hrZonesCustom"])                   # generated, not custom
        self.assertEqual(doc["hrZones"][0]["max"], 114)          # contiguous ranges
        self.assertEqual(doc["hrZones"][4]["max"], 190)          # Z5 ends at Max HR


class TestSourceSwitching(unittest.TestCase):
    def test_switch_tears_down_power_before_swap(self):
        s = make_sim()
        now = time.time()
        connect_power(s, now)
        self.assertTrue(s.ble_connected)
        s.switch_source(fw.SRC_HEART_RATE)
        self.assertEqual(s.cfg.control_source, fw.SRC_HEART_RATE)
        self.assertFalse(s.ble_connected)
        self.assertFalse(s.desired)
        self.assertFalse(s.scanning)
        # shared scan cache (DeviceScan) survives a mode switch
        self.assertIn("02:00:00:00:11:22", s.found_devices)
        self.assertEqual(s.tel["smoothedPower"], 0.0)
        self.assertEqual(s.tel["zone"], 0)
        self.assertEqual(s.tel["sourceName"], "")
        # mode persisted to storage
        with open(s.cfg_path) as f:
            self.assertEqual(json.load(f)["controlSource"], fw.SRC_HEART_RATE)

    def test_switch_tears_down_hr_before_swap(self):
        s = make_sim()
        s.switch_source(fw.SRC_HEART_RATE)
        now = time.time()
        connect_hr(s, now)
        self.assertTrue(s.hr_connected)
        s.switch_source(fw.SRC_POWER)
        self.assertFalse(s.hr_connected)
        self.assertFalse(s.hr_desired)
        self.assertEqual(s.tel["smoothedBpm"], 0.0)

    def test_switch_restores_saved_sensor_of_new_mode(self):
        s = make_sim()
        now = time.time()
        connect_power(s, now)                       # saves power meter
        s.switch_source(fw.SRC_HEART_RATE)          # no saved strap -> DISCONNECTED
        self.assertEqual(s.tel["state"], "DISCONNECTED")
        s.switch_source(fw.SRC_POWER)               # power meter restored
        self.assertTrue(s.desired)
        self.assertEqual(s._target_addr, METER["address"])

    def test_same_source_noop(self):
        s = make_sim()
        s.switch_source(fw.SRC_POWER)               # already power
        self.assertEqual(s.tel["state"], "STARTING")  # untouched

    def test_invalid_source_falls_back_to_power(self):
        s = make_sim()
        s.switch_source(99)
        self.assertEqual(s.cfg.control_source, fw.SRC_POWER)


class TestMutualExclusion(unittest.TestCase):
    def test_power_connect_ignored_in_hr_mode(self):
        s = make_sim()
        s.cfg.control_source = fw.SRC_HEART_RATE
        s.connect_to(METER["address"], METER["name"])
        self.assertFalse(s.desired)
        self.assertFalse(s.scanning)

    def test_hr_connect_ignored_in_power_mode(self):
        s = make_sim()
        s.cfg.control_source = fw.SRC_POWER
        s.hr_connect_to(STRAP["address"], STRAP["name"])
        self.assertFalse(s.hr_desired)
        self.assertFalse(s.scanning)

    def test_scan_discovers_both_sensor_types_in_power_mode(self):
        s = make_sim()
        now = time.time()
        s.start_scan(6.0, now)
        s._tick_ble(now + 6.5)
        self.assertEqual({m["type"] for m in s.found_devices.values()},
                         {"FTMS", "CPS", "HRS"})     # one shared scan: all sensors

    def test_scan_discovers_both_sensor_types_in_hr_mode(self):
        s = make_sim()
        s.switch_source(fw.SRC_HEART_RATE)
        now = time.time()
        s.start_scan(6.0, now)
        s._tick_ble(now + 6.5)
        self.assertEqual({m["type"] for m in s.found_devices.values()},
                         {"FTMS", "CPS", "HRS"})


class TestHrPersistence(unittest.TestCase):
    def test_mode_and_hr_config_roundtrip(self):
        s = make_sim()
        s.switch_source(fw.SRC_HEART_RATE)
        fw.apply_config_patch(s.cfg, {"hrMax": 200})
        s.save()
        s2 = sim_mod.Simulator(cfg_path=s.cfg_path)
        self.assertEqual(s2.cfg.control_source, fw.SRC_HEART_RATE)
        self.assertEqual(s2.cfg.hr_max, 200)
        self.assertFalse(s2.cfg.hr_zones_custom)
        self.assertEqual([z.min_bpm for z in s2.cfg.hr_zones], [100, 121, 141, 161, 181])

    def test_custom_zone_flag_roundtrip(self):
        s = make_sim()
        fw.apply_config_patch(s.cfg, {"hrZones": [{"min": 90}, {"min": 110},
                                                  {"min": 130}, {"min": 150}, {"min": 170}]})
        s.save()
        s2 = sim_mod.Simulator(cfg_path=s.cfg_path)
        self.assertTrue(s2.cfg.hr_zones_custom)
        self.assertEqual([z.min_bpm for z in s2.cfg.hr_zones], [90, 110, 130, 150, 170])
        # a Max HR change after reload must NOT touch the custom boundaries
        fw.apply_config_patch(s2.cfg, {"hrMax": 205})
        self.assertEqual([z.min_bpm for z in s2.cfg.hr_zones], [90, 110, 130, 150, 170])
        # Power config untouched and separate
        self.assertEqual(s2.cfg.ftp, 221)
        self.assertEqual(s2.cfg.zones[1].min_watts, 124)

    def test_hr_sensor_saved_separately(self):
        s = make_sim()
        now = time.time()
        connect_power(s, now)
        s.switch_source(fw.SRC_HEART_RATE)
        connect_hr(s, now)
        self.assertEqual(s.cfg.hr_source_addr, STRAP["address"])
        self.assertEqual(s.cfg.source_addr, METER["address"])   # power kept
        s.hr_disconnect(forget=True)
        self.assertEqual(s.cfg.hr_source_addr, "")
        self.assertEqual(s.cfg.source_addr, METER["address"])   # still kept


class TestHrTelemetry(unittest.TestCase):
    def test_hr_flow_end_to_end(self):
        s = make_sim()
        s.switch_source(fw.SRC_HEART_RATE)
        now = time.time()
        connect_hr(s, now)
        s.base_bpm = 120.0
        s._tick_pipeline(s._hr_last_notify + 1.0, 0.1)
        tel = s.telemetry_json()
        self.assertEqual(tel["mode"], "hr")
        self.assertEqual(tel["state"], "RECEIVING_POWER")
        self.assertEqual(tel["raw"], 120)
        self.assertEqual(tel["smoothed"], 120)
        self.assertEqual(tel["hr"], 120)
        self.assertEqual(tel["hrRaw"], 120)
        self.assertEqual(tel["hrMax"], 190)
        self.assertEqual(tel["zone"], 1)
        self.assertEqual(tel["zoneName"], "Light")
        self.assertEqual(tel["zoneCount"], fw.MAX_HR_ZONES)
        self.assertEqual(tel["source"], STRAP["name"])

    def test_hr_timeout_fades(self):
        s = make_sim()
        s.switch_source(fw.SRC_HEART_RATE)
        now = time.time()
        connect_hr(s, now)
        # Stop the virtual strap's notifications -> data goes stale and fades.
        s.hr_sending = False
        s._tick_pipeline(s._hr_last_notify + s.cfg.power_timeout_ms / 1000.0 + 2.0, 0.1)
        self.assertEqual(s.tel["state"], "CONNECTED")
        self.assertEqual(s.tel["rawBpm"], 0.0)
        self.assertFalse(s.tel["hasData"])

    def test_disconnect_resets_state(self):
        s = make_sim()
        s.switch_source(fw.SRC_HEART_RATE)
        now = time.time()
        connect_hr(s, now)
        s.hr_disconnect()
        self.assertFalse(s.hr_connected)
        self.assertEqual(s.tel["state"], "DISCONNECTED")
        self.assertEqual(s.tel["sourceName"], "")

    def test_connection_lost_triggers_reconnect(self):
        s = make_sim()
        s.switch_source(fw.SRC_HEART_RATE)
        now = time.time()
        connect_hr(s, now)
        s.cfg.auto_reconnect = True
        s.hr_connection_lost()
        self.assertEqual(s.tel["state"], "RECONNECTING")
        self.assertTrue(s.hr_desired)


if __name__ == "__main__":
    unittest.main()