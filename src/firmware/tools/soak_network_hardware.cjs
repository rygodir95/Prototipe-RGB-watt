// Node 22+: node tools/soak_network_hardware.cjs http://192.168.4.1 120 report.json
// Repeat with 600 seconds. Fixed existing 4s timeout, 500ms config / 1500ms
// simulation rest, one in-flight request per worker, no automatic WS reconnect.
const fs = require('node:fs');
const {performance} = require('node:perf_hooks');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function statistics(values) {
  const sorted = [...values].sort((a,b)=>a-b);
  const percentile = p => sorted.length ? sorted[Math.ceil(p*sorted.length)-1] : null;
  return {count:sorted.length, p50:percentile(.5), p95:percentile(.95), p99:percentile(.99),
    max:sorted.at(-1) ?? null, mean:sorted.length ? sorted.reduce((a,b)=>a+b,0)/sorted.length : null};
}
async function run(base, seconds, output) {
  if(!base || !Number.isFinite(seconds) || seconds<120) throw Error('Specify URL and duration >=120 seconds');
  const result = {started:new Date().toISOString(), seconds, requests:{}, samples:[], failures:[],
    ws:{opened:0, closed:0, errors:0, frames:0, maxGapMs:0}, timeoutMs:4000};
  let socket, stopping=false, lastFrame, end, simulationTouched=false;
  async function request(path, patch) {
    const start=performance.now();
    const data=result.requests[path] ??= {latencies:[], failures:0};
    try {
      const response=await fetch(new URL(path,base), {
        ...(patch ? {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(patch)} : {}),
        signal:AbortSignal.timeout(4000),
      });
      if(!response.ok) throw Error(`HTTP ${response.status}`);
      const body=await response.json(); // latency includes full response consumption
      data.latencies.push(Math.round((performance.now()-start)*100)/100);
      return body;
    } catch(error) {
      data.failures++;
      result.failures.push({at:new Date().toISOString(),path,message:error.message});
      throw error;
    }
  }
  async function setupRequest(path) {
    // Permit a bounded setup retry so an already-failing device still gets a
    // full observation window. Every failed attempt remains in the report and
    // prevents a pass; the per-request timeout and load cadence are unchanged.
    for(let attempt=0;attempt<8;attempt++) {
      try {return await request(path);} catch(error) {
        if(attempt===7) throw error;
        await sleep(500);
      }
    }
  }
  try {
    result.info=await setupRequest('/api/info');
    const config=await setupRequest('/api/config');
    result.before=await setupRequest('/api/diagnostics');
    const hr=config.controlSource==='hr';
    const values=(hr?config.hrZones:config.zones).map(z=>z.min+(hr?3:10));
    if(!values.length) throw Error('No configured test zones');
    const url=new URL('/ws',base); url.protocol='ws:';
    socket=new WebSocket(url);
    socket.addEventListener('message',event=>{
      try {JSON.parse(event.data);} catch(error) {result.failures.push({path:'/ws',message:error.message});}
      const now=performance.now();
      if(lastFrame!==undefined) result.ws.maxGapMs=Math.max(result.ws.maxGapMs,now-lastFrame);
      lastFrame=now; result.ws.frames++;
    });
    socket.addEventListener('close',()=>{if(!stopping) result.ws.closed++;});
    socket.addEventListener('error',()=>{if(!stopping) result.ws.errors++;});
    await new Promise(resolve=>{
      const timer=setTimeout(()=>{
        result.failures.push({at:new Date().toISOString(),path:'/ws',message:'WebSocket open timeout'});
        resolve();
      },4000);
      socket.addEventListener('open',()=>{
        clearTimeout(timer); result.ws.opened++; lastFrame=performance.now(); resolve();
      },{once:true});
    });
    // Continue recording all failures instead of abandoning the run at the first
    // lost connection. No reconnect hides whether the original socket survived.
    simulationTouched=true;
    try {await request('/api/simulation',{enabled:true});} catch(_) {}
    end=performance.now()+seconds*1000;
    const worker=async(period,fn)=>{
      while(performance.now()<end) {
        try {await fn();} catch(_) {}
        await sleep(Math.min(period,Math.max(0,end-performance.now())));
      }
    };
    let index=0;
    await Promise.all([
      worker(500,()=>request('/api/config')),
      worker(1500,async()=>{
        const reply=await request('/api/simulation',{[hr?'bpm':'watts']:values[index++%values.length]});
        if(reply.ok!==true) result.failures.push({path:'/api/simulation',message:'Update rejected'});
      }),
      worker(10000,async()=>{
        result.samples.push(await request('/api/diagnostics'));
        console.log(JSON.stringify({remainingSeconds:Math.ceil((end-performance.now())/1000),
          frames:result.ws.frames, failures:result.failures.length, health:result.samples.at(-1)}));
      }),
    ]);
    if(lastFrame!==undefined) result.ws.maxGapMs=Math.max(result.ws.maxGapMs,performance.now()-lastFrame);
    result.after=await request('/api/diagnostics');
    const healthStable=result.after.uptimeMs>=result.before.uptimeMs &&
      result.after.wifiEvents===result.before.wifiEvents && result.after.lostEvents===result.before.lostEvents;
    result.transportPassed=result.failures.length===0 && result.ws.opened===1 &&
      result.ws.closed===0 && result.ws.errors===0 && result.ws.frames>0 && result.ws.maxGapMs<3000 && healthStable;
    // Resource trends require inspecting the saved time series, not just endpoint
    // heap values. Never claim the full hardware acceptance test from HTTP alone.
    result.resourceReviewRequired=true;
  } catch(error) {
    result.fatal=error.message; result.transportPassed=false;
  } finally {
    stopping=true;
    if(simulationTouched) {
      try {await request('/api/simulation',{enabled:false});}
      catch(error) {result.cleanupError=error.message; result.transportPassed=false;}
    }
    socket?.close();
    for(const data of Object.values(result.requests)) data.statistics=statistics(data.latencies);
    fs.writeFileSync(output,JSON.stringify(result,null,2));
    console.log(JSON.stringify({transportPassed:result.transportPassed,ws:result.ws,
      requests:Object.fromEntries(Object.entries(result.requests).map(([path,d])=>[path,{...d.statistics,failures:d.failures}])),output},null,2));
  }
  return result;
}
module.exports={statistics,run};
if(require.main===module) run(process.argv[2],Number(process.argv[3]||120),process.argv[4]||'network-soak.json')
  .then(result=>{if(!result.transportPassed) process.exitCode=1;})
  .catch(error=>{console.error(error);process.exitCode=1;});
