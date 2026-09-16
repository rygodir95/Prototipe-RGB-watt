#include <cassert>
#include <iostream>
#include <thread>
#include "Config.h"
#include "Simulation.h"
#include "RuntimeMetrics.h"
#include "LocalLedOutput.h"
#include "LightingOutputManager.h"
#include <ArduinoJson.h>
TestSerial Serial;
std::vector<int> driverPins;
AppConfig g_config{};
Simulation sim;
struct AsyncWebServerRequest {
  int replies = 0;
  void send(int code, const char *mime, const char *body) {
    assert(code == 200 && std::string(mime) == "application/json");
    assert(std::string(body) == "{\"ok\":true}"); ++replies;
  }
};
std::function<void(AsyncWebServerRequest*,JsonDocument&)> simulationHandler;
void attachJsonPost(const char *path, decltype(simulationHandler) handler) {
  assert(std::string(path) == "/api/simulation"); simulationHandler = handler;
}
#include "simulation_route.h"

int main() {
  // Two minutes of animated rendering: bounded duty cycle even at 1000 pixels.
  {
    LEDController animated;
    animated.begin(5,1000,1,100); animated.setEffect(1);
    animated.setColor(255,0,0); animated.setActive(true);
    const auto before=Runtime::snapshot().values[Runtime::LedShow].calls;
    for(int i=0;i<120000;i+=2) { testMillis()+=2; animated.update(); }
    const auto frames=Runtime::snapshot().values[Runtime::LedShow].calls-before;
    assert(frames>=1490 && frames<=1500); // 40ms wire time, >=80ms frame period.
    animated.setActive(false);
    testMillis()+=1000; animated.update();
    const auto black=Runtime::snapshot().values[Runtime::LedShow].calls;
    for(int i=0;i<1000;++i) { testMillis()+=40; animated.update(); }
    assert(Runtime::snapshot().values[Runtime::LedShow].calls==black);
  }
  LEDController led;
  assert(led.begin(5, 100, 0, 100));
  led.setColor(255, 0, 0); led.setActive(true);
  testMillis() += 1000; led.update();
  assert(physicalLeds()[5][99] != 0);
  stripEvents().clear();
  led.reconfigure(5, 20, 0);
  assert(stripEvents().size() == 3);
  assert(stripEvents()[0].op == "show" && stripEvents()[0].count == 100);
  assert(stripEvents()[1].op == "delete" && stripEvents()[1].count == 100);
  assert(stripEvents()[2].op == "show" && stripEvents()[2].count == 20);
  for (auto c : physicalLeds()[5]) assert(c == 0);
  testMillis() += 1000; led.update();
  for (int i=20;i<100;++i) assert(physicalLeds()[5][i] == 0);
  size_t frames = stripEvents().size();
  for (int i=0;i<100;++i) { testMillis() += 20; led.update(); }
  assert(stripEvents().size() == frames); // Stable solid frame is not resent.
  stripEvents().clear(); led.reconfigure(5, 60, 0);
  assert(stripEvents()[0].op == "delete"); // Increasing retains rebuild behavior.
  stripEvents().clear(); led.reconfigure(18, 60, 1);
  assert(stripEvents()[0].op == "delete" && driverPins.back() == 18);

  LocalLedOutput output;
  assert(output.begin(5, 100, 0, 100));
  LightingOutputManager manager;
  assert(manager.registerOutput(&output));
  LightingState state{}; state.active=true; state.brightness=100; state.r=255;
  output.apply(state); testMillis()+=1000; output.update();
  registerSimulationRoute();
  AsyncWebServerRequest request;
  for (int i=0;i<1000;++i) {
    const size_t before=stripEvents().size();
    JsonDocument doc; doc["enabled"]=true; doc["watts"]=i;
    simulationHandler(&request,doc);
    assert(sim.snapshot().enabled && sim.snapshot().watts == i);
    output.reconfigure(5, 20 + i%10, 0); manager.applyState(state); manager.applyConfig(100, 0);
    assert(stripEvents().size()==before); // HTTP / pending config never touches hardware.
  }
  assert(request.replies==1000);
  JsonDocument test; test["enabled"]=true; test["lightingTest"]=true;
  simulationHandler(&request,test);
  assert(sim.snapshot().lightingTest);
  JsonDocument point; point["watts"]=225;
  simulationHandler(&request,point);
  assert(sim.snapshot().lightingTest && sim.watts()==225);
  JsonDocument ordinary; ordinary["enabled"]=true; ordinary["watts"]=999;
  simulationHandler(&request,ordinary);
  assert(!sim.snapshot().lightingTest);
  bool called=false;
  showHook() = [&] {
    if (called) return;
    called=true;
    JsonDocument stop; stop["enabled"]=false;
    simulationHandler(&request,stop);
    output.reconfigure(5, 12, 0); // Arrives during OLD-strip show, no lock/deletion/reentry.
  };
  testMillis()+=1000; output.update();
  assert(called && !sim.enabled());
  showHook() = nullptr;
  testMillis()+=1000; output.update();
  assert(stripEvents().back().count==12);
  for (int i=12;i<100;++i) assert(physicalLeds()[5][i]==0);
  g_config.controlSource=SRC_HEART_RATE;
  JsonDocument hr; hr["enabled"]=true; hr["bpm"]=150;
  simulationHandler(&request,hr);
  assert(sim.enabled() && sim.bpm()==150 && sim.watts()==999);
  JsonDocument stop; stop["enabled"]=false;
  simulationHandler(&request,stop);
  assert(!sim.enabled() && sim.bpm()==150);
  for (int i=0;i<100;++i) {
    const size_t before=stripEvents().size();
    simulationHandler(&request,hr);
    assert(sim.enabled());
    simulationHandler(&request,stop);
    assert(!sim.enabled());
    manager.clearActive();
    assert(stripEvents().size()==before);
  }
  // Coherent value+enabled publication while the pipeline snapshots on another task.
  sim.set(false,0);
  std::thread writer([] { for(int i=0;i<10000;++i) { sim.set(true,42); sim.set(false,0); } });
  for(int i=0;i<10000;++i) { auto s=sim.snapshot(); assert(s.watts==(s.enabled?42:0)); }
  writer.join();
  std::cout << "Lighting regressions passed: old-strip blackout, deferred rebuild, repeated simulation, coherent snapshots\n";
}
