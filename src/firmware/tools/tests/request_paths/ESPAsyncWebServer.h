#pragma once
#include <string>
#include <cassert>
void trackedFree(void *p);
using String = std::string;
struct AsyncWebServerRequest {
  void *_tempObject = nullptr;
  int status = 0;
  std::string body;
  ~AsyncWebServerRequest() { trackedFree(_tempObject); }
  void *getResponse() { return status ? this : nullptr; }
  void send(int code, const char *, const std::string &value) {
    assert(!status); status = code; body = value;
  }
};
