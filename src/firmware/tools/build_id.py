"""PlatformIO extra script: inject the short Git commit SHA as FW_BUILD_SHA.

Runs on every `pio run` (locally and in CI, before compilation). The value
becomes a C string literal available to the firmware (see FirmwareVersion.h)
and is exposed via /api/info ("buildId") and the boot log. Outside a Git
repository (or if git is unavailable) it falls back to "local".
"""
import subprocess

Import("env")


def _git_sha():
    try:
        out = subprocess.check_output(
            ["git", "rev-parse", "--short", "HEAD"],
            stderr=subprocess.DEVNULL, timeout=10).decode().strip()
        return out or "local"
    except Exception:
        return "local"


sha = _git_sha()
env.Append(CPPDEFINES=[("FW_BUILD_SHA", '"%s"' % sha)])
print("Firmware build ID (FW_BUILD_SHA): %s" % sha)