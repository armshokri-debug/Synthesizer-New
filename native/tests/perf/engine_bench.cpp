// Native callback-cost benchmark; no device, GUI or claim of Ableton CPU percentage.
#include <chrono>
#include <algorithm>
#include <atomic>
#include <cstdlib>
#include <ctime>
#include <fstream>
#include <iostream>
#include <numeric>
#include <sstream>
#include <thread>
#if defined(__SSE2__)
#include <xmmintrin.h>
#endif
#include "../../host/sy1_engine.hpp"
static thread_local bool countAlloc=false;
static thread_local uint64_t allocations=0,allocatedBytes=0;
void* operator new(std::size_t n) { if(countAlloc){++allocations;allocatedBytes+=n;} if(auto* p=std::malloc(n?n:1))return p;throw std::bad_alloc(); }
void* operator new[](std::size_t n){return ::operator new(n);}
void operator delete(void* p) noexcept{std::free(p);}
void operator delete[](void* p) noexcept{std::free(p);}
void operator delete(void* p,std::size_t) noexcept{std::free(p);}
void operator delete[](void* p,std::size_t) noexcept{std::free(p);}
static std::string read(const char* p){std::ifstream f(p);if(!f)throw std::runtime_error(std::string("missing ")+p);return {std::istreambuf_iterator<char>(f),{}};}
int main(int argc,char** argv){
 try{
  const int instances=argc>1?std::stoi(argv[1]):5, block=argc>3?std::stoi(argv[3]):128;
  const double rate=argc>2?std::stod(argv[2]):48000, seconds=argc>5?std::stod(argv[5]):4;
  const std::string scenario=argc>4?argv[4]:"idle";
#if defined(__SSE2__)
  _mm_setcsr(_mm_getcsr()|0x8040); // Same denormal handling as JUCE's audio callback.
#endif
  const auto shim=read("native/js/wa-shim.js"), bundle=read("native/js/dist/engine.js");
  std::vector<std::unique_ptr<sy1::Sy1Engine>> engines;
  std::vector<float> L(block),R(block);
  const bool playing=scenario!="idle";
  const bool drums=scenario=="drums",notes=scenario=="notes"||scenario=="chord"||scenario=="hold"||scenario=="sustain"||scenario=="tails"||scenario=="cc"||scenario=="dense-cc";
  for(int k=0;k<instances;k++){
   auto e=std::make_unique<sy1::Sy1Engine>();std::string err;
   if(!e->init(rate,shim,bundle,"",err))throw std::runtime_error(err);
   e->hostCall("setHostTempo","[120]");e->hostCall("hostTransport",playing?"[true]":"[false]");
   if(drums)e->hostCall("setMachine","[\"kerman\"]");
   if(scenario=="cc"||scenario=="dense-cc") {e->hostCall("mapCcToParam","[74,\"cutoff\"]");e->hostCall("setMidiPickup","[false]");}
   if(scenario=="tails"){e->hostCall("setSynthParam","[\"revMix\",0.6]");e->hostCall("setSynthParam","[\"delayMix\",0.5]");}
   if(scenario=="hold")e->hostCall("setSynthParam","[\"hold\",\"on\"]");
   if(scenario=="sustain")e->hostCall("hostCC","[1,64,127]");
   if(notes)for(int m:scenario=="notes"?std::vector<int>{60}:std::vector<int>{48,55,60,64,67,72})e->hostCall("midiNoteOn","["+std::to_string(m)+",0.8,1]");
   // Warm the real graph and queues; includes the initial state save / startup ramps.
   for(int i=0;i<100;i++)e->process(L.data(),R.data(),block,[](int){});
   engines.push_back(std::move(e));
  }
  const int callbacks=std::max(1,int(std::ceil(seconds*rate/block)));std::vector<double> samples;samples.reserve(callbacks);
  size_t deadlineMisses=0;double sum=0,peak=0;const double budget=block/rate*1e6;
  const auto cpu0=std::clock();
  for(int i=0;i<callbacks;i++){
   const auto t0=std::chrono::steady_clock::now();countAlloc=true;
   for(auto& e:engines){
    e->process(L.data(),R.data(),block,[&](int){
     if(playing){const double ppq=e->time()*2;e->setHostClock(true,ppq,120);const long step=long(std::floor(ppq*4+1e-9));const long prev=long(std::floor((e->time()-128/rate)*8+1e-9));if(step!=prev)e->hostCall("hostStep","["+std::to_string(step)+",0]");}
     if(scenario=="cc"||scenario=="dense-cc")for(int j=0;j<(scenario=="dense-cc"?32:1);j++)e->hostCall("hostCC","[1,74,"+std::to_string((i+j)%128)+"]",j*1.0/rate);
     if((scenario=="tails"||scenario=="hold"||scenario=="sustain")&&i==0)for(int m:{48,55,60,64,67,72})e->hostCall("midiNoteOff","["+std::to_string(m)+",1]");
    });
    for(int j=0;j<block;j++)peak=std::max(peak,double(std::fabs(L[j])));
   }
   countAlloc=false;const double us=std::chrono::duration<double,std::micro>(std::chrono::steady_clock::now()-t0).count();samples.push_back(us);sum+=us;deadlineMisses+=us>budget;
  }
  const double cpu=double(std::clock()-cpu0)/CLOCKS_PER_SEC;
  std::sort(samples.begin(),samples.end());const auto pct=[&](double p){return samples[std::min(samples.size()-1,size_t(std::ceil(samples.size()*p)-1))];};
  std::cout<<"{\"scenario\":\""<<scenario<<"\",\"instances\":"<<instances<<",\"rate\":"<<rate<<",\"buffer\":"<<block<<",\"callbacks\":"<<callbacks<<",\"mean_us\":"<<sum/callbacks<<",\"p95_us\":"<<pct(.95)<<",\"p99_us\":"<<pct(.99)<<",\"max_us\":"<<samples.back()<<",\"budget_us\":"<<budget<<",\"budget_percent\":"<<sum/callbacks/budget*100<<",\"deadline_misses\":"<<deadlineMisses<<",\"process_cpu_seconds\":"<<cpu<<",\"cpp_allocations\":"<<allocations<<",\"cpp_allocated_bytes\":"<<allocatedBytes<<",\"peak\":"<<peak<<"}\n";
 }catch(const std::exception& e){std::cerr<<e.what()<<'\n';return 1;}
}
