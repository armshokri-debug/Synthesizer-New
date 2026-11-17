#include "../../wa/wa.hpp"
#include <cassert>
#include <cstdio>
namespace wa {
class ReferencePeriodicWave {
 public:
  enum Shape { Sine, Square, Sawtooth, Triangle };
  ReferencePeriodicWave(double sampleRate, const std::vector<float>& real, const std::vector<float>& imag, bool disableNorm = false)
      : size_(sampleRate <= 24000 ? 2048 : sampleRate <= 88200 ? 4096 : 16384),
        ranges_(static_cast<unsigned>(std::lround(3 * log2f(static_cast<float>(size_))))),
        lowest_(static_cast<float>(sampleRate / size_)),
        rateScale_(static_cast<float>(size_ / sampleRate)) {
    build(real, imag, disableNorm);
  }
  /** The four built-in shapes, built once per sample rate and shared (Chrome caches them per context too). */
  static std::shared_ptr<ReferencePeriodicWave> basic(double sr, Shape s) {
    static std::vector<std::pair<double, std::shared_ptr<ReferencePeriodicWave>>> cache[4];
    static std::mutex mu;  // several plugin instances can create oscillators on different threads
    std::lock_guard<std::mutex> lock(mu);
    for (auto& e : cache[s]) if (e.first == sr) return e.second;
    auto w = build(sr, s);
    cache[s].push_back({sr, w});
    return w;
  }
  static std::shared_ptr<ReferencePeriodicWave> build(double sr, Shape s) {
    const unsigned size = sr <= 24000 ? 2048 : sr <= 88200 ? 4096 : 16384, half = size / 2;
    std::vector<float> re(half, 0.0f), im(half, 0.0f);
    for (unsigned n = 1; n < half; n++) {
      const float pf = 2 / (n * 3.14159265358979323846f);
      float b = 0;
      switch (s) {
        case Sine: b = n == 1 ? 1 : 0; break;
        case Square: b = (n & 1) ? 2 * pf : 0; break;
        case Sawtooth: b = pf * ((n & 1) ? 1 : -1); break;
        case Triangle: b = (n & 1) ? 2 * (pf * pf) * ((((n - 1) >> 1) & 1) ? -1 : 1) : 0; break;
      }
      im[n] = b;
    }
    return std::make_shared<ReferencePeriodicWave>(sr, re, im, false);
  }
  unsigned size() const { return size_; }
  float rateScale() const { return rateScale_; }
  void waveData(float f, const float*& lower, const float*& higher, float& tif) const {
    f = fabsf(f);
    const float ratio = f > 0 ? f / lowest_ : 0.5f;
    const float cents = log2f(ratio) * 1200;
    const float pr = std::min(static_cast<float>(ranges_ - 1), std::max(0.0f, 1 + cents / (1200.0f / 3)));
    const unsigned r1 = static_cast<unsigned>(pr);
    const unsigned r2 = r1 < ranges_ - 1 ? r1 + 1 : r1;
    lower = tables_[r2].data();
    higher = tables_[r1].data();
    tif = pr - r1;
  }

 private:
  unsigned size_, ranges_;
  float lowest_, rateScale_;
  std::vector<std::vector<float>> tables_;

  static void ifft(std::vector<std::complex<double>>& a) {  // in-place, unscaled, e^{+i}
    const size_t n = a.size();
    for (size_t i = 1, j = 0; i < n; i++) {
      size_t bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) std::swap(a[i], a[j]);
    }
    for (size_t len = 2; len <= n; len <<= 1) {
      const double ang = 2 * PI / len;
      const std::complex<double> wl(std::cos(ang), std::sin(ang));
      for (size_t i = 0; i < n; i += len) {
        std::complex<double> w(1);
        for (size_t j = 0; j < len / 2; j++) {
          const auto u = a[i + j], v = a[i + j + len / 2] * w;
          a[i + j] = u + v;
          a[i + j + len / 2] = u - v;
          w *= wl;
        }
      }
    }
  }
  void build(const std::vector<float>& realData, const std::vector<float>& imagData, bool disableNorm) {
    float normScale = 0.5f;
    const unsigned n = size_, half = n / 2;
    const unsigned comps = std::min(static_cast<unsigned>(realData.size()), half);
    tables_.resize(ranges_);
    for (unsigned r = 0; r < ranges_; r++) {
      const float centsToCull = r * (1200.0f / 3);
      const float cull = static_cast<float>(std::pow(2, -centsToCull / 1200.0f));
      const unsigned partials = static_cast<unsigned>(cull * half);
      std::vector<std::complex<double>> X(n);
      const unsigned keep = std::min(comps, partials + 1);
      for (unsigned i = 1; i < keep; i++) {
        // x[t] = sum a_i cos + b_i sin  ->  X[i] = (a - i b)/2, X[n-i] = conj
        const std::complex<double> c(0.5 * realData[i], -0.5 * imagData[i]);
        X[i] = c;
        X[n - i] = std::conj(c);
      }
      ifft(X);
      std::vector<float>& t = tables_[r];
      t.resize(n);
      for (unsigned i = 0; i < n; i++) t[i] = static_cast<float>(X[i].real());
      if (!disableNorm && !r) {
        float mx = 0;
        for (float v : t) mx = std::max(mx, fabsf(v));
        if (mx) normScale = 1.0f / mx;
      }
      for (float& v : t) v *= normScale;
    }
  }
};

class ReferenceOscillator : public Source {
 public:
  Param frequency, detune;
  ReferenceOscillator(Context* c, ReferencePeriodicWave::Shape s = ReferencePeriodicWave::Sine)
      : Source(c), frequency(c, 440, -static_cast<float>(c->sampleRate / 2), static_cast<float>(c->sampleRate / 2)),
        detune(c, 0, -153600, 153600) { setType(s); }
  void setType(ReferencePeriodicWave::Shape s) { wave_ = ReferencePeriodicWave::basic(ctx->sampleRate, s); }
  void params(std::vector<Param*>& v) override { v.push_back(&frequency); v.push_back(&detune); }
  void setReferencePeriodicWave(std::shared_ptr<ReferencePeriodicWave> w) { wave_ = std::move(w); }

 protected:
  std::shared_ptr<ReferencePeriodicWave> wave_;
  double vri_ = 0;  // virtual read index
  float inc_[RQ];
  static constexpr float k2 = 0.3f, k3 = 0.16f;

  static float interp(double vri, float incr, unsigned mask, float tif, const float* lo, const float* hi) {
    double sl = 0, sh = 0;
    unsigned r0 = static_cast<unsigned>(vri);
    if (incr >= k2) {
      const double f = static_cast<float>(vri) - r0;
      const unsigned r2 = (r0 + 1) & mask;
      r0 &= mask;
      sh = (1 - f) * hi[r0] + f * hi[r2];
      sl = (1 - f) * lo[r0] + f * lo[r2];
    } else if (incr >= k3) {
      unsigned ri[3];
      for (int k = -1; k <= 1; k++) ri[k + 1] = (r0 + k) & mask;
      const double t = vri - r0;
      const double a[3] = {0.5 * t * (t - 1), 1 - t * t, 0.5 * t * (t + 1)};
      for (int k = 0; k < 3; k++) { sl += a[k] * lo[ri[k]]; sh += a[k] * hi[ri[k]]; }
    } else {
      unsigned ri[5];
      for (int k = -2; k <= 2; k++) ri[k + 2] = (r0 + k) & mask;
      const double t = vri - r0, t2 = t * t;
      const double a[5] = {t * (t2 - 1) * (t - 2) / 24, -t * (t - 1) * (t2 - 4) / 6, (t2 - 1) * (t2 - 4) / 4,
                           -t * (t + 1) * (t2 - 4) / 6, t * (t2 - 1) * (t + 2) / 24};
      for (int k = 0; k < 5; k++) { sl += a[k] * lo[ri[k]]; sh += a[k] * hi[ri[k]]; }
    }
    return static_cast<float>((1 - tif) * sh + tif * sl);
  }
  static float linearSample(double vri, unsigned mask, float tif, const float* lo, const float* hi) {
    unsigned r0 = static_cast<unsigned>(vri);
    const float f = static_cast<float>(vri) - r0;
    r0 &= mask;
    const unsigned r1 = (r0 + 1) & mask;
    const float h = hi[r0] + f * (hi[r1] - hi[r0]);
    const float l = lo[r0] + f * (lo[r1] - lo[r0]);
    return h + tif * (l - h);
  }
  static void clampFreq(float* f, int n, float nyq) {
    for (int i = 0; i < n; i++) f[i] = std::isnan(f[i]) ? nyq : std::min(nyq, std::max(-nyq, f[i]));
  }

  bool phaseIncrements() {
    bool sa = false, fchg = false;
    float finalScale = wave_->rateScale();
    if (frequency.hasSampleAccurateValues() && frequency.isAudioRate()) {
      sa = true; fchg = true;
      frequency.calculateSampleAccurateValues(inc_);
    } else finalScale *= frequency.finalValue();
    if (detune.hasSampleAccurateValues() && detune.isAudioRate()) {
      sa = true;
      float dv[RQ];
      float* d = fchg ? dv : inc_;
      detune.calculateSampleAccurateValues(d);
      const float k = static_cast<float>(1.0 / 1200);
      for (int i = 0; i < RQ; i++) d[i] = std::exp2(d[i] * k);
      if (fchg) for (int i = 0; i < RQ; i++) inc_[i] = dv[i] * inc_[i];
    } else finalScale *= std::exp2(detune.finalValue() / 1200);
    if (sa) {
      clampFreq(inc_, RQ, static_cast<float>(ctx->sampleRate / 2));
      for (int i = 0; i < RQ; i++) inc_[i] *= finalScale;
    }
    return sa;
  }

  void process() override {
    out.channels = 1;
    size_t off, frames;
    double sOff;
    if (!schedule(off, frames, sOff)) { finishIfPending(); return; }
    const unsigned N = wave_->size(), mask = N - 1;
    const double invN = 1.0 / N;
    double vri = vri_;
    const float rs = wave_->rateScale();
    float previousLookup = NAN, cachedTif = 0;
    const float *cachedLo = nullptr, *cachedHi = nullptr;
    auto waveData = [&](float f, const float*& l, const float*& h, float& t) {
      if (f != previousLookup) {
        wave_->waveData(f, cachedLo, cachedHi, cachedTif);
        previousLookup = f;
      }
      l = cachedLo; h = cachedHi; t = cachedTif;
    };
    const bool sa = phaseIncrements();
    float freq = 0;
    const float *lo = nullptr, *hi = nullptr;
    float tif = 0;
    if (!sa) {
      freq = frequency.finalValue() * std::exp2(detune.finalValue() / 1200);
      clampFreq(&freq, 1, static_cast<float>(ctx->sampleRate / 2));
      waveData(freq, lo, hi, tif);
    }
    size_t di = off;
    unsigned n = static_cast<unsigned>(frames);
    if (sOff > 0) { ++di; --n; vri += (1 - sOff) * freq * rs; }
    else if (sOff < 0) vri = -sOff * freq * rs;
    float* dst = out.ch[0] + di;
    if (sa) {
      const float* pinc = inc_;  // Chrome indexes phase increments from 0 within the processed span
      const float invRs = 1 / rs;
      unsigned k = 0;
      for (; k + 4 <= n; k += 4) {  // groups of four share the interpolation choice (Chrome vector path)
        bool big = true;
        const float* L4[4]; const float* H4[4]; float T4[4];
        for (int m = 0; m < 4; m++) {
          big = big && fabsf(pinc[k + m]) >= k2;
          waveData(invRs * pinc[k + m], L4[m], H4[m], T4[m]);
        }
        if (big) {  // Chrome's vector kernel: double read indices, float interpolation
          double sum[4];
          sum[0] = pinc[k];
          for (int m = 1; m < 4; m++) sum[m] = sum[m - 1] + pinc[k + m];
          for (int m = 0; m < 4; m++) {
            double x = vri + (m ? sum[m - 1] : 0.0);
            const double r = x * invN;
            int f = static_cast<int>(r);
            if (r < static_cast<double>(f)) f -= 1;
            x -= static_cast<double>(f) * N;
            const int ri = static_cast<int>(x);
            const float fac = static_cast<float>(x) - static_cast<float>(ri);
            const unsigned r0 = static_cast<unsigned>(ri) & mask, r1 = static_cast<unsigned>(ri + 1) & mask;
            const float h = H4[m][r0] + fac * (H4[m][r1] - H4[m][r0]);
            const float l = L4[m][r0] + fac * (L4[m][r1] - L4[m][r0]);
            dst[k + m] = h + T4[m] * (l - h);
          }
          vri += sum[3];
          vri -= std::floor(vri * invN) * N;
        } else {
          for (int m = 0; m < 4; m++) {
            dst[k + m] = interp(vri, fabsf(pinc[k + m]), mask, T4[m], L4[m], H4[m]);
            vri += pinc[k + m];
            vri -= std::floor(vri * invN) * N;
          }
        }
      }
      for (; k < n; k++) {
        const float incr = pinc[k];
        waveData(invRs * incr, lo, hi, tif);
        dst[k] = interp(vri, fabsf(incr), mask, tif, lo, hi);
        vri += incr;
        vri -= std::floor(vri * invN) * N;
      }
    } else {
      const float incr = freq * rs;
      if (incr >= k2) {
        // Chrome's SSE2 / NEON kernel: four lanes with a float read index
        const float fN = static_cast<float>(N), fInvN = 1.0f / N, inc4 = 4 * incr;
        auto wrapf = [&](float x) {
          const float r = x * fInvN;
          int f = static_cast<int>(r);
          if (r < static_cast<float>(f)) f -= 1;
          return x - static_cast<float>(f) * fN;
        };
        float v[4];
        for (int m = 0; m < 4; m++) v[m] = wrapf(static_cast<float>(vri + m * incr));
        unsigned k = 0;
        for (; k + 4 <= n; k += 4) {
          for (int m = 0; m < 4; m++) {
            const unsigned r0 = static_cast<unsigned>(static_cast<int>(v[m])) & mask, r1 = (r0 + 1) & mask;
            const float f = v[m] - static_cast<float>(static_cast<int>(r0));
            const float h = hi[r0] + f * (hi[r1] - hi[r0]);
            const float l = lo[r0] + f * (lo[r1] - lo[r0]);
            dst[k + m] = h + tif * (l - h);
            v[m] = wrapf(v[m] + inc4);
          }
        }
        double vv = vri + k * incr;
        vv -= std::floor(vv * invN) * N;
        for (; k < n; k++) {  // scalar remainder
          dst[k] = linearSample(vv, mask, tif, lo, hi);
          vv += incr;
          vv -= std::floor(vv * invN) * N;
        }
        vri += n * incr;
        vri -= std::floor(vri * invN) * N;
      } else {
        for (unsigned k = 0; k < n; k++) {
          dst[k] = interp(vri, fabsf(incr), mask, tif, lo, hi);
          vri += incr;
          vri -= std::floor(vri * invN) * N;
        }
      }
    }
    vri_ = vri;
    finishIfPending();
  }
};

}
int main(){size_t count=0;
for(double rate:{24000.,44100.,48000.,96000.})for(int shape=0;shape<5;shape++){
 wa::Context ctx;ctx.sampleRate=rate;
 wa::Oscillator a(&ctx,static_cast<wa::PeriodicWave::Shape>(shape%4));
 wa::ReferenceOscillator b(&ctx,static_cast<wa::ReferencePeriodicWave::Shape>(shape%4));
 if(shape==4){std::vector<float> re(32),im(32);im[1]=1;im[3]=.25;re[7]=.1;a.setPeriodicWave(std::make_shared<wa::PeriodicWave>(rate,re,im));b.setReferencePeriodicWave(std::make_shared<wa::ReferencePeriodicWave>(rate,re,im));}
 a.start(.00011);b.start(.00011);
 const double scale=(rate<=24000?2048:rate<=88200?4096:16384)/rate;
 const float fs[]={0,-0.f,.1f,-.1f,float(.16/scale),float(.3/scale),440,-440,float(rate*.49)};
 for(int k=0;k<180;k++){
  if(k%10==0){float f=fs[(k/10)%9];a.frequency.setValue(f);b.frequency.setValue(f);}
  if(k==75){a.frequency.setTargetAtTime(123,ctx.currentTime(),.05);b.frequency.setTargetAtTime(123,ctx.currentTime(),.05);}
  if(k==110){a.detune.linearRampToValueAtTime(200,ctx.currentTime()+.1);b.detune.linearRampToValueAtTime(200,ctx.currentTime()+.1);}
  if(k==160){a.stop(ctx.currentTime()+.003);b.stop(ctx.currentTime()+.003);}
  auto& u=a.pull();auto& v=b.pull();assert(u.channels==v.channels);assert(std::memcmp(u.ch,v.ch,sizeof u.ch)==0);count+=wa::RQ;ctx.frame+=wa::RQ;
 }
}std::printf("PASS: %zu exact oscillator frames; four rates, five shapes, signed frequencies, threshold interpolation, ramps and partial starts/stops\n",count);}
