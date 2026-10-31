#include "HubBleLink.h"

#include <ArduinoJson.h>
#include <NimBLEDevice.h>
#include <math.h>

#include "AppState.h"
#include "BLEPower.h"
#include "BleScanRouter.h"
#include "Config.h"
#include "ConfigJson.h"
#include "FirmwareVersion.h"
#include "HRSensor.h"
#include "HubBleAdvertising.h"
#include "Security.h"
#include "Simulation.h"
#include "Storage.h"

// Shared subsystems owned by main.cpp. The BLE link drives the SAME control
// paths as the HTTP API instead of duplicating firmware policy.
extern Simulation    sim;
extern BLEPower      ble;
extern HRSensor      hrBle;
extern BleScanRouter bleScan;
extern Storage       storage;

// Defined in main.cpp.
extern void setControlSource(uint8_t src, bool restore);
extern void applyRuntimeConfig();
extern void scheduleReboot(uint32_t ms);

namespace {

// A private, versioned service. UUIDs are a transport contract, not branding.
const char *SERVICE_UUID = "5ca90000-6d75-4ca5-b4d6-3f9e6c5b0001";
const char *STATUS_UUID  = "5ca90001-6d75-4ca5-b4d6-3f9e6c5b0001";
const char *COMMAND_UUID = "5ca90002-6d75-4ca5-b4d6-3f9e6c5b0001";
const char *RESULT_UUID  = "5ca90003-6d75-4ca5-b4d6-3f9e6c5b0001";

const uint16_t STATUS_MAX  = 180;
const uint16_t RESULT_MAX  = 240;
const uint16_t COMMAND_MAX = 240;

HubBleLink *g_link = nullptr;

// NimBLE callbacks only forward to the link object; every state change lands
// on the Arduino loop task through the bounded command queue.
struct ServerCallbacks : public NimBLEServerCallbacks {
  void onConnect(NimBLEServer *) override {
    if (g_link) g_link->onConnect();
  }
  void onDisconnect(NimBLEServer *) override {
    if (g_link) g_link->onDisconnect();
  }
};

struct CommandCallbacks : public NimBLECharacteristicCallbacks {
  void onWrite(NimBLECharacteristic *characteristic) override {
    if (g_link) g_link->onWrite(characteristic);
  }
};

ServerCallbacks  g_serverCallbacks;
CommandCallbacks g_commandCallbacks;

// "#rrggbb" from the live colour, without pulling in the web layer helpers.
void colorHex(char *out, size_t size, uint8_t r, uint8_t g, uint8_t b) {
  snprintf(out, size, "#%02x%02x%02x", (unsigned)r, (unsigned)g, (unsigned)b);
}

}  // namespace

bool HubBleLink::enqueue(const Command &command) {
  bool accepted = false;
  portENTER_CRITICAL(&_queueMux);
  if (_queue.size < 8) {
    _queue.items[(_queue.head + _queue.size) % 8] = command;
    ++_queue.size;
    accepted = true;
  }
  portEXIT_CRITICAL(&_queueMux);
  return accepted;
}

bool HubBleLink::take(Command &command) {
  bool found = false;
  portENTER_CRITICAL(&_queueMux);
  if (_queue.size) {
    command = _queue.items[_queue.head];
    _queue.head = (uint8_t)((_queue.head + 1) % 8);
    --_queue.size;
    found = true;
  }
  portEXIT_CRITICAL(&_queueMux);
  return found;
}

void HubBleLink::configureAdvertising() {
  NimBLEAdvertising *advertising = NimBLEDevice::getAdvertising();
  if (!advertising) return;
  advertising->addServiceUUID(NimBLEUUID(SERVICE_UUID));
  advertising->setName(ADVERTISED_NAME);
  advertising->setScanResponse(true);
}

bool HubBleLink::startAdvertising(bool restart) {
  NimBLEAdvertising *advertising = NimBLEDevice::getAdvertising();
  if (!advertising) {
    _advertising = false;
    Serial.println("[HUB BLE] WARNING: advertising unavailable - control service not discoverable");
    return false;
  }
  advertising->stop();
  const bool started = advertising->start(0);
  _advertising = started && advertising->isAdvertising();
  if (_advertising) {
    Serial.println(restart ? "[HUB BLE] advertising restarted" : "[HUB BLE] advertising started");
  } else {
    Serial.println("[HUB BLE] WARNING: advertising FAILED to start - control service not discoverable");
  }
  return _advertising;
}

bool HubBleLink::begin() {
  g_link = this;

  if (!NimBLEDevice::getInitialized()) {
    Serial.println("[HUB BLE] FATAL: NimBLE is not initialised (BLEPower::begin must run first)");
    return false;
  }

  // The sensor drivers initialise NimBLE without a name; the control service
  // is what a phone or the Windows app discovers.
  NimBLEDevice::setDeviceName(ADVERTISED_NAME);

  _server = NimBLEDevice::createServer();
  if (!_server) {
    Serial.println("[HUB BLE] FATAL: server creation failed");
    return false;
  }
  _server->setCallbacks(&g_serverCallbacks);

  NimBLEService *service = _server->createService(SERVICE_UUID);
  if (!service) {
    Serial.println("[HUB BLE] FATAL: service creation failed");
    return false;
  }

  _status = service->createCharacteristic(
      STATUS_UUID, NIMBLE_PROPERTY::READ | NIMBLE_PROPERTY::NOTIFY, STATUS_MAX);
  NimBLECharacteristic *command = service->createCharacteristic(
      COMMAND_UUID, NIMBLE_PROPERTY::WRITE, COMMAND_MAX);
  _result = service->createCharacteristic(
      RESULT_UUID, NIMBLE_PROPERTY::READ | NIMBLE_PROPERTY::NOTIFY, RESULT_MAX);
  if (!_status || !command || !_result) {
    Serial.println("[HUB BLE] FATAL: characteristic creation failed");
    return false;
  }
  command->setCallbacks(&g_commandCallbacks);
  service->start();

  configureAdvertising();
  const bool advertisingOk = startAdvertising(false);
  publishStatus(true);
  Serial.printf("[HUB BLE] control service ready (%s, %s)\n", SERVICE_UUID,
                advertisingOk ? "advertising" : "NOT advertising");
  return advertisingOk;
}

void HubBleLink::onConnect() {
  if (_clients < 1) ++_clients;
  Serial.println("[HUB BLE] control client connected");
  // One control client at a time: stop advertising while it is attached.
  if (!hubBleAdvertisingWanted(_clients) && _advertising) {
    NimBLEAdvertising *advertising = NimBLEDevice::getAdvertising();
    if (advertising) advertising->stop();
    _advertising = false;
  }
  publishStatus(true);
}

void HubBleLink::onDisconnect() {
  _clients = 0;
  _stageActive = false;
  // Both transfer slots are tied to the client that started them.
  _transfer.clearAll();
  Serial.println("[HUB BLE] control client disconnected");
  // Advertising must come back so the Hub stays discoverable.
  if (hubBleAdvertisingWanted(_clients)) startAdvertising(true);
  publishStatus(true);
}

void HubBleLink::loop() {
  Command command;
  if (take(command)) handleCommand(command);

  const uint32_t now = millis();
  if (now - _lastStatus >= 1000) {
    _lastStatus = now;
    publishStatus();
  }
}

void HubBleLink::onWrite(NimBLECharacteristic *characteristic) {
  if (!characteristic) return;
  const std::string raw = characteristic->getValue();

  JsonDocument doc;
  const DeserializationError error = deserializeJson(doc, raw.data(), raw.size());
  const uint32_t id = doc["id"] | 0;
  const char *op = doc["op"] | "";

  Command command{};
  command.id = id;
  command.part = -1;
  command.transfer = -1;
  command.ackOnly = doc["ack"] | false;

#if defined(BUILD_DEV)
  // Diagnostic metadata only: never print the command body or saved secrets.
  Serial.printf("[HUB BLE][write] bytes=%u id=%lu op=%s parse=%s\n",
                (unsigned)raw.size(), (unsigned long)id, op, error.c_str());
#endif

  if (error || id == 0 || !op[0]) {
    sendResult(id, false, "invalid command");
    return;
  }

  if (strcmp(op, "simulation") == 0) {
    command.type = CommandType::Simulation;
    command.hasEnabled = !doc["on"].isNull();
    command.enabled = doc["on"] | false;
    command.value = doc["value"] | 0.0f;
  } else if (strcmp(op, "diagnostics") == 0) {
    command.type = CommandType::Diagnostics;
  } else if (strcmp(op, "info") == 0) {
    command.type = CommandType::Info;
  } else if (strcmp(op, "config_read") == 0 || strcmp(op, "devices_read") == 0) {
    const bool isConfig = (op[0] == 'c');
    if (!doc["part"].isNull()) {
      if (!doc["part"].is<int>() || doc["part"].as<int>() < 0 || doc["part"].as<int>() > 32767) {
        sendResult(id, false, "invalid part");
        return;
      }
      command.part = (int16_t)doc["part"].as<int>();
    }
    if (!doc["t"].isNull()) {
      if (!doc["t"].is<int>() || doc["t"].as<int>() < 0) {
        sendResult(id, false, "invalid transfer");
        return;
      }
      command.transfer = doc["t"].as<int>();
    }
    command.type = isConfig ? CommandType::ConfigRead : CommandType::DevicesRead;
  } else if (strcmp(op, "config_write") == 0) {
    JsonVariantConst patch = doc["patch"];
    if (!patch.is<JsonObjectConst>()) {
      sendResult(id, false, "invalid config patch");
      return;
    }
    const size_t length = serializeJson(patch, command.patch, sizeof(command.patch));
    if (length == 0 || length >= sizeof(command.patch)) {
      sendResult(id, false, "config patch too large");
      return;
    }
    command.type = CommandType::ConfigWrite;
  } else if (strcmp(op, "zone_begin") == 0) {
    const char *source = doc["source"] | "";
    if (strcmp(source, "power") == 0)       command.source = SRC_POWER;
    else if (strcmp(source, "hr") == 0)     command.source = SRC_HEART_RATE;
    else {
      sendResult(id, false, "invalid zone source");
      return;
    }
    command.value = doc["count"] | 0;
    command.type = CommandType::ZoneBegin;
  } else if (strcmp(op, "zone_stage") == 0) {
    JsonVariantConst zone = doc["zone"];
    if (!zone.is<JsonObjectConst>() || zone["index"].isNull()) {
      sendResult(id, false, "invalid zone");
      return;
    }
    const size_t length = serializeJson(zone, command.patch, sizeof(command.patch));
    if (length == 0 || length >= sizeof(command.patch)) {
      sendResult(id, false, "zone data too large");
      return;
    }
    command.type = CommandType::ZoneStage;
  } else if (strcmp(op, "zone_commit") == 0) {
    command.type = CommandType::ZoneCommit;
  } else if (strcmp(op, "scan") == 0) {
    command.type = CommandType::Scan;
  } else if (strcmp(op, "sensor_connect") == 0) {
    JsonVariantConst sensor = doc["sensor"];
    if (!sensor.is<JsonObjectConst>() || !sensor["address"].is<const char *>()) {
      sendResult(id, false, "invalid sensor");
      return;
    }
    const size_t length = serializeJson(sensor, command.patch, sizeof(command.patch));
    if (length == 0 || length >= sizeof(command.patch)) {
      sendResult(id, false, "sensor data too large");
      return;
    }
    command.type = CommandType::SensorConnect;
  } else if (strcmp(op, "sensor_disconnect") == 0) {
    command.type = CommandType::SensorDisconnect;
  } else if (strcmp(op, "sensor_forget") == 0) {
    command.type = CommandType::SensorForget;
  } else if (strcmp(op, "factory_reset") == 0) {
    command.type = CommandType::FactoryReset;
  } else {
    sendResult(id, false, "unsupported operation");
    return;
  }

  if (!enqueue(command)) sendResult(id, false, "busy");
}

void HubBleLink::handleCommand(const Command &command) {
#if defined(BUILD_DEV)
  Serial.printf("[HUB BLE][dispatch] id=%lu type=%u\n",
                (unsigned long)command.id, (unsigned)command.type);
#endif
  switch (command.type) {
    case CommandType::Simulation: {
      const bool enabled = command.hasEnabled ? command.enabled : sim.enabled();
      if (g_config.controlSource == SRC_HEART_RATE) {
        sim.setHr(enabled, command.value);
      } else {
        sim.set(enabled, command.value);
      }
      sendResult(command.id, true);
      break;
    }
    case CommandType::Diagnostics: {
      JsonDocument doc;
      doc["v"] = 1;
      doc["id"] = command.id;
      doc["ok"] = true;
      doc["heap"] = (uint32_t)ESP.getFreeHeap();
      doc["minHeap"] = (uint32_t)ESP.getMinFreeHeap();
      doc["clients"] = _clients;
      doc["advertising"] = _advertising;
      String out;
      serializeJson(doc, out);
      if (_result) {
        _result->setValue((const uint8_t *)out.c_str(), out.length());
        if (_clients) _result->notify();
      }
      break;
    }
    case CommandType::Info: {
      JsonDocument doc;
      doc["v"] = 1;
      doc["id"] = command.id;
      doc["ok"] = true;
      doc["version"] = FW_VERSION_FULL;
      doc["buildId"] = FW_BUILD_SHA;
      doc["deviceId"] = Security::deviceId();
      doc["name"] = ADVERTISED_NAME;
      String out;
      serializeJson(doc, out);
      if (_result) {
        _result->setValue((const uint8_t *)out.c_str(), out.length());
        if (_clients) _result->notify();
      }
      break;
    }
    case CommandType::ConfigRead:
      sendConfig(command.id, command.part, command.transfer);
      break;
    case CommandType::DevicesRead:
      sendDevices(command.id, command.part, command.transfer);
      break;
    case CommandType::ConfigWrite: {
      JsonDocument patch;
      if (deserializeJson(patch, command.patch)) {
        sendResult(command.id, false, "invalid config patch");
        break;
      }
      applyConfigPatch(patch);
      configSanitizeZones(g_config);
      configSanitizeHrZones(g_config);
      storage.save(g_config);
      applyRuntimeConfig();
      if (command.ackOnly) sendResult(command.id, true);
      else                 sendConfig(command.id, -1, -1);   // full burst, as the HTTP API returns the document
      break;
    }
    case CommandType::ZoneBegin: {
      _stageSource = command.source;
      _stageExpected = (uint8_t)command.value;
      _stageMask = 0;
      _stageActive = _stageExpected > 0 &&
                     _stageExpected <= (uint8_t)(_stageSource == SRC_HEART_RATE ? MAX_HR_ZONES : MAX_ZONES);
      if (!_stageActive) {
        sendResult(command.id, false, "invalid zone batch");
        break;
      }
      sendResult(command.id, true);
      break;
    }
    case CommandType::ZoneStage: {
      JsonDocument zone;
      if (deserializeJson(zone, command.patch) || zone["index"].isNull()) {
        sendResult(command.id, false, "invalid zone");
        break;
      }
      const int index = zone["index"].as<int>();
      const int limit = (_stageSource == SRC_HEART_RATE) ? MAX_HR_ZONES : MAX_ZONES;
      if (!_stageActive || index < 0 || index >= limit || index >= _stageExpected) {
        sendResult(command.id, false, "invalid zone batch");
        break;
      }
      const char *name = zone["name"] | "";
      const int minValue = zone["min"] | 0;
      uint8_t r = 0, g = 0, b = 0;
      const char *color = zone["color"] | "";
      if (strlen(color) == 7 && color[0] == '#') {
        unsigned long value = strtoul(color + 1, nullptr, 16);
        r = (uint8_t)((value >> 16) & 0xFF);
        g = (uint8_t)((value >> 8) & 0xFF);
        b = (uint8_t)(value & 0xFF);
      }
      if (_stageSource == SRC_HEART_RATE) {
        strncpy(_stagedHr[index].name, name, sizeof(_stagedHr[index].name) - 1);
        _stagedHr[index].name[sizeof(_stagedHr[index].name) - 1] = '\0';
        _stagedHr[index].minBpm = minValue;
        _stagedHr[index].r = r;
        _stagedHr[index].g = g;
        _stagedHr[index].b = b;
      } else {
        strncpy(_stagedPower[index].name, name, sizeof(_stagedPower[index].name) - 1);
        _stagedPower[index].name[sizeof(_stagedPower[index].name) - 1] = '\0';
        _stagedPower[index].minWatts = minValue;
        _stagedPower[index].r = r;
        _stagedPower[index].g = g;
        _stagedPower[index].b = b;
      }
      _stageMask = (uint8_t)(_stageMask | (1u << index));
      sendResult(command.id, true);
      break;
    }
    case CommandType::ZoneCommit: {
      if (!_stageActive || _stageMask != (uint8_t)((1u << _stageExpected) - 1u)) {
        sendResult(command.id, false, "incomplete zone batch");
        break;
      }
      if (_stageSource == SRC_HEART_RATE) {
        memcpy(g_config.hrZones, _stagedHr, sizeof(_stagedHr));
        configSanitizeHrZones(g_config);
      } else {
        memcpy(g_config.zones, _stagedPower, sizeof(_stagedPower));
        configSanitizeZones(g_config);
      }
      _stageActive = false;
      storage.save(g_config);
      applyRuntimeConfig();
      sendResult(command.id, true);
      break;
    }
    case CommandType::Scan:
      bleScan.startScan(6);
      sendResult(command.id, true);
      break;
    case CommandType::SensorConnect: {
      JsonDocument sensor;
      if (deserializeJson(sensor, command.patch)) {
        sendResult(command.id, false, "invalid sensor");
        break;
      }
      const char *address = sensor["address"] | "";
      const char *name = sensor["name"] | "";
      const char *category = sensor["category"] | "";
      if (!address[0]) {
        sendResult(command.id, false, "invalid sensor");
        break;
      }
      // Plug-and-play: the device CATEGORY selects the control source, exactly
      // like POST /api/connect.
      uint8_t target = g_config.controlSource;
      if (strcmp(category, "hr") == 0)         target = SRC_HEART_RATE;
      else if (strcmp(category, "power") == 0) target = SRC_POWER;
      else {
        bool discovered = false;
        for (const auto &d : ble.getDevices()) {
          if (d.address == address) { target = SRC_POWER; discovered = true; break; }
        }
        if (!discovered) {
          for (const auto &d : hrBle.getDevices()) {
            if (d.address == address) { target = SRC_HEART_RATE; break; }
          }
        }
      }
      if (target != g_config.controlSource) setControlSource(target, false);
      if (target == SRC_HEART_RATE) {
        strncpy(g_config.hrSourceAddr, address, sizeof(g_config.hrSourceAddr) - 1);
        g_config.hrSourceAddr[sizeof(g_config.hrSourceAddr) - 1] = '\0';
        strncpy(g_config.hrSourceName, name, sizeof(g_config.hrSourceName) - 1);
        g_config.hrSourceName[sizeof(g_config.hrSourceName) - 1] = '\0';
        storage.save(g_config);
        hrBle.connectToAddress(address, name);
      } else {
        strncpy(g_config.sourceAddr, address, sizeof(g_config.sourceAddr) - 1);
        g_config.sourceAddr[sizeof(g_config.sourceAddr) - 1] = '\0';
        strncpy(g_config.sourceName, name, sizeof(g_config.sourceName) - 1);
        g_config.sourceName[sizeof(g_config.sourceName) - 1] = '\0';
        storage.save(g_config);
        ble.connectToAddress(address, name);
      }
      sendResult(command.id, true);
      break;
    }
    case CommandType::SensorDisconnect:
      if (g_config.controlSource == SRC_HEART_RATE) hrBle.disconnect();
      else                                         ble.disconnect();
      sendResult(command.id, true);
      break;
    case CommandType::SensorForget:
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
      sendResult(command.id, true);
      break;
    case CommandType::FactoryReset:
      storage.factoryReset(g_config);
      sendResult(command.id, true);
      scheduleReboot(1500);
      break;
  }
}

void HubBleLink::sendResult(uint32_t id, bool ok, const char *error) {
  JsonDocument doc;
  doc["v"] = 1;
  doc["id"] = id;
  doc["ok"] = ok;
  if (!ok) doc["error"] = error ? error : "command failed";
  String out;
  serializeJson(doc, out);
#if defined(BUILD_DEV)
  Serial.printf("[HUB BLE][result] id=%lu ok=%u bytes=%u\n",
                (unsigned long)id, ok ? 1u : 0u, (unsigned)out.length());
#endif
  if (!_result) return;
  _result->setValue((const uint8_t *)out.c_str(), out.length());
  if (_clients) _result->notify();
}

void HubBleLink::sendConfig(uint32_t id, int32_t part, int32_t transfer) {
  JsonDocument doc;
  buildConfigJson(doc);
  String payload;
  serializeJson(doc, payload);
  sendPaged(id, HubBleTransfer::CONFIG, payload.c_str(), part, transfer);
}

void HubBleLink::sendDevices(uint32_t id, int32_t part, int32_t transfer) {
  JsonDocument doc;
  doc["scanning"] = bleScan.isScanning();
  JsonArray arr = doc["devices"].to<JsonArray>();
  const auto powerDevices = ble.getDevices();
  for (const auto &d : powerDevices) {
    JsonObject o = arr.add<JsonObject>();
    o["address"] = d.address;
    o["name"] = d.name;
    o["type"] = d.type;
    o["category"] = "power";
    o["rssi"] = d.rssi;
    o["connected"] = ble.isConnected() && strcmp(g_config.sourceAddr, d.address.c_str()) == 0;
  }
  const auto heartDevices = hrBle.getDevices();
  for (const auto &d : heartDevices) {
    JsonObject o = arr.add<JsonObject>();
    o["address"] = d.address;
    o["name"] = d.name;
    o["type"] = d.type;
    o["category"] = "hr";
    o["rssi"] = d.rssi;
    o["connected"] = hrBle.isConnected() && strcmp(g_config.hrSourceAddr, d.address.c_str()) == 0;
  }
  String payload;
  serializeJson(doc, payload);
  sendPaged(id, HubBleTransfer::DEVICES, payload.c_str(), part, transfer);
}

void HubBleLink::sendPaged(uint32_t id, HubBleTransfer::Kind kind, const char *payload,
                           int32_t part, int32_t transfer) {
  if (part < 0) {
    // Legacy burst (no page requested): store a fresh transfer and emit it whole.
    const HubBleTransfer::Status status = _transfer.begin(kind, payload, millis());
    if (status != HubBleTransfer::STATUS_OK) {
      sendResult(id, false, status == HubBleTransfer::STATUS_TOO_LARGE
                                 ? "payload too large" : "transfer state error");
      return;
    }
    for (uint16_t page = 0; page < _transfer.pages(kind); page++) {
      sendPage(id, kind, (int32_t)page, (int32_t)_transfer.token(kind));
    }
    return;
  }
  if (part == 0) {
    const HubBleTransfer::Status status = _transfer.begin(kind, payload, millis());
    if (status != HubBleTransfer::STATUS_OK) {
      sendResult(id, false, status == HubBleTransfer::STATUS_TOO_LARGE
                                 ? "payload too large" : "transfer state error");
      return;
    }
  }
  sendPage(id, kind, part, transfer);
}

void HubBleLink::sendPage(uint32_t id, HubBleTransfer::Kind kind, int32_t part,
                          int32_t transfer) {
  const char *chunk = nullptr;
  uint16_t length = 0;
  const HubBleTransfer::Status status =
      _transfer.page(kind, part, transfer, millis(), chunk, length);

  if (status != HubBleTransfer::STATUS_OK) {
    // Correlated, explicit error: the client learns WHICH transfer and page
    // failed, and the response still carries its request id.
    char message[64];
    const char *name = HubBleTransfer::kindName(kind);
    if (status == HubBleTransfer::STATUS_EXPIRED) {
      snprintf(message, sizeof(message), "%s transfer expired", name);
    } else if (status == HubBleTransfer::STATUS_INVALID_PAGE) {
      snprintf(message, sizeof(message), "%s transfer has no page %ld (of %u)",
               name, (long)part, (unsigned)_transfer.pages(kind));
    } else {
      snprintf(message, sizeof(message), "%s transfer too large", name);
    }
    sendResult(id, false, message);
    return;
  }

  JsonDocument doc;
  doc["v"] = 1;
  doc["id"] = id;
  doc["ok"] = true;
  doc["type"] = HubBleTransfer::kindName(kind);
  doc["part"] = part;
  doc["parts"] = _transfer.pages(kind);
  doc["t"] = _transfer.token(kind);
  doc["data"] = String(chunk).substring(0, length);
  String out;
  serializeJson(doc, out);
  if (!_result) return;
  _result->setValue((const uint8_t *)out.c_str(), out.length());
  if (_clients) _result->notify();
}

void HubBleLink::publishStatus(bool force) {
  const bool hr = (g_config.controlSource == SRC_HEART_RATE);

  JsonDocument doc;
  doc["source"] = hr ? "hr" : "power";
  doc["state"] = deviceStateName(g_tel.state);
  doc["connected"] = g_tel.connected;
  doc["data"] = g_tel.hasData;
  doc["sim"] = g_tel.simMode;
  doc["raw"] = (int)lroundf(hr ? g_tel.rawBpm : g_tel.rawPower);
  doc["value"] = (int)lroundf(hr ? g_tel.smoothedBpm : g_tel.smoothedPower);
  doc["zone"] = g_tel.zone;
  char hex[8];
  colorHex(hex, sizeof(hex), g_tel.r, g_tel.g, g_tel.b);
  doc["color"] = hex;

  String out;
  serializeJson(doc, out);
  if (!force && out == _previousStatus) return;
  _previousStatus = out;
  if (!_status) return;
  _status->setValue((const uint8_t *)out.c_str(), out.length());
  if (_clients) _status->notify();
}
