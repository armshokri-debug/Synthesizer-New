// One serialized engine producer and any number of non-audio readers.
// Readers may allocate/copy under their own mutex; publication never takes it.
#pragma once
#include <array>
#include <atomic>
#include <mutex>
#include <string>

namespace sy1 {
class StateSnapshots {
 public:
  void publish(std::string state) {
    slots_[producer_].swap(state);
    producer_ = middle_.exchange(producer_ | dirty, std::memory_order_acq_rel) & indexMask;
  }

  std::string read() {
    std::lock_guard<std::mutex> lock(readers_);
    if (middle_.load(std::memory_order_acquire) & dirty)
      consumer_ = middle_.exchange(consumer_, std::memory_order_acq_rel) & indexMask;
    return slots_[consumer_];
  }

 private:
  static constexpr unsigned dirty = 4, indexMask = 3;
  static_assert(std::atomic<unsigned>::is_always_lock_free, "State publication must be lock-free");
  std::array<std::string, 3> slots_;
  unsigned producer_ = 0, consumer_ = 2;
  std::atomic<unsigned> middle_{1};
  std::mutex readers_;
};
}
