"""Edge-case and interruption behaviour: dropouts, invalid HR, reconnects,
rapid source switching, persistence reload and bad config patches.

Covers the regression list from docs/production-readiness.md without any
hardware: power dropout -> fade, HR dropout, zero/out-of-range HR, BLE
connection lost -> auto-reconnect, rapid Power <-> HR switching, persisted
configuration reload, invalid configuration patches, and the telemetry
broadcast shape. Run from tools/pc-simulator/:  python -m unittest discover -s tests
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


def connect_via_devices_page(s, dev, category, now=None):
    now = now or time.time()
    s.connect_device(dev["address"], dev["name"], category)
    t0 = s._scan_start
    s._tick_ble(t0 + 3.0)
    s._tick_ble(t0 + 6.5)
    s._tick_ble(t0 + 8.0)
    return t0


def tick_data(s, now, seconds=1.0, dt=0.1):
    """Run the pipeline for `seconds` of (fresh) data time."""
    t = now
    end = now + seconds
    while t < end:
        t += dt
        s._tick_pipeline(t, dt)
    return t


class TestPowerDropout(unittest.TestCase):
    def test_stale_power_fades_leds_and_drops_state(self):
        s = make_sim()
        t0 = connect_via_devices_page(s, METER, "power")
        self.assertTrue(s.ble_connected)
        t = tick_data(s, t0 + 8.0, 1.0)
        self.assertTrue(s.tel["hasData"])
        self.assertEqual(s.tel["state"], "RECEIVING_POWER")
        fade_with_data = s.local_led.fade
        self.assertGreater(fade_with_data, 0.9)   # LEDs fully on while data flows

        # Meter goes silent (e.g. rider stops pedaling / meter drops out).
        s.sending = False
        t = tick_data(s, t, s.cfg.power_timeout_ms / 1000.0 + 1.0)

        self.assertFalse(s.tel["hasData"])
        self.assertEqual(s.tel["rawPower"], 0)
        # Still connected (link up) but no data: state demoted, LEDs fading.
        self.assertEqual(s.tel["state"], "CONNECTED")
        self.assertLess(s.local_led.fade, fade_with_data)
        t = tick_data(s, t, 2.0)
        self.assertEqual(s.local_led.fade, 0.0)   # fully faded out


class TestHrDropout(unittest.TestCase):
    def test_stale_hr_fades_leds_and_drops_state(self):
        s = make_sim()
        s.switch_source(fw.SRC_HEART_RATE)
        t0 = connect_via_devices_page(s, STRAP, "hr")
        self.assertTrue(s.hr_connected)
        t = tick_data(s, t0 + 8.0, 2.0)
        self.assertTrue(s.tel["hasData"])
        self.assertEqual(s.tel["state"], "RECEIVING_POWER")   # shared state name

        # Strap stops notifying.
        s.hr_sending = False
        t = tick_data(s, t, s.cfg.power_timeout_ms / 1000.0 + 1.0)
        self.assertFalse(s.tel["hasData"])
        self.assertEqual(s.tel["rawBpm"], 0)
        self.assertEqual(s.tel["state"], "CONNECTED")
        t = tick_data(s, t, 2.0)
        self.assertEqual(s.local_led.fade, 0.0)


class TestInvalidHr(unittest.TestCase):
    def test_zero_bpm_lands_in_zone_1_without_crash(self):
        s = make_sim()
        s.switch_source(fw.SRC_HEART_RATE)
        t0 = connect_via_devices_page(s, STRAP, "hr")
        s.base_bpm = 0.0                    # sensor reports a broken 0 value
        s._hr_value = 0.0
        s._hr_last_notify = time.time()
        tick_data(s, t0 + 8.0, 0.3)
        self.assertEqual(s.tel["zone"], 0)          # clamps to Z1
        self.assertEqual(s.tel["rawBpm"], 0)

    def test_overshoot_bpm_clamps_to_last_zone(self):
        s = make_sim()
        s.switch_source(fw.SRC_HEART_RATE)
        t0 = connect_via_devices_page(s, STRAP, "hr")
        s.base_bpm = 300.0                 # way above Max HR
        s._hr_value = 300.0
        s._hr_last_notify = time.time()
        tick_data(s, t0 + 8.0, 0.3)
        self.assertEqual(s.tel["zone"], fw.MAX_HR_ZONES - 1)   # Z5

    def test_malformed_hr_measurement_packet_rejected(self):
        # HRSensor.cpp parse: flags byte 0 -> uint8 value, bit0 set -> uint16.
        self.assertEqual(fw.parse_hr_measurement(bytes([0x00, 0x5A])), 90)
        self.assertEqual(fw.parse_hr_measurement(bytes([0x01, 0xBC, 0x00])), 188)
        self.assertIsNone(fw.parse_hr_measurement(bytes([0x00])))     # too short
        self.assertIsNone(fw.parse_hr_measurement(bytes()))           # empty


class TestBleReconnect(unittest.TestCase):
    def test_connection_lost_auto_reconnects(self):
        s = make_sim()
        t0 = connect_via_devices_page(s, METER, "power")
        self.assertTrue(s.ble_connected)

        # Meter drops out mid-ride.
        s.connection_lost()
        self.assertFalse(s.ble_connected)
        self.assertEqual(s.tel["state"], "RECONNECTING")   # auto_reconnect on

        # Reconnect loop fires after its 7 s backoff -> scan -> connect.
        now = t0 + 20.0
        s._last_attempt = 0.0     # force the backoff window to be elapsed
        s._tick_ble(now)
        self.assertTrue(s.scanning)
        s._tick_ble(now + 3.0)   # scan reveals the meter again
        s._tick_ble(now + 6.5)   # scan end -> connecting
        s._tick_ble(now + 8.0)   # connect completes
        self.assertTrue(s.ble_connected)
        self.assertEqual(s.tel["state"], "CONNECTED")
        t = tick_data(s, now + 8.0, 0.5)
        self.assertEqual(s.tel["state"], "RECEIVING_POWER")

    def test_connection_lost_without_auto_reconnect_goes_disconnected(self):
        s = make_sim()
        connect_via_devices_page(s, METER, "power")
        s.cfg.auto_reconnect = False
        s.connection_lost()
        self.assertEqual(s.tel["state"], "DISCONNECTED")
        s._tick_ble(time.time() + 30.0)   # no reconnect attempts fired
        self.assertFalse(s.scanning)
        self.assertFalse(s._connecting)


class TestRapidSwitching(unittest.TestCase):
    def test_rapid_power_hr_switching_keeps_exactly_one_active_module(self):
        s = make_sim()
        connect_via_devices_page(s, METER, "power")
        s.cfg.hr_source_addr = STRAP["address"]        # pretend a strap was saved
        s.cfg.hr_source_name = STRAP["name"]

        for i in range(10):
            src = fw.SRC_HEART_RATE if i % 2 == 0 else fw.SRC_POWER
            s.switch_source(src, restore=False)        # rapid, no auto-restore
            # the previously active module is ALWAYS fully torn down
            if src == fw.SRC_HEART_RATE:
                self.assertFalse(s.ble_connected)
                self.assertFalse(s.desired)
                self.assertFalse(s._connecting)
            else:
                self.assertFalse(s.hr_connected)
                self.assertFalse(s.hr_desired)
                self.assertFalse(s._hr_connecting)
            self.assertFalse(s.scanning)
            # and never both at once
            self.assertFalse(s.hr_connected and s.ble_connected)
            # live measurement state is cleared on every switch
            self.assertEqual(s.tel["rawPower"], 0)
            self.assertEqual(s.tel["smoothedBpm"], 0)
            self.assertEqual(s.tel["zone"], 0)
            self.assertFalse(s.tel["hasData"])
            self.assertEqual(s.tel["state"], "DISCONNECTED")
            # saved pairings per source survive switching untouched
            self.assertEqual(s.cfg.source_addr, METER["address"])
            self.assertEqual(s.cfg.hr_source_addr, STRAP["address"])


class TestConfigPersistenceReload(unittest.TestCase):
    def test_saved_config_round_trips_through_disk(self):
        d = tempfile.mkdtemp()
        path = os.path.join(d, "c.json")
        s = sim_mod.Simulator(cfg_path=path)
        fw.apply_config_patch(s.cfg, {
            "ftp": 275, "zoneCount": 5, "hrMax": 196,
            "brightness": 64, "ledEffect": 2, "ledType": "SK6812",
            "hrZones": [{"name": "Z1 · Easy", "min": 96, "color": "#112233"}],
        })
        s.save()

        s2 = sim_mod.Simulator(cfg_path=path)   # cold boot from NVS equivalent
        self.assertTrue(s2.cfg.hr_zones_custom)  # explicit edit persisted
        self.assertEqual(s2.cfg.ftp, 275)
        self.assertEqual(s2.cfg.zone_count, 5)
        self.assertEqual(s2.cfg.hr_max, 196)
        self.assertEqual(s2.cfg.brightness, 64)
        self.assertEqual(s2.cfg.led_effect, 2)
        self.assertEqual(s2.cfg.led_type, fw.LED_SK6812)
        self.assertEqual(s2.cfg.hr_zones[0].name, "Z1 · Easy")

    def test_corrupt_stored_config_falls_back_to_defaults(self):
        d = tempfile.mkdtemp()
        path = os.path.join(d, "c.json")
        with open(path, "w", encoding="utf-8") as f:
            f.write("{ this is not json")
        s = sim_mod.Simulator(cfg_path=path)
        self.assertEqual(s.cfg.ftp, 0)   # factory defaults (unset), device still boots

    def test_wrong_version_config_falls_back_to_defaults(self):
        d = tempfile.mkdtemp()
        path = os.path.join(d, "c.json")
        with open(path, "w", encoding="utf-8") as f:
            json.dump({"version": "999", "ftp": 400}, f)
        s = sim_mod.Simulator(cfg_path=path)
        self.assertEqual(s.cfg.ftp, 0)


class TestInvalidConfigPatch(unittest.TestCase):
    def test_bad_zone_patch_is_sanitized_not_stored_raw(self):
        s = make_sim()
        fw.apply_config_patch(s.cfg, {
            "zones": [
                {"name": "A", "min": -4, "color": "#ff0000"},   # negative
                {"name": "B", "min": 0, "color": "#00ff00"},    # not ascending
                {"name": "C", "min": 0, "color": "#0000ff"},    # duplicate
            ],
        })
        mins = [s.cfg.zones[i].min_watts for i in range(s.cfg.zone_count)]
        self.assertEqual(mins[0], 0)                     # negative clamped
        self.assertLess(mins[0], mins[1])                # ascending enforced
        self.assertLess(mins[1], mins[2])                # duplicates split up

    def test_nonsense_scalars_are_clamped(self):
        s = make_sim()
        fw.apply_config_patch(s.cfg, {
            "brightness": 9999, "ledCount": -5, "smoothing": 250,
            "ledEffect": 42, "powerTimeout": 10,
        })
        self.assertEqual(s.cfg.brightness, 100)
        self.assertEqual(s.cfg.led_count, 1)
        self.assertEqual(s.cfg.smoothing, 100)
        self.assertEqual(s.cfg.led_effect, 2)
        self.assertEqual(s.cfg.power_timeout_ms, 500)

    def test_unknown_led_type_falls_back_to_ws2812b(self):
        s = make_sim()
        fw.apply_config_patch(s.cfg, {"ledType": "EXOTIC-123"})
        self.assertEqual(s.cfg.led_type, fw.LED_WS2812B)


class TestTelemetryShape(unittest.TestCase):
    def test_telemetry_carries_mode_and_hr_fields(self):
        s = make_sim()
        s.switch_source(fw.SRC_HEART_RATE)
        connect_via_devices_page(s, STRAP, "hr")
        tick_data(s, time.time(), 1.0)
        doc = s.telemetry_json()
        self.assertEqual(doc["mode"], "hr")
        self.assertEqual(doc["hrMax"], s.cfg.hr_max)
        self.assertIn("hr", doc)
        self.assertIn("hrRaw", doc)
        self.assertIn("zoneName", doc)
        self.assertIn("color", doc)

    def test_telemetry_mode_field_tracks_source_switch(self):
        s = make_sim()
        doc = s.telemetry_json()
        self.assertEqual(doc["mode"], "power")
        s.switch_source(fw.SRC_HEART_RATE, restore=False)
        self.assertEqual(s.telemetry_json()["mode"], "hr")


if __name__ == "__main__":
    unittest.main()