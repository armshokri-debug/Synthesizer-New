#include "paired_api.hpp"
#include <algorithm>
#include <chrono>
#include <fstream>
#include <iostream>
#include <string>
#include <ctime>
#include <vector>
#if defined(__SSE2__)
#include <xmmintrin.h>
#endif
static double cpuNow(){
#if defined(CLOCK_THREAD_CPUTIME_ID)
 timespec t{};clock_gettime(CLOCK_THREAD_CPUTIME_ID,&t);return t.tv_sec*1e6+t.tv_nsec*.001;
#else
 return double(std::clock())/CLOCKS_PER_SEC*1e6;
#endif
}
int main(int argc,char** argv){
 const int count=argc>1?std::stoi(argv[1]):5,block=argc>3?std::stoi(argv[3]):128;const double rate=argc>2?std::stod(argv[2]):48000,seconds=argc>5?std::stod(argv[5]):4;const char* scene=argc>4?argv[4]:"idle";
#if defined(__SSE2__)
 _mm_setcsr(_mm_getcsr()|0x8040);
#endif
 auto read=[](const char* p){std::ifstream f(p);return std::string{std::istreambuf_iterator<char>(f),{}};};
 const auto shim=read("native/js/wa-shim.js"),bundle=read("native/js/dist/engine.js");
 const auto baselineShim=argc>6?read(argv[6]):shim;
 if(shim.empty()||baselineShim.empty()||bundle.empty())return 2;
 const PerfApi apis[2]={sy1_before_api(),sy1_after_api()};std::vector<void*> engines[2];
 for(int v=0;v<2;v++)for(int k=0;k<count;k++)engines[v].push_back(apis[v].create(rate,block,scene,(v==0?baselineShim:shim).c_str(),bundle.c_str()));
 const size_t n=size_t(seconds*rate/block);std::vector<double> times[2],cpuTimes[2];for(int v=0;v<2;v++){times[v].reserve(n);cpuTimes[v].reserve(n);}std::vector<float> l(block),r(block);
 for(size_t callback=0;callback<n;callback++)for(int order=0;order<2;order++){
  const int v=(callback+order)%2;const auto t=std::chrono::steady_clock::now();const double cpu0=cpuNow();for(void* e:engines[v])apis[v].process(e,l.data(),r.data(),block);cpuTimes[v].push_back(cpuNow()-cpu0);times[v].push_back(std::chrono::duration<double,std::micro>(std::chrono::steady_clock::now()-t).count());
 }
 std::cout<<"{\"scenario\":\""<<scene<<"\",\"instances\":"<<count<<",\"rate\":"<<rate<<",\"buffer\":"<<block<<",\"callbacks\":"<<n<<",\"versions\":[";
 for(int v=0;v<2;v++){
  double cpuSum=0;for(double x:cpuTimes[v])cpuSum+=x;std::sort(cpuTimes[v].begin(),cpuTimes[v].end());double sum=0;size_t misses=0;for(double x:times[v]){sum+=x;misses+=x>block/rate*1e6;}std::sort(times[v].begin(),times[v].end());auto p=[&](double q){return times[v][std::min(n-1,size_t(q*n))];};
  std::cout<<(v?",":"")<<"{\"name\":\""<<(v?"after":"before")<<"\",\"mean_us\":"<<sum/n<<",\"median_us\":"<<p(.5)<<",\"mean_thread_cpu_us\":"<<cpuSum/n<<",\"p99_thread_cpu_us\":"<<cpuTimes[v][std::min(n-1,size_t(.99*n))]<<",\"p95_us\":"<<p(.95)<<",\"p99_us\":"<<p(.99)<<",\"max_us\":"<<times[v].back()<<",\"deadline_misses\":"<<misses<<",\"budget_percent\":"<<sum/n/(block/rate*1e6)*100<<"}";
  for(void* e:engines[v])apis[v].destroy(e);
 }
 std::cout<<"]}\n";
}
