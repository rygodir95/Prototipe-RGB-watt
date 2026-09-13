"""Package the tested application and a pinned, portable Windows esptool."""
import argparse
import hashlib
import io
import json
from pathlib import Path
import shutil
import subprocess
import urllib.request
import zipfile

TOOL_URL = 'https://github.com/espressif/esptool/releases/download/v4.11.0/esptool-v4.11.0-windows-amd64.zip'
TOOL_SHA256 = '0edab659cca62df69c91a80cc685c1c3bbdefb7eff53abf43c2b902a735ad2f9'


def package(output, archive=None):
    root = Path(__file__).resolve().parents[1]
    build = root / '.pio/build/esp32dev-dev'
    metadata = json.loads((build / 'idedata.json').read_text())['extra']
    app_offset = int(metadata['application_offset'], 0)
    ota = next(i for i in metadata['flash_images'] if Path(i['path']).name == 'boot_app0.bin')
    if app_offset != 0x10000 or int(ota['offset'], 0) != 0xe000:
        raise ValueError('Unsupported layout: expected classic ESP32 min_spiffs')
    firmware = (build / 'firmware.bin').read_bytes()
    boot_app = Path(ota['path']).read_bytes()
    if not firmware or firmware[0] != 0xe9 or len(firmware) > 0x1e0000:
        raise ValueError('Invalid application image')
    if len(boot_app) != 0x2000:
        raise ValueError('Invalid OTA boot image size')
    data = Path(archive).read_bytes() if archive else urllib.request.urlopen(TOOL_URL, timeout=90).read()
    if hashlib.sha256(data).hexdigest() != TOOL_SHA256:
        raise ValueError('esptool archive checksum mismatch')
    output = Path(output)
    output.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(io.BytesIO(data)) as tool_zip:
        for name in ('esptool.exe', 'LICENSE'):
            (output / name).write_bytes(tool_zip.read('esptool-windows-amd64/' + name))
    (output / 'firmware.bin').write_bytes(firmware)
    (output / 'boot_app0.bin').write_bytes(boot_app)
    for source in (root / 'tools/windows-flash').iterdir():
        if source.is_file():
            # Batch files need CRLF when started by cmd.exe.
            if source.suffix == '.bat':
                (output / source.name).write_bytes(source.read_text().replace('\n', '\r\n').encode('ascii'))
            else:
                shutil.copy2(source, output / source.name)
    manifest = {
        'chip': 'esp32', 'appOffset': hex(app_offset), 'otaOffset': hex(int(ota['offset'], 0)),
        'commit': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=root, text=True).strip(),
        'hashes': {name: hashlib.sha256((output / name).read_bytes()).hexdigest()
                   for name in ('firmware.bin', 'boot_app0.bin', 'esptool.exe')},
    }
    (output / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    print('Windows flash package:', output)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', required=True)
    parser.add_argument('--esptool-archive')
    args = parser.parse_args()
    package(args.output, args.esptool_archive)
