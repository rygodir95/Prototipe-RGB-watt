#include <Arduino.h>
#include <WiFi.h>
#include <ESPmDNS.h>

#include "Config.h"
#include "AppState.h"
#include "Storage.h"
#include "PowerProcessor.h"
#include "PowerZones.h"
#include "LEDController.h"
#include "BLEPower.h"
#include "HRSensor.h"
#include "Simulation.h"
#include "WebInterface.h"
#include "Security.h"
#include "FirmwareVersion.h"
#include "Log.h"

// ---- Global subsystems ------------------------------------------------------
Storage        storage;
LEDController  leds;
PowerProcessor processor;
BLEPower       ble;
HRSensor       hrBle;
Simulation     sim;
WebInterface   web;

bool g_logEnabled = true;   // gated by build type + config.debug

static int      s_prevZone     = 0;   // hysteresis state, Power mode
static int      s_prevZoneHr   = 0;   // hysteresis state, Heart Rate mode
static uint32_t s_rebootAt     = 0;
static uint32_t s_lastProc     = 0;
static uint32_t s_lastDebug    = 0;

// ---- Config application -----------------------------------------------------
void applyRuntimeConfig() {
  g_logEnabled = g_config.debug;
  processor.setSmoothing(g_config.smoothing);
  leds.reconfigure(g_config.ledPin, g_config.ledCount, g_config.ledType);
  leds.setBrightnessPct(g_config.brightness);
  leds.setEffect(g_config.ledEffect);
  ble.setAutoReconnect(g_config.autoReconnect);
  hrBle.setAutoReconnect(g_config.autoReconnect);
}

void scheduleReboot(uint32_t ms) { s_rebootAt = millis() + ms; }

// ---- Control source switching (mutually exclusive modes) --------------------

void setControlSource(uint8_t src) {
  if (src != SRC_POWER && src != SRC_HEART_RATE) src = SRC_POWER;
  if (src == g_config.controlSource) return;

  // 1. Fully tear down the currently active BLE module: disconnect, stop its
  //    scan and reconnect logic, drop its cached device list.
  if (g_config.controlSource == SRC_HEART_RATE) hrBle.shutdown();
  else                                          ble.shutdown();

  // 2. Clear the shared live measurement state and LED pipeline.
  processor.reset();
  s_prevZone   = 0;
  s_prevZoneHr = 0;
  g_tel.rawPower      = 0;
  g_tel.smoothedPower = 0;
  g_tel.rawBpm        = 0;
  g_tel.smoothedBpm   = 0;
  g_tel.zone   = 0;
  g_tel.r = 0; g_tel.g = 0; g_tel.b = 0;
  g_tel.hasData = false;
  g_tel.sourceName[0] = '\0';
  leds.setActive(false);

  // 3. Activate only the selected source and persist the mode.
  g_config.controlSource = src;
  g_tel.controlSource    = src;
  storage.save(g_config);
  Serial.printf("[SRC] Control source switched to %s\n",
                src == SRC_HEART_RATE ? "Heart Rate" : "Power");

  // 4. Restore the selected source's own saved sensor (kept separate per mode).
  if (g_config.autoReconnect) {
    if (src == SRC_HEART_RATE && strlen(g_config.hrSourceAddr) > 0) {
      Serial.printf("[HR] Restoring saved source: %s\n", g_config.hrSourceName);
      hrBle.connectToAddress(g_config.hrSourceAddr, g_config.hrSourceName);
    } else if (src == SRC_POWER && strlen(g_config.sourceAddr) > 0) {
      Serial.printf("[BLE] Restoring saved source: %s\n", g_config.sourceName);
      ble.connectToAddress(g_config.sourceAddr, g_config.sourceName);
    } else {
      g_tel.state = DeviceState::DISCONNECTED;
    }
  } else {
    g_tel.state = DeviceState::DISCONNECTED;
  }
}

// ---- WiFi -------------------------------------------------------------------
static void startAccessPoint() {
  WiFi.mode(WIFI_AP);
  WiFi.softAP("RGB-Watt-Controller");
  Serial.print("[WIFI] AP started: RGB-Watt-Controller  IP: ");
  Serial.println(WiFi.softAPIP());
}

static void setupWifi() {
  if (strlen(g_config.wifiSsid) == 0) {
    startAccessPoint();
    return;
  }
  WiFi.mode(WIFI_STA);
  WiFi.begin(g_config.wifiSsid, g_config.wifiPass);
  Serial.printf("[WIFI] Connecting to %s", g_config.wifiSsid);
  uint32_t start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < 12000) {
    delay(250);
    Serial.print(".");
  }
  Serial.println();
  if (WiFi.status() == WL_CONNECTED) {
    Serial.print("[WIFI] Connected. IP: ");
    Serial.println(WiFi.localIP());
  } else {
    Serial.println("[WIFI] STA failed, falling back to AP");
    startAccessPoint();
  }
  if (MDNS.begin("rgbwatt")) {
    Serial.println("[WIFI] mDNS: http://rgbwatt.local");
  }
}

// ---- Processing pipeline ----------------------------------------------------
// Shared concept: selected sensor -> measurement -> active zone -> LED output.
// The branch is taken once per tick based on the persisted control source.
static void processPipeline() {
  uint32_t now = millis();
  bool  hr      = (g_config.controlSource == SRC_HEART_RATE);
  bool  haveData = false;
  float raw      = 0;

  if (sim.enabled()) {
    raw      = hr ? sim.bpm() : sim.watts();
    haveData = true;
    g_tel.simMode = true;
  } else {
    g_tel.simMode = false;
    if (hr) {
      if (hrBle.isConnected() && (now - hrBle.getBpmTime()) < (uint32_t)g_config.powerTimeoutMs) {
        raw      = hrBle.getBpm();
        haveData = true;
      }
    } else if (ble.isConnected() && (now - ble.getPowerTime()) < (uint32_t)g_config.powerTimeoutMs) {
      raw      = ble.getPower();
      haveData = true;
    }
  }

  g_tel.connected = hr ? hrBle.isConnected() : ble.isConnected();
  g_tel.hasData   = haveData;

  if (haveData) {
    float smoothed = processor.update(raw);
    int zone;
    uint8_t r, g, b;
    if (hr) {
      zone = HRZones::zoneIndex(g_config, smoothed, s_prevZoneHr, true);
      s_prevZoneHr = zone;
      HRZones::colorFor(g_config, smoothed, r, g, b);
      g_tel.rawBpm      = raw;
      g_tel.smoothedBpm = smoothed;
    } else {
      zone = PowerZones::zoneIndex(g_config, smoothed, s_prevZone, true);
      s_prevZone = zone;
      PowerZones::colorFor(g_config, smoothed, r, g, b);
      g_tel.rawPower      = raw;
      g_tel.smoothedPower = smoothed;
    }
    g_tel.zone = zone;
    g_tel.r = r; g_tel.g = g; g_tel.b = b;

    leds.setColor(r, g, b);
    leds.setActive(true);

    bool receiving = sim.enabled() || (hr ? hrBle.isConnected() : ble.isConnected());
    if (receiving) g_tel.state = DeviceState::RECEIVING_POWER;

    if (g_config.debug && now - s_lastDebug > 1000) {
      s_lastDebug = now;
      if (hr) {
        Serial.printf("[HR] %d bpm  Smoothed: %d bpm\n", (int)lroundf(raw), (int)lroundf(smoothed));
        Serial.printf("[ZONE] Zone %d - %s\n", zone + 1, g_config.hrZones[zone].name);
      } else {
        Serial.printf("[POWER] %d W  Smoothed: %d W\n", (int)lroundf(raw), (int)lroundf(smoothed));
        Serial.printf("[ZONE] Zone %d - %s\n", zone + 1, g_config.zones[zone].name);
      }
      Serial.printf("[RGB] %d, %d, %d\n", r, g, b);
    }
  } else {
    // No fresh data -> fade LEDs out; keep last smoothed for display briefly.
    leds.setActive(false);
    if (hr) {
      g_tel.rawBpm = 0;
      if (hrBle.isConnected() && g_tel.state == DeviceState::RECEIVING_POWER) g_tel.state = DeviceState::CONNECTED;
    } else {
      g_tel.rawPower = 0;
      if (ble.isConnected() && g_tel.state == DeviceState::RECEIVING_POWER) g_tel.state = DeviceState::CONNECTED;
    }
    processor.reset();
  }
}

void setup() {
  Serial.begin(115200);
  delay(200);
  Serial.println("\n[BOOT] RGB Watt Controller");
  Serial.printf("[FW] Version %s (%s)\n", FW_VERSION_FULL, FW_BUILD_TYPE);
  g_tel.state = DeviceState::STARTING;

  Security::begin();   // device identity / security layer (non-destructive)

  storage.begin();
  storage.load(g_config);
  g_logEnabled = g_config.debug;
  g_tel.controlSource = g_config.controlSource;

  if (!leds.begin(g_config.ledPin, g_config.ledCount, g_config.ledType, g_config.brightness)) {
    Serial.println("[RGB] WARNING: LED init failed");
    g_tel.state = DeviceState::ERROR;
  }
  leds.setEffect(g_config.ledEffect);
  processor.setSmoothing(g_config.smoothing);

  setupWifi();

  ble.begin();          // initialises NimBLE once
  ble.setAutoReconnect(g_config.autoReconnect);
  hrBle.begin();
  hrBle.setAutoReconnect(g_config.autoReconnect);

  web.begin();

  // Auto-reconnect to the saved source of the ACTIVE control source on boot.
  if (g_config.controlSource == SRC_HEART_RATE) {
    if (strlen(g_config.hrSourceAddr) > 0 && g_config.autoReconnect) {
      Serial.printf("[HR] Restoring saved source: %s\n", g_config.hrSourceName);
      hrBle.connectToAddress(g_config.hrSourceAddr, g_config.hrSourceName);
    } else {
      g_tel.state = DeviceState::DISCONNECTED;
    }
  } else {
    if (strlen(g_config.sourceAddr) > 0 && g_config.autoReconnect) {
      Serial.printf("[BLE] Restoring saved source: %s\n", g_config.sourceName);
      ble.connectToAddress(g_config.sourceAddr, g_config.sourceName);
    } else {
      g_tel.state = DeviceState::DISCONNECTED;
    }
  }
}

void loop() {
  // Only the active control source's BLE module is ever serviced.
  if (g_config.controlSource == SRC_HEART_RATE) hrBle.update();
  else                                         ble.update();

  uint32_t now = millis();
  if (now - s_lastProc >= 100) {
    s_lastProc = now;
    processPipeline();
  }

  leds.update();
  web.loop();

  if (s_rebootAt && millis() >= s_rebootAt) {
    Serial.println("[SYS] Rebooting...");
    delay(100);
    ESP.restart();
  }
}