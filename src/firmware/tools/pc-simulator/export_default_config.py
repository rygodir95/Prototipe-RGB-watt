#!/usr/bin/env python3
"""Export the ZoneGlow default configuration as JSON.

This is the SINGLE authoritative source for the desktop shell's bundled
default-config.json: it reuses the PC simulator's AppConfig defaults and
build_config_json() (the faithful port of the firmware's configLoadDefaults()
and buildConfigJson()), so the offline desktop UI shows exactly the defaults
the simulator and the ESP32 firmware report - there is no second,
hand-maintained desktop copy.

Usage: python export_default_config.py <output.json>
"""

import json
import sys

from pipeline import AppConfig, build_config_json


def main():
    if len(sys.argv) != 2:
        print("usage: python export_default_config.py <output.json>", file=sys.stderr)
        return 2
    doc = build_config_json(AppConfig())
    with open(sys.argv[1], "w", encoding="utf-8") as f:
        json.dump(doc, f, indent=2, separators=(",", ": "), sort_keys=True)
        f.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
