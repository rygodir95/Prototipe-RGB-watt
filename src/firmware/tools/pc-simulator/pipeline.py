"""Faithful PC port of the ESP32 RGB Watt Controller logic.

Every class/function below mirrors a specific piece of the firmware
(baseline commit 75150c31, test snapshot v1.0.0-test1):

    PowerProcessor   <-> src/PowerProcessor.cpp        (EMA smoothing)
    zone_index      <-> PowerZones::zoneIndex()       (zones + hysteresis)
    color_for       <-> PowerZones::colorFor()        (RGB interpolation)
    AppConfig       <-> include/Config.h + src/Config.cpp
    apply_config_patch <-> applyConfigPatch() in src/WebInterface.cpp
    build_config_json <-> buildConfigJson() in src/WebInterface.cpp
    storage to/from JSON <-> src/Storage.cpp (NVS blob -> JSON file)

Constants, clamps, rounding and the order of operations match the firmware
exactly.  Known deviations (both documented in the README):
  * float32 (ESP32) vs float64 (Python) arithmetic,
  * zone colour hex parsing is strict instead of strtol-lenient.
No zone/RGB/smoothing behaviour was changed - this is a port, not a redesign.
"""

import math

MIN_ZONES = 5
MAX_ZONES = 7
MAX_HR_ZONES = 5
CONFIG_VERSION = 0x52474205  # 'RGB' + version 5

# ControlSource (include/Config.h): exactly one source active at a time.
SRC_POWER, SRC_HEART_RATE = 0, 1

LED_WS2812B = 0
LED_SK6812 = 1
EFFECT_SOLID, EFFECT_BREATHING, EFFECT_COMET = 0, 1, 2

# AppState.h enum values, used for telemetry "state" strings.
DEVICE_STATES = ["STARTING", "SCANNING", "CONNECTING", "CONNECTED",
                 "RECEIVING_POWER", "DISCONNECTED", "RECONNECTING", "ERROR"]


def lround(x):
    """lroundf() for the non-negative values used in this project."""
    return int(math.floor(x + 0.5))


def constrain(v, lo, hi):
    if v < lo:
        return lo
    if v > hi:
        return hi
    return v


def to_int(v, default=0):
    """ArduinoJson as<int>()-style coercion for JSON values."""
    if isinstance(v, bool):
        return 1 if v else 0
    if isinstance(v, (int, float)):
        return int(v)
    if isinstance(v, str):
        try:
            return int(float(v))
        except ValueError:
            return default
    return default


def to_bool(v, default=False):
    if isinstance(v, bool):
        return v
    if isinstance(v, (int, float)):
        return v != 0
    if isinstance(v, str):
        return v.lower() == "true"
    return default


# ---------------------------------------------------------------------------
# Config (include/Config.h + src/Config.cpp)
# ---------------------------------------------------------------------------

# Coggan-style zone lower bounds as a percentage of FTP for 5/6/7 zone models.
PCT_7 = [0, 56, 76, 91, 106, 121, 151]
PCT_6 = [0, 56, 76, 91, 106, 121]
PCT_5 = [0, 56, 76, 91, 106]

NAMES_7 = ["Recovery", "Endurance", "Tempo", "Threshold", "VO2 Max", "Anaerobic", "Neuromuscular"]
NAMES_6 = ["Recovery", "Endurance", "Tempo", "Threshold", "VO2 Max", "Anaerobic"]
NAMES_5 = ["Recovery", "Endurance", "Tempo", "Threshold", "VO2 Max"]

# Blue -> Cyan -> Green -> Yellow -> Orange -> Red -> Deep Red
COLORS_7 = [(0, 90, 255), (0, 200, 200), (0, 220, 70), (255, 220, 0),
            (255, 120, 0), (255, 25, 0), (150, 0, 0)]
COLORS_6 = [(0, 90, 255), (0, 200, 200), (0, 220, 70), (255, 220, 0),
            (255, 120, 0), (255, 25, 0)]
COLORS_5 = [(0, 90, 255), (0, 200, 200), (0, 220, 70), (255, 140, 0),
             (255, 25, 0)]

# Heart-rate zones: lower bounds at 50/60/70/80/90 % of Max HR
# (Z1 spans everything below 60 %, Z5 everything at or above 90 %).
HR_PCT = [50, 60, 70, 80, 90]
HR_NAMES = ["Very Light", "Light", "Moderate", "Hard", "Maximum"]
HR_COLORS = [(120, 130, 255), (0, 190, 255), (0, 230, 120),
             (255, 200, 0), (255, 40, 40)]


def parse_hr_measurement(data):
    """Port of HRSensor::onNotify - Heart Rate Measurement (0x2A37).

    Layout: [flags:1][HR:1|2 LE][optional: energy expended, RR intervals...]
    flags bit0 = HR value format (0 -> uint8, 1 -> uint16 LE).
    Returns the bpm value, or None when the packet is invalid/implausible.
    """
    if not isinstance(data, (bytes, bytearray)) or len(data) < 2:
        return None
    flags = data[0]
    if flags & 0x01:
        if len(data) < 3:
            return None
        bpm = data[1] | (data[2] << 8)
    else:
        bpm = data[1]
    if bpm == 0 or bpm > 250:
        return None
    return bpm


class HRZone:
    def __init__(self, name="", min_bpm=0, r=0, g=0, b=0):
        self.name = name          # char[24] in firmware (max 23 chars)
        self.min_bpm = min_bpm
        self.r, self.g, self.b = r, g, b


class Zone:
    def __init__(self, name="", min_watts=0, r=0, g=0, b=0):
        self.name = name          # char[24] in firmware (max 23 chars)
        self.min_watts = min_watts
        self.r, self.g, self.b = r, g, b


class AppConfig:
    """AppConfig struct + the Config.cpp helpers."""

    def __init__(self):
        self.load_defaults()

    def load_defaults(self):  # configLoadDefaults()
        self.version = CONFIG_VERSION
        self.ftp = 221
        self.smoothing = 45
        self.power_timeout_ms = 5000
        self.hysteresis = 5
        self.zone_count = 7
        self.zones = [Zone() for _ in range(MAX_ZONES)]
        self.control_source = SRC_POWER   # ControlSource
        self.hr_max = 190
        self.hr_zones = [HRZone() for _ in range(MAX_HR_ZONES)]
        self.hr_source_addr = ""  # char[24]
        self.hr_source_name = ""  # char[40]
        self.led_pin = 5
        self.led_count = 60
        self.brightness = 100
        self.led_type = LED_WS2812B
        self.led_effect = EFFECT_SOLID
        self.source_addr = ""     # char[24]
        self.source_name = ""     # char[40]
        self.auto_reconnect = True
        self.wifi_ssid = ""       # char[33]
        self.wifi_pass = ""       # char[65]
        self.theme = "dark"       # char[8] (max 7 chars)
        self.debug = True         # dev build default
        self.apply_default_zones()
        self.apply_default_hr_zones()

    def apply_default_zones(self):  # configApplyDefaultZones()
        if self.zone_count == 5:
            pct, names, colors = PCT_5, NAMES_5, COLORS_5
        elif self.zone_count == 6:
            pct, names, colors = PCT_6, NAMES_6, COLORS_6
        else:
            self.zone_count = 7
            pct, names, colors = PCT_7, NAMES_7, COLORS_7
        for i in range(self.zone_count):
            self.zones[i].name = names[i][:23]
            self.zones[i].min_watts = lround(pct[i] / 100.0 * self.ftp)
            self.zones[i].r, self.zones[i].g, self.zones[i].b = colors[i]
        self.sanitize_zones()

    def scale_zones(self, old_ftp, new_ftp):  # configScaleZones()
        if old_ftp <= 0 or new_ftp <= 0:
            return
        ratio = float(new_ftp) / float(old_ftp)
        for i in range(self.zone_count):
            self.zones[i].min_watts = lround(self.zones[i].min_watts * ratio)
        self.sanitize_zones()

    def sanitize_zones(self):  # configSanitizeZones()
        if self.zone_count < MIN_ZONES:
            self.zone_count = MIN_ZONES
        if self.zone_count > MAX_ZONES:
            self.zone_count = MAX_ZONES
        if self.zones[0].min_watts < 0:
            self.zones[0].min_watts = 0
        for i in range(1, self.zone_count):
            if self.zones[i].min_watts <= self.zones[i - 1].min_watts:
                self.zones[i].min_watts = self.zones[i - 1].min_watts + 1

    def apply_default_hr_zones(self):  # configApplyDefaultHrZones()
        for i in range(MAX_HR_ZONES):
            self.hr_zones[i].name = HR_NAMES[i][:23]
            self.hr_zones[i].min_bpm = lround(HR_PCT[i] / 100.0 * self.hr_max)
            self.hr_zones[i].r, self.hr_zones[i].g, self.hr_zones[i].b = HR_COLORS[i]
        self.sanitize_hr_zones()

    def scale_hr_zones(self, old_max, new_max):  # configScaleHrZones()
        if old_max <= 0 or new_max <= 0:
            return
        ratio = float(new_max) / float(old_max)
        for i in range(MAX_HR_ZONES):
            self.hr_zones[i].min_bpm = lround(self.hr_zones[i].min_bpm * ratio)
        self.sanitize_hr_zones()

    def sanitize_hr_zones(self):  # configSanitizeHrZones()
        if self.hr_max < 100:
            self.hr_max = 100
        if self.hr_max > 230:
            self.hr_max = 230
        if self.hr_zones[0].min_bpm < 0:
            self.hr_zones[0].min_bpm = 0
        for i in range(1, MAX_HR_ZONES):
            if self.hr_zones[i].min_bpm <= self.hr_zones[i - 1].min_bpm:
                self.hr_zones[i].min_bpm = self.hr_zones[i - 1].min_bpm + 1

    # ---- persistence (Storage.cpp equivalent, NVS blob -> JSON file) ----

    def to_storage(self):
        return {
            "version": CONFIG_VERSION,
            "ftp": self.ftp, "smoothing": self.smoothing,
            "powerTimeoutMs": self.power_timeout_ms, "hysteresis": self.hysteresis,
            "controlSource": self.control_source,
            "zoneCount": self.zone_count,
            "zones": [{"name": z.name, "minWatts": z.min_watts,
                       "r": z.r, "g": z.g, "b": z.b} for z in self.zones],
            "hrMax": self.hr_max,
            "hrZones": [{"name": z.name, "minBpm": z.min_bpm,
                         "r": z.r, "g": z.g, "b": z.b} for z in self.hr_zones],
            "ledPin": self.led_pin, "ledCount": self.led_count,
            "brightness": self.brightness, "ledType": self.led_type,
            "ledEffect": self.led_effect,
            "sourceAddr": self.source_addr, "sourceName": self.source_name,
            "hrSourceAddr": self.hr_source_addr, "hrSourceName": self.hr_source_name,
            "autoReconnect": self.auto_reconnect,
            "wifiSsid": self.wifi_ssid, "wifiPass": self.wifi_pass,
            "theme": self.theme, "debug": self.debug,
        }

    def from_storage(self, data):  # version-checked like Storage::load()
        if not isinstance(data, dict) or data.get("version") != CONFIG_VERSION:
            self.load_defaults()
            return False
        self.load_defaults()
        self.ftp = to_int(data.get("ftp"), 221)
        self.smoothing = to_int(data.get("smoothing"), 45)
        self.power_timeout_ms = to_int(data.get("powerTimeoutMs"), 5000)
        self.hysteresis = to_int(data.get("hysteresis"), 5)
        self.zone_count = constrain(to_int(data.get("zoneCount"), 7), MIN_ZONES, MAX_ZONES)
        zones = data.get("zones")
        if isinstance(zones, list):
            for i, z in enumerate(zones[:MAX_ZONES]):
                if not isinstance(z, dict):
                    continue
                self.zones[i].name = str(z.get("name", ""))[:23]
                self.zones[i].min_watts = to_int(z.get("minWatts"), 0)
                self.zones[i].r = constrain(to_int(z.get("r")), 0, 255)
                self.zones[i].g = constrain(to_int(z.get("g")), 0, 255)
                self.zones[i].b = constrain(to_int(z.get("b")), 0, 255)
        self.led_pin = to_int(data.get("ledPin"), 5)
        self.led_count = to_int(data.get("ledCount"), 60)
        self.brightness = to_int(data.get("brightness"), 100)
        self.led_type = to_int(data.get("ledType"), LED_WS2812B)
        self.led_effect = to_int(data.get("ledEffect"), EFFECT_SOLID)
        self.source_addr = str(data.get("sourceAddr", ""))[:23]
        self.source_name = str(data.get("sourceName", ""))[:39]
        self.auto_reconnect = to_bool(data.get("autoReconnect"), True)
        self.wifi_ssid = str(data.get("wifiSsid", ""))[:32]
        self.wifi_pass = str(data.get("wifiPass", ""))[:64]
        self.theme = str(data.get("theme", "dark"))[:7]
        self.debug = to_bool(data.get("debug"), True)
        self.sanitize_zones()
        return True


def hex_from_rgb(r, g, b):
    return "#%02X%02X%02X" % (r, g, b)


def rgb_from_hex(hexstr):  # rgbFromHex() - strict (see module docstring)
    if not isinstance(hexstr, str):
        return None
    h = hexstr[1:] if hexstr.startswith("#") else hexstr
    if len(h) < 6:
        return None
    try:
        v = int(h[:6], 16)
    except ValueError:
        return None
    return ((v >> 16) & 0xFF, (v >> 8) & 0xFF, v & 0xFF)


def build_config_json(cfg):  # buildConfigJson()
    doc = {
        "ftp": cfg.ftp,
        "smoothing": cfg.smoothing,
        "powerTimeout": cfg.power_timeout_ms,
        "hysteresis": cfg.hysteresis,
        "zoneCount": cfg.zone_count,
        "ledPin": cfg.led_pin,
        "ledCount": cfg.led_count,
        "brightness": cfg.brightness,
        "ledType": "SK6812" if cfg.led_type == LED_SK6812 else "WS2812B",
        "ledEffect": cfg.led_effect,
        "autoReconnect": cfg.auto_reconnect,
        "sourceAddr": cfg.source_addr,
        "sourceName": cfg.source_name,
        "wifiSsid": cfg.wifi_ssid,
        "theme": cfg.theme,
        "debug": cfg.debug,
        "zones": [],
    }
    for i in range(cfg.zone_count):
        z = cfg.zones[i]
        doc["zones"].append({
            "name": z.name,
            "min": z.min_watts,
            "max": (cfg.zones[i + 1].min_watts - 1) if i < cfg.zone_count - 1 else -1,
            "color": hex_from_rgb(z.r, z.g, z.b),
        })
    return doc


def apply_config_patch(cfg, doc):  # applyConfigPatch()
    """doc is the parsed JSON body. Mirrors the firmware exactly."""
    old_ftp = cfg.ftp
    has_zone_count = doc.get("zoneCount") is not None
    has_ftp = doc.get("ftp") is not None
    has_zones = isinstance(doc.get("zones"), list)

    if has_zone_count:
        cfg.zone_count = to_int(doc["zoneCount"])
        if has_ftp:
            cfg.ftp = to_int(doc["ftp"])
        cfg.apply_default_zones()          # regenerate on count change
    elif has_ftp:
        new_ftp = to_int(doc["ftp"])
        if not has_zones:
            cfg.scale_zones(old_ftp, new_ftp)
        cfg.ftp = new_ftp

    if has_zones:
        arr = doc["zones"]
        i = 0
        for z in arr:
            if i >= cfg.zone_count or i >= MAX_ZONES:
                break
            if isinstance(z, dict):
                if z.get("name") is not None:
                    cfg.zones[i].name = str(z["name"])[:23]
                if z.get("min") is not None:
                    cfg.zones[i].min_watts = to_int(z["min"])
                if z.get("color") is not None:
                    rgb = rgb_from_hex(z["color"])
                    if rgb is not None:
                        cfg.zones[i].r, cfg.zones[i].g, cfg.zones[i].b = rgb
            i += 1
        cfg.sanitize_zones()

    if doc.get("smoothing") is not None:
        cfg.smoothing = constrain(to_int(doc["smoothing"]), 0, 100)
    if doc.get("powerTimeout") is not None:
        cfg.power_timeout_ms = max(500, to_int(doc["powerTimeout"]))
    if doc.get("hysteresis") is not None:
        cfg.hysteresis = max(0, to_int(doc["hysteresis"]))
    if doc.get("ledPin") is not None:
        cfg.led_pin = to_int(doc["ledPin"])   # firmware: no clamp (known issue)
    if doc.get("ledCount") is not None:
        cfg.led_count = constrain(to_int(doc["ledCount"]), 1, 1000)
    if doc.get("brightness") is not None:
        cfg.brightness = constrain(to_int(doc["brightness"]), 0, 100)
    if doc.get("ledType") is not None:
        cfg.led_type = LED_SK6812 if doc["ledType"] == "SK6812" else LED_WS2812B
    if doc.get("ledEffect") is not None:
        cfg.led_effect = constrain(to_int(doc["ledEffect"]), 0, 2)
    if doc.get("autoReconnect") is not None:
        cfg.auto_reconnect = to_bool(doc["autoReconnect"])
    if doc.get("theme") is not None:
        cfg.theme = str(doc["theme"])[:7]
    if doc.get("debug") is not None:
        cfg.debug = to_bool(doc["debug"])


# ---------------------------------------------------------------------------
# PowerProcessor (src/PowerProcessor.cpp)
# ---------------------------------------------------------------------------

class PowerProcessor:
    def __init__(self):
        self._alpha = 0.3
        self._v = 0.0
        self._init = False

    def set_smoothing(self, strength):
        if strength < 0:
            strength = 0
        if strength > 100:
            strength = 100
        # strength 0 -> alpha 1.0 (no smoothing); 100 -> alpha 0.05 (heavy)
        self._alpha = 1.0 - (strength / 100.0) * 0.95

    def reset(self):
        self._init = False
        self._v = 0.0

    def update(self, raw):
        if not self._init:
            self._v = raw
            self._init = True
        else:
            self._v = self._alpha * raw + (1.0 - self._alpha) * self._v
        return self._v

    def value(self):
        return self._v if self._init else 0.0


# ---------------------------------------------------------------------------
# PowerZones (src/PowerZones.cpp)
# ---------------------------------------------------------------------------

def _lerp8(a, b, t):
    return int(math.floor(a + (b - a) * t + 0.5)) & 0xFF


def zone_index(cfg, watts, prev_zone, use_hysteresis=True):
    n = cfg.zone_count
    z = 0
    for i in range(n):
        if watts >= cfg.zones[i].min_watts:
            z = i
    if use_hysteresis and 0 <= prev_zone < n and z != prev_zone:
        hys = float(cfg.hysteresis)
        if z > prev_zone:
            # moving up: require clearing the entered zone's lower bound by margin
            if watts < cfg.zones[z].min_watts + hys:
                z = prev_zone
        else:
            # moving down: require dropping below current zone's lower bound by margin
            if watts > cfg.zones[prev_zone].min_watts - hys:
                z = prev_zone
    return z


def color_for(cfg, watts):
    n = cfg.zone_count
    if n <= 0:
        return 0, 0, 0
    if watts <= cfg.zones[0].min_watts:   # below first boundary -> first colour
        z = cfg.zones[0]
        return z.r, z.g, z.b
    i = 0
    for k in range(n):
        if watts >= cfg.zones[k].min_watts:
            i = k
    if i >= n - 1:                        # last (open-ended) zone: solid colour
        z = cfg.zones[n - 1]
        return z.r, z.g, z.b
    lo = float(cfg.zones[i].min_watts)
    hi = float(cfg.zones[i + 1].min_watts)
    t = (watts - lo) / (hi - lo) if hi > lo else 0.0
    if t < 0:
        t = 0.0
    if t > 1:
        t = 1.0
    return (_lerp8(cfg.zones[i].r, cfg.zones[i + 1].r, t),
            _lerp8(cfg.zones[i].g, cfg.zones[i + 1].g, t),
            _lerp8(cfg.zones[i].b, cfg.zones[i + 1].b, t))