#!/usr/bin/env bash
# Usage: bash native/tests/perf/build.sh /absolute/pinned-baseline /absolute/results
set -euo pipefail
base=$(cd "$1" && pwd)
out=$2
mkdir -p "$out/obj"
for f in quickjs libregexp libunicode dtoa; do
  gcc -O2 -w -c "native/third_party/quickjs/$f.c" -o "$out/obj/$f.o"
done
for test in convolver delay; do
  g++ -O3 -ffp-contract=off -std=c++17 "native/tests/perf/${test}_test.cpp" -o "$out/$test-test"
  "$out/$test-test"
done
g++ -O3 -ffp-contract=off -std=c++17 -DSY1_EXPECT_DIRECT_DISPATCH native/tests/perf/worklet_dispatch_test.cpp -o "$out/worklet-test"
"$out/worklet-test"
SY1_PORT_DELAY=1 "$out/worklet-test"
g++ -O3 -ffp-contract=off -std=c++17 -DSY1_BENCH_BASELINE -Dsy1=sy1_before -Dwa=wa_before "-DSY1_BENCH_HEADER=\"$base/native/host/sy1_engine.hpp\"" -c native/tests/perf/paired_engine.cpp -o "$out/before-pair.o"
g++ -O3 -ffp-contract=off -std=c++17 "-DSY1_BENCH_HEADER=\"$(pwd)/native/host/sy1_engine.hpp\"" -c native/tests/perf/paired_engine.cpp -o "$out/after-pair.o"
g++ -O3 -ffp-contract=off -std=c++17 native/tests/perf/paired_bench.cpp "$out/before-pair.o" "$out/after-pair.o" "$out"/obj/*.o -lm -pthread -o "$out/paired-bench"
