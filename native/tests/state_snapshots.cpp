#include "../host/state_snapshots.hpp"
#include <cassert>
#include <iostream>
#include <thread>
#include <vector>

int main() {
  sy1::StateSnapshots states;
  assert(states.read().empty());
  states.publish("first");
  states.publish("latest");
  assert(states.read() == "latest");
  assert(states.read() == "latest");
  constexpr unsigned count = 100000;
  std::atomic<bool> finished{false};
  std::vector<std::thread> readers;
  for (int i = 0; i < 3; ++i) {
    readers.emplace_back([&] {
      unsigned previous = 0;
      while (!finished.load(std::memory_order_acquire)) {
        const auto value = states.read();
        if (value == "latest") continue;
        const auto separator = value.find(':');
        assert(separator != std::string::npos);
        const unsigned sequence = std::stoul(value.substr(0, separator));
        assert(sequence >= previous);
        previous = sequence;
        assert(value.substr(separator + 1) == std::string(1024, char('a' + sequence % 26)));
      }
    });
  }
  for (unsigned i = 1; i <= count; ++i)
    states.publish(std::to_string(i) + ":" + std::string(1024, char('a' + i % 26)));
  finished.store(true, std::memory_order_release);
  for (auto& reader : readers) reader.join();
  assert(states.read() == std::to_string(count) + ":" + std::string(1024, char('a' + count % 26)));
  std::cout << "PASS: 100000 state publications, three concurrent readers, consistent monotonic snapshots\n";
}
