# TCP lifecycle investigation

This is instrumentation, not a stability fix. The baseline device is build
`5f2dcd032eb769c77d3bf65512ea81724e0d096a`, using AsyncTCP 3.5.0 and
ESPAsyncWebServer 3.12.1 on Arduino-ESP32 2.0.17.

The reported 120-second baseline had 59 successful config reads / 2 timeouts,
46 successful simulation updates / 2 timeouts, and a failed WebSocket.
LED work was below 3 ms; there was no reboot or new Wi-Fi event.
A subsequent isolated 30-request raw TCP probe also reproduced failures with
no simulation traffic: delayed connects, headers, and connection closure;
received bodies were complete. This rules out demo overlap as a necessary
trigger, but does not yet distinguish packet loss from TCP lifecycle defects.

AsyncTCP 3.5.0 does not initialize `_rx_ack_len` in its constructor, although
`close()` passes it to `tcp_recved`. Upstream PR 123 addresses that field and
callback destruction safety: https://github.com/ESP32Async/AsyncTCP/pull/123.
This is a candidate defect, not a demonstrated cause of this device's stalls.
No dependency workaround has been applied.

## Diagnostic build

`/api/diagnostics` reports `diagnosticRevision: tcp-lifecycle-1` and a `network`
snapshot. `[NET]` serial records carry the same counters independently of HTTP.
Existing `[PERF]`, `[WIFI]`, and `[RESET]` records remain available.

The TCP snapshot runs once per second on the TCP/IP task, with at most one
outstanding non-blocking callback. It records active/TIME_WAIT PCBs, SYN_RCVD,
ESTABLISHED and closing states, PCBs retransmitting, maximum current retry
count, PCBs with unacknowledged/unsent data, and zero receive windows.
These are sampled gauges, not cumulative packet-loss counters. Short-lived
states between samples can be missed. No PCB pointers escape the TCP/IP task.

HTTP timing starts at parsed-request middleware dispatch, **not** SYN arrival
or the first body chunk. `dispatchMaxUs` measures middleware continuation;
`lifetimeMaxMs` measures dispatch to disconnect. `closed` excludes WS upgrades.
It does not prove the client received every byte. Raw client timing and TCP
gauges must be correlated with it. WS counters record open, disconnect, error,
and active connections without replacing library-owned AsyncClient callbacks.

## Physical validation

After flashing, confirm both `/api/info` and `diagnosticRevision`. Capture USB
serial without toggling DTR/RTS. Run:

```
node tools/soak_network_hardware.cjs http://192.168.4.1 120 before-or-after-120.json
node tools/soak_network_hardware.cjs http://192.168.4.1 600 after-600.json
```

The runner retains the existing 4-second request timeout, 500 ms rest between
config reads and 1500 ms between simulation updates. Each worker consumes its
full response before another request. It records every failure, does not
reconnect the WebSocket, and attempts to disable simulation on exit. It does
not change saved config. Failed bootstrap requests abort before simulation.

Reports include individual full-response latencies, p50/p95/p99/max/mean,
10-second health samples, WS frame gaps and disconnects. A transport pass is
not sufficient: review serial reset/AP logs, heap/largest-block trends, PCB
counts and sample freshness before declaring full acceptance. Sampled minimum
heap alone is a historical low-water mark, not evidence of a continuing leak.

The instrumented two-minute and ten-minute physical runs, root-cause proof,
and final stability fix are still pending.
