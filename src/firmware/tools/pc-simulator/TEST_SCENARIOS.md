# TEST SCENARIOS — PC Simulator, RGB Watt Controller

Manual test cases for the PC simulator (testing tool only). Each case has a
Test ID, objective, steps, expected result, and an **Actual result** field for
the tester. Preconditions unless stated otherwise:

* Simulator started via `run_simulator.bat`, GUI open at `http://localhost:8080/`
* Developer panel open at `http://localhost:8080/dev/`
* Default config (FTP 221 W, 7 zones, smoothing 45, hysteresis 5 W,
  timeout 5000 ms) — if unsure, run *Factory reset* in the panel first.

---

## T01 — Basic power change

**Objective:** a simulated wattage flows through the whole pipeline to the GUI.

**Steps:**
1. GUI dashboard: enable Simulation, set the slider to 0 W, then 300 W.
2. Watch the dashboard power value, zone badge and glow color.

**Expected:** smoothed power ramps up (EMA, smoothing 45); zone advances from
Recovery through Endurance/Tempo/Threshold; color transitions continuously
blue → cyan → green → yellow → orange. Panel "Live pipeline" shows the same raw
and smoothed values. Log shows `power update` and `zone` events.

**Actual result:** ______________________________

## T02 — Zone boundary test (off-by-one)

**Objective:** verify the exact zone boundary handling of the existing rules.

**Steps:**
1. In the panel: click *Set boundary-test zones* (0/100/130/160/190/220/250 W),
   then apply **hysteresis 0** and **smoothing 0**.
2. Use the *Zone boundary probes*: click 99 → 100 → 101 → 129 → 130 → 131 W.

**Expected:** with hysteresis 0 and smoothing 0 the zone index follows the raw
wattage: 99 W → Z1, 100 W → Z2 (lower bound inclusive), 101 W → Z2, 129 W → Z2,
130 W → Z3, 131 W → Z3. Colors interpolate within each zone span.

**Actual result:** ______________________________

## T03 — Hysteresis test

**Objective:** verify the existing hysteresis implementation around boundaries.

**Steps:**
1. Boundary-test zones as in T02, smoothing 0, **hysteresis 5**.
2. Set 129 W, then 130 W, then 133 W, then back down 131 W → 126 W → 124 W.
3. Oscillation test: alternate 219 → 221 → 219 → 221 → 219 W.

**Expected:** entering a zone requires clearing its lower bound by the margin:
130 W stays Z2 (130 < 130+5), 135 W enters Z3; leaving downward requires
dropping below the boundary by the margin. In the 219/221 oscillation the zone
does **not** flicker between Z5 and Z6 — that is the hysteresis working. The
zone changes exactly as the firmware's `PowerZones::zoneIndex` dictates; the
simulator does not soften or change this behavior.

**Actual result:** ______________________________

## T04 — Smoothing test

**Objective:** verify EMA smoothing behavior at different settings.

**Steps:**
1. Set smoothing 0 (panel: apply), set power 0 W, then jump to 300 W.
2. Observe the smoothed value in the panel/GUI.
3. Set smoothing 90 and repeat 0 → 300 W, then back to 0 W.

**Expected:** smoothing 0 → smoothed follows raw instantly (one tick, 100 ms).
Smoothing 90 → smoothed approaches 300 W gradually over several seconds and
falls back slowly; zone changes lag visibly behind the raw value.

**Actual result:** ______________________________

## T05 — Power timeout

**Objective:** verify the stale-data timeout path.

**Steps:**
1. Panel → BLE simulation: *Connect Meter*, confirm state RECEIVING_POWER.
2. Set power timeout to 2000 ms (panel quick-apply), set power to 200 W.
3. Click *Stop telemetry* and watch the panel/GUI for ~5 s.
4. Click *Restore telemetry*.

**Expected:** after ~2 s without data: `timeout` event in the log, hasData
goes false, raw drops to 0, LED fade ramps to 0 over ~600 ms (preview dims),
state falls back to CONNECTED (still connected, just silent), smoothed value is
kept for display briefly. On restore, telemetry resumes and the fade ramps back
up. With Simulation Mode ON the timeout never triggers (same as firmware).

**Actual result:** ______________________________

## T06 — BLE disconnect / reconnect simulation

**Objective:** verify the state transitions the GUI shows for the meter.

**Steps:**
1. *Connect Meter* → wait for RECEIVING_POWER (dashboard shows the meter).
2. Click *Disconnect* in the panel (same as GUI *Disconnect*).
3. Click *Connection lost* after reconnecting, with auto-reconnect **on** (Settings).
4. Repeat with auto-reconnect **off**.
5. Toggle *Meters hidden from scan* ON, then trigger a scan / reconnect.

**Expected:** disconnect → DISCONNECTED immediately. Connection lost →
RECONNECTING, automatic reconnection after ~7 s (scan + connect). With
auto-reconnect off → stays DISCONNECTED. With meters hidden: scan finds
nothing, "No devices found", reconnect loops every ~7 s (this mirrors the
known firmware issue with non-advertising meters).

**Actual result:** ______________________________

## T07 — WebSocket disconnect / reconnect

**Objective:** verify telemetry robustness over the WebSocket.

**Steps:**
1. With the GUI open, click *Disconnect WS clients* in the panel.
2. Wait ~3 s, then click *Pause telemetry*, then *Resume telemetry*.

**Expected:** GUI loses telemetry briefly and reconnects by itself (~2 s,
its own retry logic); status pill reappears with live data. Paused broadcast →
GUI values freeze; resume → values catch up to current state.

**Actual result:** ______________________________

## T08 — Configuration persistence

**Objective:** verify config survives a simulated reboot.

**Steps:**
1. Change FTP to 250 W in the GUI (Zones view), save zones with a custom name.
2. Change brightness to 40%.
3. Stop the simulator (Ctrl+C), restart it, reload the GUI.

**Expected:** FTP 250, custom zone name and rescaled boundaries, brightness
40% all persist (stored in `sim_config.json` — the NVS equivalent). If a saved
power source exists and auto-reconnect is on, the boot sequence tries to
reconnect to it (visible in the log as `restoring saved source`). Factory reset
restores defaults.

**Actual result:** ______________________________

## T09 — Invalid input testing

**Objective:** verify API robustness against malformed data.

**Steps:**
1. From a terminal:
   `curl -X POST http://localhost:8080/api/config -d "not json" -H "Content-Type: application/json"`
2. `curl -X POST http://localhost:8080/api/config -d "{\"smoothing\":999,\"hysteresis\":-5,\"brightness\":700,\"ledCount\":99999}"`
3. `curl -X POST http://localhost:8080/api/config -d "{\"zoneCount\":9}"`
4. Zone editor: set two zones to the same lower bound and save.

**Expected:** 1 → `400 {"ok":false,"error":"bad json"}` (no crash). 2 → values
are clamped by the existing rules (smoothing 100, hysteresis 0, brightness 100,
ledCount 1000). 3 → zoneCount falls back to 7 (MAX_ZONES) with default zones.
4 → sanitize forces strictly increasing boundaries. The simulator keeps running
in all cases.

**Actual result:** ______________________________

## T10 — Rapid power changes

**Objective:** verify stability and correct rendering under fast changes.

**Steps:**
1. Panel: enable *Jump* (100 ↔ 250 W, every 1000 ms) with smoothing 45.
2. Set the jump interval to 100 ms for a few seconds, then disable.
3. Enable *Noise* ±30 W on top.

**Expected:** zone flicker is suppressed by smoothing/hysteresis, the GUI and
panel keep updating smoothly, no stale values, no crashes; log records the
jumps. Noise visibly jitters the raw value while smoothed stays stable.

**Actual result:** ______________________________

## T11 — RGB output verification

**Objective:** verify the interpolated RGB result without physical LEDs.

**Steps:**
1. Set smoothing 0, hysteresis 0.
2. Walk the power through 0 → 124 → 168 → 201 → 234 → 267 → 334 → 400 W
   (FTP-221 default boundaries: 0/124/168/201/234/267/334).
3. Compare the panel's "RGB (zone color)" and the big preview with the zone
   colors configured in the GUI zone editor.

**Expected:** at each boundary crossing the color lands exactly on the
configured zone color (boundaries are the anchor points of the existing
interpolation); between boundaries the color is a continuous blend of the
neighboring zone colors; brightness scales the preview; the hex value shown
matches the GUI zone editor colors.

**Actual result:** ______________________________

## T12 — Full end-to-end simulated workout

**Objective:** verify the complete pipeline over a longer scripted sequence.

**Steps:**
1. Panel → Test sequence: keep `0,100,150,200,250,300,0`, delay 1500 ms, *Run*.
2. Alternatively drive it manually with presets and noise.
3. Watch GUI dashboard, zone bar marker, zone badge, event log.
4. While running, change brightness to 20% mid-sequence.

**Expected:** Simulation Mode engages automatically, power steps through the
sequence, zones/colors track every step, the zone-bar marker moves, log shows
each script step, zone and RGB changes. Brightness change applies live
(preview dims) without disturbing the sequence. After the last step (0 W) the
zone returns to Z1 with the first zone color.

**Actual result:** ______________________________

---

### Tester summary

| ID | Pass / Fail | Notes |
|----|-------------|-------|
| T01 | | |
| T02 | | |
| T03 | | |
| T04 | | |
| T05 | | |
| T06 | | |
| T07 | | |
| T08 | | |
| T09 | | |
| T10 | | |
| T11 | | |
| T12 | | |