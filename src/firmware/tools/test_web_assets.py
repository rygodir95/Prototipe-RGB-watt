"""Host regression for the actual asset handlers, generated arrays and filler.

Run: python tools/test_web_assets.py (g++ on PATH, or set CXX).
The server double checks the chosen response overload; TCP itself needs the
on-device check_web_assets.py smoke test.
"""
import importlib.util
import os
from pathlib import Path
import re
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]


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
            assert (temp / filename).read_bytes() == expected, 'Body mismatch: ' + filename
            print(f'{filename}: Content-Length = {len(expected)}, complete UTF-8 body matches')


if __name__ == '__main__':
    main()
