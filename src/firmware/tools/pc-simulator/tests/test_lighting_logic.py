"""Lighting-logic feature tests: FTP-relative power hysteresis (1.5 %),
20 % center plateau colour interpolation, and zero-safe FTP / Max HR defaults
("0 = not set") with first-set regeneration.

Complements test_power_regression.py / test_hr.py (behavioural coverage for
the same features lives there too - this file pins the feature contracts).

Run from tools/pc-simulator/:  python -m unittest discover -s tests
"""

import json
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import pipeline as fw                                    # noqa: E402


class TestUnsetDefaults(unittest.TestCase):
    def test_factory_defaults_are_zero(self):
        c = fw.AppConfig()
        self.assertEqual(c.ftp, 0)       # 0 = not set
        self.assertEqual(c.hr_max, 0)   # 0 = not set

    def test_zero_values_survive_storage_roundtrip(self):
        c = fw.AppConfig()
        fw.apply_config_patch(c, {"ftp": 275, "hrMax": 195})
        c.ftp = 0        # explicitly back to "not set"
        c.hr_max = 0
        c2 = fw.AppConfig()
        self.assertTrue(c2.from_storage(json.loads(json.dumps(c.to_storage()))))
        self.assertEqual(c2.ftp, 0)
        self.assertEqual(c2.hr_max, 0)

    def test_zero_hrmax_patch_accepted_and_kept(self):
        c = fw.AppConfig()
        fw.apply_config_patch(c, {"hrMax": 190})
        fw.apply_config_patch(c, {"hrMax": 0})
        self.assertEqual(c.hr_max, 0)   # not clamped up to 100: 0 = not set

    def test_unset_config_is_functional(self):
        # A fresh, unconfigured device must produce sane pipeline results:
        # no division by zero, monotonically increasing boundaries.
        c = fw.AppConfig()
        self.assertEqual(fw.zone_index(c, 100.0, 0, True), 6)   # trivial zones
        r, g, b = fw.color_for(c, 100.0)
        self.assertEqual((r, g, b), (c.zones[6].r, c.zones[6].g, c.zones[6].b))


class TestFirstSetRegeneration(unittest.TestCase):
    def test_ftp_zero_to_value_regenerates_template(self):
        c = fw.AppConfig()
        fw.apply_config_patch(c, {"ftp": 250})
        self.assertEqual(c.ftp, 250)
        self.assertEqual([c.zones[i].min_watts for i in range(7)],
                         [0, 140, 190, 228, 265, 303, 378])   # 56..151 % of 250

    def test_hrmax_zero_to_value_regenerates_template(self):
        c = fw.AppConfig()
        fw.apply_config_patch(c, {"hrMax": 200})
        self.assertEqual([z.min_bpm for z in c.hr_zones], [100, 121, 141, 161, 181])

    def test_set_to_set_still_scales(self):
        c = fw.AppConfig()
        fw.apply_config_patch(c, {"ftp": 250})
        fw.apply_config_patch(c, {"ftp": 300})   # set -> set: proportional scale
        self.assertEqual(c.zones[1].min_watts, 168)   # 56 % of 300


class TestFtpRelativeHysteresis(unittest.TestCase):
    def test_margin_is_1_5_percent_of_ftp(self):
        c = fw.AppConfig()
        fw.apply_config_patch(c, {"ftp": 400})   # Z1/Z2 boundary: 56 % = 224 W
        # Moving up: held until the boundary is cleared by 1.5 % of 400 = 6 W.
        self.assertEqual(fw.zone_index(c, 224, 0, True), 0)   # at boundary: held
        self.assertEqual(fw.zone_index(c, 229, 0, True), 0)    # within +6: held
        self.assertEqual(fw.zone_index(c, 231, 0, True), 1)    # cleared: enter
        # Moving down: held until dropping 6 W below the boundary.
        self.assertEqual(fw.zone_index(c, 219, 1, True), 1)   # above 218: held
        self.assertEqual(fw.zone_index(c, 217, 1, True), 0)   # below 218: leave

    def test_hr_uses_absolute_config_hysteresis(self):
        c = fw.AppConfig()
        fw.apply_config_patch(c, {"hrMax": 200})   # Z1/Z2 boundary: 121 bpm
        c.hysteresis = 10
        self.assertEqual(fw.hr_zone_index(c, 121, 0, True), 0)   # at boundary: held
        self.assertEqual(fw.hr_zone_index(c, 130, 0, True), 0)   # within +10: held
        self.assertEqual(fw.hr_zone_index(c, 132, 0, True), 1)   # cleared: enter


class TestCenterPlateau(unittest.TestCase):
    def setUp(self):
        self.c = fw.AppConfig()
        fw.apply_config_patch(self.c, {"ftp": 221})   # Z1/Z2 boundary: 124 W

    def test_center_is_exact_zone_colour(self):
        r, g, b = fw.color_for(self.c, 62.0)          # center of Z1 [0, 124)
        z1 = self.c.zones[0]
        self.assertEqual((r, g, b), (z1.r, z1.g, z1.b))

    def test_boundary_is_colour_midpoint(self):
        r, g, b = fw.color_for(self.c, 124)
        z1, z2 = self.c.zones[0], self.c.zones[1]
        self.assertEqual((r, g, b), ((z1.r + z2.r) // 2,
                                     (z1.g + z2.g) // 2,
                                     (z1.b + z2.b) // 2))

    def test_continuous_across_boundary(self):
        lo = fw.color_for(self.c, 123.999)
        hi = fw.color_for(self.c, 124.001)
        for a, b in zip(lo, hi):
            self.assertLessEqual(abs(a - b), 1)

    def test_zone0_extends_below_plateau(self):
        # Zone 0 has no lower neighbour: its colour extends to the boundary.
        r, g, b = fw.color_for(self.c, 1)
        z1 = self.c.zones[0]
        self.assertEqual((r, g, b), (z1.r, z1.g, z1.b))

    def test_hr_boundary_is_colour_midpoint(self):
        c = fw.AppConfig()
        fw.apply_config_patch(c, {"hrMax": 190})   # Z1/Z2 boundary: 115 bpm
        r, g, b = fw.hr_color_for(c, 115)
        z1, z2 = c.hr_zones[0], c.hr_zones[1]
        self.assertEqual((r, g, b), ((z1.r + z2.r) // 2,
                                     (z1.g + z2.g) // 2,
                                     (z1.b + z2.b) // 2))


if __name__ == "__main__":
    unittest.main()