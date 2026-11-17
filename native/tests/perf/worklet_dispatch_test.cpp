#include "../../host/worklets.hpp"
#include <atomic>
#include <cassert>
#include <cstdio>
static size_t allocs=0;
void* operator new(size_t n){++allocs;if(auto* p=malloc(n?n:1))return p;throw std::bad_alloc();}
void operator delete(void* p)noexcept{free(p);}void operator delete(void* p,size_t)noexcept{free(p);}
int main(){
 wa::Context c;sy1::HQWorklet w(&c);std::string key="cutoff";int count=0;
 if(sy1::WorkletNode::portDelay()){
  {std::string owned="cutoff";w.post([&count,owned]{assert(owned=="cutoff");++count;});}
  w.pull();assert(count==0);c.frame+=wa::RQ;w.pull();assert(count==1);
  puts("PASS: deferred callable ownership and one-quantum delivery unchanged");return 0;
 }
 size_t before=allocs;
 for(int i=0;i<10000;i++)w.post([&count,key]{++count;});
 assert(count==10000);printf("10000 numeric worklet dispatches: %zu C++ allocations\n",allocs-before);
#ifdef SY1_EXPECT_DIRECT_DISPATCH
 assert(allocs==before);
#endif
}
