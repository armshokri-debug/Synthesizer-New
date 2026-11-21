// SY-1 native — the plugin's sound engine: the web app's engine (js/dist/engine.js)
// running in QuickJS on native/wa, driven in 128-frame blocks.
//
// All JavaScript runs on the audio thread. Other threads hand calls in through
// post() (a short mutex, try-locked by the audio thread so it never waits).
#pragma once
#include <cmath>
#include <cstdio>
#include <atomic>
#include <chrono>
#include <thread>
#include <cstring>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

#include "wajs.hpp"
#include "ui_events.hpp"
#include "ui_scope.hpp"
#include "state_snapshots.hpp"

namespace sy1 {

class Sy1Engine {
 public:
  Sy1Engine() {
    in_.reserve(256);
    drainScratch_.reserve(256);
  }
  /** Build the engine. storageJson: the saved plugin state ("" = fresh). */
  bool init(double sampleRate, const std::string& shimJs, const std::string& engineJs, const std::string& storageJson, std::string& err) {
    {  // calls queued for the engine being replaced do not carry over
      std::lock_guard<std::mutex> l(inMu_);
      in_.clear();
    }
    js_ = std::make_unique<WaJs>(sampleRate);
    err = js_->eval(shimJs, "wa-shim.js");
    if (!err.empty()) return false;
    err = js_->eval("__loadStorage(" + quote(storageJson) + ");", "<state>");
    if (!err.empty()) return false;
    err = js_->eval(engineJs, "engine.js");
    if (!err.empty()) return false;
    err = js_->eval("globalThis.__ctx = __makeCtx(); SY1E.initMachine(); SY1E.prepareAudio();", "<start>");
    if (!err.empty()) return false;
    fifoPos_ = wa::RQ;  // first sample renders a block
    saveState();
    return true;
  }
  bool ready() const { return js_ != nullptr; }
  WaJs* js() { return js_.get(); }  // tests

  /** Queue an engine call (name + JSON array of arguments) from any thread. */
  void post(const std::string& name, const std::string& argsJson) {
    std::lock_guard<std::mutex> l(inMu_);
    in_.push_back({name, argsJson});
  }
  /** Calls this engine made on its own (DAW MIDI, tempo): the window applies them too. */
  std::vector<std::pair<std::string, std::string>> takeOutgoing() {
    return out_.take();
  }
  /** Last ~1000 output samples (mono) for the window's scope. */
  std::vector<float> scope() {
    return scope_.take();
  }
  /** The plugin state: everything the app saves (machines, patches, banks, settings). */
  std::string state() {
    return states_.read();
  }

  // ---- audio thread ------------------------------------------------------
  /** A call made by the host side on the audio thread (MIDI, tempo, transport). */
  void hostCall(const std::string& name, const std::string& argsJson, double offsetSec = 0) {
    js_->callEngine(name, argsJson, offsetSec);
    out_.push(name, argsJson);
  }
  /** The engine's audio clock (seconds; audio thread). */
  double time() const { return js_->g.ctx.currentTime(); }
  /** MIDI the engine produced since the last call (audio thread). */
  template <class F>
  void takeMidiOut(F&& each) {
    for (const auto& m : js_->midiOut) each(m.b0, m.b1, m.b2, m.t);
    js_->midiOut.clear();
  }
  /** The DAW's clock for the next block (audio thread). */
  void setHostClock(bool playing, double ppq, double bpm) { js_->host.playing = playing; js_->host.ppq = ppq; js_->host.bpm = bpm; }
  /** Render n frames (any block size), one 128-frame engine block at a time. */
  template <class OnBlock>
  void process(float* L, float* R, int n, OnBlock beforeBlock) {
    for (int i = 0; i < n; i++) {
      if (fifoPos_ >= wa::RQ) {
        beforeBlock(i);  // the host applies MIDI events due before this block
        drainIn();
        js_->render(fifoL_, fifoR_);  // runs the JS timers too
        fifoPos_ = 0;
        pushScope();
        idleGc();
        const unsigned requested = saveRequest_.load(std::memory_order_acquire);
        if (requested != saveSeq_.load(std::memory_order_relaxed)) {
          js_->flushPatchSave();  // a knob turned just before the save is in it too
          saveState();
          saveSeq_.store(requested, std::memory_order_release);
        } else if (++blocks_ % 375 == 0 && js_->takeStorageDirty()) {
          saveState();  // about every second at 48 kHz, only when something changed
        }
      }
      // never let a broken value (NaN / infinity) reach the speakers
      const float l = fifoL_[fifoPos_], r = fifoR_[fifoPos_];
      L[i] = std::isfinite(l) ? l : 0.0f;
      R[i] = std::isfinite(r) ? r : 0.0f;
      fifoPos_++;
    }
  }
  /** Save the state now (audio thread, or any thread while audio is not running). */
  void saveState() {
    // Serialization still allocates on the engine thread. Publication alone
    // is isolated from slow host/UI readers; do not use this runtime concurrently.
    states_.publish(js_->dumpStorage());
  }
  /** From another thread (DAW saving the project, window opening): the audio thread saves the
   *  state at its next block; waits up to timeoutMs, then returns whatever state is newest. */
  std::string freshState(int timeoutMs) {
    const unsigned want = saveRequest_.fetch_add(1, std::memory_order_acq_rel) + 1;
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(timeoutMs);
    // Only the requesting host/UI thread waits. The audio thread publishes an
    // atomic completion ticket without a mutex or condition-variable wakeup.
    while (static_cast<int>(saveSeq_.load(std::memory_order_acquire) - want) < 0) {
      if (std::chrono::steady_clock::now() >= deadline) break;
      std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }
    return states_.read();
  }

  static std::string quote(const std::string& s) {
    std::string o = "\"";
    for (char c : s) {
      switch (c) {
        case '"': o += "\\\""; break;
        case '\\': o += "\\\\"; break;
        case '\n': o += "\\n"; break;
        case '\r': o += "\\r"; break;
        case '\t': o += "\\t"; break;
        default:
          if (static_cast<unsigned char>(c) < 0x20) { char b[8]; std::snprintf(b, sizeof b, "\\u%04x", c); o += b; }
          else o += c;
      }
    }
    return o + "\"";
  }

 private:
  std::unique_ptr<WaJs> js_;
  float fifoL_[wa::RQ] = {}, fifoR_[wa::RQ] = {};
  int fifoPos_ = wa::RQ;
  size_t blocks_ = 0;
  unsigned quiet_ = 0;
  std::mutex inMu_;
  struct Call { std::string name, args; };
  std::vector<Call> in_;
  std::vector<Call> drainScratch_;
  UiEvents out_;
  UiScope scope_;
  StateSnapshots states_;
  std::atomic<unsigned> saveRequest_{0}, saveSeq_{0};
  static_assert(std::atomic<unsigned>::is_always_lock_free, "State tickets must be lock-free");

  void drainIn() {
    {
      std::unique_lock<std::mutex> l(inMu_, std::try_to_lock);
      if (!l.owns_lock() || in_.empty()) return;
      drainScratch_.swap(in_);
    }
    for (auto& c : drainScratch_) js_->callEngine(c.name, c.args);
    drainScratch_.clear();
  }
  /** Garbage collection only after a second of silence (never while something sounds). */
  void idleGc() {
    float peak = 0;
    for (int k = 0; k < wa::RQ; k++) peak = std::max(peak, std::max(std::fabs(fifoL_[k]), std::fabs(fifoR_[k])));
    if (peak > 1e-5f) { quiet_ = 0; return; }
    if (++quiet_ == 400) js_->collectGarbage();
  }
  void pushScope() {
    scope_.push(fifoL_, fifoR_, wa::RQ);
  }
};

}  // namespace sy1
