#!/usr/bin/env python3
"""PC development/test simulator for the ESP32 RGB Watt Zone Controller.

TESTING TOOL ONLY - this is not part of the firmware build. Nothing here is
compiled for the ESP32, embedded into WebContent.h, or required by the device.

It emulates the ESP32/device side:

  * serves the EXISTING web GUI (../../data/web/) completely unchanged,
  * implements the same REST API and WebSocket telemetry as
    src/WebInterface.cpp (same paths, same JSON keys, same status codes),
  * runs a faithful port of the firmware pipeline (see pipeline.py):
    virtual power -> EMA smoothing -> zone calc with hysteresis -> RGB,
  * simulates the BLE power meter as a state machine (no real BLE),
  * persists the configuration to sim_config.json (NVS equivalent),
  * exposes a Developer / Test Panel at http://localhost:<port>/dev/

Prerequisites: Python 3.8+, standard library only (no pip packages).
"""

import argparse
import base64
import hashlib
import json
import random
import socket
import struct
import sys
import threading
import time
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import pipeline as fw  # noqa: E402  (faithful firmware port)

WEB_ROOT = HERE.parent.parent / "data" / "web"
DEV_PANEL = HERE / "devpanel.html"
CFG_PATH = HERE / "sim_config.json"
WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

SIM_VERSION = "1.0.0-dev-sim"

# Virtual BLE meters. "reveal" = seconds after scan start before the meter
# shows up in scan results (mimics staggered real-world scan results).
VIRTUAL_METERS = [
    {"address": "02:00:00:00:11:22", "name": "Virtual Trainer", "type": "FTMS",
     "rssi": -57, "reveal": 1.4},
    {"address": "02:00:00:00:33:44", "name": "Virtual Power Meter", "type": "CPS",
     "rssi": -66, "reveal": 2.9},
]

# Virtual BLE heart rate sensors (Heart Rate Service 0x180D devices).
VIRTUAL_HR_SENSORS = [
    {"address": "02:00:00:00:55:66", "name": "Virtual HR Strap", "type": "HRS",
     "rssi": -59, "reveal": 1.2},
    {"address": "02:00:00:00:77:88", "name": "Virtual Watch HR", "type": "HRS",
     "rssi": -71, "reveal": 2.4},
]

MAX_EVENTS = 300


class Simulator:
    """Virtual ESP32: config + BLE state machine + pipeline + event log."""

    def __init__(self, cfg_path=CFG_PATH):
        self.lock = threading.RLock()
        self.cfg_path = Path(cfg_path)
        self.cfg = fw.AppConfig()
        self._load()

        # Telemetry (AppState.h Telemetry struct)
        self.tel = {
            "state": "STARTING", "connected": False, "hasData": False,
            "simMode": False, "rawPower": 0.0, "smoothedPower": 0.0,
            "rawBpm": 0.0, "smoothedBpm": 0.0,
            "zone": 0, "r": 0, "g": 0, "b": 0, "sourceName": "",
        }
        # Simulation mode (include/Simulation.h)
        self.sim_enabled = False
        self.sim_watts = 0.0
        self.sim_bpm = 120.0

        # Virtual power source (dev panel controls)
        self.base_watts = 150.0
        self.noise = False
        self.noise_amp = 10.0
        self.freeze = False
        self.frozen_value = None
        self.sending = True          # meter notifications on/off
        self.jump = False
        self.jump_a = 100.0
        self.jump_b = 250.0
        self.jump_ms = 1000
        self._jump_hi = False
        self._jump_t = 0.0

        # Virtual BLE (state machine mirroring src/BLEPower.cpp flow)
        self.ble_connected = False
        self.desired = False
        self._target_addr = ""
        self._target_name = ""
        self.scanning = False
        self._scan_start = 0.0
        self._scan_end = 0.0
        self.found_devices = {}      # address -> meter dict (cleared on scan)
        self.devices_visible = True
        self._connecting = False
        self._connect_end = 0.0
        self._last_attempt = 0.0
        self._last_power = 0.0       # last meter "notification" time
        self._last_power_value = 0.0

        # Virtual BLE HR sensor (state machine mirroring src/HRSensor.cpp flow)
        self.hr_connected = False
        self.hr_desired = False
        self._hr_target_addr = ""
        self._hr_target_name = ""
        self._hr_connecting = False
        self._hr_connect_end = 0.0
        self._hr_last_attempt = 0.0
        self._hr_last_notify = 0.0   # last strap "notification" time
        self._hr_value = 0.0
        self.hr_sending = True       # strap notifications on/off
        self.base_bpm = 120.0         # bpm the virtual strap reports

        # LED preview (fade from LEDController.cpp, scaled by brightness)
        self.fade = 0.0
        self._fade_target = 0.0

        # Pipeline state
        self.processor = fw.PowerProcessor()
        self.processor.set_smoothing(self.cfg.smoothing)
        self.prev_zone = 0
        self.prev_zone_hr = 0
        self._had_data = False
        self._boot_done = False

        # WebSocket clients
        self.ws_lock = threading.Lock()
        self.ws_clients = set()
        self.ws_paused = False

        # Event log
        self.events = []
        self._event_id = 0
        self._last_power_log = 0.0
        self._last_rgb_log = 0.0
        self._last_rgb = ""

        # Script runner
        self.script = None            # {"steps": [...], "delayMs": int, "i": int}
        self._script_stop = threading.Event()

    # ---- events ----------------------------------------------------------

    def log(self, etype, msg):
        with self.lock:
            self._event_id += 1
            ev = {"id": self._event_id,
                  "time": time.strftime("%H:%M:%S") + ".%03d" % (int(time.time() * 1000) % 1000),
                  "type": etype, "msg": str(msg)}
            self.events.append(ev)
            if len(self.events) > MAX_EVENTS:
                del self.events[:-MAX_EVENTS]
        print("[%s] %s" % (etype.upper(), msg), flush=True)

    # ---- persistence (Storage.cpp equivalent) ----------------------------

    def _load(self):
        if self.cfg_path.exists():
            try:
                data = json.loads(self.cfg_path.read_text(encoding="utf-8"))
            except (ValueError, OSError):
                data = None
            if data is not None and self.cfg.from_storage(data):
                print("[STORE] Configuration loaded", flush=True)
                return
            print("[STORE] Stored config unusable, using defaults", flush=True)
        else:
            print("[STORE] No stored config, using defaults", flush=True)

    def save(self):
        try:
            self.cfg_path.write_text(
                json.dumps(self.cfg.to_storage(), indent=1), encoding="utf-8")
        except OSError as e:
            print("[STORE] save failed: %s" % e, flush=True)

    def factory_reset(self):
        self.cfg = fw.AppConfig()
        self.save()
        self.processor.set_smoothing(self.cfg.smoothing)

    # ---- telemetry JSON (broadcastTelemetry) ----------------------------

    def telemetry_json(self):
        """broadcastTelemetry() from src/WebInterface.cpp - faithful port."""
        t = self.tel
        hr = self.mode() == "hr"
        if hr:
            zone_name = self.cfg.hr_zones[t["zone"]].name \
                if 0 <= t["zone"] < fw.MAX_HR_ZONES else ""
            zone_count = fw.MAX_HR_ZONES
            raw, smoothed = t["rawBpm"], t["smoothedBpm"]
        else:
            zone_name = self.cfg.zones[t["zone"]].name \
                if 0 <= t["zone"] < self.cfg.zone_count else ""
            zone_count = self.cfg.zone_count
            raw, smoothed = t["rawPower"], t["smoothedPower"]
        return {
            "mode": "hr" if hr else "power",
            "state": t["state"],
            "connected": t["connected"],
            "hasData": t["hasData"],
            "sim": t["simMode"],
            # raw/smoothed always carry the ACTIVE source's measurement (W or bpm)
            "raw": fw.lround(raw),
            "smoothed": fw.lround(smoothed),
            # explicit HR fields for clients/tests
            "hr": fw.lround(t["smoothedBpm"]),
            "hrRaw": fw.lround(t["rawBpm"]),
            "hrMax": self.cfg.hr_max,
            "zone": t["zone"],
            "zoneName": zone_name,
            "ftp": self.cfg.ftp,
            "zoneCount": zone_count,
            "brightness": self.cfg.brightness,
            "source": t["sourceName"],
            "color": fw.hex_from_rgb(t["r"], t["g"], t["b"]),
        }

    # ---- virtual power source ---------------------------------------------

    def power_value(self, now):
        """Effective watts the virtual meter reports this instant."""
        if self.freeze and self.frozen_value is not None:
            return self.frozen_value
        w = self.base_watts
        if self.jump:
            if now - self._jump_t >= self.jump_ms / 1000.0:
                self._jump_t = now
                self._jump_hi = not self._jump_hi
                self.log("power", "jump -> %d W" % (self.jump_b if self._jump_hi else self.jump_a))
            w = self.jump_b if self._jump_hi else self.jump_a
        if self.noise:
            w += random.uniform(-self.noise_amp, self.noise_amp)
        return max(0.0, w)

    # ---- control source (main.cpp setControlSource - mutual exclusion) ----

    def mode(self):
        """Active control source: "hr" or "power". Exactly one is ever active."""
        return "hr" if self.cfg.control_source == fw.SRC_HEART_RATE else "power"

    def is_connected(self):
        """Connected state of the ACTIVE control source's sensor."""
        return self.hr_connected if self.mode() == "hr" else self.ble_connected

    def ble_shutdown(self):
        """Power module teardown: disconnect, stop scan/connect/reconnect,
        drop its cached device list."""
        self.desired = False
        self.ble_connected = False
        self._connecting = False
        self.scanning = False
        self.found_devices = {}

    def hr_shutdown(self):
        """Heart Rate module teardown (mirror of ble_shutdown)."""
        self.hr_desired = False
        self.hr_connected = False
        self._hr_connecting = False
        self.scanning = False
        self.found_devices = {}

    def switch_source(self, src):
        """main.cpp setControlSource(): disconnect the currently active sensor
        BEFORE swapping to the new input. Only one module is ever
        scanning/connecting/processing at a time, and each mode keeps its own
        saved sensor, zones and live state."""
        if src != fw.SRC_POWER and src != fw.SRC_HEART_RATE:
            src = fw.SRC_POWER
        if src == self.cfg.control_source:
            return

        # 1. Fully tear down the currently active BLE module.
        if self.cfg.control_source == fw.SRC_HEART_RATE:
            self.hr_shutdown()
        else:
            self.ble_shutdown()

        # 2. Clear the shared live measurement state and the LED pipeline.
        self.processor.reset()
        self.prev_zone = 0
        self.prev_zone_hr = 0
        t = self.tel
        t["rawPower"] = 0.0
        t["smoothedPower"] = 0.0
        t["rawBpm"] = 0.0
        t["smoothedBpm"] = 0.0
        t["zone"] = 0
        t["r"] = t["g"] = t["b"] = 0
        t["hasData"] = False
        t["sourceName"] = ""
        self._fade_target = 0.0

        # 3. Activate only the selected source and persist the mode.
        self.cfg.control_source = src
        self.save()
        self.log("src", "control source switched to %s"
                 % ("Heart Rate" if src == fw.SRC_HEART_RATE else "Power"))

        # 4. Restore the selected source's own saved sensor (kept per mode).
        if self.cfg.auto_reconnect:
            if src == fw.SRC_HEART_RATE and self.cfg.hr_source_addr:
                self.log("hr", "restoring saved source: %s" % self.cfg.hr_source_name)
                self.hr_connect_to(self.cfg.hr_source_addr, self.cfg.hr_source_name)
            elif src == fw.SRC_POWER and self.cfg.source_addr:
                self.log("ble", "restoring saved source: %s" % self.cfg.source_name)
                self.connect_to(self.cfg.source_addr, self.cfg.source_name)
            else:
                self.set_state("DISCONNECTED")
        else:
            self.set_state("DISCONNECTED")

    # ---- BLE simulation ----------------------------------------------------

    def start_scan(self, seconds, now=None):
        if self.scanning:
            return
        now = now or time.time()
        self.scanning = True
        self._scan_start = now
        self._scan_end = now + seconds
        self.found_devices = {}
        if not self.is_connected():
            self.set_state("SCANNING")
        self.log("ble", "scan started (%ds)" % seconds)

    def connect_to(self, addr, name, now=None):
        """Firmware BLEPower::connectToAddress equivalent (Power mode only)."""
        if self.mode() == "hr":
            return   # mutual exclusion: only the active module connects
        now = now or time.time()
        self._target_addr = addr
        self._target_name = name
        self.desired = True
        if self.scanning:
            self.scanning = False
        if addr in self.found_devices:
            self._start_connecting(now)
        else:
            self.start_scan(6.0, now)   # not seen yet -> scan then connect

    def _start_connecting(self, now):
        self._connecting = True
        self._connect_end = now + 1.2
        if not self.ble_connected:
            self.set_state("CONNECTING")

    def disconnect(self, forget=False):
        self.desired = False
        self.ble_connected = False
        self._connecting = False
        self.tel["sourceName"] = ""
        self.set_state("DISCONNECTED")
        self.log("ble", "disconnected")
        if forget:
            self._target_addr = ""
            self._target_name = ""
            self.cfg.source_addr = ""
            self.cfg.source_name = ""
            self.save()

    def connection_lost(self):
        """Meter drops out unexpectedly; auto-reconnect (if enabled) kicks in."""
        self.ble_connected = False
        self._connecting = False
        self.set_state("RECONNECTING" if (self.desired and self.cfg.auto_reconnect)
                       else "DISCONNECTED")
        self._last_attempt = time.time()
        self.log("ble", "connection lost")

    # ---- Heart Rate sensor simulation (HRSensor.cpp) -------------------------

    def hr_connect_to(self, addr, name, now=None):
        """HRSensor::connectToAddress equivalent (Heart Rate mode only)."""
        if self.mode() != "hr":
            return   # mutual exclusion: only the active module connects
        now = now or time.time()
        self._hr_target_addr = addr
        self._hr_target_name = name
        self.hr_desired = True
        if self.scanning:
            self.scanning = False
        if addr in self.found_devices:
            self._hr_start_connecting(now)
        else:
            self.start_scan(6.0, now)   # not seen yet -> scan then connect

    def _hr_start_connecting(self, now):
        self._hr_connecting = True
        self._hr_connect_end = now + 1.2
        if not self.hr_connected:
            self.set_state("CONNECTING")

    def hr_disconnect(self, forget=False):
        self.hr_desired = False
        self.hr_connected = False
        self._hr_connecting = False
        self.tel["sourceName"] = ""
        self.set_state("DISCONNECTED")
        self.log("hr", "disconnected")
        if forget:
            self._hr_target_addr = ""
            self._hr_target_name = ""
            self.cfg.hr_source_addr = ""
            self.cfg.hr_source_name = ""
            self.save()

    def hr_connection_lost(self):
        """Strap drops out unexpectedly; auto-reconnect (if enabled) kicks in."""
        self.hr_connected = False
        self._hr_connecting = False
        self.set_state("RECONNECTING" if (self.hr_desired and self.cfg.auto_reconnect)
                       else "DISCONNECTED")
        self._hr_last_attempt = time.time()
        self.log("hr", "connection lost")

    def set_state(self, s):
        if self.tel["state"] != s:
            self.tel["state"] = s
            self.log("state", s.replace("_", " ").lower())

    # ---- per-tick state machines -------------------------------------------

    def _tick_ble(self, now):
        # Only the active control source's BLE machine is ever serviced (loop()).
        if self.mode() == "hr":
            self._tick_ble_hr(now)
        else:
            self._tick_ble_power(now)

    def _tick_ble_power(self, now):
        # Connecting completes -> CONNECTED (data flow then promotes to RECEIVING_POWER)
        if self._connecting and now >= self._connect_end:
            self._connecting = False
            self.ble_connected = True
            self.tel["sourceName"] = self._target_name
            self.set_state("CONNECTED")
            self.log("ble", "connected to %s" % (self._target_name or self._target_addr))

        # Scan results appear staggered
        if self.scanning:
            if self.devices_visible:
                for m in VIRTUAL_METERS:
                    if (now - self._scan_start) >= m["reveal"] \
                            and m["address"] not in self.found_devices:
                        self.found_devices[m["address"]] = dict(m)
                        self.log("ble", "device found: %s [%s]" % (m["name"], m["type"]))
            if now >= self._scan_end:   # onScanEnd
                self.scanning = False
                self.log("ble", "scan complete (%d devices)" % len(self.found_devices))
                if self.desired and not self.ble_connected and self._target_addr:
                    if self._target_addr in self.found_devices:
                        self._start_connecting(now)
                    else:
                        self.set_state("DISCONNECTED")

        # Auto-reconnect loop (BLEPower::update equivalent)
        if (self.desired and self.cfg.auto_reconnect and not self.ble_connected
                and not self.scanning and not self._connecting and self._target_addr):
            if now - self._last_attempt > 7.0:
                self._last_attempt = now
                self.set_state("RECONNECTING")
                self.log("ble", "attempting reconnect...")
                self.start_scan(6.0, now)

    def _tick_ble_hr(self, now):
        # Strap connect completes -> CONNECTED (data flow then promotes to RECEIVING_POWER)
        if self._hr_connecting and now >= self._hr_connect_end:
            self._hr_connecting = False
            self.hr_connected = True
            self._hr_value = self.base_bpm
            self._hr_last_notify = now
            self.tel["sourceName"] = self._hr_target_name
            self.set_state("CONNECTED")
            self.log("hr", "connected to %s" % (self._hr_target_name or self._hr_target_addr))

        # Scan results appear staggered (HR sensors only)
        if self.scanning:
            if self.devices_visible:
                for m in VIRTUAL_HR_SENSORS:
                    if (now - self._scan_start) >= m["reveal"] \
                            and m["address"] not in self.found_devices:
                        self.found_devices[m["address"]] = dict(m)
                        self.log("hr", "device found: %s [%s]" % (m["name"], m["type"]))
            if now >= self._scan_end:   # onScanEnd
                self.scanning = False
                self.log("hr", "scan complete (%d devices)" % len(self.found_devices))
                if self.hr_desired and not self.hr_connected and self._hr_target_addr:
                    if self._hr_target_addr in self.found_devices:
                        self._hr_start_connecting(now)
                    else:
                        self.set_state("DISCONNECTED")

        # Auto-reconnect loop (HRSensor::update equivalent)
        if (self.hr_desired and self.cfg.auto_reconnect and not self.hr_connected
                and not self.scanning and not self._hr_connecting and self._hr_target_addr):
            if now - self._hr_last_attempt > 7.0:
                self._hr_last_attempt = now
                self.set_state("RECONNECTING")
                self.log("hr", "attempting reconnect...")
                self.start_scan(6.0, now)

    def _tick_pipeline(self, now, dt):
        """processPipeline() from src/main.cpp - faithful port. The branch is
        taken once per tick based on the persisted control source."""
        have_data = False
        raw = 0.0
        hr = self.mode() == "hr"

        # Virtual meter "notifications" (10 Hz while connected + sending)
        if not hr and self.ble_connected and self.sending:
            self._last_power_value = self.power_value(now)
            self._last_power = now
        # Virtual strap "notifications" (~1 Hz while connected, like real HRS)
        if hr and self.hr_connected and self.hr_sending \
                and now - self._hr_last_notify >= 1.0:
            self._hr_value = self.base_bpm
            self._hr_last_notify = now

        if self.sim_enabled:
            raw = self.sim_bpm if hr else self.sim_watts
            have_data = True
            self.tel["simMode"] = True
        else:
            self.tel["simMode"] = False
            if hr:
                if self.hr_connected and \
                        (now - self._hr_last_notify) < self.cfg.power_timeout_ms / 1000.0:
                    raw = self._hr_value
                    have_data = True
            elif self.ble_connected and \
                    (now - self._last_power) < self.cfg.power_timeout_ms / 1000.0:
                raw = self._last_power_value
                have_data = True

        connected = self.hr_connected if hr else self.ble_connected
        self.tel["connected"] = connected
        self.tel["hasData"] = have_data

        if have_data:
            smoothed = self.processor.update(raw)
            if hr:
                zone = fw.hr_zone_index(self.cfg, smoothed, self.prev_zone_hr, True)
                self.prev_zone_hr = zone
                r, g, b = fw.hr_color_for(self.cfg, smoothed)
                self.tel["rawBpm"] = raw
                self.tel["smoothedBpm"] = smoothed
                zone_name = self.cfg.hr_zones[zone].name
                unit = "bpm"
            else:
                zone = fw.zone_index(self.cfg, smoothed, self.prev_zone, True)
                self.prev_zone = zone
                r, g, b = fw.color_for(self.cfg, smoothed)
                self.tel["rawPower"] = raw
                self.tel["smoothedPower"] = smoothed
                zone_name = self.cfg.zones[zone].name
                unit = "W"
            self.tel["zone"] = zone
            self.tel["r"], self.tel["g"], self.tel["b"] = r, g, b
            self._fade_target = 1.0

            if self.sim_enabled or connected:
                self.set_state("RECEIVING_POWER")

            if zone != getattr(self, "_last_zone_logged", None):
                self._last_zone_logged = zone
                self.log("zone", "zone %d (%s)" % (zone + 1, zone_name))
            rgb_hex = fw.hex_from_rgb(r, g, b)
            if rgb_hex != self._last_rgb and now - self._last_rgb_log > 0.4:
                self._last_rgb = rgb_hex
                self._last_rgb_log = now
                self.log("rgb", "color %s" % rgb_hex)
            eff = int(round(raw))
            if eff != getattr(self, "_last_power_logged", None) \
                    and now - self._last_power_log > 0.4 and not self.freeze:
                self._last_power_logged = eff
                self._last_power_log = now
                self.log("hr" if hr else "power",
                         "%s update: %d %s (smoothed %d %s)"
                         % ("hr" if hr else "power", eff, unit,
                            fw.lround(smoothed), unit))
        else:
            # No fresh data -> fade LEDs out; keep last smoothed for display.
            self._fade_target = 0.0
            if hr:
                self.tel["rawBpm"] = 0.0
            else:
                self.tel["rawPower"] = 0.0
            if connected and self.tel["state"] == "RECEIVING_POWER":
                self.set_state("CONNECTED")
            if self._had_data and connected:
                self.log("timeout", "%s data stale after %d ms - fading out"
                         % ("heart rate" if hr else "power", self.cfg.power_timeout_ms))
            self.processor.reset()

        self._had_data = have_data

        # LED fade (~600 ms full fade, LEDController.cpp)
        step = dt / 0.6
        if self.fade < self._fade_target:
            self.fade = min(self._fade_target, self.fade + step)
        elif self.fade > self._fade_target:
            self.fade = max(self._fade_target, self.fade - step)

    # ---- WebSocket ---------------------------------------------------------

    def ws_register(self, conn):
        with self.ws_lock:
            self.ws_clients.add(conn)

    def ws_unregister(self, conn):
        with self.ws_lock:
            self.ws_clients.discard(conn)

    def ws_broadcast(self):
        if self.ws_paused:
            return
        with self.ws_lock:
            if not self.ws_clients:
                return
            frame = ws_encode(0x81, json.dumps(self.telemetry_json()).encode())
            dead = []
            for c in self.ws_clients:
                try:
                    c.sendall(frame)
                except OSError:
                    dead.append(c)
            for c in dead:
                self.ws_clients.discard(c)

    def ws_kick(self):
        with self.ws_lock:
            n = len(self.ws_clients)
            for c in self.ws_clients:
                try:
                    # shutdown() first: close() alone does not wake the blocked
                    # recv() in the client's handler thread, so no FIN would be
                    # sent and the browser would never see the disconnect.
                    c.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass
                try:
                    c.close()
                except OSError:
                    pass
            self.ws_clients.clear()
        self.log("ws", "disconnected %d WebSocket client(s)" % n)

    # ---- dev panel status ---------------------------------------------------

    def status_json(self):
        eff = self.power_value(time.time())
        base = (self.cfg.brightness / 100.0) * self.fade
        hr_mode = self.mode() == "hr"
        saved_addr = self.cfg.hr_source_addr if hr_mode else self.cfg.source_addr
        return {
            "tel": {
                "mode": self.mode(),
                "state": self.tel["state"], "connected": self.tel["connected"],
                "hasData": self.tel["hasData"], "simMode": self.tel["simMode"],
                "raw": fw.lround(self.tel["rawBpm"] if self.mode() == "hr"
                                 else self.tel["rawPower"]),
                "smoothed": fw.lround(self.tel["smoothedBpm"] if self.mode() == "hr"
                                      else self.tel["smoothedPower"]),
                "hr": fw.lround(self.tel["smoothedBpm"]),
                "hrRaw": fw.lround(self.tel["rawBpm"]),
                "zone": self.tel["zone"],
                "zoneName": (self.cfg.hr_zones[self.tel["zone"]].name
                             if 0 <= self.tel["zone"] < fw.MAX_HR_ZONES else "")
                if self.mode() == "hr" else
                (self.cfg.zones[self.tel["zone"]].name
                 if 0 <= self.tel["zone"] < self.cfg.zone_count else ""),
                "color": fw.hex_from_rgb(self.tel["r"], self.tel["g"], self.tel["b"]),
                "brightness": self.cfg.brightness,
                "displayR": fw.lround(self.tel["r"] * base),
                "displayG": fw.lround(self.tel["g"] * base),
                "displayB": fw.lround(self.tel["b"] * base),
                "ledFade": round(self.fade, 2),
                "source": self.tel["sourceName"],
            },
            "power": {
                "base": self.base_watts, "effective": round(eff, 1),
                "noise": self.noise, "noiseAmp": self.noise_amp,
                "freeze": self.freeze, "sending": self.sending,
                "jump": self.jump, "jumpA": self.jump_a, "jumpB": self.jump_b,
                "jumpMs": self.jump_ms,
            },
            "hr": {"strapBpm": self.base_bpm, "sending": self.hr_sending,
                   "simBpm": self.sim_bpm},
            "sim": {"enabled": self.sim_enabled, "watts": self.sim_watts,
                    "bpm": self.sim_bpm},
            "ble": {
                "state": self.tel["state"], "connected": self.is_connected(),
                "bleConnected": self.ble_connected, "hrConnected": self.hr_connected,
                "desired": self.desired, "hrDesired": self.hr_desired,
                "hrTargetAddr": self._hr_target_addr,
                "hrTargetName": self._hr_target_name,
                "scanning": self.scanning,
                "targetAddr": self._target_addr, "targetName": self._target_name,
                "devicesVisible": self.devices_visible,
                "savedAddr": saved_addr,
                "sending": self.sending, "hrSending": self.hr_sending,
                "devices": [{"address": m["address"], "name": m["name"],
                             "type": m["type"],
                             "rssi": m["rssi"] + random.randint(-3, 3),
                             "connected": self.is_connected() and saved_addr == m["address"]}
                            for m in self.found_devices.values()],
            },
            "ws": {"clients": len(self.ws_clients), "paused": self.ws_paused},
            "script": {"running": self.script is not None,
                       "steps": self.script["steps"] if self.script else [],
                       "delayMs": self.script["delayMs"] if self.script else 0,
                       "step": self.script["i"] if self.script else -1},
            "cfg": {
                "mode": self.mode(),
                "ftp": self.cfg.ftp, "zoneCount": self.cfg.zone_count,
                "hrMax": self.cfg.hr_max,
                "sourceAddr": self.cfg.source_addr,
                "sourceName": self.cfg.source_name,
                "hrSourceAddr": self.cfg.hr_source_addr,
                "hrSourceName": self.cfg.hr_source_name,
                "hrZoneMins": [z.min_bpm for z in self.cfg.hr_zones],
                "hrZoneNames": [z.name for z in self.cfg.hr_zones],
                "smoothing": self.cfg.smoothing,
                "hysteresis": self.cfg.hysteresis,
                "powerTimeout": self.cfg.power_timeout_ms,
                "brightness": self.cfg.brightness,
                "zoneMins": [self.cfg.zones[i].min_watts
                             for i in range(self.cfg.zone_count)],
                "zoneNames": [self.cfg.zones[i].name
                              for i in range(self.cfg.zone_count)],
            },
        }

    # ---- script runner -------------------------------------------------------

    def run_script(self, steps, delay_ms):
        self.script = {"steps": steps, "delayMs": delay_ms, "i": 0}
        self._script_stop.clear()
        self.log("script", "started: %s (delay %d ms)" % (steps, delay_ms))
        try:
            for i, w in enumerate(steps):
                if self._script_stop.is_set():
                    break
                with self.lock:
                    self.script["i"] = i
                    self.sim_enabled = True    # deterministic, GUI-visible
                    if self.mode() == "hr":
                        self.sim_bpm = float(w)   # steps are bpm in HR mode
                    else:
                        self.sim_watts = float(w)
                    self.freeze = False
                    self.frozen_value = None
                self.log("script", "step %d/%d: %g %s"
                         % (i + 1, len(steps), w,
                            "bpm" if self.mode() == "hr" else "W"))
                if self._script_stop.wait(delay_ms / 1000.0):
                    break
        finally:
            with self.lock:
                self.script = None
            self.log("script", "stopped")

    # ---- main loop -------------------------------------------------------------

    def run(self):
        time.sleep(1.0)
        with self.lock:
            self._boot_done = True
            # Auto-reconnect to the saved source of the ACTIVE control source
            # on boot (main.cpp setup()).
            if self.mode() == "hr":
                if self.cfg.hr_source_addr and self.cfg.auto_reconnect:
                    self.log("hr", "restoring saved source: %s" % self.cfg.hr_source_name)
                    self.hr_connect_to(self.cfg.hr_source_addr, self.cfg.hr_source_name)
                else:
                    self.set_state("DISCONNECTED")
            elif self.cfg.source_addr and self.cfg.auto_reconnect:
                self.log("ble", "restoring saved source: %s" % self.cfg.source_name)
                self.connect_to(self.cfg.source_addr, self.cfg.source_name)
            else:
                self.set_state("DISCONNECTED")

        last_tick = time.time()
        last_bcast = 0.0
        while True:
            time.sleep(0.02)
            now = time.time()
            if now - last_tick >= 0.1:
                dt = now - last_tick
                last_tick = now
                with self.lock:
                    self._tick_ble(now)
                    self._tick_pipeline(now, dt)
            if now - last_bcast >= 0.2:
                last_bcast = now
                with self.lock:
                    self.ws_broadcast()


# ---------------------------------------------------------------------------
# WebSocket plumbing (RFC 6455, minimal server side - stdlib only)
# ---------------------------------------------------------------------------

def ws_encode(opcode, payload):
    header = bytearray([0x80 | opcode])
    n = len(payload)
    if n <= 125:
        header.append(n)
    elif n <= 0xFFFF:
        header.append(126)
        header += struct.pack(">H", n)
    else:
        header.append(127)
        header += struct.pack(">Q", n)
    return bytes(header) + payload


def _recv_exact(conn, n):
    buf = b""
    while len(buf) < n:
        try:
            chunk = conn.recv(n - len(buf))
        except OSError:
            return None
        if not chunk:
            return None
        buf += chunk
    return buf


def ws_read_frame(conn):
    hdr = _recv_exact(conn, 2)
    if hdr is None:
        return None, None
    opcode = hdr[0] & 0x0F
    ln = hdr[1] & 0x7F
    if ln == 126:
        ext = _recv_exact(conn, 2)
        if ext is None:
            return None, None
        ln = struct.unpack(">H", ext)[0]
    elif ln == 127:
        ext = _recv_exact(conn, 8)
        if ext is None:
            return None, None
        ln = struct.unpack(">Q", ext)[0]
    if ln > 1 << 20:
        return None, None
    if hdr[1] & 0x80:   # client->server frames are masked
        mask = _recv_exact(conn, 4)
        data = _recv_exact(conn, ln)
        if mask is None or data is None:
            return None, None
        data = bytearray(data)
        for i in range(ln):
            data[i] ^= mask[i % 4]
        return opcode, bytes(data)
    data = _recv_exact(conn, ln)
    return opcode, data if data is not None else b""


# ---------------------------------------------------------------------------
# HTTP handler: existing GUI static files + firmware REST API + dev panel
# ---------------------------------------------------------------------------

SIM = None  # set in main()

CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
}


class Handler(BaseHTTPRequestHandler):
    server_version = "RGBWattSim/1.0"
    protocol_version = "HTTP/1.0"   # no keep-alive: simplest and most robust

    def log_message(self, *args):    # silence per-request logging (GUI polls)
        pass

    # ---- helpers ----

    def _send(self, code, ctype, body):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _json(self, code, obj):
        self._send(code, "application/json", json.dumps(obj).encode("utf-8"))

    def _file_from_disk(self, path, code=200):
        try:
            data = Path(path).read_bytes()
        except OSError:
            self._send(404, "text/plain", b"Not found")
            return
        ctype = CONTENT_TYPES.get(Path(path).suffix, "application/octet-stream")
        self._send(code, ctype, data)

    def _read_body(self):
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        if length <= 0:
            return b""
        return self.rfile.read(length)

    def _read_json(self):
        """Returns (doc, error). Mirrors the firmware's bad-json handling."""
        body = self._read_body()
        try:
            doc = json.loads(body.decode("utf-8")) if body else {}
        except (ValueError, UnicodeDecodeError):
            return None, True
        if not isinstance(doc, dict):
            doc = {}   # ArduinoJson: "x" on a non-object body reads as null
        return doc, False

    # ---- WebSocket /ws ----

    def _handle_ws(self):
        key = self.headers.get("Sec-WebSocket-Key")
        upgrade = (self.headers.get("Upgrade") or "").lower()
        if not key or "websocket" not in upgrade:
            self._json(400, {"ok": False, "error": "websocket upgrade required"})
            return
        accept = base64.b64encode(
            hashlib.sha1((key + WS_GUID).encode()).digest()).decode()
        self.connection.sendall(
            ("HTTP/1.1 101 Switching Protocols\r\n"
             "Upgrade: websocket\r\nConnection: Upgrade\r\n"
             "Sec-WebSocket-Accept: %s\r\n\r\n" % accept).encode())
        SIM.ws_register(self.connection)
        SIM.log("ws", "client connected (%d total)" % (len(SIM.ws_clients)))
        try:
            while True:
                opcode, data = ws_read_frame(self.connection)
                if opcode is None:
                    break
                if opcode == 8:      # close
                    try:
                        self.connection.sendall(ws_encode(0x88, b""))
                    except OSError:
                        pass
                    break
                if opcode == 9:      # ping -> pong
                    self.connection.sendall(ws_encode(0x8A, data or b""))
        except OSError:
            pass
        finally:
            SIM.ws_unregister(self.connection)
            SIM.log("ws", "client disconnected (%d total)" % len(SIM.ws_clients))

    # ---- GET ----

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        sim = SIM

        if path == "/ws":
            self._handle_ws()
            return
        if path in ("/", "/index.html"):
            self._file_from_disk(WEB_ROOT / "index.html")
            return
        if path == "/style.css":
            self._file_from_disk(WEB_ROOT / "style.css")
            return
        if path == "/app.js":
            self._file_from_disk(WEB_ROOT / "app.js")
            return
        if path in ("/dev", "/dev/"):
            self._file_from_disk(DEV_PANEL)
            return
        if path == "/api/config":
            with sim.lock:
                self._json(200, fw.build_config_json(sim.cfg))
            return
        if path == "/api/info":
            self._json(200, {
                "version": SIM_VERSION, "versionCode": 10000, "build": "sim",
                "production": False, "deviceId": "PC-SIMULATOR",
                "serial": "SIM-000001", "provisioned": False,
                "secureBoot": False, "flashEncrypted": False,
                "signedOtaRequired": False,
            })
            return
        if path == "/api/devices":
            with sim.lock:
                hr = sim.mode() == "hr"
                saved = sim.cfg.hr_source_addr if hr else sim.cfg.source_addr
                doc = {
                    "scanning": sim.scanning,
                    "devices": [
                        {"address": a, "name": m["name"], "type": m["type"],
                         "rssi": m["rssi"] + random.randint(-3, 3),
                         "connected": sim.is_connected() and saved == a}
                        for a, m in sim.found_devices.items()],
                }
            self._json(200, doc)
            return
        if path == "/dev/api/status":
            with sim.lock:
                self._json(200, sim.status_json())
            return
        if path == "/dev/api/log":
            qs = self.path.split("?", 1)[1] if "?" in self.path else ""
            after = 0
            for part in qs.split("&"):
                if part.startswith("after="):
                    try:
                        after = int(part[6:])
                    except ValueError:
                        pass
            with sim.lock:
                evs = [e for e in sim.events if e["id"] > after]
                last = sim.events[-1]["id"] if sim.events else 0
            self._json(200, {"events": evs, "last": last})
            return
        self._send(404, "text/plain", b"Not found")

    # ---- POST ----

    def do_POST(self):
        path = self.path.split("?", 1)[0]
        sim = SIM

        # ---- existing firmware API ----
        if path == "/api/ota":
            self._read_body()   # drain
            self._json(400, {"ok": False, "error": "OTA not available in the PC simulator"})
            return

        doc, bad = self._read_json()
        if bad:
            self._json(400, {"ok": False, "error": "bad json"})
            return

        if path == "/api/config":
            with sim.lock:
                if doc.get("controlSource") is not None:
                    # setControlSource() runs FIRST: fully disconnect the
                    # active sensor before swapping to the new input.
                    sim.switch_source(fw.SRC_HEART_RATE
                                      if doc["controlSource"] == "hr" else fw.SRC_POWER)
                fw.apply_config_patch(sim.cfg, doc)
                sim.save()
                sim.processor.set_smoothing(sim.cfg.smoothing)
                sim.log("config", "configuration updated (%s)" %
                        ", ".join(sorted(doc.keys())) if doc else "empty patch")
                self._json(200, fw.build_config_json(sim.cfg))
            return
        if path == "/api/scan":
            with sim.lock:
                sim.start_scan(6.0)
            self._json(200, {"ok": True})
            return
        if path == "/api/connect":
            addr = doc.get("address")
            if not addr:
                self._json(400, {"ok": False})
                return
            name = doc.get("name") or ""
            with sim.lock:
                if sim.mode() == "hr":
                    sim.cfg.hr_source_addr = str(addr)[:23]
                    sim.cfg.hr_source_name = str(name)[:39]
                    sim.save()
                    sim.hr_connect_to(str(addr), str(name))
                else:
                    sim.cfg.source_addr = str(addr)[:23]
                    sim.cfg.source_name = str(name)[:39]
                    sim.save()
                    sim.connect_to(str(addr), str(name))
            self._json(200, {"ok": True})
            return
        if path == "/api/disconnect":
            with sim.lock:
                if sim.mode() == "hr":
                    sim.hr_disconnect()
                else:
                    sim.disconnect()
            self._json(200, {"ok": True})
            return
        if path == "/api/forget":
            with sim.lock:
                if sim.mode() == "hr":
                    sim.hr_disconnect(forget=True)
                else:
                    sim.disconnect(forget=True)
            self._json(200, {"ok": True})
            return
        if path == "/api/simulation":
            with sim.lock:
                en = sim.sim_enabled if doc.get("enabled") is None \
                    else fw.to_bool(doc["enabled"])
                if sim.mode() == "hr":
                    b = sim.sim_bpm if doc.get("bpm") is None else float(doc["bpm"])
                    if doc.get("bpm") is not None:
                        sim.base_bpm = float(b)   # keep virtual strap in sync
                    sim.sim_enabled = en
                    sim.sim_bpm = b
                    if doc.get("enabled") is not None or doc.get("bpm") is not None:
                        sim.log("sim", "simulation %s at %g bpm"
                                % ("ON" if en else "OFF", b))
                else:
                    w = sim.sim_watts if doc.get("watts") is None else float(doc["watts"])
                    if doc.get("watts") is not None:
                        sim.base_watts = float(w)   # keep virtual meter in sync
                    sim.sim_enabled = en
                    sim.sim_watts = w
                    if doc.get("enabled") is not None or doc.get("watts") is not None:
                        sim.log("sim", "simulation %s at %g W"
                                % ("ON" if en else "OFF", w))
            self._json(200, {"ok": True})
            return
        if path == "/api/wifi":
            with sim.lock:
                if doc.get("ssid") is not None:
                    sim.cfg.wifi_ssid = str(doc["ssid"])[:32]
                if doc.get("pass") is not None:
                    sim.cfg.wifi_pass = str(doc["pass"])[:64]
                sim.save()
                sim.log("config", "wifi settings saved (reboot simulated - "
                                 "server keeps running)")
            self._json(200, {"ok": True, "reboot": True})
            return
        if path == "/api/factory-reset":
            with sim.lock:
                sim.factory_reset()
                sim.log("config", "factory reset (reboot simulated - server keeps running)")
            self._json(200, {"ok": True, "reboot": True})
            return

        # ---- developer panel API ----
        if path == "/dev/api/power":
            with sim.lock:
                if doc.get("bpm") is not None:   # virtual strap bpm (HR mode testing)
                    sim.base_bpm = fw.constrain(float(doc["bpm"]), 30, 250)
                    sim.sim_bpm = sim.base_bpm   # keep Simulation Mode in sync
                    sim.log("hr", "virtual strap bpm set to %g" % sim.base_bpm)
                    self._json(200, {"ok": True})
                    return
                w = fw.constrain(float(doc.get("watts", sim.base_watts)), 0, 9999)
                sim.base_watts = w
                sim.sim_watts = w
                sim.freeze = False
                sim.frozen_value = None
                if sim.sim_enabled:
                    sim.log("power", "simulated power set to %g W" % w)
                else:
                    sim.log("power", "virtual meter power set to %g W" % w)
            self._json(200, {"ok": True})
            return
        if path == "/dev/api/power/mode":
            with sim.lock:
                if doc.get("noise") is not None:
                    sim.noise = fw.to_bool(doc["noise"])
                    sim.log("power", "noise %s (±%g W)" %
                            ("ON" if sim.noise else "OFF", sim.noise_amp))
                if doc.get("noiseAmp") is not None:
                    sim.noise_amp = fw.constrain(float(doc["noiseAmp"]), 0, 100)
                if doc.get("freeze") is not None:
                    want = fw.to_bool(doc["freeze"])
                    if want and not sim.freeze:
                        sim.frozen_value = sim.power_value(time.time())
                    if not want:
                        sim.frozen_value = None
                    sim.freeze = want
                    sim.log("power", "freeze %s at %g W" %
                            ("ON" if want else "OFF", sim.frozen_value or 0))
                if doc.get("sending") is not None:
                    sim.sending = fw.to_bool(doc["sending"])
                    sim.log("power", "meter telemetry %s" %
                            ("started" if sim.sending else "stopped"))
                if doc.get("hrSending") is not None:
                    sim.hr_sending = fw.to_bool(doc["hrSending"])
                    sim.log("hr", "strap telemetry %s" %
                            ("started" if sim.hr_sending else "stopped"))
                if doc.get("jump") is not None:
                    sim.jump = fw.to_bool(doc["jump"])
                    sim._jump_t = 0.0
                    sim.log("power", "jump %s (%g <-> %g W)" %
                            ("ON" if sim.jump else "OFF", sim.jump_a, sim.jump_b))
                if doc.get("jumpA") is not None:
                    sim.jump_a = fw.constrain(float(doc["jumpA"]), 0, 9999)
                if doc.get("jumpB") is not None:
                    sim.jump_b = fw.constrain(float(doc["jumpB"]), 0, 9999)
                if doc.get("jumpMs") is not None:
                    sim.jump_ms = fw.constrain(int(doc["jumpMs"]), 50, 60000)
            self._json(200, {"ok": True})
            return
        if path == "/dev/api/ble":
            action = doc.get("action", "")
            with sim.lock:
                # Every action targets the ACTIVE control source's sensor, so
                # the panel can never drive both modules at once.
                hr_mode = sim.mode() == "hr"
                if action == "scan":
                    sim.start_scan(6.0)
                elif action == "connect":
                    pool = VIRTUAL_HR_SENSORS if hr_mode else VIRTUAL_METERS
                    m = pool[0]
                    addr = doc.get("address") or m["address"]
                    dev = next((x for x in pool if x["address"] == addr), m)
                    if hr_mode:
                        sim.cfg.hr_source_addr = dev["address"]
                        sim.cfg.hr_source_name = dev["name"]
                        sim.save()
                        sim.found_devices.setdefault(dev["address"], dict(dev))
                        sim.hr_connect_to(dev["address"], dev["name"])
                    else:
                        sim.cfg.source_addr = dev["address"]
                        sim.cfg.source_name = dev["name"]
                        sim.save()
                        sim.found_devices.setdefault(dev["address"], dict(dev))
                        sim.connect_to(dev["address"], dev["name"])
                elif action == "disconnect":
                    if hr_mode:
                        sim.hr_disconnect()
                    else:
                        sim.disconnect()
                elif action == "lost":
                    if hr_mode:
                        sim.hr_connection_lost()
                    else:
                        sim.connection_lost()
                elif action == "reconnect":
                    if hr_mode:
                        if sim._hr_target_addr:
                            sim._hr_last_attempt = 0.0
                            sim.hr_desired = True
                            if sim._hr_target_addr in sim.found_devices:
                                sim._hr_start_connecting(time.time())
                            else:
                                sim.start_scan(6.0)
                            sim.log("hr", "manual reconnect requested")
                    elif sim._target_addr:
                        sim._last_attempt = 0.0
                        sim.desired = True
                        if sim._target_addr in sim.found_devices:
                            sim._start_connecting(time.time())
                        else:
                            sim.start_scan(6.0)
                        sim.log("ble", "manual reconnect requested")
                elif action == "forget":
                    if hr_mode:
                        sim.hr_disconnect(forget=True)
                    else:
                        sim.disconnect(forget=True)
                elif action == "visible":
                    sim.devices_visible = fw.to_bool(doc.get("on"), True)
                    sim.log("ble", "virtual meters %s in scan results" %
                            ("visible" if sim.devices_visible else "hidden"))
                else:
                    self._json(400, {"ok": False, "error": "unknown action"})
                    return
            self._json(200, {"ok": True})
            return
        if path == "/dev/api/ws":
            action = doc.get("action", "")
            if action == "pause":
                SIM.ws_paused = True
                SIM.log("ws", "telemetry broadcast paused")
            elif action == "resume":
                SIM.ws_paused = False
                SIM.log("ws", "telemetry broadcast resumed")
            elif action == "kick":
                SIM.ws_kick()
            else:
                self._json(400, {"ok": False, "error": "unknown action"})
                return
            self._json(200, {"ok": True})
            return
        if path == "/dev/api/script":
            action = doc.get("action", "")
            if action == "run":
                try:
                    steps = [float(s) for s in doc.get("steps", [])
                             if str(s).strip() != ""]
                    delay = fw.constrain(int(doc.get("delayMs", 1500)), 100, 60000)
                except (TypeError, ValueError):
                    self._json(400, {"ok": False, "error": "bad steps/delay"})
                    return
                if not steps:
                    self._json(400, {"ok": False, "error": "no steps"})
                    return
                threading.Thread(target=SIM.run_script,
                                  args=(steps, delay), daemon=True).start()
            elif action == "stop":
                SIM._script_stop.set()
            else:
                self._json(400, {"ok": False, "error": "unknown action"})
                return
            self._json(200, {"ok": True})
            return
        if path == "/dev/api/log/clear":
            with sim.lock:
                sim.events = []
                sim.log("sys", "event log cleared")
            self._json(200, {"ok": True})
            return

        self._send(404, "text/plain", b"Not found")


# ---------------------------------------------------------------------------

def main():
    global SIM
    ap = argparse.ArgumentParser(
        description="PC simulator for the ESP32 RGB Watt Controller (testing tool)")
    ap.add_argument("--port", type=int, default=8080)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--no-browser", action="store_true")
    ap.add_argument("--config", default=str(CFG_PATH))
    args = ap.parse_args()

    if not (WEB_ROOT / "index.html").exists():
        print("ERROR: web GUI not found at %s" % WEB_ROOT, file=sys.stderr)
        print("The simulator must stay inside tools/pc-simulator/ of the repo.",
              file=sys.stderr)
        sys.exit(1)

    SIM = Simulator(cfg_path=args.config)
    threading.Thread(target=SIM.run, daemon=True).start()

    try:
        server = ThreadingHTTPServer((args.host, args.port), Handler)
    except OSError as e:
        print("ERROR: cannot bind %s:%d (%s)" % (args.host, args.port, e),
              file=sys.stderr)
        sys.exit(1)
    server.daemon_threads = True

    url = "http://localhost:%d/" % args.port
    print("=" * 60, flush=True)
    print(" RGB Watt Controller - PC SIMULATOR (%s)" % SIM_VERSION, flush=True)
    print(" TESTING TOOL ONLY - not part of the firmware build", flush=True)
    print("=" * 60, flush=True)
    print(" Existing web GUI : %s" % url, flush=True)
    print(" Developer panel  : %sdev/" % url, flush=True)
    print(" Config storage   : %s" % args.config, flush=True)
    print(" Stop with Ctrl+C or by closing this window.", flush=True)
    print("=" * 60, flush=True)
    if not args.no_browser:
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[SIM] stopped", flush=True)


if __name__ == "__main__":
    main()