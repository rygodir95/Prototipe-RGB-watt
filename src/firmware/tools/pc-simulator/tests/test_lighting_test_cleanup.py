"""Lighting Test cleanup regression tests.

Bug: after the Lighting Test (simulation endpoint) stopped, the telemetry
state stayed stuck at the last simulated value - state RECEIVING_POWER,
smoothed power/zone/colour kept - even with no sensor connected. The
dashboard and Diagnostics showed a phantom live source until reboot.

Fixed in simulator.py _tick_pipeline() / main.cpp processPipeline():
when no fresh data arrives AND no sensor is connected, the stale
measurement, zone, colour and RECEIVING_POWER state are cleared back to
the normal idle state. With a sensor still connected, the previous
brief-display timeout behaviour is unchanged.

Run from tools/pc-simulator/:  python -m unittest discover -s tests
"""

import os
import sys
import tempfile
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import pipeline as fw                                    # noqa: E402
import simulator as sim_mod                             # noqa: E402

METER = sim_mod.VIRTUAL_METERS[0]


def make_sim():
    cfg_path = os.path.join(tempfile.mkdtemp(), "c.json")
    s = sim_mod.Simulator(cfg_path=cfg_path)
    s.cfg.smoothing = 0
    s.cfg.hysteresis = 0
    s.processor.set_smoothing(0)
    # Zones configured (0 = "not set" at factory default): behaviour tests
    # exercise the pipeline, not the unset-default gating.
    fw.apply_config_patch(s.cfg, {"ftp": 221, "hrMax": 190})
    return s


def tick(s, now, seconds=0.3, dt=0.1):
    t = now
    end = now + seconds
    while t < end:
        t += dt
        s._tick_pipeline(t, dt)
    return t


class TestLightingTestCleanupNoSensor(unittest.TestCase):
    def test_stop_clears_stale_test_telemetry_to_idle(self):
        s = make_sim()
        self.assertFalse(s.ble_connected)          # no sensor at all

        # Run the Lighting Test: simulated values flow normally.
        s.sim_enabled = True
        s.sim_watts = 300.0
        now = tick(s, time.time(), 0.3)
        self.assertTrue(s.tel["hasData"])
        self.assertEqual(s.tel["state"], "RECEIVING_POWER")
        self.assertEqual(s.tel["smoothedPower"], 300.0)
        self.assertGreater(s.tel["zone"], 0)
        self.assertNotEqual((s.tel["r"], s.tel["g"], s.tel["b"]), (0, 0, 0))
        self.assertTrue(s.lighting.state.active)

        # Stop the test (same path as natural completion: enabled=false).
        s.sim_enabled = False
        now = tick(s, now, 0.3)

        # Everything returns to the normal no-source idle state.
        self.assertFalse(s.tel["hasData"])
        self.assertFalse(s.tel["simMode"])
        self.assertEqual(s.tel["smoothedPower"], 0.0)
        self.assertEqual(s.tel["rawPower"], 0.0)
        self.assertEqual(s.tel["zone"], 0)
        self.assertEqual((s.tel["r"], s.tel["g"], s.tel["b"]), (0, 0, 0))
        self.assertEqual(s.tel["state"], "DISCONNECTED")
        self.assertFalse(s.lighting.state.active)   # LEDs fade out

    def test_hr_mode_stop_clears_stale_test_telemetry(self):
        s = make_sim()
        s.switch_source(fw.SRC_HEART_RATE, restore=False)
        s.sim_enabled = True
        s.sim_bpm = 170.0
        now = tick(s, time.time(), 0.3)
        self.assertEqual(s.tel["state"], "RECEIVING_POWER")
        self.assertEqual(s.tel["smoothedBpm"], 170.0)

        s.sim_enabled = False
        now = tick(s, now, 0.3)
        self.assertEqual(s.tel["smoothedBpm"], 0.0)
        self.assertEqual(s.tel["zone"], 0)
        self.assertEqual(s.tel["state"], "DISCONNECTED")
        self.assertFalse(s.tel["hasData"])

    def test_restarting_test_after_cleanup_still_works(self):
        s = make_sim()
        s.sim_enabled = True
        s.sim_watts = 300.0
        now = tick(s, time.time(), 0.3)
        s.sim_enabled = False
        now = tick(s, now, 0.3)                      # cleanup ran
        self.assertEqual(s.tel["state"], "DISCONNECTED")

        # A new Lighting Test drives the pipeline again from the idle state.
        s.sim_enabled = True
        s.sim_watts = 250.0
        now = tick(s, now, 0.3)
        self.assertTrue(s.tel["hasData"])
        self.assertEqual(s.tel["state"], "RECEIVING_POWER")
        self.assertEqual(s.tel["smoothedPower"], 250.0)
        self.assertGreater(s.tel["zone"], 0)


class TestLightingTestCleanupWithSensor(unittest.TestCase):
    def test_stop_returns_to_real_sensor_state_not_idle(self):
        s = make_sim()
        # Connect a real power meter (virtual meter sends 150 W).
        s.cfg.source_addr = METER["address"]
        s.cfg.source_name = METER["name"]
        s.connect_to(METER["address"], METER["name"], time.time())
        t0 = s._scan_start
        s._tick_ble(t0 + 1.5)
        s._tick_ble(t0 + 6.5)
        s._tick_ble(t0 + 8.0)
        now = tick(s, t0 + 8.0, 0.5)
        self.assertTrue(s.ble_connected)
        self.assertEqual(s.tel["state"], "RECEIVING_POWER")
        self.assertEqual(s.tel["smoothedPower"], 150.0)

        # Lighting Test overrides the value while enabled.
        s.sim_enabled = True
        s.sim_watts = 300.0
        now = tick(s, now, 0.3)
        self.assertEqual(s.tel["smoothedPower"], 300.0)

        # Stop: the REAL sensor's state comes back, not the idle state.
        s.sim_enabled = False
        s._tick_ble(now + 0.05)                      # fresh meter notification
        now = tick(s, now + 0.1, 0.3)
        self.assertTrue(s.tel["hasData"])
        self.assertEqual(s.tel["state"], "RECEIVING_POWER")
        self.assertEqual(s.tel["smoothedPower"], 150.0)
        self.assertTrue(s.lighting.state.active)

    def test_stop_keeps_brief_timeout_behaviour_when_connected(self):
        s = make_sim()
        s.cfg.source_addr = METER["address"]
        s.cfg.source_name = METER["name"]
        s.connect_to(METER["address"], METER["name"], time.time())
        t0 = s._scan_start
        s._tick_ble(t0 + 1.5)
        s._tick_ble(t0 + 6.5)
        s._tick_ble(t0 + 8.0)
        now = tick(s, t0 + 8.0, 0.5)
        s.sim_enabled = True
        s.sim_watts = 300.0
        now = tick(s, now, 0.3)

        # Stop the test and silence the meter: connected-but-stale keeps the
        # pre-existing demote-to-CONNECTED behaviour (no forced idle).
        s.sim_enabled = False
        s.sending = False
        now = tick(s, now, s.cfg.power_timeout_ms / 1000.0 + 1.0)
        self.assertFalse(s.tel["hasData"])
        self.assertEqual(s.tel["state"], "CONNECTED")


if __name__ == "__main__":
    unittest.main()