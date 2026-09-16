"""Run the browser's diagnostic points through the real firmware zone/EMA code."""
import json
import os
from pathlib import Path
import subprocess
import tempfile

root = Path(__file__).resolve().parents[1]
app = root / 'data/web/app.js'
# Nonuniform, customized boundaries; extra saved Power entries must be ignored.
power = [0, 83, 157, 214, 289, 361, 477]
hr = [70, 103, 129, 154, 178]
js = r"""
const fs=require('fs'),vm=require('vm');
const app=fs.readFileSync(process.argv[1],'utf8');
const ctx=vm.createContext({config:JSON.parse(process.argv[2]),isHrMode:()=>process.argv[3]==='hr'});
vm.runInContext(app.slice(app.indexOf('function demoSequence()'),app.indexOf('async function startDemo')),ctx);
console.log(JSON.stringify(vm.runInContext('demoSequence()',ctx)));
"""
cases = []
for is_hr, count in [(False, 5), (False, 6), (False, 7), (True, 5)]:
    cfg = dict(zoneCount=count, zones=[dict(min=x) for x in power],
               hrZones=[dict(min=x) for x in hr], hrMax=201)
    seq = json.loads(subprocess.check_output(['node', '-e', js, str(app),
                    json.dumps(cfg), 'hr' if is_hr else 'power'], text=True))
    bounds = hr if is_hr else power[:count]
    assert len(seq) == count * 3 + 1
    for i in range(count if is_hr else count - 1):
        lo, hi = bounds[i], (bounds[i+1] if i+1 < count else cfg['hrMax'])
        for j, t in enumerate([.2, .5, .8]):
            assert abs(seq[i*3+j] - (lo+(hi-lo)*t)) < 1e-6
    assert seq[-1] == seq[0]
    cases.append((is_hr, count, seq))

main = (root/'src/main.cpp').read_text()
# Exercise the exact selection expression used in the production pipeline.
start = main.index('const bool lightingTest = simulation.enabled')
selection = main[start:main.index('    if (hr)', start)]
assert 'smoothed, s_prevZone, !lightingTest)' in main
assert 'smoothed, s_prevZoneHr, !lightingTest)' in main
code = r"""
#include <cassert>
#include <cmath>
#include <iostream>
#include "Simulation.h"
#include "PowerProcessor.h"
#include "PowerZones.h"
int main() {
AppConfig c{}; c.ftp=260; c.hrMax=201; c.hysteresis=100;
int power[]={0,83,157,214,289,361,477}, hr[]={70,103,129,154,178};
for(int i=0;i<7;++i) {c.zones[i].minWatts=power[i]; c.zones[i].r=20+i*30; c.zones[i].b=240-i*30;}
for(int i=0;i<5;++i) {c.hrZones[i].minBpm=hr[i]; c.hrZones[i].g=20+i*40; c.hrZones[i].b=240-i*40;}
"""
for is_hr, count, seq in cases:
    ns = 'HRZones' if is_hr else 'PowerZones'
    code += '{ c.zoneCount=%d; float points[]={%s};\n' % (count, ','.join(str(x)+'f' if '.' in str(x) else str(x)+'.0f' for x in seq))
    code += r"""
for(int strength : {0,50,90,100}) {
PowerProcessor processor; processor.setSmoothing(strength); processor.update(17);
Simulation sim; sim.patch(false,true,true,false,0,true,true);
bool visited[7]={}; int index=0;
for(float raw : points) {
const auto simulation=sim.snapshot();
""" + selection + f"""
assert(smoothed==raw); assert(processor.value()==17);
int zone={ns}::zoneIndex(c,smoothed,0,!lightingTest); visited[zone]=true;
uint8_t r,g,b; {ns}::colorFor(c,smoothed,r,g,b);
"""
    if not is_hr:
        code += f"""
if(index=={(count-1)*3+1}) {{ assert(zone=={count-1}); assert(r==c.zones[zone].r && b==c.zones[zone].b); }}
if(index=={(count-1)*3} || index=={(count-1)*3+2}) {{
assert(zone=={count-2}); assert(r>c.zones[zone].r && r<c.zones[zone+1].r);
}}
"""
    code += f"""
if(index=={len(seq)-1}) assert(zone==0);
++index;
}}
for(int i=0;i<{count};++i) assert(visited[i]);
""" + r"""
// Ordinary simulation enables clear test mode; normal smoothing/history survives.
sim.patch(false,true,true,true,100); assert(!sim.snapshot().lightingTest);
float normal=processor.update(100,sim.snapshot().lightingTest);
float expected=17+(100-17)*(1-strength*.0095f);
assert(std::abs(normal-expected)<.001f);
sim.patch(false,false,false,false,0,true,true);
sim.patch(false,true,false,false,0); assert(!sim.snapshot().lightingTest);
}
}
"""
code += 'std::cout << "PASS: actual browser points, Power 5/6/7, HR, gradient/solid/wrap, all smoothing strengths and normal EMA preservation\\n"; }'
with tempfile.TemporaryDirectory() as temp:
    temp=Path(temp); source=temp/'sequence.cpp'; source.write_text(code)
    binary=temp/('sequence.exe' if os.name=='nt' else 'sequence')
    subprocess.run([os.environ.get('CXX','g++'),'-std=c++11','-pthread',
        '-I'+str(root/'tools/tests/led_pin'),'-I'+str(root/'include'),str(source),
        str(root/'src/PowerProcessor.cpp'),str(root/'src/PowerZones.cpp'),'-o',str(binary)],check=True)
    subprocess.run([str(binary)],check=True)
