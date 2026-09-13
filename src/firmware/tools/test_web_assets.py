"""Host regression for actual asset handlers, arrays and TCP response state.

Run: python tools/test_web_assets.py (g++ on PATH, or set CXX).
The transport double injects backpressure and ACKs; real ESP32/Wi-Fi still
needs the on-device check_web_assets.py smoke test.
"""
import importlib.util
import http.client
import io
import os
from pathlib import Path
import re
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]


class WireSocket:
    def __init__(self, data):
        self.data = data

    def makefile(self, *args, **kwargs):
        return io.BytesIO(self.data)


def main():
    spec = importlib.util.spec_from_file_location('embed_web', ROOT / 'tools/embed_web.py')
    embed = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(embed)
    with tempfile.TemporaryDirectory(prefix='web-assets-') as temp:
        temp = Path(temp)
        embed.OUT = str(temp / 'WebContent.h')
        embed.main()
        generated = Path(embed.OUT).read_text(encoding='utf-8')
        assert generated == (ROOT / 'include/WebContent.h').read_text(encoding='utf-8'), 'Stale WebContent.h'
        for _, symbol in embed.FILES:
            assert f'const char {symbol}[] PROGMEM' in generated
        source = (ROOT / 'src/WebInterface.cpp').read_text(encoding='utf-8')
        handlers = []
        for route in ('/', '/style.css', '/app.js'):
            match = re.search(r'server\.on\("' + re.escape(route) + r'", HTTP_GET,.*?\n  \}\);', source, re.S)
            assert match, 'Missing asset route: ' + route
            handlers.append(match.group())
        (temp / 'asset_routes.h').write_text('void registerAssetRoutes() {\n' + '\n'.join(handlers) + '\n}\n')
        stubs = ROOT / 'tools/tests/web_assets'
        binary = temp / ('test.exe' if os.name == 'nt' else 'test')
        subprocess.run([os.environ.get('CXX', 'g++'), '-std=c++11', '-Wall', '-Wextra',
                        '-finput-charset=UTF-8', '-fexec-charset=UTF-8',
                        '-I' + str(stubs), '-I' + str(ROOT / 'include'), '-I' + str(temp),
                        str(stubs / 'test.cpp'), '-o', str(binary)], check=True)
        subprocess.run([str(binary), str(temp)], check=True)
        for filename, _ in embed.FILES:
            expected = ('\n' + (ROOT / 'data/web' / filename).read_text(encoding='utf-8')).encode('utf-8')
            wire = (temp / (filename + '.http')).read_bytes()
            response = http.client.HTTPResponse(WireSocket(wire))
            response.begin()
            assert response.status == 200
            assert response.getheader('Content-Type') == {
                'index.html': 'text/html', 'style.css': 'text/css',
                'app.js': 'application/javascript'}[filename]
            assert response.getheader('X-Firmware-Build') == 'local'
            assert response.getheader('Content-Length') == str(len(expected))
            assert response.getheader('Transfer-Encoding') is None
            assert response.read() == expected, 'Body mismatch: ' + filename
            assert wire.split(b'\r\n\r\n', 1)[1] == expected, 'Extra/missing response bytes'
            print(f'{filename}: parsed HTTP 200, Content-Length = {len(expected)}, complete UTF-8 body matches')


if __name__ == '__main__':
    main()
