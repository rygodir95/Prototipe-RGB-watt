"""Hub lighting architecture regression tests (LightingOutputManager).

Covers the LightingOutput / LocalLedOutput / LightingOutputManager refactor:
 - Power telemetry still reaches the registered local output with the exact
   zone colour the Zone Engine computed (zone -> manager -> output).
 - Heart Rate telemetry likewise.
 - Simulation mode drives the lighting state.
 - Control-source switch clears the active state (mutual exclusion intact).
 - Data timeout fades the output out.
 - Brightness/effect config flows through the manager and scales the preview.
 - A second (mock) registered output receives the SAME LightingState, and
   unregistering stops it - while pre-refactor telemetry expectations
   (zone indices, colours, fade) stay identical.

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


class MockLightingOutput(fw.LightingOutput):
    """Second output emulating a future remote light node."""

    def __init__(self, out_id="node-1", name="Mock Node"):
        self._id = out_id
        self._name = name
        self.enabled = True
        self.available = True
        self.applied = []
        self.updates = 0

    def id(self):
        return self._id

    def name(self):
        return self._name

    def is_local(self):
        return False

    def is_available(self):
        return self.available

    def is_enabled(self):
        return self.enabled

    def set_enabled(self, on):
        self.enabled = on

    def apply(self, state):
        self.applied.append(state.copy())

    def update(self, now, dt):
        self.updates += 1


class TestLightingManagerBasics(unittest.TestCase):
    def test_register_unregister_and_status(self):
        m = fw.LightingOutputManager()
        local = fw.LocalLedOutput()
        self.assertTrue(m.register_output(local))
        self.assertFalse(m.register_output(local))          # duplicate id
        self.assertEqual(m.count(), 1)
        self.assertIs(m.find("local-led"), local)
        devs = m.status()
        self.assertEqual(len(devs), 1)
        self.assertEqual(devs[0].id, "local-led")
        self.assertEqual(devs[0].name, "Hub LED Strip")
        self.assertTrue(devs[0].local)
        self.assertTrue(devs[0].available)
        self.assertTrue(devs[0].enabled)
        self.assertTrue(m.unregister_output("local-led"))
        self.assertEqual(m.count(), 0)
        self.assertFalse(m.unregister_output("local-led"))

    def test_state_snapshot_is_a_copy(self):
        m = fw.LightingOutputManager()
        st = m.state
        st.active = True
        self.assertFalse(m.state.active)                    # snapshot, not ref


class TestPowerLightingPipeline(unittest.TestCase):
    def test_telemetry_reaches_local_output(self):
        s = make_sim()
        t0 = connect_power(s, time.time())
        st = s.lighting.state
        self.assertTrue(st.active)
        self.assertEqual(st.zone, 1)                        # 150 W -> Z2
        self.assertEqual(st.control_source, fw.SRC_POWER)
        # The output received EXACTLY the zone engine's colour.
        led = s.local_led
        exp_r, exp_g, exp_b = fw.color_for(s.cfg, s.tel["smoothedPower"])
        self.assertEqual((led.r, led.g, led.b), (exp_r, exp_g, exp_b))
        self.assertEqual((led.r, led.g, led.b),
                         (s.tel["r"], s.tel["g"], s.tel["b"]))
        self.assertEqual(led._fade_target, 1.0)
        # Fade advanced by one tick: 0.1 s / 0.6 s full fade.
        self.assertAlmostEqual(led.fade, 0.1 / 0.6, places=6)
        # Status JSON still reports the same preview as before the refactor.
        dev = s.status_json()["tel"]
        self.assertEqual(dev["ledFade"], round(led.fade, 2))
        self.assertEqual(dev["displayR"],
                         fw.lround(led.r * (s.cfg.brightness / 100.0)
                                   * led.fade))

    def test_simulation_mode_drives_lighting(self):
        s = make_sim()
        s.sim_enabled = True
        s.sim_watts = 300.0
        now = time.time()
        s._tick_pipeline(now, 0.1)
        st = s.lighting.state
        self.assertTrue(st.active)
        self.assertEqual(st.zone, s.tel["zone"])
        exp_r, exp_g, exp_b = fw.color_for(s.cfg, s.tel["smoothedPower"])
        self.assertEqual((s.local_led.r, s.local_led.g, s.local_led.b),
                         (exp_r, exp_g, exp_b))

    def test_timeout_fades_local_output(self):
        s = make_sim()
        t0 = connect_power(s, time.time())
        self.assertTrue(s.lighting.state.active)
        # Stop the virtual meter's notifications -> data goes stale.
        s.sending = False
        t = t0 + 8.5 + s.cfg.power_timeout_ms / 1000.0 + 0.5
        s._tick_pipeline(t, 0.1)
        self.assertFalse(s.lighting.state.active)
        self.assertEqual(s.local_led._fade_target, 0.0)
        # Further ticks decay the fade to exactly 0 (one step of 0.1/0.6).
        s._tick_pipeline(t + 0.1, 0.1)
        self.assertEqual(s.local_led.fade, 0.0)

    def test_config_flows_through_manager(self):
        s = make_sim()
        s.sim_enabled = True
        s.sim_watts = 150.0
        s._tick_pipeline(time.time(), 0.1)
        color = (s.local_led.r, s.local_led.g, s.local_led.b)
        self.assertNotEqual(color, (0, 0, 0))
        # applyConfig must keep the zone colour and only swap the config
        # fields (mirrors firmware applyRuntimeConfig).
        s.cfg.brightness = 40
        s.cfg.led_effect = fw.EFFECT_COMET
        s.lighting.apply_config(s.cfg.brightness, s.cfg.led_effect)
        led = s.local_led
        st = s.lighting.state
        self.assertEqual(led.brightness, 40)
        self.assertEqual(led.effect, fw.EFFECT_COMET)
        self.assertEqual(st.brightness, 40)
        self.assertEqual(st.effect, fw.EFFECT_COMET)
        self.assertTrue(st.active)                          # colour kept
        self.assertEqual((st.r, st.g, st.b), color)
        # Preview pixels scale by the new brightness.
        base = 0.4 * led.fade
        self.assertEqual(led.display(),
                         (fw.lround(led.r * base),
                          fw.lround(led.g * base),
                          fw.lround(led.b * base)))


class TestHeartRateLightingPipeline(unittest.TestCase):
    def test_hr_telemetry_reaches_local_output(self):
        s = make_sim()
        s.switch_source(fw.SRC_HEART_RATE)
        connect_hr(s, time.time())
        st = s.lighting.state
        self.assertTrue(st.active)
        self.assertEqual(st.control_source, fw.SRC_HEART_RATE)
        self.assertEqual(st.zone, s.tel["zone"])
        exp_r, exp_g, exp_b = fw.hr_color_for(s.cfg, s.tel["smoothedBpm"])
        self.assertEqual((s.local_led.r, s.local_led.g, s.local_led.b),
                         (exp_r, exp_g, exp_b))
        self.assertEqual(s.local_led._fade_target, 1.0)

    def test_source_switch_deactivates_lighting(self):
        s = make_sim()
        s.sim_enabled = True
        s.sim_watts = 150.0
        s._tick_pipeline(time.time(), 0.1)
        self.assertTrue(s.lighting.state.active)
        self.assertEqual(s.lighting.state.control_source, fw.SRC_POWER)
        # switch_source() must clear the lighting pipeline (mutual exclusion).
        s.switch_source(fw.SRC_HEART_RATE)
        self.assertFalse(s.lighting.state.active)
        self.assertEqual(s.local_led._fade_target, 0.0)
        # HR data drives it again, flagged with the HR control source.
        s.sim_bpm = 120.0
        s._tick_pipeline(time.time() + 0.2, 0.1)
        st = s.lighting.state
        self.assertTrue(st.active)
        self.assertEqual(st.control_source, fw.SRC_HEART_RATE)
        self.assertEqual(st.zone, s.tel["zone"])


class TestMultipleOutputs(unittest.TestCase):
    def test_second_output_receives_same_state(self):
        s = make_sim()
        mock = MockLightingOutput("node-1")
        self.assertTrue(s.lighting.register_output(mock))
        self.assertEqual(s.lighting.count(), 2)
        # Registration brings the new output up to the current (inactive)
        # state - exactly one initial distribution, then silence.
        self.assertEqual(len(mock.applied), 1)
        self.assertFalse(mock.applied[0].active)
        mock.applied = []
        devs = s.lighting.status()
        self.assertEqual(len(devs), 2)
        self.assertTrue(devs[0].local)
        self.assertFalse(devs[1].local)

        s.sim_enabled = True
        s.sim_watts = 150.0
        s._tick_pipeline(time.time(), 0.1)
        st = s.lighting.state
        # The mock node got exactly one distribution: identical fields.
        self.assertEqual(len(mock.applied), 1)
        self.assertEqual(mock.applied[0].fields(), st.fields())
        self.assertEqual(mock.applied[0].zone, 1)
        self.assertGreater(mock.applied[0].version, 0)
        self.assertGreater(mock.applied[0].timestamp, 0.0)
        # Local output got the same colour (byte-identical state).
        self.assertEqual((mock.applied[0].r, mock.applied[0].g,
                          mock.applied[0].b),
                         (s.local_led.r, s.local_led.g, s.local_led.b))
        # Updates tick both outputs.
        self.assertEqual(mock.updates, 1)

        # Unregister -> no further distributions or updates reach the node.
        self.assertTrue(s.lighting.unregister_output("node-1"))
        s._tick_pipeline(time.time() + 0.2, 0.1)
        self.assertEqual(len(mock.applied), 1)
        self.assertEqual(mock.updates, 1)   # nothing after unregistration
        self.assertEqual(s.lighting.count(), 1)

    def test_disabled_output_is_skipped(self):
        s = make_sim()
        mock = MockLightingOutput("node-1")
        s.lighting.register_output(mock)
        mock.set_enabled(False)
        mock.applied = []      # drop the registration-time initial state
        s.sim_enabled = True
        s.sim_watts = 150.0
        s._tick_pipeline(time.time(), 0.1)
        self.assertEqual(len(mock.applied), 0)   # skipped: not enabled
        # The local output still receives state.
        self.assertTrue(s.lighting.state.active)


if __name__ == "__main__":
    unittest.main()