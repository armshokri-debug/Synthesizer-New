#include "../host/sy1_engine.hpp"
#include <cassert>
#include <fstream>
#include <iostream>
#include <iterator>
#include <thread>
#include <vector>

static std::string readFile(const char* path) {
  std::ifstream file(path);
  return {std::istreambuf_iterator<char>(file), {}};
}

int main() {
  // Cached wrappers must resolve replaced globals and preserve job boundaries.
  {
    sy1::WaJs js(48000);
    assert(js.eval("globalThis.__takeDirty=()=> '1'; globalThis.__dumpStorage=()=> 'first'; globalThis.SY1E={flushPatchSave(){globalThis.flushed=true;Promise.resolve().then(()=>globalThis.job=true);}};").empty());
    assert(js.takeStorageDirty());
    assert(js.dumpStorage() == "first");
    js.flushPatchSave();
    assert(js.evalString("String(flushed && job)") == "true");
    assert(js.eval("__takeDirty=()=>'';__dumpStorage=()=> 'replacement';").empty());
    assert(!js.takeStorageDirty());
    assert(js.dumpStorage() == "replacement");
    assert(js.eval("__dumpStorage=()=>{throw Error('expected')};").empty());
    assert(js.dumpStorage().empty());
    assert(js.eval("__dumpStorage=()=> 'recovered';").empty());
    assert(js.dumpStorage() == "recovered");
  }
  const auto shim = readFile("native/js/wa-shim.js");
  const auto bundle = readFile("native/js/dist/engine.js");
  assert(!shim.empty() && !bundle.empty());
  sy1::Sy1Engine engine;
  std::string error;
  assert(engine.init(48000, shim, bundle, "", error));
  const auto initial = engine.state();
  assert(!initial.empty());
  // A stopped renderer returns its last state at the existing bounded timeout.
  assert(engine.freshState(0) == initial);
  std::atomic<unsigned> snapshots{0};
  std::vector<std::thread> readers;
  for (int i = 0; i < 3; ++i) {
    readers.emplace_back([&] {
      for (int request = 0; request < 30; ++request) {
        auto state = engine.freshState(1000);
        assert(!state.empty() && state.front() == '{' && state.back() == '}');
        ++snapshots;
      }
    });
  }
  float left[128], right[128];
  unsigned block = 0;
  while (snapshots.load() < 90) {
    if (block % 16 == 0) {
      engine.hostCall("setSynthParam", "[\"cutoff\"," + std::to_string(200 + block % 10000) + "]");
      engine.hostCall("setSynthParam", "[\"res\"," + std::to_string(block % 20) + "]");
    }
    engine.process(left, right, 128, [](int) {});
    ++block;
    std::this_thread::yield();
  }
  for (auto& reader : readers) reader.join();
  // A host save must flush the most recent debounced knob changes immediately.
  engine.hostCall("setSynthParam", "[\"cutoff\",1234]");
  engine.hostCall("setSynthParam", "[\"res\",7]");
  std::string saved;
  std::atomic<bool> savedDone{false};
  std::thread saver([&] { saved = engine.freshState(1000); savedDone.store(true); });
  while (!savedDone.load()) engine.process(left, right, 128, [](int) {});
  saver.join();
  assert(saved.find("\\\"cutoff\\\":1234") != std::string::npos);
  assert(saved.find("\\\"res\\\":7") != std::string::npos);
  assert(engine.js()->eval("globalThis.__saved = JSON.parse(" + sy1::Sy1Engine::quote(saved) + ");").empty());
  assert(engine.js()->evalString("JSON.stringify(__saved)") == saved);
  sy1::Sy1Engine restored;
  assert(restored.init(48000, shim, bundle, saved, error));
  assert(restored.js()->evalString("String(SY1E.getSynthPatch().cutoff)") == "1234");
  assert(restored.js()->evalString("String(SY1E.getSynthPatch().res)") == "7");
  std::cout << "PASS: cached state calls, exceptions, promise order, 90 concurrent save requests, latest cutoff/resonance flush and project-state restore\n";
}
