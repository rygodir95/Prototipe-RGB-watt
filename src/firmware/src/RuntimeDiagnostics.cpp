#include "RuntimeDiagnostics.h"
#include <WiFi.h>
#include <esp_system.h>
#include <esp_heap_caps.h>

namespace {
struct Event { uint32_t at=0; int id=0, reason=0; };
struct Events { Event items[16]; uint8_t head=0, size=0; uint32_t seen=0, lost=0; };
LightingMailbox<Events> events;
LightingMailbox<RuntimeHealth> health;
char output[1024];
size_t pending=0, offset=0;
uint32_t lastReport=0;
}

const char *runtimeResetName(int reason) {
  switch(reason) {
    case ESP_RST_POWERON: return "POWER_ON";
    case ESP_RST_EXT: return "EXTERNAL";
    case ESP_RST_SW: return "SOFTWARE";
    case ESP_RST_PANIC: return "PANIC";
    case ESP_RST_INT_WDT: return "INTERRUPT_WATCHDOG";
    case ESP_RST_TASK_WDT: return "TASK_WATCHDOG";
    case ESP_RST_WDT: return "WATCHDOG";
    case ESP_RST_DEEPSLEEP: return "DEEP_SLEEP";
    case ESP_RST_BROWNOUT: return "BROWNOUT";
    case ESP_RST_SDIO: return "SDIO";
    default: return "UNKNOWN";
  }
}
RuntimeHealth runtimeHealth() { return health.read(); }

void beginRuntimeDiagnostics() {
  const int reason=esp_reset_reason();
  health.access([&](RuntimeHealth &h) { h.resetReason=reason; });
  Serial.printf("[RESET] reason=%s code=%d heap=%u min=%u\n", runtimeResetName(reason), reason,
                ESP.getFreeHeap(), ESP.getMinFreeHeap());
  WiFi.onEvent([](WiFiEvent_t id, WiFiEventInfo_t info) {
    switch(id) {
      case ARDUINO_EVENT_WIFI_STA_START: case ARDUINO_EVENT_WIFI_STA_STOP:
      case ARDUINO_EVENT_WIFI_STA_CONNECTED: case ARDUINO_EVENT_WIFI_STA_DISCONNECTED:
      case ARDUINO_EVENT_WIFI_STA_GOT_IP: case ARDUINO_EVENT_WIFI_STA_LOST_IP:
      case ARDUINO_EVENT_WIFI_AP_START: case ARDUINO_EVENT_WIFI_AP_STOP:
      case ARDUINO_EVENT_WIFI_AP_STACONNECTED: case ARDUINO_EVENT_WIFI_AP_STADISCONNECTED:
      case ARDUINO_EVENT_WIFI_AP_STAIPASSIGNED: break;
      default: return;
    }
    Event e; e.at=millis(); e.id=id;
    if(id==ARDUINO_EVENT_WIFI_STA_DISCONNECTED) e.reason=info.wifi_sta_disconnected.reason;
    // Wi-Fi task only copies a bounded record. Serial/logging belongs to loop().
    events.access([&](Events &q) {
      ++q.seen;
      if(q.size==16) { ++q.lost; return; }
      q.items[(q.head+q.size)%16]=e; ++q.size;
    });
  });
}

void serviceRuntimeDiagnostics() {
  // Never wait for the USB/UART consumer, including when it is disconnected.
  if(offset<pending) {
    const int room=Serial.availableForWrite();
    if(room>0) offset+=Serial.write(reinterpret_cast<const uint8_t *>(output+offset),
                                  min(static_cast<size_t>(room), pending-offset));
    return;
  }
  Event event; bool found=false;
  events.access([&](Events &q) {
    if(q.size) { event=q.items[q.head]; q.head=(q.head+1)%16; --q.size; found=true; }
  });
  if(found) {
    pending=snprintf(output,sizeof(output),"[WIFI] at=%lu event=%s id=%d disconnect_reason=%d\n",
                     static_cast<unsigned long>(event.at),WiFi.eventName(static_cast<WiFiEvent_t>(event.id)),event.id,event.reason);
    offset=0; return;
  }
  const uint32_t now=millis();
  if(now-lastReport<10000) return;
  lastReport=now;
  RuntimeHealth h=health.read(); h.uptimeMs=now;
  h.freeHeap=ESP.getFreeHeap(); h.minHeap=ESP.getMinFreeHeap();
  h.largestBlock=heap_caps_get_largest_free_block(MALLOC_CAP_8BIT);
  h.stackFree=uxTaskGetStackHighWaterMark(nullptr);
  h.wifiMode=WiFi.getMode(); h.wifiStatus=WiFi.status();
  events.access([&](Events &q) { h.wifiEvents=q.seen; h.lostEvents=q.lost; });
  health.access([&](RuntimeHealth &current) { current=h; });
  const auto m=Runtime::snapshot();
  pending=snprintf(output,sizeof(output),
    "[PERF] up_ms=%lu heap=%lu min=%lu largest=%lu stack=%lu wifi=%d/%d events=%lu lost=%lu "
    "loop_max_us=%lu web_max_us=%lu show=%lu/%luus rebuild=%lu/%luus config=%lu/%luus "
    "json=%lu/%luus sim=%lu/%luus getcfg=%lu/%luus ws=%lu skip=%lu wrong_led_task=%lu\n",
    (unsigned long)h.uptimeMs,(unsigned long)h.freeHeap,(unsigned long)h.minHeap,(unsigned long)h.largestBlock,
    (unsigned long)h.stackFree,h.wifiMode,h.wifiStatus,(unsigned long)h.wifiEvents,(unsigned long)h.lostEvents,
    (unsigned long)m.values[Runtime::Loop].maxUs,(unsigned long)m.values[Runtime::Web].maxUs,
    (unsigned long)m.values[Runtime::LedShow].calls,(unsigned long)m.values[Runtime::LedShow].maxUs,
    (unsigned long)m.values[Runtime::LedRebuild].calls,(unsigned long)m.values[Runtime::LedRebuild].maxUs,
    (unsigned long)m.values[Runtime::ConfigApply].calls,(unsigned long)m.values[Runtime::ConfigApply].maxUs,
    (unsigned long)m.values[Runtime::JsonRequest].calls,(unsigned long)m.values[Runtime::JsonRequest].maxUs,
    (unsigned long)m.values[Runtime::SimulationRequest].calls,(unsigned long)m.values[Runtime::SimulationRequest].maxUs,
    (unsigned long)m.values[Runtime::ConfigRead].calls,(unsigned long)m.values[Runtime::ConfigRead].maxUs,
    (unsigned long)m.values[Runtime::WsSent].calls,(unsigned long)m.values[Runtime::WsSkipped].calls,
    (unsigned long)m.values[Runtime::WrongLedTask].calls);
  pending=min(pending,sizeof(output)-1); offset=0;
}
