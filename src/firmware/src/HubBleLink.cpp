#include "HubBleLink.h"

#include <ArduinoJson.h>
#include <NimBLEDevice.h>

#include "AppState.h"
#include "Config.h"
#include "RuntimeDiagnostics.h"
#include "Simulation.h"
#include "WebInterface.h"

extern Simulation sim;

namespace {
// A private, versioned service. UUIDs are intentionally neutral: they are a
// transport contract, not product branding.
static const char *SERVICE_UUID = "5ca90000-6d75-4ca5-b4d6-3f9e6c5b0001";
static const char *STATUS_UUID  = "5ca90001-6d75-4ca5-b4d6-3f9e6c5b0001";
static const char *COMMAND_UUID = "5ca90002-6d75-4ca5-b4d6-3f9e6c5b0001";
static const char *RESULT_UUID  = "5ca90003-6d75-4ca5-b4d6-3f9e6c5b0001";

HubBleLink *g_link = nullptr;

class ServerCallbacks : public NimBLEServerCallbacks {
  void onConnect(NimBLEServer *) override {
    if (g_link) g_link->onConnect();
    // Keep advertising so the server remains discoverable after a transient
    // client loss. Firmware accepts one control client at a time.
    NimBLEDevice::startAdvertising();
  }
  void onDisconnect(NimBLEServer *) override {
    if (g_link) g_link->onDisconnect();
    NimBLEDevice::startAdvertising();
  }
};

class CommandCallbacks : public NimBLECharacteristicCallbacks {
  void onWrite(NimBLECharacteristic *characteristic) override {
    if (g_link) g_link->onWrite(characteristic);
  }
};

static ServerCallbacks g_serverCallbacks;
static CommandCallbacks g_commandCallbacks;
}

bool HubBleLink::enqueue(const Command &command) {
  bool accepted = false;
  _queue.access([&](Queue &queue) {
    if (queue.size == 8) return;
    queue.items[(queue.head + queue.size) % 8] = command;
    ++queue.size;
    accepted = true;
  });
  return accepted;
}

bool HubBleLink::take(Command &command) {
  bool found = false;
  _queue.access([&](Queue &queue) {
    if (!queue.size) return;
    command = queue.items[queue.head];
    queue.head = (queue.head + 1) % 8;
    --queue.size;
    found = true;
  });
  return found;
}

void HubBleLink::begin() {
  g_link = this;
  NimBLEServer *server = NimBLEDevice::createServer();
  server->setCallbacks(&g_serverCallbacks);
  NimBLEService *service = server->createService(SERVICE_UUID);
  _status = service->createCharacteristic(STATUS_UUID,
      NIMBLE_PROPERTY::READ | NIMBLE_PROPERTY::NOTIFY, 180);
  NimBLECharacteristic *command = service->createCharacteristic(COMMAND_UUID,
      NIMBLE_PROPERTY::WRITE, 180);
  _result = service->createCharacteristic(RESULT_UUID,
      NIMBLE_PROPERTY::READ | NIMBLE_PROPERTY::NOTIFY, 120);
  command->setCallbacks(&g_commandCallbacks);
  service->start();

  NimBLEAdvertising *advertising = NimBLEDevice::getAdvertising();
  advertising->addServiceUUID(service->getUUID());
  advertising->setScanResponse(true);
  advertising->start();
  Serial.println("[HUB BLE] Control service advertising");
  publishStatus(true);
}

size_t HubBleLink::clientCount() const { return _clients; }

void HubBleLink::onConnect() {
  if (_clients < 1) ++_clients;
  Serial.println("[HUB BLE] Control client connected");
}

void HubBleLink::onDisconnect() {
  _clients = 0;
  Serial.println("[HUB BLE] Control client disconnected");
}

void HubBleLink::onWrite(NimBLECharacteristic *characteristic) {
  const std::string raw = characteristic->getValue();
  StaticJsonDocument<160> doc;
  const DeserializationError error = deserializeJson(doc, raw.data(), raw.size());
  const uint32_t id = doc["id"] | 0;
  const char *op = doc["op"] | "";
  Command command{};
  command.id = id;

  if (error || id == 0 || !op[0]) { sendResult(id, false, "invalid command"); return; }
  if (strcmp(op, "lighting_test") == 0) {
    command.type = CommandType::LightingTest;
    command.enabled = doc["on"] | false;
  } else if (strcmp(op, "simulation") == 0) {
    command.type = CommandType::Simulation;
    command.enabled = doc["on"] | false;
    command.value = doc["value"] | 0.0f;
  } else if (strcmp(op, "source") == 0) {
    const char *value = doc["value"] | "";
    if (strcmp(value, "power") == 0) command.source = SRC_POWER;
    else if (strcmp(value, "hr") == 0) command.source = SRC_HEART_RATE;
    else { sendResult(id, false, "invalid source"); return; }
    command.type = CommandType::Source;
  } else if (strcmp(op, "diagnostics") == 0) {
    command.type = CommandType::Diagnostics;
  } else {
    sendResult(id, false, "unsupported command");
    return;
  }
  if (!enqueue(command)) sendResult(id, false, "busy");
}

void HubBleLink::sendResult(uint32_t id, bool ok, const char *error) {
  if (!_result) return;
  StaticJsonDocument<120> doc;
  doc["v"] = 1;
  doc["id"] = id;
  doc["ok"] = ok;
  if (error) doc["error"] = error;
  String out;
  serializeJson(doc, out);
  _result->setValue(out.c_str());
  if (_clients) _result->notify();
}

void HubBleLink::publishStatus(bool force) {
  if (!_status) return;
  const bool hr = g_config.controlSource == SRC_HEART_RATE;
  StaticJsonDocument<180> doc;
  doc["v"] = 1;
  doc["state"] = deviceStateName(g_tel.state);
  doc["source"] = hr ? "hr" : "power";
  doc["connected"] = g_tel.connected;
  doc["data"] = g_tel.hasData;
  doc["value"] = (int)lroundf(hr ? g_tel.smoothedBpm : g_tel.smoothedPower);
  doc["zone"] = g_tel.zone;
  char color[8];
  snprintf(color, sizeof(color), "#%02X%02X%02X", g_tel.r, g_tel.g, g_tel.b);
  doc["color"] = color;
  doc["sim"] = g_tel.simMode;
  String out;
  serializeJson(doc, out);
  if (!force && out == _previousStatus && millis() - _lastStatus < 1500) return;
  _status->setValue(out.c_str());
  if (_clients) _status->notify();
  _previousStatus = out;
  _lastStatus = millis();
}

void HubBleLink::advanceLightingTest() {
  if (!_lightingTestRunning) return;
  const uint32_t now = millis();
  if (_lastLightingTestStep && now - _lastLightingTestStep < 1500) return;

  const bool hr = g_config.controlSource == SRC_HEART_RATE;
  const uint8_t count = hr ? MAX_HR_ZONES : g_config.zoneCount;
  if (!count) return;
  const uint8_t index = _lightingTestStep++ % count;
  float value;
  if (hr) {
    const int lower = g_config.hrZones[index].minBpm;
    const int upper = index + 1 < count ? g_config.hrZones[index + 1].minBpm : g_config.hrMax;
    value = (lower + max(lower, upper)) * 0.5f;
  } else {
    const int lower = g_config.zones[index].minWatts;
    const int upper = index + 1 < count ? g_config.zones[index + 1].minWatts : lower + 50;
    value = (lower + max(lower, upper)) * 0.5f;
  }
  sim.patch(hr, true, true, true, value, true, true);
  _lastLightingTestStep = now;
}

void HubBleLink::loop() {
  Command command;
  if (take(command)) {
    switch (command.type) {
      case CommandType::LightingTest:
        _lightingTestRunning = command.enabled;
        _lightingTestStep = 0;
        _lastLightingTestStep = 0;
        if (command.enabled) {
          advanceLightingTest();
        } else {
          sim.patch(g_config.controlSource == SRC_HEART_RATE, true, false,
                    false, 0, true, false);
        }
        sendResult(command.id, true);
        break;
      case CommandType::Simulation:
        sim.patch(g_config.controlSource == SRC_HEART_RATE, true, command.enabled,
                  true, command.value);
        sendResult(command.id, true);
        break;
      case CommandType::Source:
        setControlSource(command.source, true);
        sendResult(command.id, true);
        break;
      case CommandType::Diagnostics: {
        const RuntimeHealth health = runtimeHealth();
        StaticJsonDocument<120> doc;
        doc["v"] = 1; doc["id"] = command.id; doc["ok"] = true;
        doc["heap"] = health.freeHeap; doc["minHeap"] = health.minHeap;
        String out; serializeJson(doc, out);
        _result->setValue(out.c_str());
        if (_clients) _result->notify();
        break;
      }
    }
    publishStatus(true);
  }
  advanceLightingTest();
  if (millis() - _lastStatus >= 500) publishStatus(false);
}

