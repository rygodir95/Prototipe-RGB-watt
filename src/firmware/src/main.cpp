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
Simulation     sim;
WebInterface   web;

bool g_logEnabled = true;   // gated by build type + config.debug

static int      s_prevZone   = 0;
static uint32_t s_rebootAt   = 0;
static uint32_t s_lastProc   = 0;
static uint32_t s_lastDebug  = 0;

// ---- Config application -----------------------------------------------------
void applyRuntimeConfig() {
  g_logEnabled = g_config.debug;
  processor.setSmoothing(g_config.smoothing);
  leds.reconfigure(g_config.ledPin, g_config.ledCount, g_config.ledType);
  leds.setBrightnessPct(g_config.brightness);
  leds.setEffect(g_config.ledEffect);
  ble.setAutoReconnect(g_config.autoReconnect);
}

void scheduleReboot(uint32_t ms) { s_rebootAt = millis() + ms; }

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
static void processPipeline() {
  uint32_t now = millis();
  bool  haveData = false;
  float raw      = 0;

  if (sim.enabled()) {
    raw      = sim.watts();
    haveData = true;
    g_tel.simMode = true;
  } else {
    g_tel.simMode = false;
    if (ble.isConnected() && (now - ble.getPowerTime()) < (uint32_t)g_config.powerTimeoutMs) {
      raw      = ble.getPower();
      haveData = true;
    }
  }

  g_tel.connected = ble.isConnected();
  g_tel.hasData   = haveData;

  if (haveData) {
    float smoothed = processor.update(raw);
    int zone = PowerZones::zoneIndex(g_config, smoothed, s_prevZone, true);
    s_prevZone = zone;
    uint8_t r, g, b;
    PowerZones::colorFor(g_config, smoothed, r, g, b);

    g_tel.rawPower      = raw;
    g_tel.smoothedPower = smoothed;
    g_tel.zone          = zone;
    g_tel.r = r; g_tel.g = g; g_tel.b = b;

    leds.setColor(r, g, b);
    leds.setActive(true);

    // Reflect RECEIVING_POWER while connected (BLE) or SIM.
    if (sim.enabled())        g_tel.state = DeviceState::RECEIVING_POWER;
    else if (ble.isConnected()) g_tel.state = DeviceState::RECEIVING_POWER;

    if (g_config.debug && now - s_lastDebug > 1000) {
      s_lastDebug = now;
      Serial.printf("[POWER] %d W  Smoothed: %d W\n", (int)lroundf(raw), (int)lroundf(smoothed));
      Serial.printf("[ZONE] Zone %d - %s\n", zone + 1, g_config.zones[zone].name);
      Serial.printf("[RGB] %d, %d, %d\n", r, g, b);
    }
  } else {
    // No fresh data -> fade LEDs out; keep last smoothed for display briefly.
    leds.setActive(false);
    g_tel.rawPower = 0;
    if (ble.isConnected()) {
      if (g_tel.state == DeviceState::RECEIVING_POWER) g_tel.state = DeviceState::CONNECTED;
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

  if (!leds.begin(g_config.ledPin, g_config.ledCount, g_config.ledType, g_config.brightness)) {
    Serial.println("[RGB] WARNING: LED init failed");
    g_tel.state = DeviceState::ERROR;
  }
  leds.setEffect(g_config.ledEffect);
  processor.setSmoothing(g_config.smoothing);

  setupWifi();

  ble.begin();
  ble.setAutoReconnect(g_config.autoReconnect);

  web.begin();

  // Auto-reconnect to saved power source on boot.
  if (strlen(g_config.sourceAddr) > 0 && g_config.autoReconnect) {
    Serial.printf("[BLE] Restoring saved source: %s\n", g_config.sourceName);
    ble.connectToAddress(g_config.sourceAddr, g_config.sourceName);
  } else {
    g_tel.state = DeviceState::DISCONNECTED;
  }
}

void loop() {
  ble.update();

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
