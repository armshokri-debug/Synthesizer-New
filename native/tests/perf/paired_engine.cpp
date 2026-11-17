// Compile twice: pinned checkout and candidate; namespace renaming avoids ODR overlap.
#include SY1_BENCH_HEADER
#include "paired_api.hpp"
#include <fstream>
#include <sstream>
namespace {
struct Instance {sy1::Sy1Engine engine;std::string scenario;bool first=true;};
void* create(double rate,int block,const char* scenario,const char* shim,const char* bundle){
 auto* i=new Instance;i->scenario=scenario;std::string err;
 const std::string seeded=std::string("{let seed=123456;Math.random=()=>{seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;return(seed>>>0)/4294967296;};}\n")+bundle;
 if(!i->engine.init(rate,shim,seeded,"",err))throw std::runtime_error(err);
 auto& e=i->engine;const std::string sc=scenario;
 e.hostCall("setHostTempo","[120]");e.hostCall("hostTransport",sc=="idle"?"[false]":"[true]");
 if(sc=="drums")e.hostCall("setMachine","[\"kerman\"]");
 if(sc=="cc"||sc=="dense-cc"){e.hostCall("mapCcToParam","[74,\"cutoff\"]");e.hostCall("setMidiPickup","[false]");}
 if(sc=="tails"){e.hostCall("setSynthParam","[\"revMix\",0.6]");e.hostCall("setSynthParam","[\"delayMix\",0.5]");}
 if(sc=="hold")e.hostCall("setSynthParam","[\"hold\",\"on\"]");if(sc=="sustain")e.hostCall("hostCC","[1,64,127]");
 if(sc!="idle"&&sc!="playing-idle"&&sc!="drums")for(int n:{48,55,60,64,67,72})e.hostCall("midiNoteOn","["+std::to_string(n)+",0.8,1]");
 std::vector<float> l(block),r(block);for(int k=0;k<int(std::ceil(2*rate/block));k++)e.process(l.data(),r.data(),block,[](int){});
 return i;
}
void process(void* opaque,float* l,float* r,int block){
 auto& i=*static_cast<Instance*>(opaque);auto& e=i.engine;const auto& s=i.scenario;
 e.process(l,r,block,[&](int){
  const double rate=e.js()->g.ctx.sampleRate;
  if(s!="idle"){const double ppq=e.time()*2;e.setHostClock(true,ppq,120);const long step=long(std::floor(ppq*4+1e-9)),prev=long(std::floor((e.time()-128/rate)*8+1e-9));if(step!=prev)e.hostCall("hostStep","["+std::to_string(step)+",0]");}
  if(s=="cc"||s=="dense-cc")for(int j=0;j<(s=="dense-cc"?32:1);j++)e.hostCall("hostCC","[1,74,"+std::to_string((e.js()->g.ctx.frame/128+j)%128)+"]",j/rate);
  if(i.first&&(s=="tails"||s=="hold"||s=="sustain"))for(int n:{48,55,60,64,67,72})e.hostCall("midiNoteOff","["+std::to_string(n)+",1]");i.first=false;
 });
}
void destroy(void* p){delete static_cast<Instance*>(p);}
}
#ifdef SY1_BENCH_BASELINE
extern "C" PerfApi sy1_before_api(){return {create,process,destroy};}
#else
extern "C" PerfApi sy1_after_api(){return {create,process,destroy};}
#endif
