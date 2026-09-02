#include "WebInterface.h"
#include "WebContent.h"
#include "AppState.h"
#include "Config.h"
#include "Storage.h"
#include "BLEPower.h"
#include "Simulation.h"
#include <ESPAsyncWebServer.h>
#include <ArduinoJson.h>
#include <Update.h>

// Globals defined in main.cpp
extern Storage    storage;
extern BLEPower   ble;
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
}

// ---- POST /api/config -------------------------------------------------------

static void applyConfigPatch(JsonDocument &doc) {
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

  server.on("/api/scan", HTTP_POST, [](AsyncWebServerRequest *req) {
    ble.startScan(6);
    req->send(200, "application/json", "{\"ok\":true}");
  });

  server.on("/api/devices", HTTP_GET, [](AsyncWebServerRequest *req) {
    JsonDocument doc;
    doc["scanning"] = ble.isScanning();
    JsonArray arr = doc["devices"].to<JsonArray>();
    auto devs = ble.getDevices();
    for (auto &d : devs) {
      JsonObject o = arr.add<JsonObject>();
      o["address"]   = d.address;
      o["name"]      = d.name;
      o["type"]      = d.type;
      o["rssi"]      = d.rssi;
      o["connected"] = ble.isConnected() && strcmp(g_config.sourceAddr, d.address.c_str()) == 0;
    }
    String out; serializeJson(doc, out);
    req->send(200, "application/json", out);
  });

  attachJsonPost("/api/connect", [](AsyncWebServerRequest *req, JsonDocument &doc) {
    const char *addr = doc["address"].as<const char*>();
    const char *name = doc["name"].isNull() ? "" : doc["name"].as<const char*>();
    if (!addr) { req->send(400, "application/json", "{\"ok\":false}"); return; }
    strncpy(g_config.sourceAddr, addr, sizeof(g_config.sourceAddr) - 1);
    g_config.sourceAddr[sizeof(g_config.sourceAddr) - 1] = '\0';
    strncpy(g_config.sourceName, name, sizeof(g_config.sourceName) - 1);
    g_config.sourceName[sizeof(g_config.sourceName) - 1] = '\0';
    storage.save(g_config);
    ble.connectToAddress(addr, name);
    req->send(200, "application/json", "{\"ok\":true}");
  });

  server.on("/api/disconnect", HTTP_POST, [](AsyncWebServerRequest *req) {
    ble.disconnect();
    req->send(200, "application/json", "{\"ok\":true}");
  });

  server.on("/api/forget", HTTP_POST, [](AsyncWebServerRequest *req) {
    ble.forget();
    g_config.sourceAddr[0] = '\0';
    g_config.sourceName[0] = '\0';
    storage.save(g_config);
    req->send(200, "application/json", "{\"ok\":true}");
  });

  attachJsonPost("/api/simulation", [](AsyncWebServerRequest *req, JsonDocument &doc) {
    bool  en = doc["enabled"].isNull() ? sim.enabled() : doc["enabled"].as<bool>();
    float w  = doc["watts"].isNull()   ? sim.watts()   : doc["watts"].as<float>();
    sim.set(en, w);
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
  server.on("/api/ota", HTTP_POST,
    [](AsyncWebServerRequest *req) {
      bool ok = !Update.hasError();
      AsyncWebServerResponse *res = req->beginResponse(
        200, "application/json", ok ? "{\"ok\":true,\"reboot\":true}" : "{\"ok\":false}");
      res->addHeader("Connection", "close");
      req->send(res);
      if (ok) scheduleReboot(1500);
    },
    [](AsyncWebServerRequest *req, String filename, size_t index, uint8_t *data, size_t len, bool final) {
      if (index == 0) {
        Serial.printf("[OTA] Start: %s\n", filename.c_str());
        if (!Update.begin(UPDATE_SIZE_UNKNOWN)) Update.printError(Serial);
      }
      if (len) {
        if (Update.write(data, len) != len) Update.printError(Serial);
      }
      if (final) {
        if (Update.end(true)) Serial.printf("[OTA] Success: %u bytes\n", (unsigned)(index + len));
        else Update.printError(Serial);
      }
    });

  server.onNotFound([](AsyncWebServerRequest *req) {
    req->send(404, "text/plain", "Not found");
  });
}

// ---- telemetry --------------------------------------------------------------

void WebInterface::broadcastTelemetry() {
  if (ws.count() == 0) return;
  JsonDocument doc;
  doc["state"]     = deviceStateName(g_tel.state);
  doc["connected"] = g_tel.connected;
  doc["hasData"]   = g_tel.hasData;
  doc["sim"]       = g_tel.simMode;
  doc["raw"]       = (int)lroundf(g_tel.rawPower);
  doc["smoothed"]  = (int)lroundf(g_tel.smoothedPower);
  doc["zone"]      = g_tel.zone;
  doc["zoneName"]  = (g_tel.zone >= 0 && g_tel.zone < g_config.zoneCount)
                       ? g_config.zones[g_tel.zone].name : "";
  doc["ftp"]       = g_config.ftp;
  doc["zoneCount"] = g_config.zoneCount;
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
