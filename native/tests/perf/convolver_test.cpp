// Exact equivalence to the approved scalar accumulation order, including FIR history.
#include "../../wa/wa.hpp"
#include <cassert>
#include <cstdio>
#include <random>
struct Reference {
 int block;std::vector<float> rev,buffer;
 Reference(int n,std::vector<float> k):block(n),rev(k.rbegin(),k.rend()),buffer(k.size()-1+n,0){}
 void process(const float* src,float* dst){
  const size_t ks=rev.size(),hist=ks-1;std::memcpy(buffer.data()+hist,src,block*sizeof(float));
  for(int i=0;i<block;i++){float acc[8]={};size_t j=0;for(;j+8<=ks;j+=8)for(int m=0;m<8;m++)acc[m]+=buffer[i+j+m]*rev[j+m];float sum=((acc[0]+acc[4])+(acc[1]+acc[5]))+((acc[2]+acc[6])+(acc[3]+acc[7]));for(;j<ks;j++)sum+=buffer[i+j]*rev[j];dst[i]=sum;}
  std::memmove(buffer.data(),buffer.data()+block,hist*sizeof(float));
 }
};
int main(){
 std::mt19937 rng(7);size_t compared=0;
 for(int block:{1,31,64,128,256,512})for(int length:{1,7,8,63,128,129,257}){
  std::vector<float> k(length);for(auto& x:k)x=(int(rng()%2000)-1000)*.0003f;
  wa::detail::DirectConvolver current(block,k);Reference reference(block,k);
  std::vector<float> input(block),a(block),b(block);
  for(int iteration=0;iteration<120;iteration++){
   for(auto& x:input)x=iteration%12<8?0.0f:(int(rng()%2000)-1000)*.001f;
   if(iteration==55)input[0]=-0.0f;
   if(iteration==65)input[0]=std::numeric_limits<float>::denorm_min();
   if(iteration==75){current.reset();std::fill(reference.buffer.begin(),reference.buffer.end(),0);}
   current.process(input.data(),a.data());reference.process(input.data(),b.data());
   assert(std::memcmp(a.data(),b.data(),a.size()*sizeof(float))==0);assert(current.buffer==reference.buffer);compared+=block;
  }
 }
 for(float value:{INFINITY,-INFINITY,NAN}){std::vector<float> k(128,1);k[30]=value;wa::detail::DirectConvolver c(128,k);Reference r(128,k);float in[128]={},a[128],b[128];c.process(in,a);r.process(in,b);for(int i=0;i<128;i++)assert((std::isnan(a[i])&&std::isnan(b[i]))||a[i]==b[i]);}
 std::printf("PASS: %zu bit-identical FIR samples, history, silence/impulse transitions, resets, signed zeros, subnormals, non-finite kernels\n",compared);
}
