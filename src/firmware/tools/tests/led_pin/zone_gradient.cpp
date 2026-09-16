#include "PowerZones.h"
#include <cassert>
#include <cmath>
#include <algorithm>
#include <initializer_list>

// Distinct basis colors expose the contribution of each configured neighbour.
// Test both engines, all zone counts, every interpolation position and values
// outside a retained logical zone (hysteresis clamps interpolation only).
void testZoneGradient() {
  for (bool hr : {false, true}) {
    for (int n = 5; n <= (hr ? 5 : 7); ++n) {
      AppConfig c{}; c.zoneCount=n; c.ftp=300; c.hysteresis=4;
      for (int active=0; active<n; ++active) {
        for (int i=0; i<n; ++i) {
          c.zones[i].minWatts=50+i*100;
          if(i<5) c.hrZones[i].minBpm=50+i*100;
          c.zones[i].r=i<active ? 255 : 0;
          c.zones[i].g=i==active ? 255 : 0;
          c.zones[i].b=i>active ? 255 : 0;
          if(i<5) {
            c.hrZones[i].r=c.zones[i].r;
            c.hrZones[i].g=c.zones[i].g;
            c.hrZones[i].b=c.zones[i].b;
          }
        }
        for (int step=-10; step<=1010; ++step) {
          float t=step/1000.0f, value=50+active*100+t*100;
          uint8_t r,g,b;
          if(hr) HRZones::colorFor(c,value,r,g,b,active);
          else PowerZones::colorFor(c,value,r,g,b,active);
          assert(g>=229 && r<=26 && b<=26); // 90% minimum, rounding tolerance.
          float clamped=std::max(0.0f,std::min(1.0f,t));
          float lower=(active>0 && active<n-1 && clamped<.4f) ? .1f*(1-clamped/.4f) : 0;
          float upper=(active<n-1 && clamped>.6f) ? .1f*(clamped-.6f)/.4f : 0;
          assert(std::abs(int(r)-int(std::lround(255*lower)))<=1);
          assert(std::abs(int(b)-int(std::lround(255*upper)))<=1);
          assert(std::abs(int(g)-int(std::lround(255*(1-lower-upper))))<=1);
        }
        // Actual unchanged detector retains the current zone on both sides.
        for(float v : {50+active*100-1.0f, 50+(active+1)*100+1.0f}) {
          int zone=hr ? HRZones::zoneIndex(c,v,active,true) : PowerZones::zoneIndex(c,v,active,true);
          assert(zone==active);
          uint8_t r,g,b;
          if(hr) HRZones::colorFor(c,v,r,g,b,zone);
          else PowerZones::colorFor(c,v,r,g,b,zone);
          assert(g>=229 && r<=26 && b<=26);
        }
      }
    }
  }
}
