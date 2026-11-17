#include "../host/ui_scope.hpp"
#include <cassert>
#include <iostream>
#include <thread>
#include <algorithm>

int main() {
  sy1::UiScope scope;
  float block[128];
  for (int n = 0; n < 16; ++n) {
    for (int i = 0; i < 128; ++i) block[i] = static_cast<float>(n * 128 + i);
    scope.push(block, block, 128);
  }
  auto empty = scope.take();
  assert(std::all_of(empty.begin(), empty.end(), [](float v) { return v == 0; }));
  for (int i = 0; i < 128; ++i) block[i] = static_cast<float>(2048 + i);
  scope.push(block, block, 128);
  auto latest = scope.take();
  for (size_t i = 0; i < latest.size(); ++i) assert(latest[i] == 1152 + 4 * i);
  // Continuous producer and consumer: every snapshot must be ordered and untorn.
  std::atomic<bool> done{false};
  std::thread audio([&] {
    for (int n = 17; n < 100017; ++n) {
      for (int i = 0; i < 128; ++i) block[i] = static_cast<float>(n * 128 + i);
      scope.push(block, block, 128);
    }
    done.store(true, std::memory_order_release);
  });
  size_t snapshots = 0;
  do {
    const auto values = scope.take();
    assert(values.front() >= latest.front());
    for (size_t i = 1; i < values.size(); ++i) assert(values[i] == values[0] + 4 * i);
    latest = values;
    ++snapshots;
  } while (!done.load(std::memory_order_acquire));
  audio.join();
  std::cout << "Scope: demand-only publication, history wraparound, " << snapshots
            << " untorn concurrent snapshots over 100000 audio blocks passed\n";
}
