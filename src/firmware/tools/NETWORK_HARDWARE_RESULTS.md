# Physical network comparison — 2026-09-15

All results below use diagnostic firmware `e502e2f`. No AsyncTCP dependency,
LED, BLE, zone, sensor or UI change separates the AP and router measurements.
The runner retains a four-second request deadline, 500 ms rest between config
reads, and 1500 ms rest between simulation updates. Latency statistics cover
successful full JSON responses; failures are counted separately. Counts include
setup/cleanup. Simulation is disabled after each run.

## Access-point path

The last combined ordinary-Windows/capture run had 95 successful config reads
and 2 timeouts, plus 56 successful simulation requests and 1 timeout. Config
p50/p95/max were 362/2091/3944 ms; simulation 343/2147/3148 ms. The WS stayed
connected with 133 frames and a 2615 ms maximum gap. This fails HTTP acceptance.
Earlier AP runs also lost WS connections and showed ping loss and TCP connect
delays without simulation. HTTP/1.0 fresh connections reproduced delays too.

Closing PCBs with retransmissions accumulated during failures and subsequently
declined. Heap recovered after traffic stopped. WS open/close counters balanced
after clients disconnected. These observations do not demonstrate an unchecked
WS-client leak, main-loop stall, or an LED/simulation handler bottleneck.

Two Windows Packet Monitor captures were incomplete: the IP-filtered capture
contained only four inbound packets, while the MAC-filtered capture contained
none despite successful HTTP and WS delivery. They demonstrate some repeated
SYN/request/FIN sequences but cannot establish loss direction. Missing responses
in those traces are not evidence that the ESP32 did not transmit them.

## Router station path

After correcting the saved network name, the same firmware joined the router
in station mode. The earlier join failure was `NO_AP_FOUND`; that configuration
error is distinct from AP HTTP timeouts.

The 120-second router run passed: 208 config requests, 76 simulation requests,
170 WS frames; zero HTTP failures or WS reconnects. Config p50/p95/max were
59/141/246 ms; simulation 125/228/627 ms. WS maximum gap was 1510 ms. Wi-Fi
event counts were unchanged and largest free heap block stayed 94196 bytes.

Windows had both Ethernet and USB Wi-Fi routes to the router, with Ethernet
preferred. Therefore this comparison alone does not isolate AP firmware from
the computer's USB Wi-Fi path. A source-address-bound adapter comparison is
needed before assigning the fault to either side.

The 600-second router run also passed:

| Endpoint | Successful requests | Failures | p50 / p95 / max, ms |
| --- | ---: | ---: | --- |
| Config reads | 1040 | 0 | 57 / 135 / 1069 |
| Simulation | 376 | 0 | 122 / 163 / 335 |
| Diagnostics | 62 | 0 | 40 / 138 / 207 |

WS delivered 877 frames on one connection, with zero errors/disconnects and a
1545 ms maximum gap. Cleanup succeeded. Uptime increased from 52873 to 653005 ms;
reset reason remained POWER_ON and Wi-Fi event count stayed 3. These snapshots
show no reboot/brownout or Wi-Fi restart during this run; the earlier router
test was a separate boot.

During the run, sampled free heap ranged from 112148 to 121540 bytes. The largest
block ranged from 90100 to 94196 and ended at 94196. Historical minimum heap
reached 102804. This is a peak-allocation measure, not a monotonic leak counter.
Sampled active PCBs peaked at 3, closing at 1; there were zero sampled TCP
retries and zero diagnostic queue drops. The final post-load snapshot had
119432 free bytes, a 94196-byte largest block, zero active/closing/TIME_WAIT PCBs,
and WS opened/closed 1/1 with zero active clients. No progressive unrecovered
resource degradation was observed.

## Adapter-bound comparison

After the soak, 30 alternating fresh HTTP reads per adapter explicitly bound
their source address to the respective interface. Both used the same router
and unchanged Hub station-mode firmware:

| Adapter | Success / failure | Median / max, ms |
| --- | --- | --- |
| Ethernet | 30 / 0 | 125 / 235 |
| TP-Link USB Wi-Fi | 30 / 0 | 110 / 187 |

This short read-only probe is not a second ten-minute WS test. It does show the
USB adapter can deliver reliable HTTP through the router during this sample.

## Conclusion and limits

The failures are associated with the direct ESP32 AP network path in these
measurements. The same HTTP/WS firmware and request cadence pass through the
router, including a stable ten-minute run. TCP retransmission/connection delays
also occurred before HTTP dispatch on the AP path. This supports a delivery/
acknowledgement problem on that path; it does not identify the exact radio,
driver, channel, or AP interoperability mechanism.

No speculative AsyncTCP patch, larger timeout, or slower demo cadence was
applied. The uninitialized AsyncTCP field noted in NETWORK_INVESTIGATION.md
remains a separate source-level defect whose causal role has not been proved.
These are network-topology comparisons, not proof of a firmware fix. AP-mode
acceptance and the exact root cause remain unresolved; router operation is
validated. Do not mark the original AP stability requirement complete.
