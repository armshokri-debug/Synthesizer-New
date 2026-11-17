#include "../../wa/wa.hpp"
#include <random>
#include <cassert>
#include <cstdio>
namespace wa {
class ReferenceIIR : public Node {
 public:
  ReferenceIIR(Context* c, std::vector<double> ff, std::vector<double> fb) : Node(c), ff_(std::move(ff)), fb_(std::move(fb)) {
    const double a0 = fb_[0];
    for (auto& v : ff_) v /= a0;
    for (auto& v : fb_) v /= a0;
  }
 protected:
  static constexpr int L = 32;
  std::vector<double> ff_, fb_;
  struct K { double x[L] = {}, y[L] = {}; int idx = 0; };
  std::vector<K> k_;
  void process() override {
    const Bus& b = in[0];
    out.channels = b.channels;
    if (static_cast<int>(k_.size()) != b.channels) k_.assign(b.channels, K{});
    const int nfb = static_cast<int>(fb_.size()), nff = static_cast<int>(ff_.size()), mn = std::min(nfb, nff);
    for (int c = 0; c < b.channels; c++) {
      K& s = k_[c];
      for (int n = 0; n < RQ; n++) {
        double yn = ff_[0] * b.ch[c][n];
        for (int k = 1; k < mn; k++) { const int m = (s.idx - k) & (L - 1); yn += ff_[k] * s.x[m]; yn -= fb_[k] * s.y[m]; }
        for (int k = mn; k < nff; k++) yn += ff_[k] * s.x[(s.idx - k) & (L - 1)];
        for (int k = mn; k < nfb; k++) yn -= fb_[k] * s.y[(s.idx - k) & (L - 1)];
        s.x[s.idx] = b.ch[c][n];
        s.y[s.idx] = yn;
        s.idx = (s.idx + 1) & (L - 1);
        out.ch[c][n] = static_cast<float>(yn);
      }
    }
  }
};

class IirTestFeed : public Node {public: IirTestFeed(Context* c):Node(c,0){} float samples[2][RQ]={};int channels=2;int outputChannels()const override{return channels;} void process()override{out.channels=channels;std::memcpy(out.ch,samples,sizeof samples);} };
}
int main(){std::mt19937 rng(171);size_t n=0;
for(double rate:{44100.,48000.,96000.})for(int ff:{1,2,4})for(int fb:{1,2,4}){
 std::vector<double> f(ff),g(fb);g[0]=1.;for(auto& x:f)x=(int(rng()%100)-50)*.001;for(int j=1;j<fb;j++)g[j]=(int(rng()%100)-50)*.001;
 wa::Context ctx;ctx.sampleRate=rate;wa::IirTestFeed a(&ctx),b(&ctx);wa::IIR x(&ctx,f,g);wa::ReferenceIIR y(&ctx,f,g);a.connect(&x);b.connect(&y);
 for(int block=0;block<400;block++){
  a.channels=b.channels=block<100?1:block<300?2:1;
  for(auto& c:a.samples)for(auto& s:c)s=block<20||block>250?0.f:(int(rng()%2000)-1000)*.001f;
  if(block==10)a.samples[0][3]=-0.f;
  if(block==22)a.samples[1][11]=std::numeric_limits<float>::denorm_min();
  std::memcpy(b.samples,a.samples,sizeof a.samples);
  auto& u=x.pull();auto& v=y.pull();assert(u.channels==v.channels);assert(std::memcmp(u.ch,v.ch,sizeof u.ch)==0);n+=u.channels*wa::RQ;ctx.frame+=wa::RQ;
 }
}std::printf("PASS: %zu exact IIR samples, 27 rate/tap cases, channel changes, impulses and tails\n",n);}
