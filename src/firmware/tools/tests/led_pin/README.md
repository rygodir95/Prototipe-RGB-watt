# LED pin regression

From `src/firmware`, run `pio run`, then `python tools/test_led_pin.py`.
The host test needs `g++` on PATH, or set `CXX` to a host C++ compiler.
It uses the same ArduinoJson dependency as the firmware build.

The test compiles the real Config, Storage and LEDController sources and the
API's LED pin patch helper. Only Arduino logging/time, NVS and NeoPixel hardware
are replaced. It checks all GPIO numbers, negative and overflowing values,
flash pins, input-only pins, malformed JSON types, omitted fields, persistence
round trips, initialization, runtime reconfiguration and fallback logs.

The classic ESP32 output GPIOs are accepted except flash GPIO6-11. Invalid
values fall back to GPIO5. Existing valid pins are preserved. Strapping pins
remain configurable; this validation does not replace board wiring checks.

For hardware verification, boot with an invalid `ledPin` in a valid-version
NVS config and confirm a `[STORE] Invalid ledPin ... falling back to GPIO5`
message, no invalid GPIO/RMT initialization error, and LED output on GPIO5.
POST `{"ledPin":34}` to `/api/config` and confirm the API log, reported config
and next boot use GPIO5. A patch omitting `ledPin` must retain the current pin.
