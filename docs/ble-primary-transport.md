# Hub BLE transport (prototype)

This is the first step toward a BLE-primary Hub. The Hub remains responsible
for the Power/Heart Rate sensor link, zone calculation and LED output. A phone
or desktop client connects to the Hub's local GATT server; it never connects to
the training sensors directly.

Wi-Fi stays available for the existing web UI, diagnostics and OTA. It is not
required for the Hub to operate or for the BLE control path.

## Connection model

The ESP32 permits two simultaneous BLE links:

1. one selected Power **or** Heart Rate sensor;
2. one phone or desktop control client.

Source switching stays serialized. The old sensor link has to close before the
new sensor link is opened, so this never temporarily requires a third link.

The device advertises as `Training Hub` and exposes service
`5ca90000-6d75-4ca5-b4d6-3f9e6c5b0001`.

| Characteristic | UUID suffix | Direction | Purpose |
| --- | --- | --- | --- |
| Status | `...0001` | read / notify | Compact live state and telemetry |
| Command | `...0002` | write | One JSON command, maximum 180 bytes |
| Result | `...0003` | read / notify | Command acknowledgement or error |

Every message has protocol version `v: 1`. Status includes the active source,
connection/data state, smoothed value, zone, colour and simulation state. The
Hub sends a changed status promptly and an unchanged-state heartbeat every at
most 1.5 seconds.

## Supported commands

Each command needs a non-zero client-selected `id`; the result echoes it.

```json
{"id":1,"op":"lighting_test","on":true}
{"id":2,"op":"simulation","on":true,"value":180}
{"id":3,"op":"source","value":"hr"}
{"id":4,"op":"diagnostics"}
```

`lighting_test` uses the existing lighting-test simulation path. `simulation`
uses the existing selected-source simulation path. `source` selects a previously
saved Power or Heart Rate source. `diagnostics` returns current and minimum free
heap. Configuration writes are deliberately not included in this first BLE
transport increment: they need a versioned patch/validation contract and
pairing policy before they can safely replace the existing web configuration.

## Client validation

An Android emulator can exercise the client UI and a mocked transport. It is
not acceptance evidence for the real ESP32 radio link. Final BLE acceptance
requires a physical Android phone, a real sensor and the physical LED strip:

1. pair/connect to `Training Hub` and subscribe to Status and Result;
2. verify live Power and HR status and a 1.5-second-or-less status heartbeat;
3. send every supported command and verify its matching Result;
4. switch the active source while the control client stays connected;
5. disconnect/reconnect the phone and the sensor independently;
6. repeat with Wi-Fi disabled at the Hub, then restore Wi-Fi and verify the web
   UI and OTA/diagnostics remain available.

