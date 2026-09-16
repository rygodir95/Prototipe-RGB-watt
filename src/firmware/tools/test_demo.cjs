// Production demo code, virtual clock, and slow/failing HTTP response bodies.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const app = fs.readFileSync(path.join(__dirname, '../data/web/app.js'), 'utf8');
const source = app.slice(app.indexOf('const DEMO_STEP_MS'), app.indexOf('// ---------------- Configuration backup'));

function fixture() {
  let now = 0, id = 0, active = 0, maxActive = 0, mode = 'slow';
  const timers = new Map(), calls = [], messages = [], banner = {hidden:true};
  function setTimeout(fn, delay) { timers.set(++id, {at:now+delay, fn}); return id; }
  function clearTimeout(key) { timers.delete(key); }
  const context = vm.createContext({
    setTimeout, clearTimeout, AbortController,
    config:{zoneCount:5,zones:[{min:0},{min:100},{min:200},{min:300},{min:400}]}, isHrMode:()=>false,
    $:()=>banner, toast:s=>messages.push(s), window:{addEventListener(){}},
    fetch: (url, options) => {
      assert.equal(url, '/api/simulation');
      active++; maxActive=Math.max(maxActive,active);
      const call={start:now, patch:JSON.parse(options.body)}; calls.push(call);
      return new Promise((resolve, reject) => {
        let finished=false;
        const finish=()=>{ if(!finished) {finished=true; active--; call.end=now;} };
        let rejectBody;
        const abort=()=>{finish(); const e=new Error('aborted'); reject(e); if(rejectBody) rejectBody(e);};
        options.signal.addEventListener('abort',abort,{once:true});
        const selected=mode;
        if(selected==='hang') return;
        setTimeout(()=>{
          if(finished) return;
          if(selected==='network') {finish(); reject(new Error('empty response')); return;}
          resolve({ok:selected!=='http', json:()=>new Promise((res,rej)=>{
            rejectBody=rej;
            if(selected==='bodyhang') return;
            setTimeout(()=>{if(finished) return; finish(); res({ok:selected!=='http'});}, selected==='slow'?1800:10);
          })});
        },50);
      });
    },
  });
  vm.runInContext(source,context);
  async function flush() { for(let n=0;n<30;n++) await Promise.resolve(); }
  async function advance(ms) {
    const end=now+ms; await flush();
    while(true) {
      const next=[...timers].filter(([,t])=>t.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];
      if(!next) break;
      now=next[1].at; timers.delete(next[0]); next[1].fn(); await flush();
    }
    now=end; await flush();
  }
  return {advance,calls,messages,banner,run:s=>vm.runInContext(s,context),
    setMode:s=>mode=s, maxActive:()=>maxActive, active:()=>active};
}

(async()=>{
  const f=fixture(); f.run('void startDemo(100)'); f.run('void startDemo(100)');
  await f.advance(100);
  for(let i=0;i<100;i++) f.run('void demoTick()');
  assert.equal(f.calls.length,1); // No reentrant requests while enable body is pending.
  await f.advance(120000); // Two minutes, body transfer slower than old interval.
  assert(f.calls.length>30); assert.equal(f.maxActive(),1);
  assert.equal(f.calls[0].patch.lightingTest,true);
  assert.equal(f.calls[0].patch.watts,20);
  const values=f.calls.filter(c=>'watts' in c.patch);
  for(let i=1;i<values.length;i++) assert(values[i].start-values[i-1].end>=1500);
  f.run('void stopDemo()'); f.run('void stopDemo()'); f.run('void startDemo(100)');
  await f.advance(10000);
  assert.equal(f.calls.at(-1).patch.enabled,false); assert.equal(f.active(),0);
  assert.equal(f.banner.hidden,true);
  const count=f.calls.length; await f.advance(120000); assert.equal(f.calls.length,count);
  for(const mode of ['network','http','hang','bodyhang']) {
    const broken=fixture(); broken.setMode(mode); broken.run('void startDemo(100)');
    await broken.advance(20000);
    assert.equal(broken.active(),0); assert.equal(broken.maxActive(),1);
    assert.equal(broken.banner.hidden,true); assert(broken.messages.length);
    const n=broken.calls.length; await broken.advance(10000); assert.equal(broken.calls.length,n);
    const midRun=fixture(); midRun.setMode('fast'); midRun.run('void startDemo(100)');
    await midRun.advance(500); midRun.setMode(mode);
    await midRun.advance(20000);
    assert.equal(midRun.active(),0); assert.equal(midRun.maxActive(),1);
    assert.equal(midRun.banner.hidden,true); assert(midRun.messages.length);
    const stopped=midRun.calls.length; await midRun.advance(10000); assert.equal(midRun.calls.length,stopped);
  }
  const finite=fixture(); finite.setMode('fast'); finite.run('void startDemo(1)');
  await finite.advance(50000);
  assert.equal(finite.calls.filter(c=>'watts' in c.patch).length,27);
  assert.equal(finite.calls.at(-1).patch.enabled,false);
  const stopping=fixture(); stopping.run('void startDemo(100)');
  stopping.run('void stopDemo()'); stopping.run('void startDemo(100)');
  await stopping.advance(20000);
  assert.equal(stopping.maxActive(),1);
  assert.equal(stopping.calls.length,2); // enable then disable, no late restart.
  assert.equal(stopping.calls.at(-1).patch.enabled,false);
  console.log('PASS: 120s sustained demo, single in-flight body, minimum rest, double start/stop, timeout/HTTP/network failures, no orphan timers');
})().catch(e=>{console.error(e);process.exitCode=1;});
