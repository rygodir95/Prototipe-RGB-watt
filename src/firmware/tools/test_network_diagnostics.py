"""Run the real sampler against a controlled TCP/IP mailbox and PCB lists."""
import os
from pathlib import Path
import subprocess
import tempfile

root = Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory(prefix='network-diagnostics-') as directory:
    temp = Path(directory)
    (temp / 'lwip/priv').mkdir(parents=True)
    (temp / 'lwip/tcpip.h').write_text('''#pragma once
using err_t=int;
constexpr int ERR_OK=0;
extern void (*queued)(void *);
extern bool reject;
inline int tcpip_try_callback(void (*fn)(void *), void *) {
  if(reject) return -1;
  queued=fn; return 0;
}
''')
    (temp / 'lwip/priv/tcp_priv.h').write_text('''#pragma once
enum {SYN_RCVD, ESTABLISHED, FIN_WAIT_1};
struct tcp_pcb {tcp_pcb *next=nullptr; int state=ESTABLISHED;
  unsigned nrtx=0; void *unacked=nullptr, *unsent=nullptr; unsigned rcv_wnd=100;};
extern tcp_pcb *tcp_active_pcbs, *tcp_tw_pcbs;
''')
    (temp / 'test.cpp').write_text('''#include "NetworkDiagnostics.h"
#include <lwip/priv/tcp_priv.h>
#include <cassert>
void (*queued)(void *)=nullptr;
bool reject=false;
tcp_pcb *tcp_active_pcbs=nullptr, *tcp_tw_pcbs=nullptr;
int main() {
  testMillis()=1000; serviceNetworkDiagnostics(); assert(queued);
  auto first=queued; queued=nullptr;
  testMillis()=2000; serviceNetworkDiagnostics(); assert(!queued);
  // No second sample can accumulate while TCP/IP is blocked.
  tcp_pcb a,b,c; a.next=&b; b.next=&c; a.state=SYN_RCVD;
  b.nrtx=3; b.unacked=&a; c.state=FIN_WAIT_1; c.rcv_wnd=0;
  tcp_active_pcbs=&a; first(nullptr);
  auto h=networkHealth(); assert(h.active==3 && h.synReceived==1);
  assert(h.established==1 && h.closing==1 && h.maxRetries==3);
  assert(h.retransmitting==1 && h.unacked==1 && h.zeroWindow==1);
  reject=true; testMillis()=3000; serviceNetworkDiagnostics();
  assert(networkHealth().sampleDrops==1);
  reject=false; testMillis()=4000; serviceNetworkDiagnostics(); assert(queued);
  tcp_active_pcbs=nullptr; queued(nullptr); assert(networkHealth().active==0);
  for(int i=0;i<10000;++i) {
    networkDispatch(12); networkRequestClosed(50);
    networkWebSocketEvent(true,false,false); networkWebSocketEvent(false,true,false);
  }
  h=networkHealth(); assert(h.wsActive==0 && h.wsOpened==10000 && h.wsClosed==10000);
  assert(h.dispatches==10000 && h.closed==10000 && h.dispatchMaxUs==12 && h.lifetimeMaxMs==50);
}
''')
    binary = temp / ('test.exe' if os.name == 'nt' else 'test')
    subprocess.run([os.environ.get('CXX', 'g++'), '-std=c++11', '-pthread', '-Wall', '-Wextra',
        '-I'+str(temp), '-I'+str(root/'tools/tests/led_pin'), '-I'+str(root/'include'),
        str(temp/'test.cpp'), str(root/'src/NetworkDiagnostics.cpp'), '-o', str(binary)], check=True)
    subprocess.run([str(binary)], check=True, timeout=10)
print('PASS: bounded TCP/IP sampling, failed enqueue recovery, PCB snapshots and connection counters')
