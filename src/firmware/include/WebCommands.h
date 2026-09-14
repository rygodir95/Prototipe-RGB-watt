#pragma once
#include "LightingMailbox.h"
enum class WebCommandType { Scan, Connect, Disconnect, Forget, SaveWifi, FactoryReset };
struct WebCommand {
  WebCommandType type=WebCommandType::Scan;
  char address[40]={0}, name[40]={0}, category[8]={0};
};
class WebCommands {
public:
  bool push(const WebCommand &command) {
    bool accepted=false;
    _queue.access([&](Queue &q) {
      if(q.size==8) return;
      q.items[(q.head+q.size)%8]=command; ++q.size; accepted=true;
    });
    return accepted;
  }
  bool take(WebCommand &command) {
    bool found=false;
    _queue.access([&](Queue &q) {
      if(!q.size) return;
      command=q.items[q.head]; q.head=(q.head+1)%8; --q.size; found=true;
    });
    return found;
  }
private:
  struct Queue { WebCommand items[8]; uint8_t head=0, size=0; };
  LightingMailbox<Queue> _queue;
};
