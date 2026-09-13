# Embedded asset transfer regression

Run `python tools/test_web_assets.py` from `src/firmware` (host g++, or CXX).
It compiles the actual route handlers and EmbeddedAssetResponse, using a TCP
test double. The double limits available space, returns partial/zero `add()`
results, fails `send()` temporarily after bytes have been accepted, delays
ACKs, and interleaves six independent HTTP/1.0 and HTTP/1.1 requests.
The resulting HTTP streams are parsed and compared byte-for-byte with the
embedded asset source, including Content-Length, MIME and the final byte.

The response stores only a flash pointer and small HTTP headers. Flash reads
use a 512-byte buffer, TCP takes its own copy, and the per-request cursor moves
only by the accepted byte count. Completion requires the final ACK. This is
specific to embedded assets; API responses and other firmware logic are unchanged.

This host test does not establish real ESP32/Wi-Fi reliability. After flashing,
run `python tools/check_web_assets.py http://DEVICE_IP` to repeat concurrent
downloads of all three assets. It checks actual HTTP status, Content-Length,
and every body byte. Each result prints the X-Firmware-Build response header
to distinguish the installed firmware from older/cached builds.
