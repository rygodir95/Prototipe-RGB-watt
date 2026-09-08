"""Control-source teardown-settle gate tests (firmware parity).

Root cause guarded: a category switch (connected HR -> connect a Power
device) used to start the new driver's connect attempt while NimBLE's
ASYNCHRONOUS disconnect of the OLD link was still in flight; with
CONFIG_BT_NIMBLE_MAX_CONNECTIONS=1 that attempt failed deterministically
with rc=6 (BLE_HS_ENOMEM). The simulator models the same gate: the old link
needs TEARDOWN_SETTLE_S to terminate, and the ONE pending connect of the
new source is held (never duplicated, never dropped) until it settles.

Covers:
  * HR -> Power switch: the connect attempt waits for the old link to
    settle, then exactly one attempt runs and connects,
  * the mirrored Power -> HR sequence,
  * direct same-category connects stay immediate (no gate),
  * switching when the old source is already disconnected stays immediate,
  * a later switch tears the module down and clears its held attempt
    (firmware shutdown() clears _doConnect).

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
STRAP = sim_mod.VIRTUAL_HR_SENSORS[0]
SETTLE = sim_mod.TEARDOWN_SETTLE_S


def make_sim():
    cfg_path = os.path.join(tempfile.mkdtemp(), "c.json")
    s = sim_mod.Simulator(cfg_path=cfg_path)
    s.cfg.smoothing = 0
    s.cfg.hysteresis = 0
    s.processor.set_smoothing(0)
    return s


def connect_power_sync(s):
    """Power mode, meter connected through the normal scan+connect flow."""
    now = time.time()
    s.cfg.source_addr = METER["address"]
    s.cfg.source_name = METER["name"]
    s.connect_to(METER["address"], METER["name"], now)
    t0 = s._scan_start
    s._tick_ble(t0 + 1.5)
    s._tick_ble(t0 + 6.5)
    s._tick_ble(t0 + 8.0)
    return t0


def connect_hr_sync(s):
    """HR mode, strap connected through the normal scan+connect flow."""
    s.switch_source(fw.SRC_HEART_RATE)
    now = time.time()
    s.cfg.hr_source_addr = STRAP["address"]
    s.cfg.hr_source_name = STRAP["name"]
    s.hr_connect_to(STRAP["address"], STRAP["name"], now)
    t0 = s._scan_start
    s._tick_ble(t0 + 1.3)
    s._tick_ble(t0 + 6.5)
    s._tick_ble(t0 + 8.0)
    return t0


class TestTeardownSettleGate(unittest.TestCase):
    def test_hr_to_power_waits_for_old_link_to_settle(self):
        s = make_sim()
        connect_hr_sync(s)
        self.assertTrue(s.hr_connected)

        t = time.time()
        s.connect_device(METER["address"], METER["name"], "power")
        self.assertEqual(s.cfg.control_source, fw.SRC_POWER)
        self.assertTrue(s._teardown_until > t)      # old link registered
        # the ONE connect attempt is held: not started, not lost
        self.assertFalse(s._connecting)
        self.assertTrue(s._connect_pending)

        s._tick_ble(t + 0.05)                       # old link still terminating
        self.assertFalse(s._connecting)
        self.assertTrue(s._connect_pending)

        s._tick_ble(t + SETTLE + 0.2)               # old link settled
        self.assertTrue(s._connecting)              # exactly one attempt begins
        self.assertFalse(s._connect_pending)
        self.assertEqual(s.tel["state"], "CONNECTING")

        s._tick_ble(t + SETTLE + 2.0)               # 1.2 s connect window
        self.assertTrue(s.ble_connected)
        self.assertEqual(s.tel["state"], "CONNECTED")

        started = [e for e in s.events
                   if e["type"] == "ble" and e["msg"].startswith("connected to")]
        self.assertEqual(len(started), 1)          # ONE attempt in total
        settled = [e for e in s.events
                   if e["type"] == "src" and e["msg"].endswith("link settled")]
        self.assertEqual(len(settled), 1)          # the gate opened exactly once

    def test_power_to_hr_waits_for_old_link_to_settle(self):
        s = make_sim()
        connect_power_sync(s)
        self.assertTrue(s.ble_connected)

        t = time.time()
        s.connect_device(STRAP["address"], STRAP["name"], "hr")
        self.assertEqual(s.cfg.control_source, fw.SRC_HEART_RATE)
        self.assertTrue(s._teardown_until > t)
        self.assertFalse(s._hr_connecting)
        self.assertTrue(s._hr_connect_pending)

        s._tick_ble(t + SETTLE + 0.2)               # old link settled
        self.assertTrue(s._hr_connecting)           # exactly one attempt begins
        self.assertFalse(s._hr_connect_pending)
        s._tick_ble(t + SETTLE + 2.0)               # 1.2 s connect window
        self.assertTrue(s.hr_connected)
        self.assertEqual(s.tel["state"], "CONNECTED")
        started = [e for e in s.events
                   if e["type"] == "hr" and e["msg"].startswith("connected to")]
        self.assertEqual(len(started), 1)

    def test_same_category_connect_stays_immediate(self):
        s = make_sim()
        connect_power_sync(s)
        other = sim_mod.VIRTUAL_METERS[1]
        t = time.time()
        s.connect_device(other["address"], other["name"], "power")
        self.assertEqual(s.cfg.control_source, fw.SRC_POWER)  # no switch
        self.assertFalse(s._teardown_until > t)     # no gate registration
        self.assertTrue(s._connecting)               # starts right away
        self.assertFalse(s._connect_pending)

    def test_switch_with_old_source_disconnected_stays_immediate(self):
        s = make_sim()
        s.switch_source(fw.SRC_HEART_RATE)
        now = time.time()
        s.start_scan(6.0, now)
        s._tick_ble(now + 6.5)                      # unified scan: all devices
        t = time.time()
        s.connect_device(METER["address"], METER["name"], "power")
        self.assertEqual(s.cfg.control_source, fw.SRC_POWER)
        self.assertFalse(s._teardown_until > t)     # old link was down -> no gate
        self.assertTrue(s._connecting)              # immediate

    def test_pending_attempt_cleared_by_a_later_switch(self):
        s = make_sim()
        connect_hr_sync(s)
        s.connect_device(METER["address"], METER["name"], "power")
        self.assertTrue(s._connect_pending)         # held by the gate
        # switching back tears the POWER module down: its held attempt is
        # cleared (firmware shutdown() clears _doConnect)
        s.switch_source(fw.SRC_HEART_RATE)
        self.assertFalse(s._connect_pending)


if __name__ == "__main__":
    unittest.main()