"""Compile real LED/LocalLedOutput/Simulation code and /api/simulation handler.
Run after pio run: python tools/test_lighting.py. No physical hardware writes.
"""
import os
from pathlib import Path
import re
import subprocess
import tempfile
root=Path(__file__).resolve().parents[1]
source=(root/'src/WebInterface.cpp').read_text(encoding='utf-8')
route=re.search(r'attachJsonPost\("/api/simulation",.*?\n  \}\);',source,re.S)
assert route
with tempfile.TemporaryDirectory(prefix='lighting-') as temp:
    temp=Path(temp)
    (temp/'simulation_route.h').write_text('void registerSimulationRoute() {\n'+route.group()+'\n}\n')
    binary=temp/('test.exe' if os.name=='nt' else 'test')
    subprocess.run([os.environ.get('CXX','g++'),'-std=c++11','-pthread','-Wall','-Wextra',
        '-DARDUINOJSON_ENABLE_ARDUINO_STRING=0','-DARDUINOJSON_ENABLE_ARDUINO_STREAM=0',
        '-DARDUINOJSON_ENABLE_ARDUINO_PRINT=0','-DARDUINOJSON_ENABLE_PROGMEM=0',
        '-I'+str(root/'tools/tests/led_pin'),'-I'+str(root/'include'),'-I'+str(temp),
        '-I'+str(root/'.pio/libdeps/esp32dev-dev/ArduinoJson/src'),
        str(root/'tools/tests/led_pin/lighting.cpp'),str(root/'src/LEDController.cpp'),
        str(root/'src/LocalLedOutput.cpp'),str(root/'src/LightingOutputManager.cpp'),'-o',str(binary)],check=True)
    subprocess.run([str(binary)],check=True,timeout=30)
