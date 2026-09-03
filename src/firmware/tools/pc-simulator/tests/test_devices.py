"""Devices-page behaviour: one shared scan lists BOTH sensor types and
connecting a device activates its own control source (mutual exclusion).

Mirrors the firmware's DeviceScan.cpp combined scan and WebInterface.cpp
/api/connect. Run from tools/pc-simulator/:  python -m unittest discover -s tests
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
STRAP = sim_mod.VIRTUAL_HR_SENSORS[0]


def make_sim():
    cfg_path = os.path.join(tempfile.mkdtemp(), "c.json")
    s = sim_mod.Simulator(cfg_path=cfg_path)
    s.cfg.smoothing = 0
    s.cfg.hysteresis = 0
    s.processor.set_smoothing(0)
    return s


def connect_via_devices_page(s, dev, category, now=None):
    """Connect exactly like the Devices page does (connect_device): may switch
    the control source first, then run the connect state machine to the end."""
    now = now or time.time()
    s.connect_device(dev["address"], dev["name"], category)
    t0 = s._scan_start
    s._tick_ble(t0 + 3.0)     # reveal both pools (reveals: 1.2/1.4/2.4/2.9)
    s._tick_ble(t0 + 6.5)     # scan end -> start connecting
    s._tick_ble(t0 + 8.0)     # connect completes (1.2 s connect window)
    return t0


class TestCombinedScan(unittest.TestCase):
    def test_scan_finds_power_and_hr_sensors(self):
        s = make_sim()
        now = time.time()
        s.start_scan(6.0, now)
        s._tick_ble(now + 6.5)
        self.assertEqual({m["type"] for m in s.found_devices.values()},
                         {"FTMS", "CPS", "HRS"})

    def test_scan_state_when_disconnected(self):
        s = make_sim()
        now = time.time()
        s.start_scan(6.0, now)
        self.assertEqual(s.tel["state"], "SCANNING")


class TestConnectDevice(unittest.TestCase):
    def test_connect_hr_device_switches_source_and_tears_down_power(self):
        s = make_sim()
        connect_via_devices_page(s, METER, "power")
        self.assertTrue(s.ble_connected)
        self.assertEqual(s.cfg.source_addr, METER["address"])
        # Now connect an HR strap from the Devices page.
        s.connect_device(STRAP["address"], STRAP["name"], "hr")
        self.assertEqual(s.cfg.control_source, fw.SRC_HEART_RATE)  # switched
        self.assertFalse(s.ble_connected)                           # torn down
        self.assertFalse(s.desired)
        self.assertEqual(s.cfg.source_addr, METER["address"])       # remembered
        self.assertEqual(s.cfg.hr_source_addr, STRAP["address"])    # saved
        t1 = s._scan_start
        s._tick_ble(t1 + 3.0)
        s._tick_ble(t1 + 6.5)
        s._tick_ble(t1 + 8.0)
        self.assertTrue(s.hr_connected)
        self.assertFalse(s.ble_connected)     # mutual exclusion maintained

    def test_connect_power_device_switches_back(self):
        s = make_sim()
        connect_via_devices_page(s, STRAP, "hr")
        self.assertTrue(s.hr_connected)
        self.assertEqual(s.cfg.control_source, fw.SRC_HEART_RATE)
        connect_via_devices_page(s, METER, "power")
        self.assertEqual(s.cfg.control_source, fw.SRC_POWER)
        self.assertTrue(s.ble_connected)
        self.assertFalse(s.hr_connected)
        self.assertEqual(s.cfg.hr_source_addr, STRAP["address"])   # kept

    def test_category_inferred_from_discovered_device(self):
        s = make_sim()
        now = time.time()
        s.start_scan(6.0, now)
        s._tick_ble(now + 6.5)                       # both pools discovered
        s.connect_device(STRAP["address"], STRAP["name"])   # no category given
        self.assertEqual(s.cfg.control_source, fw.SRC_HEART_RATE)

    def test_each_source_keeps_its_own_saved_device(self):
        s = make_sim()
        connect_via_devices_page(s, METER, "power")
        connect_via_devices_page(s, STRAP, "hr")
        self.assertEqual(s.cfg.source_addr, METER["address"])
        self.assertEqual(s.cfg.hr_source_addr, STRAP["address"])
        # Switching back and forth never crosses the saved addresses.
        s.switch_source(fw.SRC_POWER)
        self.assertEqual(s.cfg.source_addr, METER["address"])
        self.assertEqual(s.cfg.hr_source_addr, STRAP["address"])

    def test_switch_without_restore_does_not_reconnect(self):
        s = make_sim()
        connect_via_devices_page(s, STRAP, "hr")
        # Switch without restore: the power mode's saved meter is NOT reconnected.
        s.switch_source(fw.SRC_POWER, restore=False)
        self.assertFalse(s.desired)
        self.assertEqual(s.tel["state"], "DISCONNECTED")
        # Default switch DOES restore the new source's saved sensor.
        s.switch_source(fw.SRC_HEART_RATE)
        self.assertTrue(s.hr_desired)


if __name__ == "__main__":
    unittest.main()