#pragma once
#include "RuntimeMetrics.h"

struct RuntimeHealth {
  uint32_t uptimeMs=0, freeHeap=0, minHeap=0, largestBlock=0, stackFree=0;
  uint32_t wifiEvents=0, lostEvents=0;
  int resetReason=0, wifiMode=0, wifiStatus=0;
};
void beginRuntimeDiagnostics();
void serviceRuntimeDiagnostics(); // loop task only; bounded serial writes
RuntimeHealth runtimeHealth();    // cached snapshot; no hardware work
const char *runtimeResetName(int reason);
