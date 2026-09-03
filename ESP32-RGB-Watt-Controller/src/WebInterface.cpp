#include "WebInterface.h"
#include "WebContent.h"
#include "AppState.h"
#include "Config.h"
#include "Storage.h"
#include "BLEPower.h"
#include "HRSensor.h"
#include "Simulation.h"
#include "Security.h"
#include "FirmwareVersion.h"
#include <ESPAsyncWebServer.h>
#include <ArduinoJson.h>
#include <Update.h>
#include <mbedtls/sha256.h>

// Globals defined in main.cpp
extern Storage    storage;
extern BLEPower   ble;
extern HRSensor   hrBle;
extern Simulation sim;

static AsyncWebServer server(80);
static AsyncWebSocket ws("/ws");

// ---- helpers ----------------------------------------------------------------

static void hexFromRGB(char *out, uint8_t r, uint8_t g, uint8_t b) {
  sprintf(out, "#%02X%02X%02X", r, g, b);
}

static bool rgbFromHex(const char *hex, uint8_t &r, uint8_t &g, uint8_t &b) {
  if (!hex) return false;
  if (hex[0] == '#') hex++;
  if (strlen(hex) < 6) return false;
  long v = strtol(hex, nullptr, 16);
  r = (v >> 16) & 0xFF; g = (v >> 8) & 0xFF; b = v & 0xFF;
  return true;
}

static void buildConfigJson(JsonDocument &doc) {
  doc["controlSource"] = (g_config.controlSource == SRC_HEART_RATE) ? "hr" : "power";
  doc["ftp"]          = g_config.ftp;
  doc["smoothing"]    = g_config.smoothing;
  doc["powerTimeout"] = g_config.powerTimeoutMs;
  doc["hysteresis"]   = g_config.hysteresis;
  doc["zoneCount"]    = g_config.zoneCount;
  doc["ledPin"]       = g_config.ledPin;
  doc["ledCount"]     = g_config.ledCount;
  doc["brightness"]   = g_config.brightness;
  doc["ledType"]      = (g_config.ledType == LED_SK6812) ? "SK6812" : "WS2812B";
  doc["ledEffect"]    = g_config.ledEffect;
  doc["autoReconnect"]= g_config.autoReconnect;
  doc["sourceAddr"]   = g_config.sourceAddr;
  doc["sourceName"]   = g_config.sourceName;
  doc["wifiSsid"]     = g_config.wifiSsid;
  doc["theme"]        = g_config.theme;
  doc["debug"]        = g_config.debug;

  JsonArray zones = doc["zones"].to<JsonArray>();
  for (int i = 0; i < g_config.zoneCount; i++) {
    JsonObject z = zones.add<JsonObject>();
    z["name"] = g_config.zones[i].name;
    z["min"]  = g_config.zones[i].minWatts;
    z["max"]  = (i < g_config.zoneCount - 1) ? g_config.zones[i + 1].minWatts - 1 : -1;
    char hex[8];
    hexFromRGB(hex, g_config.zones[i].r, g_config.zones[i].g, g_config.zones[i].b);
    z["color"] = hex;
  }

  doc["hrMax"]        = g_config.hrMax;
  doc["hrSourceAddr"] = g_config.hrSourceAddr;
  doc["hrSourceName"] = g_config.hrSourceName;

  JsonArray hz = doc["hrZones"].to<JsonArray>();
  for (int i = 0; i < MAX_HR_ZONES; i++) {
    JsonObject z = hz.add<JsonObject>();
    z["name"] = g_config.hrZones[i].name;
    z["min"]  = g_config.hrZones[i].minBpm;
    z["max"]  = (i < MAX_HR_ZONES - 1) ? g_config.hrZones[i + 1].minBpm - 1 : -1;
    char hex[8];
    hexFromRGB(hex, g_config.hrZones[i].r, g_config.hrZones[i].g, g_config.hrZones[i].b);
    z["color"] = hex;
  }
}

// ---- POST /api/config -------------------------------------------------------

static void applyConfigPatch(JsonDocument &doc) {
  // Control source switch first: it fully tears down the other BLE module
  // (disconnect, stop scan/reconnect, clear live state) and persists the mode.
  if (!doc["controlSource"].isNull()) {
    const char *s = doc["controlSource"].as<const char*>();
    if (s && strcmp(s, "hr") == 0)          setControlSource(SRC_HEART_RATE);
    else if (s && strcmp(s, "power") == 0)  setControlSource(SRC_POWER);
  }

  int oldFtp = g_config.ftp;
  bool hasZoneCount = !doc["zoneCount"].isNull();
  bool hasFtp       = !doc["ftp"].isNull();
  bool hasZones     = doc["zones"].is<JsonArray>();

  if (hasZoneCount) {
    g_config.zoneCount = doc["zoneCount"].as<int>();
    if (hasFtp) g_config.ftp = doc["ftp"].as<int>();
    configApplyDefaultZones(g_config);       // regenerate on count change
  } else if (hasFtp) {
    int newFtp = doc["ftp"].as<int>();
    if (!hasZones) configScaleZones(g_config, oldFtp, newFtp);
    g_config.ftp = newFtp;
  }

  if (hasZones) {
    JsonArray arr = doc["zones"].as<JsonArray>();
    int i = 0;
    for (JsonObject z : arr) {
      if (i >= g_config.zoneCount || i >= MAX_ZONES) break;
      if (!z["name"].isNull()) {
        strncpy(g_config.zones[i].name, z["name"].as<const char*>(), sizeof(g_config.zones[i].name) - 1);
        g_config.zones[i].name[sizeof(g_config.zones[i].name) - 1] = '\0';
      }
      if (!z["min"].isNull()) g_config.zones[i].minWatts = z["min"].as<int>();
      if (!z["color"].isNull()) {
        uint8_t r, g, b;
        if (rgbFromHex(z["color"].as<const char*>(), r, g, b)) {
          g_config.zones[i].r = r; g_config.zones[i].g = g; g_config.zones[i].b = b;
        }
      }
      i++;
    }
    configSanitizeZones(g_config);
  }

  // --- Heart Rate configuration (kept separate from Power) ---
  bool hrReset = false;
  if (!doc["hrZonesReset"].isNull()) hrReset = doc["hrZonesReset"].as<bool>();
  if (!doc["hrMax"].isNull()) {
    int oldMax = g_config.hrMax;
    int newMax = constrain(doc["hrMax"].as<int>(), 100, 230);
    if (!doc["hrZones"].is<JsonArray>() && !hrReset)
      configScaleHrZones(g_config, oldMax, newMax);   // rescale custom boundaries
    g_config.hrMax = newMax;
  }
  if (doc["hrZones"].is<JsonArray>()) {
    JsonArray arr = doc["hrZones"].as<JsonArray>();
    int i = 0;
    for (JsonObject z : arr) {
      if (i >= MAX_HR_ZONES) break;
      if (!z["name"].isNull()) {
        strncpy(g_config.hrZones[i].name, z["name"].as<const char*>(), sizeof(g_config.hrZones[i].name) - 1);
        g_config.hrZones[i].name[sizeof(g_config.hrZones[i].name) - 1] = '\0';
      }
      if (!z["min"].isNull()) g_config.hrZones[i].minBpm = z["min"].as<int>();
      if (!z["color"].isNull()) {
        uint8_t r, g, b;
        if (rgbFromHex(z["color"].as<const char*>(), r, g, b)) {
          g_config.hrZones[i].r = r; g_config.hrZones[i].g = g; g_config.hrZones[i].b = b;
        }
      }
      i++;
    }
    configSanitizeHrZones(g_config);
  }
  if (hrReset) configApplyDefaultHrZones(g_config);

  if (!doc["smoothing"].isNull())    g_config.smoothing      = constrain(doc["smoothing"].as<int>(), 0, 100);
  if (!doc["powerTimeout"].isNull()) g_config.powerTimeoutMs = max(500, doc["powerTimeout"].as<int>());
  if (!doc["hysteresis"].isNull())   g_config.hysteresis     = max(0, doc["hysteresis"].as<int>());
  if (!doc["ledPin"].isNull())       g_config.ledPin         = doc["ledPin"].as<int>();
  if (!doc["ledCount"].isNull())     g_config.ledCount       = constrain(doc["ledCount"].as<int>(), 1, 1000);
  if (!doc["brightness"].isNull())   g_config.brightness     = constrain(doc["brightness"].as<int>(), 0, 100);
  if (!doc["ledType"].isNull()) {
    const char *t = doc["ledType"].as<const char*>();
    g_config.ledType = (t && strcmp(t, "SK6812") == 0) ? LED_SK6812 : LED_WS2812B;
  }
  if (!doc["ledEffect"].isNull()) g_config.ledEffect = constrain(doc["ledEffect"].as<int>(), 0, 2);
  if (!doc["autoReconnect"].isNull()) g_config.autoReconnect = doc["autoReconnect"].as<bool>();
  if (!doc["theme"].isNull()) {
    strncpy(g_config.theme, doc["theme"].as<const char*>(), sizeof(g_config.theme) - 1);
    g_config.theme[sizeof(g_config.theme) - 1] = '\0';
  }
  if (!doc["debug"].isNull()) g_config.debug = doc["debug"].as<bool>();

  storage.save(g_config);
  applyRuntimeConfig();
}

// Generic JSON body accumulator for POST handlers.
typedef std::function<void(AsyncWebServerRequest*, JsonDocument&)> JsonHandler;

static void attachJsonPost(const char *path, JsonHandler handler) {
  server.on(path, HTTP_POST,
    [](AsyncWebServerRequest *req) {},
    NULL,
    [handler](AsyncWebServerRequest *req, uint8_t *data, size_t len, size_t index, size_t total) {
      if (index == 0) req->_tempObject = new std::string();
      std::string *body = (std::string *)req->_tempObject;
      body->append((const char *)data, len);
      if (index + len == total) {
        JsonDocument doc;
        DeserializationError err = deserializeJson(doc, *body);
        delete body; req->_tempObject = nullptr;
        if (err) { req->send(400, "application/json", "{\"ok\":false,\"error\":\"bad json\"}"); return; }
        handler(req, doc);
      }
    });
}

// ---- routes -----------------------------------------------------------------

void WebInterface::setupRoutes() {
  server.on("/", HTTP_GET, [](AsyncWebServerRequest *req) {
    req->send(200, "text/html", INDEX_HTML);
  });
  server.on("/style.css", HTTP_GET, [](AsyncWebServerRequest *req) {
    req->send(200, "text/css", STYLE_CSS);
  });
  server.on("/app.js", HTTP_GET, [](AsyncWebServerRequest *req) {
    req->send(200, "application/javascript", APP_JS);
  });

  server.on("/api/config", HTTP_GET, [](AsyncWebServerRequest *req) {
    JsonDocument doc; buildConfigJson(doc);
    String out; serializeJson(doc, out);
    req->send(200, "application/json", out);
  });

  attachJsonPost("/api/config", [](AsyncWebServerRequest *req, JsonDocument &doc) {
    applyConfigPatch(doc);
    JsonDocument out; buildConfigJson(out);
    String s; serializeJson(out, s);
    req->send(200, "application/json", s);
  });

  // Sensor routes operate on the ACTIVE control source only (mutual exclusion).
  server.on("/api/scan", HTTP_POST, [](AsyncWebServerRequest *req) {
    if (g_config.controlSource == SRC_HEART_RATE) hrBle.startScan(6);
    else                                          ble.startScan(6);
    req->send(200, "application/json", "{\"ok\":true}");
  });

  server.on("/api/devices", HTTP_GET, [](AsyncWebServerRequest *req) {
    JsonDocument doc;
    JsonArray arr = doc["devices"].to<JsonArray>();
    if (g_config.controlSource == SRC_HEART_RATE) {
      doc["scanning"] = hrBle.isScanning();
      auto devs = hrBle.getDevices();
      for (auto &d : devs) {
        JsonObject o = arr.add<JsonObject>();
        o["address"]   = d.address;
        o["name"]      = d.name;
        o["type"]      = d.type;
        o["rssi"]      = d.rssi;
        o["connected"] = hrBle.isConnected() && strcmp(g_config.hrSourceAddr, d.address.c_str()) == 0;
      }
    } else {
      doc["scanning"] = ble.isScanning();
      auto devs = ble.getDevices();
      for (auto &d : devs) {
        JsonObject o = arr.add<JsonObject>();
        o["address"]   = d.address;
        o["name"]      = d.name;
        o["type"]      = d.type;
        o["rssi"]      = d.rssi;
        o["connected"] = ble.isConnected() && strcmp(g_config.sourceAddr, d.address.c_str()) == 0;
      }
    }
    String out; serializeJson(doc, out);
    req->send(200, "application/json", out);
  });

  attachJsonPost("/api/connect", [](AsyncWebServerRequest *req, JsonDocument &doc) {
    const char *addr = doc["address"].as<const char*>();
    const char *name = doc["name"].isNull() ? "" : doc["name"].as<const char*>();
    if (!addr) { req->send(400, "application/json", "{\"ok\":false}"); return; }
    if (g_config.controlSource == SRC_HEART_RATE) {
      strncpy(g_config.hrSourceAddr, addr, sizeof(g_config.hrSourceAddr) - 1);
      g_config.hrSourceAddr[sizeof(g_config.hrSourceAddr) - 1] = '\0';
      strncpy(g_config.hrSourceName, name, sizeof(g_config.hrSourceName) - 1);
      g_config.hrSourceName[sizeof(g_config.hrSourceName) - 1] = '\0';
      storage.save(g_config);
      hrBle.connectToAddress(addr, name);
    } else {
      strncpy(g_config.sourceAddr, addr, sizeof(g_config.sourceAddr) - 1);
      g_config.sourceAddr[sizeof(g_config.sourceAddr) - 1] = '\0';
      strncpy(g_config.sourceName, name, sizeof(g_config.sourceName) - 1);
      g_config.sourceName[sizeof(g_config.sourceName) - 1] = '\0';
      storage.save(g_config);
      ble.connectToAddress(addr, name);
    }
    req->send(200, "application/json", "{\"ok\":true}");
  });

  server.on("/api/disconnect", HTTP_POST, [](AsyncWebServerRequest *req) {
    if (g_config.controlSource == SRC_HEART_RATE) hrBle.disconnect();
    else                                          ble.disconnect();
    req->send(200, "application/json", "{\"ok\":true}");
  });

  server.on("/api/forget", HTTP_POST, [](AsyncWebServerRequest *req) {
    if (g_config.controlSource == SRC_HEART_RATE) {
      hrBle.forget();
      g_config.hrSourceAddr[0] = '\0';
      g_config.hrSourceName[0] = '\0';
    } else {
      ble.forget();
      g_config.sourceAddr[0] = '\0';
      g_config.sourceName[0] = '\0';
    }
    storage.save(g_config);
    req->send(200, "application/json", "{\"ok\":true}");
  });

  attachJsonPost("/api/simulation", [](AsyncWebServerRequest *req, JsonDocument &doc) {
    bool en = doc["enabled"].isNull() ? sim.enabled() : doc["enabled"].as<bool>();
    if (g_config.controlSource == SRC_HEART_RATE) {
      float b = doc["bpm"].isNull() ? sim.bpm() : doc["bpm"].as<float>();
      sim.setHr(en, b);
    } else {
      float w = doc["watts"].isNull() ? sim.watts() : doc["watts"].as<float>();
      sim.set(en, w);
    }
    req->send(200, "application/json", "{\"ok\":true}");
  });

  attachJsonPost("/api/wifi", [](AsyncWebServerRequest *req, JsonDocument &doc) {
    if (!doc["ssid"].isNull()) {
      strncpy(g_config.wifiSsid, doc["ssid"].as<const char*>(), sizeof(g_config.wifiSsid) - 1);
      g_config.wifiSsid[sizeof(g_config.wifiSsid) - 1] = '\0';
    }
    if (!doc["pass"].isNull()) {
      strncpy(g_config.wifiPass, doc["pass"].as<const char*>(), sizeof(g_config.wifiPass) - 1);
      g_config.wifiPass[sizeof(g_config.wifiPass) - 1] = '\0';
    }
    storage.save(g_config);
    req->send(200, "application/json", "{\"ok\":true,\"reboot\":true}");
    scheduleReboot(1500);
  });

  server.on("/api/factory-reset", HTTP_POST, [](AsyncWebServerRequest *req) {
    storage.factoryReset(g_config);
    req->send(200, "application/json", "{\"ok\":true,\"reboot\":true}");
    scheduleReboot(1500);
  });

  // Over-the-air firmware update: POST a compiled .bin as multipart upload.
  // Production builds enforce an ECDSA signature (X-FW-Signature header, hex DER)
  // and an anti-rollback version check. Development builds allow unsigned uploads
  // but still verify a signature if one is supplied.
  server.on("/api/ota", HTTP_POST,
    [](AsyncWebServerRequest *req) {
      bool ok = !Update.hasError() && !s_otaRejected;
      const char *msg = ok ? "{\"ok\":true,\"reboot\":true}"
                           : (s_otaReason[0] ? nullptr : "{\"ok\":false}");
      String body;
      if (msg) body = msg;
      else { body = String("{\"ok\":false,\"error\":\"") + s_otaReason + "\"}"; }
      AsyncWebServerResponse *res = req->beginResponse(ok ? 200 : 400, "application/json", body);
      res->addHeader("Connection", "close");
      req->send(res);
      if (ok) scheduleReboot(1500);
    },
    [](AsyncWebServerRequest *req, String filename, size_t index, uint8_t *data, size_t len, bool final) {
      if (index == 0) otaBegin(req, filename);
      if (s_otaRejected) return;
      otaWrite(data, len);
      if (final) otaFinish(index + len);
    });

  // Device / firmware / security information.
  server.on("/api/info", HTTP_GET, [](AsyncWebServerRequest *req) {
    JsonDocument doc;
    doc["version"]        = FW_VERSION_FULL;
    doc["versionCode"]    = FW_VERSION_CODE;
    doc["build"]          = FW_BUILD_TYPE;
    doc["production"]     = Security::isProduction();
    doc["deviceId"]       = Security::deviceId();
    doc["serial"]         = Security::serialNumber();
    doc["provisioned"]    = Security::isProvisioned();
    doc["secureBoot"]     = Security::secureBootEnabled();
    doc["flashEncrypted"] = Security::flashEncryptionEnabled();
    doc["signedOtaRequired"] = Security::requireSignedOTA();
    String out; serializeJson(doc, out);
    req->send(200, "application/json", out);
  });

  server.onNotFound([](AsyncWebServerRequest *req) {
    req->send(404, "text/plain", "Not found");
  });
}

// ---- telemetry --------------------------------------------------------------

void WebInterface::broadcastTelemetry() {
  if (ws.count() == 0) return;
  bool hr = (g_config.controlSource == SRC_HEART_RATE);
  JsonDocument doc;
  doc["mode"]      = hr ? "hr" : "power";
  doc["state"]     = deviceStateName(g_tel.state);
  doc["connected"] = g_tel.connected;
  doc["hasData"]   = g_tel.hasData;
  doc["sim"]       = g_tel.simMode;
  // raw/smoothed always carry the ACTIVE source's measurement (W or bpm).
  doc["raw"]       = (int)lroundf(hr ? g_tel.rawBpm : g_tel.rawPower);
  doc["smoothed"]  = (int)lroundf(hr ? g_tel.smoothedBpm : g_tel.smoothedPower);
  // Explicit HR fields for clients/tests.
  doc["hr"]        = (int)lroundf(g_tel.smoothedBpm);
  doc["hrRaw"]     = (int)lroundf(g_tel.rawBpm);
  doc["hrMax"]     = g_config.hrMax;
  doc["zone"]      = g_tel.zone;
  if (hr) doc["zoneName"] = (g_tel.zone >= 0 && g_tel.zone < MAX_HR_ZONES)
                              ? g_config.hrZones[g_tel.zone].name : "";
  else    doc["zoneName"] = (g_tel.zone >= 0 && g_tel.zone < g_config.zoneCount)
                              ? g_config.zones[g_tel.zone].name : "";
  doc["ftp"]       = g_config.ftp;
  doc["zoneCount"] = hr ? MAX_HR_ZONES : g_config.zoneCount;
  doc["brightness"]= g_config.brightness;
  doc["source"]    = g_tel.sourceName;
  char hex[8]; hexFromRGB(hex, g_tel.r, g_tel.g, g_tel.b);
  doc["color"]     = hex;
  String out; serializeJson(doc, out);
  ws.textAll(out);
}

void WebInterface::begin() {
  ws.onEvent([](AsyncWebSocket *s, AsyncWebSocketClient *c,
                AwsEventType type, void *arg, uint8_t *data, size_t len) {
    (void)s; (void)c; (void)arg; (void)data; (void)len;
  });
  server.addHandler(&ws);
  setupRoutes();
  server.begin();
  Serial.println("[WEB] Server started on port 80");
}

void WebInterface::loop() {
  uint32_t now = millis();
  if (now - _lastBroadcast >= 200) {
    _lastBroadcast = now;
    broadcastTelemetry();
  }
  if (now - _lastCleanup >= 2000) {
    _lastCleanup = now;
    ws.cleanupClients();
  }
}

size_t WebInterface::clientCount() const { return ws.count(); }