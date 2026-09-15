// Optional real-device test (Node 22+): node tools/soak_demo_hardware.cjs http://HUB_IP
// Changes simulation only, for 120 seconds; always attempts to disable it on exit.
const assert = require('node:assert/strict');
const base = process.argv[2];
if (!base) throw new Error('Usage: node tools/soak_demo_hardware.cjs http://HUB_IP');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let socket, stopping = false, fault, frames = 0, reads = 0, updates = 0;
let lastFrame = Date.now(), maxConfigMs = 0;
async function request(path, patch) {
  try {
  const response = await fetch(new URL(path, base), {
    ...(patch ? {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(patch)} : {}),
    signal:AbortSignal.timeout(4000),
  });
  assert(response.ok, `HTTP ${response.status} on ${path}`);
  return await response.json();
  } catch(e) {throw new Error(`${path}: ${e.name}: ${e.message}`);}
}
(async () => {
  try {
    console.log("Starting physical Hub test",new Date().toISOString());
    const config = await request('/api/config');
    try {console.log("Diagnostics before",JSON.stringify(await request("/api/diagnostics")));} catch(_) {}
    const hr = config.controlSource === 'hr';
    const zones = hr ? config.hrZones : config.zones;
    const values = zones.map(z => z.min + (hr ? 3 : 10));
    const url = new URL('/ws', base); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    socket = new WebSocket(url);
    socket.addEventListener('message', event => {
      try { JSON.parse(event.data); frames++; lastFrame=Date.now(); }
      catch (e) { fault=e; }
    });
    socket.addEventListener('close', () => { if(!stopping) fault=new Error('WebSocket disconnected'); });
    socket.addEventListener('error', () => { fault=new Error('WebSocket error'); });
    await new Promise((resolve,reject) => {
      const timer=setTimeout(()=>reject(new Error('WebSocket open timeout')),4000);
      socket.addEventListener('open',()=>{clearTimeout(timer);lastFrame=Date.now();resolve();},{once:true});
    });
    assert.equal((await request('/api/simulation',{enabled:true})).ok,true);
    const end = Date.now()+120000;
    let lastProgress=Date.now();
    let complete=false;
    const polling=(async()=>{
      try {
        while(!complete) {
          const start=Date.now(); await request('/api/config'); reads++;
          maxConfigMs=Math.max(maxConfigMs,Date.now()-start);
          if(Date.now()-lastFrame>3000) throw new Error('WebSocket telemetry stalled >3s');
          await sleep(500);
        }
      } catch(e) {fault=e;}
    })();
    try {
      while(Date.now()<end) {
        if(fault) throw fault;
        assert.equal((await request('/api/simulation',{[hr?'bpm':'watts']:values[updates%values.length]})).ok,true);
        updates++;
        if(Date.now()-lastProgress>=20000) {
          console.log(`Progress: ${updates} updates, ${reads} config reads, ${frames} WS frames, max config ${maxConfigMs}ms`);
          lastProgress=Date.now();
        }
        await sleep(1500);
      }
    } finally {complete=true; await polling;}
    if(fault) throw fault;
    assert(frames>50 && reads>20 && updates>20);
    try {console.log("Diagnostics after",JSON.stringify(await request("/api/diagnostics")));} catch(_) {}
    console.log(`PASS: 120s hardware demo; ${updates} updates, ${reads} config reads (max ${maxConfigMs}ms), ${frames} WS frames; no reconnects`);
  } finally {
    stopping=true;
    try {await request('/api/simulation',{enabled:false});}
    catch(e) {console.error('Disable simulation failed:',e.message); process.exitCode=1;}
    finally {if(socket) socket.close();}
  }
})().catch(e=>{console.error(e);process.exitCode=1;});
