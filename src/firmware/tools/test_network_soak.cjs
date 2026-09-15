// Exercise the real hardware runner with deterministic transport failures.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const source=fs.readFileSync(require.resolve('./soak_network_hardware.cjs'),'utf8');
async function scenario(options={}) {
  let now=0,id=0,finished=false,result,error,saved,configAttempts=0;
  const timers=new Map(), patches=[], active=new Map();
  const later=(fn,ms)=>{const key=++id;timers.set(key,{at:now+ms,fn});return key;};
  const delay=ms=>new Promise(resolve=>later(resolve,ms));
  class Socket {
    constructor() {
      this.listeners={};this.closed=false;
      if(!options.neverOpen) later(()=>{
        this.emit('open');
        const frame=()=>{if(!this.closed){this.emit('message',{data:'{}'});later(frame,500);}};
        later(frame,500);
      },options.lateOpen?4500:10);
      if(options.disconnect) later(()=>this.close(),30000);
    }
    addEventListener(name,fn){(this.listeners[name]??=[]).push(fn);}
    emit(name,event={}){for(const fn of this.listeners[name]||[])fn(event);}
    close(){if(!this.closed){this.closed=true;this.emit('close');}}
  }
  const context={module:{exports:{}},URL,Date,WebSocket:Socket,
    AbortSignal:{timeout:()=>({})},setTimeout:later,clearTimeout:key=>timers.delete(key),
    console:{log:()=>{},error:()=>{}},
    require:name=>name==='node:fs'?{writeFileSync:(_,data)=>{saved=JSON.parse(data);}}:
      name==='node:perf_hooks'?{performance:{now:()=>now}}:require(name),
    fetch:async(url,init)=>{
      const path=url.pathname;
      // Verify full response-body consumption before reusing a worker.
      assert.equal(active.get(path)||0,0,'overlapping '+path);
      active.set(path,1);
      await delay(5);
      let body;
      if(path==='/api/config') {
        configAttempts++;
        if(options.setupAlwaysFails || (options.setupFailure && configAttempts===1)){
          active.set(path,0);throw Error('injected setup failure');
        }
        body={controlSource:'power',zones:[{min:0},{min:100}]};
      } else if(path==='/api/info') body={buildId:'test'};
      else if(path==='/api/diagnostics') body={uptimeMs:now+1000,wifiEvents:3,lostEvents:0};
      else if(path==='/api/simulation') {
        const patch=JSON.parse(init.body);patches.push(patch);
        if(options.cleanupFailure && patch.enabled===false){active.set(path,0);throw Error('injected cleanup failure');}
        body={ok:true};
      } else throw Error(path);
      return {ok:true,status:200,json:async()=>{await delay(20);active.set(path,0);return body;}};
    }};
  vm.runInNewContext(source,context);
  context.module.exports.run('http://192.168.4.1',120,'unused.json')
    .then(value=>{result=value;finished=true;},err=>{error=err;finished=true;});
  for(let steps=0;!finished && steps<10000;steps++) {
    await new Promise(setImmediate); // drain nested promise continuations
    if(finished)break;
    assert(timers.size,'runner deadlocked');
    const [key,timer]=[...timers].sort((a,b)=>a[1].at-b[1].at)[0];
    timers.delete(key);now=timer.at;timer.fn();
  }
  if(error)throw error;
  assert(finished && saved,'runner did not write its report');
  if(options.setupAlwaysFails) {
    assert.equal(configAttempts,8,'bound setup retries');
    assert.equal(patches.length,0,'unreachable device must not start simulation');
    return result;
  }
  assert.equal(patches.filter(p=>p.enabled===true).length,1,'enable only once');
  assert.equal(patches.at(-1).enabled,false,'disable on exit');
  assert(patches.filter(p=>'watts' in p).length>50);
  return result;
}
(async()=>{
  assert.equal((await scenario()).transportPassed,true);
  for(const options of [{lateOpen:true},{neverOpen:true},{disconnect:true},{setupFailure:true},{setupAlwaysFails:true},{cleanupFailure:true}]) {
    const result=await scenario(options);
    assert.equal(result.transportPassed,false,JSON.stringify(options));
  }
  console.log('PASS: 120s runner, serialized bodies, one enable, cleanup, late/missing WS, disconnect and setup failure accounting');
})().catch(error=>{console.error(error);process.exitCode=1;});
