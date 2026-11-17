#include SY1_HQ_HEADER
#include <algorithm>
#include <cstdio>
int main(int argc, char** argv) {
 if(argc!=2)return 2; FILE* out=fopen(argv[1],"wb");if(!out)return 3;
 for(double sr : {44100.,48000.,96000.}) for(const char* ft : {"lowpass","bandpass","highpass","lp24","ladder"}) for(double uni : {1.,3.,7.}) {
   sy1::hq::Engine e(sr);
   e.setParam("osc1Wave","sawtooth");e.setParam("osc2Wave","square");
   e.setParam("cutoff",500.);e.setParam("res",15.);e.setParam("envAmt",.5);
   e.setParam("filterDrive",.6);e.setParam("drift",.8);e.setParam("keyTrack",.7);
   e.setParam("filterType",ft); e.setParam("unison",uni); e.snapParams();
   for(int j=0;j<10;++j) e.noteOn(j+1,40+j*4,j*3,.9,j,0,0);
   float l[128],r[128];
   for(int b=0;b<600;++b) {
     if(b==30)e.setParam("cutoff",15000.);
     if(b==60)e.setParam("res",25.);
     if(b==100)e.setBend(.8);
     if(b==140)e.setMod(.7);
     if(b==180)e.glideTo(1,70,-30,.2);
     if(b==220)e.setParam("filterDrive",0.);
     if(b==260)e.setParam("unison",5.);
     if(b==300)for(int j=1;j<=10;++j)e.noteOff(j,j*3,false);
     std::fill(l,l+128,0);std::fill(r,r+128,0);e.render(l,r,128);
     if(fwrite(l,sizeof(float),128,out)!=128||fwrite(r,sizeof(float),128,out)!=128)return 4;
   }
 }
 return fclose(out)==0?0:5;
}
