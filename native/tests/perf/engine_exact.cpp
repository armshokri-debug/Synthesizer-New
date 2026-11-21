#include "paired_api.hpp"
#include <array>
#include <cstring>
#include <cstdio>
#include <fstream>
#include <iterator>
#include <string>
std::string read(const char* path) {std::ifstream f(path);return {std::istreambuf_iterator<char>(f),{}};}
int main(int argc, char** argv){
 const auto shim=read("native/js/wa-shim.js"),bundle=read("native/js/dist/engine.js");
 if(shim.empty()||bundle.empty())return 2;
 const auto baselineShim = argc > 1 ? read(argv[1]) : shim;
 if(baselineShim.empty())return 2;
 const auto a=sy1_before_api(),b=sy1_after_api();
 for(int n:{32,64,128,256,512})for(const char* scene:{"idle","chord","hold","sustain","tails","dense-cc","drums","knobs"}){
  auto* x=a.create(48000,n,scene,baselineShim.c_str(),bundle.c_str());auto* y=b.create(48000,n,scene,shim.c_str(),bundle.c_str());
  std::array<float,512> al,ar,bl,br;
  for(int k=0;k<48000/n;k++){
   a.process(x,al.data(),ar.data(),n);b.process(y,bl.data(),br.data(),n);
   if(memcmp(al.data(),bl.data(),n*sizeof(float))||memcmp(ar.data(),br.data(),n*sizeof(float))){fprintf(stderr,"Mismatch %s/%d\n",scene,n);return 1;}
  }
  a.destroy(x);b.destroy(y);
 }
 puts("PASS: 40 bit-identical full engine comparisons (8 scenes x 5 buffer sizes including 32)");
}
