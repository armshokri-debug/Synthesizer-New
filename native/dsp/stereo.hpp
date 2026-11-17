#pragma once
// SSE2 is baseline on Intel Macs. Other platforms retain the scalar DSP.
#if defined(__SSE2__) && !defined(SY1_SCALAR_FILTERS)
#include <emmintrin.h>
namespace sy1 { namespace dsp {
struct Stereo {
  __m128d v;
  explicit Stereo(double a) : v(_mm_set1_pd(a)) {}
  Stereo(double l, double r) : v(_mm_set_pd(r, l)) {}
  explicit Stereo(__m128d a) : v(a) {}
  void store(double& l, double& r) const {
    _mm_store_sd(&l, v);
    _mm_storeh_pd(&r, v);
  }
};
inline Stereo operator+(Stereo a, Stereo b) { return Stereo(_mm_add_pd(a.v,b.v)); }
inline Stereo operator-(Stereo a, Stereo b) { return Stereo(_mm_sub_pd(a.v,b.v)); }
inline Stereo operator*(Stereo a, Stereo b) { return Stereo(_mm_mul_pd(a.v,b.v)); }
inline Stereo operator/(Stereo a, Stereo b) { return Stereo(_mm_div_pd(a.v,b.v)); }
inline Stereo select(__m128d mask, Stereo yes, Stereo no) {
  return Stereo(_mm_or_pd(_mm_and_pd(mask,yes.v),_mm_andnot_pd(mask,no.v)));
}
inline Stereo tanh(Stereo x) {
  const auto hi = _mm_cmpgt_pd(x.v, Stereo(3).v);
  const auto lo = _mm_cmplt_pd(x.v, Stereo(-3).v);
  // Clamp only lanes which scalar code returns from early; preserve NaNs.
  const auto bounded = select(_mm_or_pd(hi,lo),Stereo(0),x);
  const auto x2 = bounded * bounded;
  const auto y = (bounded * (Stereo(27) + x2)) / (Stereo(27) + Stereo(9) * x2);
  return select(hi,Stereo(1),select(lo,Stereo(-1),y));
}
}}
#endif
