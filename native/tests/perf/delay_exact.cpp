// Compare optimized delay against the unchanged baseline interpolation and history.
#include "../../wa/wa.hpp"
#include <cassert>
#include <cstdio>
#include <random>
namespace wa {
class ReferenceDelay : public Node {
 public:
  Param delayTime;
  ReferenceDelay(Context* c, double maxDelay = 1) : Node(c), delayTime(c, 0, 0, static_cast<float>(maxDelay)), max_(maxDelay) {
    len_ = RQ + timeToSampleFrame(maxDelay, c->sampleRate, 2);
  }
  void params(std::vector<Param*>& v) override { v.push_back(&delayTime); }
 protected:
  double max_;
  size_t len_;
  struct K { std::vector<float> buf; size_t w = 0; };
  std::vector<K> k_;
  void process() override {
    const Bus& b = in[0];
    out.channels = b.channels;
    if (static_cast<int>(k_.size()) != b.channels) {
      k_.assign(b.channels, K{});
      for (auto& k : k_) k.buf.assign(len_, 0.0f);
    }
    const float sr = static_cast<float>(ctx->sampleRate);
    for (int c = 0; c < b.channels; c++) {
      K& s = k_[c];
      float times[RQ];
      if (delayTime.isAudioRate()) delayTime.calculateSampleAccurateValues(times);
      else { const float t = delayTime.finalValue(); for (int k = 0; k < RQ; k++) times[k] = t; }
      // write this quantum's input first (Chrome CopyToCircularBuffer), then read
      const size_t rem = len_ - s.w;
      const size_t first = std::min(static_cast<size_t>(RQ), rem);
      std::memcpy(&s.buf[s.w], b.ch[c], first * sizeof(float));
      if (RQ > static_cast<int>(rem)) std::memcpy(&s.buf[0], b.ch[c] + rem, (RQ - rem) * sizeof(float));
      size_t w = s.w;
      // Chrome's SSE2 / NEON kernel (groups of four): read position computed in float
      {
        const float fl = static_cast<float>(len_);
        const int il = static_cast<int>(len_);
        auto wrapI = [&](int v) { return v < il ? v : v - il; };
        int wi[4];
        for (int m = 0; m < 4; m++) wi[m] = wrapI(static_cast<int>(w) + m);
        for (int k = 0; k < RQ; k += 4) {
          for (int m = 0; m < 4; m++) {
            const float dfr = std::max(times[k + m], 0.0f) * sr;
            float rp = static_cast<float>(wi[m]) + (fl - dfr);
            if (rp >= fl) rp -= fl;
            const int r1 = wrapI(static_cast<int>(rp));
            const int r2 = wrapI(r1 + 1);
            const float f = rp - static_cast<float>(r1);
            const float s1 = s.buf[r1], s2 = s.buf[r2];
            out.ch[c][k + m] = s1 + f * (s2 - s1);
            wi[m] = wrapI(wi[m] + 4);
          }
        }
        w += RQ;
        if (w >= len_) w -= len_;
      }
      for (int i = RQ; i < RQ; i++) {
        const double dt = std::fmax(times[i], 0);
        const double dfr = dt * sr;
        double rp = w + len_ - dfr;
        if (rp >= len_) rp -= len_;
        const size_t r1 = static_cast<size_t>(rp);
        size_t r2 = r1 + 1;
        if (r2 >= len_) r2 -= len_;
        const float f = static_cast<float>(rp - r1);
        const float s1 = s.buf[r1], s2 = s.buf[r2];
        if (++w >= len_) w -= len_;
        out.ch[c][i] = s1 + f * (s2 - s1);
      }
      s.w = w;
    }
  }
};


class TestFeed : public Node { public: TestFeed(Context* c):Node(c,0){} float values[2][RQ]={}; int channels=2; int outputChannels()const override{return channels;} void process()override{out.channels=channels;std::memcpy(out.ch,values,sizeof values);} };
}
int main(){size_t compared=0;std::mt19937 rng(42);
 for(double rate:{44100.,48000.,96000.})for(double maximum:{.0001,.003,.2,2.}){
  wa::Context ctx;ctx.sampleRate=rate;wa::TestFeed feed(&ctx),feedRef(&ctx);wa::Delay actual(&ctx,maximum);wa::ReferenceDelay reference(&ctx,maximum);feed.connect(&actual);feedRef.connect(&reference);
  for(int block=0;block<1600;block++){
   // Long zero spans, impulse tails, re-entry, tiny nonzero values and sign of zero.
   for(auto& channel:feed.values)for(auto& x:channel)x=(block%900>810&&block%900<830)?(int(rng()%2000)-1000)*.0005f:0.f;
   if(block==30)feed.values[0][43]=1.f;if(block==40)feed.values[1][19]=-0.f;
   if(block==50)feed.values[1][50]=std::numeric_limits<float>::denorm_min();
   if(block%25==0){const float d=maximum*float(rng()%1000)/1000;actual.delayTime.setTargetAtTime(d,ctx.currentTime(),.01);reference.delayTime.setTargetAtTime(d,ctx.currentTime(),.01);}
   if(block==150||block==700){feed.channels=block==150?1:2;}
   std::memcpy(feedRef.values,feed.values,sizeof feed.values);feedRef.channels=feed.channels;
   auto& a=actual.pull();auto& b=reference.pull();assert(a.channels==b.channels);assert(std::memcmp(a.ch,b.ch,sizeof a.ch)==0);compared+=wa::RQ*a.channels;ctx.frame+=wa::RQ;
  }
 }
 printf("PASS: %zu bit-identical delay samples across 44.1/48/96 kHz, tiny/long buffers, silence, impulses, tails, parameter ramps and channel changes\n",compared);
}
