#include <cassert>
#include <cstdlib>
#include <cstring>
#include <functional>
#include <future>
#include <iostream>
#include <map>
#include <thread>
#include <vector>
#include <ArduinoJson.h>
#include <ESPAsyncWebServer.h>
#include "Config.h"
#include "LedPinConfig.h"
#include "DeferredConfig.h"
#include "Simulation.h"
#include "WebInterface.h"
#include "AppState.h"
#include "WebCommands.h"

std::map<void *, size_t> allocations;
bool failAllocation = false;
void *trackedMalloc(size_t size) {
  if (failAllocation) return nullptr;
  void *p = std::malloc(size); assert(p); allocations[p] = size; return p;
}
void trackedFree(void *p) {
  if (!p) return;
  assert(allocations.count(p));
  std::memset(p, 0xDD, allocations[p]); // Parsed strings must outlive the body.
  allocations.erase(p); std::free(p);
}
#define malloc trackedMalloc
#define free trackedFree
#include "JsonPostBody.h"
#undef malloc
#undef free

Telemetry g_tel;
const char *deviceStateName(DeviceState) { return "TEST"; }
struct TestWebSocket {
  bool writable=true;
  int frames=0, cleanups=0;
  size_t count() { return 1; }
  bool availableForWriteAll() { return writable; }
  void textAll(const std::string &body) {
    assert(writable);
    JsonDocument doc; assert(!deserializeJson(doc,body)); ++frames;
  }
  void cleanupClients() { ++cleanups; }
} ws;
TestSerial Serial;
Simulation sim;
bool g_logEnabled = true;
thread_local bool inRequest = false;
int runtimeCalls = 0, saves = 0;
std::function<void()> blockWork;
std::function<void()> blockStorage;
AppConfig saved{};
struct Processor {
  void setSmoothing(int) { assert(!inRequest); ++runtimeCalls; if(blockWork) blockWork(); }
} processor;
struct LocalLed {
  void reconfigure(int, int, int) { assert(!inRequest); }
} localLed;
struct Lighting {
  void applyConfig(int, int) { assert(!inRequest); }
} lighting;
int commandCalls=0;
struct Device { std::string address; };
struct Ble {
  std::vector<Device> getDevices() { return {}; }
  void connectToAddress(const char *, const char *) { assert(!inRequest); ++commandCalls; }
  void disconnect() { assert(!inRequest); ++commandCalls; }
  void forget() { assert(!inRequest); ++commandCalls; }
  void setAutoReconnect(bool) { assert(!inRequest); }
} ble, hrBle;
struct Scan { void startScan(int) { assert(!inRequest); ++commandCalls; } } bleScan;
void setControlSource(uint8_t src, bool) { assert(!inRequest); g_config.controlSource=src; }
void scheduleReboot(uint32_t) { assert(!inRequest); ++commandCalls; }
struct Storage {
  void factoryReset(AppConfig &config) { assert(!inRequest); configLoadDefaults(config); ++commandCalls; }
  void save(const AppConfig &config) {
    assert(!inRequest); if(blockStorage) blockStorage(); saved=config; ++saves;
  }
} storage;
using Handler = std::function<void(AsyncWebServerRequest *, JsonDocument &)>;
std::map<std::string, Handler> handlers;
void attachJsonPost(const char *path, Handler handler) { handlers[path]=handler; }
constexpr int HTTP_POST=1;
struct Server {
  void on(const char *path,int,std::function<void(AsyncWebServerRequest *)> handler) {
    handlers[path]=[handler](AsyncWebServerRequest *req,JsonDocument &) {handler(req);};
  }
} server;
#include "production.h"

void post(const char *path, const std::string &body) {
  AsyncWebServerRequest req;
  inRequest=true;
  for(size_t i=0;i<body.size();i+=7) {
    receiveJsonBody(&req, reinterpret_cast<const uint8_t *>(body.data()+i),
                    std::min(size_t(7),body.size()-i),i,body.size(),handlers.at(path));
  }
  inRequest=false;
  assert(req.status==200 && req._tempObject==nullptr && allocations.empty());
  if(std::string(path)=="/api/config") {
    JsonDocument reply; assert(!deserializeJson(reply,req.body));
    assert(reply["ledCount"].as<int>()==g_config.ledCount);
    assert(reply["theme"].as<std::string>()==g_config.theme);
  }
}

int main() {
  WebCommands commands;
  for(int i=0;i<8;++i) { WebCommand c; c.address[0]=static_cast<char>(i); assert(commands.push(c)); }
  assert(!commands.push(WebCommand{})); // Backpressure instead of an unbounded queue.
  for(int i=0;i<8;++i) { WebCommand c; assert(commands.take(c)); assert(c.address[0]==i); }
  WebCommand empty; assert(!commands.take(empty));
  configLoadDefaults(g_config); registerRoutes();
  post("/api/config", R"({"ledCount":100,"theme":"light"})");
  assert(runtimeCalls==0 && saves==0 && std::string(g_config.theme)=="light");
  // Hold loop hardware work indefinitely; HTTP callbacks must still complete.
  std::promise<void> entered, release;
  auto released=release.get_future();
  blockWork=[&] { entered.set_value(); released.wait(); };
  std::thread loop([] { servicePendingConfig(); });
  entered.get_future().wait();
  for(int i=0;i<1000;++i) {
    post("/api/config", "{\"ledCount\":"+std::to_string(20+i%50)+",\"brightness\":75}");
    post("/api/simulation", "{\"enabled\":true,\"watts\":"+std::to_string(i)+"}");
    post("/api/simulation", R"({"enabled":false})");
    assert(!sim.snapshot().enabled && sim.snapshot().watts==i);
  }
  release.set_value(); loop.join(); blockWork=nullptr;
  assert(saves==1 && saved.ledCount==100);
  servicePendingConfig();
  assert(saves==2 && saved.ledCount==69 && saved.brightness==75);
  servicePendingConfig(); assert(saves==2); // No redundant flash writes.
  post("/api/config", R"({"ledCount":40})");
  std::promise<void> storageEntered, storageRelease;
  auto storageReleased=storageRelease.get_future();
  blockStorage=[&] { storageEntered.set_value(); storageReleased.wait(); };
  std::thread saving([] { servicePendingConfig(); });
  storageEntered.get_future().wait();
  for(int i=0;i<1000;++i) {
    post("/api/config", "{\"ledCount\":"+std::to_string(50+i%50)+"}");
    post("/api/simulation", R"({"enabled":true,"watts":250})");
  }
  storageRelease.set_value(); saving.join(); blockStorage=nullptr;
  assert(saved.ledCount==40);
  servicePendingConfig(); assert(saved.ledCount==99 && saves==4);
  post("/api/config", R"({"ledPin":255,"ledCount":10000})");
  assert(g_config.ledPin==5 && g_config.ledCount==1000);
  servicePendingConfig();
  // Two minutes of loop time: real request handlers and telemetry scheduling.
  WebInterface web;
  const uint32_t started=millis();
  for(uint32_t elapsed=0;elapsed<=120000;elapsed+=20) {
    testMillis()=started+elapsed;
    if(elapsed%1200==0) post("/api/simulation", "{\"enabled\":true,\"watts\":"+std::to_string(elapsed%500)+"}");
    if(elapsed%1000==0) {
      JsonDocument reply; buildConfigJson(reply); // Same GET /api/config builder.
      assert(reply["ledCount"].as<int>()==g_config.ledCount);
    }
    // A slow browser stops reading for ten seconds; telemetry must be dropped.
    ws.writable=elapsed<30000 || elapsed>=40000;
    web.loop();
  }
  // 1.5 s unchanged-state heartbeat, minus the simulated ten-second slow
  // reader period below.
  assert(ws.frames>=72 && ws.frames<=74 && ws.cleanups==60);
  // An unchanged state still receives a 1.5 s heartbeat, leaving margin for
  // normal Wi-Fi jitter below the physical-soak 3 s silence limit.
  const int heartbeatFrames=ws.frames;
  testMillis()+=400; web.loop(); assert(ws.frames==heartbeatFrames);
  testMillis()+=500; web.loop(); assert(ws.frames==heartbeatFrames+1);
  const int callsBefore=commandCalls;
  for(const char *path : {"/api/scan","/api/disconnect","/api/forget","/api/factory-reset"}) post(path,"{}");
  post("/api/connect",R"({"address":"AA:BB:CC:DD:EE:FF","name":"Test HR","category":"hr"})");
  post("/api/wifi",R"({"ssid":"test","pass":"test"})");
  assert(commandCalls==callsBefore); // Real route callbacks only store commands.
  for(int i=0;i<6;++i) serviceWebCommand();
  assert(commandCalls>callsBefore);
  assert(std::string(g_config.hrSourceAddr)=="AA:BB:CC:DD:EE:FF");
  const auto handler=handlers.at("/api/config");
  const uint8_t data[]={'{','}'};
  for(int i=0;i<1000;++i) {
    { AsyncWebServerRequest req; receiveJsonBody(&req,data,1,0,200,handler);
      assert(!req.status && allocations.size()==1); }
    assert(allocations.empty()); // Server disconnect cleanup frees whole upload.
  }
  { AsyncWebServerRequest req; receiveJsonBody(&req,data,1,0,200,handler);
    receiveJsonBody(&req,data,1,20,200,handler); assert(req.status==400); }
  { AsyncWebServerRequest req; receiveJsonBody(&req,data,1,0,1,handler); assert(req.status==400); }
  { AsyncWebServerRequest req; receiveJsonBody(&req,data,2,0,20000,handler); assert(req.status==413);
    receiveJsonBody(&req,data,2,2,20000,handler); }
  { AsyncWebServerRequest req; failAllocation=true;
    receiveJsonBody(&req,data,2,0,2,handler); assert(req.status==503); failAllocation=false; }
  assert(allocations.empty());
  std::cout << "PASS: 2000 config saves and 3000 Lighting Test calls during blocked runtime/NVS work; 120s simulated config/telemetry service with slow-client backpressure; upload cleanup/errors\n";
}
