"""Read-only, on-device HTTP regression: python tools/check_web_assets.py http://192.168.4.1

Fetches all three assets concurrently three times and checks status, MIME,
Content-Length and exact body bytes. Run against this firmware version.
"""
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import sys
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
ASSETS = (('/', 'index.html', 'text/html'), ('/style.css', 'style.css', 'text/css'),
          ('/app.js', 'app.js', 'application/javascript'))


def check(base, asset):
    path, filename, mime = asset
    expected = ('\n' + (ROOT / 'data/web' / filename).read_text(encoding='utf-8')).encode('utf-8')
    request = urllib.request.Request(base.rstrip('/') + path, headers={'Cache-Control': 'no-cache'})
    with urllib.request.urlopen(request, timeout=30) as response:
        assert response.status == 200, (path, response.status)
        assert response.headers.get_content_type() == mime, (path, response.headers)
        assert response.headers.get('Content-Length') == str(len(expected)), (path, response.headers)
        assert response.read() == expected, 'Truncated/changed body: ' + path
    return f'{path}: 200, {len(expected)} bytes, exact match'


if __name__ == '__main__':
    if len(sys.argv) != 2:
        raise SystemExit(__doc__)
    with ThreadPoolExecutor(max_workers=3) as executor:
        for result in executor.map(lambda asset: check(sys.argv[1], asset), ASSETS * 3):
            print(result)
