"""Compile and run real firmware LED pin paths with fake NVS/LED hardware.

Run after `pio run`: python tools/test_led_pin.py
Requires a host C++ compiler (g++ by default; override with CXX).
"""
import os
from pathlib import Path
import subprocess
import tempfile

firmware = Path(__file__).resolve().parents[1]
stubs = firmware / "tools/tests/led_pin"
arduino_json = firmware / ".pio/libdeps/esp32dev-dev/ArduinoJson/src"
if not arduino_json.is_dir():
    raise SystemExit("Run pio run first to install ArduinoJson")

with tempfile.TemporaryDirectory(prefix="led-pin-") as temp:
    binary = Path(temp) / ("test.exe" if os.name == "nt" else "test")
    subprocess.run([
        os.environ.get("CXX", "g++"), "-std=c++11", "-Wall", "-Wextra",
        "-DARDUINOJSON_ENABLE_ARDUINO_STRING=0",
        "-DARDUINOJSON_ENABLE_ARDUINO_STREAM=0",
        "-DARDUINOJSON_ENABLE_ARDUINO_PRINT=0",
        "-DARDUINOJSON_ENABLE_PROGMEM=0",
        "-I" + str(stubs), "-I" + str(firmware / "include"),
        "-I" + str(arduino_json), str(stubs / "test.cpp"),
        str(firmware / "src/Config.cpp"), str(firmware / "src/Storage.cpp"),
        str(firmware / "src/LEDController.cpp"), "-o", str(binary),
    ], check=True)
    subprocess.run([str(binary)], check=True)
