"""Exercise production config/simulation callbacks while loop work is blocked."""
import os
from pathlib import Path
import re
import subprocess
import tempfile

root = Path(__file__).resolve().parents[1]
web = (root / 'src/WebInterface.cpp').read_text(encoding='utf-8')
main = (root / 'src/main.cpp').read_text(encoding='utf-8')
assert 'receiveJsonBody(req, data, len, index, total, handler)' in web
assert re.search(r'void loop\(\)\s*\{.*?servicePendingConfig\(\);', main, re.S)
helpers = web[web.index('static void hexFromRGB'):web.index('// ---- Secure OTA')]
config = web[web.index('void buildConfigJson'):web.index('// Generic JSON')]
service = main[main.index('static DeferredConfig pendingConfig;'):main.index('void scheduleReboot')]
telemetry = web[web.index('void WebInterface::broadcastTelemetry()'):web.index('void WebInterface::begin()')]
telemetry += web[web.index('void WebInterface::loop()'):web.index('size_t WebInterface::clientCount()')]
assert main.index('web.loop();', main.index('void loop()')) < main.index('lighting.update();', main.index('void loop()'))
routes = [re.search(r'attachJsonPost\("/api/' + path + r'",.*?\n  \}\);', web, re.S).group()
          for path in ('config', 'simulation', 'connect', 'wifi')]
routes += [re.search(r'server.on\("/api/' + path + r'", HTTP_POST,.*?\n  \}\);', web, re.S).group() for path in ('scan', 'disconnect', 'forget', 'factory-reset')]
commands = web[web.index('static WebCommands webCommands;'):web.index('// ---- routes')]
with tempfile.TemporaryDirectory(prefix='request-paths-') as directory:
    temp = Path(directory)
    (temp / 'production.h').write_text(service + helpers + config + commands + telemetry + '\nvoid registerRoutes() {\n' + '\n'.join(routes) + '\n}\n')
    binary = temp / ('test.exe' if os.name == 'nt' else 'test')
    subprocess.run([os.environ.get('CXX', 'g++'), '-std=c++11', '-pthread', '-Wall', '-Wextra',
        '-DARDUINOJSON_ENABLE_ARDUINO_STRING=0', '-DARDUINOJSON_ENABLE_ARDUINO_STREAM=0',
        '-DARDUINOJSON_ENABLE_ARDUINO_PRINT=0', '-DARDUINOJSON_ENABLE_PROGMEM=0',
        '-I' + str(root / 'tools/tests/request_paths'), '-I' + str(root / 'tools/tests/led_pin'),
        '-I' + str(root / 'include'), '-I' + str(temp),
        '-I' + str(root / '.pio/libdeps/esp32dev-dev/ArduinoJson/src'),
        str(root / 'tools/tests/request_paths/test.cpp'), str(root / 'src/Config.cpp'),
        '-o', str(binary)], check=True)
    subprocess.run([str(binary)], check=True, timeout=30)
