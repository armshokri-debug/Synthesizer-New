#!/bin/bash
set -euo pipefail
root="$(cd "$(dirname "$0")/../../.." && pwd)"
out="$(mktemp -d)"
trap 'rm -rf "$out"' EXIT
cxx="${CXX:-c++}"
for test in delay_exact iir_exact oscillator_exact convolver_test; do
  "$cxx" -O3 -ffp-contract=off -std=c++17 "$root/native/tests/perf/$test.cpp" -o "$out/$test"
  "$out/$test"
done
for mode in scalar stereo; do
  if [ "$mode" = scalar ]; then
    "$cxx" -O3 -ffp-contract=off -std=c++17 -DSY1_SCALAR_FILTERS "-DSY1_HQ_HEADER=\"$root/native/dsp/hq.hpp\"" "$root/native/tests/perf/hq_stress.cpp" -o "$out/$mode"
  else
    "$cxx" -O3 -ffp-contract=off -std=c++17 "-DSY1_HQ_HEADER=\"$root/native/dsp/hq.hpp\"" "$root/native/tests/perf/hq_stress.cpp" -o "$out/$mode"
  fi
  "$out/$mode" "$out/$mode.f32"
done
cmp "$out/scalar.f32" "$out/stereo.f32"
echo 'PASS: 6912000 bit-identical stereo samples: 5 filters, 3 rates, 3 unison settings, automation, glide and release.'
