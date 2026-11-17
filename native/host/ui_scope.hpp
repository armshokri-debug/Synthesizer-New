// Latest oscilloscope snapshot, never a lock or an allocation in the audio callback.
#pragma once
#include <array>
#include <atomic>
#include <cstddef>
#include <vector>

namespace sy1 {
class UiScope {
 public:
  static constexpr size_t historySize = 1024, size = 256;
  // Single audio producer. Retain history; publish only when the editor asks.
  void push(const float* left, const float* right, size_t count) {
    for (size_t i = 0; i < count; ++i) {
      history_[pos_] = 0.5f * (left[i] + right[i]);
      pos_ = (pos_ + 1) % historySize;
    }
    if (!requested_.exchange(false, std::memory_order_acquire)) return;
    auto& snapshot = slots_[producer_];
    for (size_t i = 0; i < size; ++i) snapshot[i] = history_[(pos_ + i * (historySize / size)) % historySize];
    producer_ = middle_.exchange(producer_ | dirty, std::memory_order_acq_rel) & indexMask;
  }
  // Single message-thread consumer. Producer and consumer always own different slots.
  std::vector<float> take() {
    if (middle_.load(std::memory_order_acquire) & dirty)
      consumer_ = middle_.exchange(consumer_, std::memory_order_acq_rel) & indexMask;
    const auto& snapshot = slots_[consumer_];
    std::vector<float> result(snapshot.begin(), snapshot.end());
    requested_.store(true, std::memory_order_release);
    return result;
  }
 private:
  static constexpr unsigned dirty = 4, indexMask = 3;
  static_assert(std::atomic<unsigned>::is_always_lock_free && std::atomic<bool>::is_always_lock_free,
                "Scope exchange must be lock-free");
  std::array<float, historySize> history_{};
  std::array<std::array<float, size>, 3> slots_{};
  size_t pos_ = 0;
  unsigned producer_ = 0, consumer_ = 2;
  alignas(64) std::atomic<unsigned> middle_{1};
  alignas(64) std::atomic<bool> requested_{false};
};
}
