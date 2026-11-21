# SY-1 real-time audit and conservative fixes

Baseline: `c3f7c3e883b8185c543144cfa1b46c18883a6e5d` (main inspected on 2026-11-21).
Candidate branch: `fix/realtime-state-publication`.

## Findings grounded in code

These paths establish real-time hazards. They do not by themselves identify the cause of an individual hardware dropout. The user's reported six simultaneous instances, severe crackling at buffer 32, and improvement to approximately 13% CPU at buffer 256 are user observations, not measurements reproduced in this environment.

| Priority | Evidence at the baseline | Consequence | Status |
|---|---|---|---|
| High | `native/host/sy1_engine.hpp:98-105,116-128`: render calls saveState; __dumpStorage is evaluated and stateMu_ is locked. state()/freshState() copy the string under the same mutex. Saving also locks again and notifies a condition variable. | A host/UI reader holding the mutex can block audio publication. Serialization and compilation allocate in an audio callback. | Removed the shared audio/read mutex and audio-side condition-variable notification. Removed repeated expression compilation. JSON serialization and string allocation/free remain on the engine thread. |
| High | `native/host/wajs.hpp:94-123` at baseline: each engine call builds a JS string, parses JSON, executes JS, frees values and drains pending promise jobs; each render runs timers and drains jobs. | Rapid Cutoff/Resonance UI events and CC automation cause interpreter/allocation work on audio. Promise draining has no fixed upper work bound. | General event delivery and job ordering retained. No event dropping, coalescing, smoothing change or cross-thread access to the QuickJS runtime introduced. |
| High | `src/engine/synth.ts:79-100` plus baseline `native/js/wa-shim.js:165-179`: each patch change cancels/reschedules a 300 ms save timeout. clearTimeout filters the entire timer array into a new array. A due save stringifies the patch on audio. | Unnecessary replacement-array allocations on rapid knob movements, followed by timer-driven serialization. | Cancellation uses stable in-place compaction. Timer objects, due-timer arrays and patch serialization still allocate. |
| High | `native/host/sy1_engine.hpp:89-105` and `plugin/Source/PluginProcessor.cpp:183-211`: the engine renders 128 frames in the callback that exhausts its FIFO, even when host buffer is 32. | Work is concentrated into one of every four 32-frame host callbacks. At 48 kHz, that callback has about 667 us; at buffer 256 each callback has about 5333 us. Six instances add load, with actual host scheduling depending on routing. | Quantization and original timing retained to preserve sound and MIDI. This remains a key limitation for buffer 32. |
| High | `native/host/sy1_engine.hpp` idleGc() and `native/host/wajs.hpp:136` at baseline: manual full GC runs in the callback after 400 quiet quanta. Sweep traverses the graph every 64 quanta and can delete nodes and grow scratch storage. | A quiet instance's maintenance can still consume CPU needed by other sounding instances. Graph changes may allocate/free in audio. | Open. Automatic cycle GC is already disabled via JS_SetGCThreshold(-1). Reference-count frees may still occur. Moving runtime access to another thread without a handoff would be unsafe. |
| High | `plugin/Source/PluginProcessor.cpp:185-186,261-284`: lifecycle_ is try-locked in processBlock; failure clears audio/MIDI. Restore holds it while constructing an engine. | Rendering does not wait for this lock, but concurrent restore can explicitly produce silent buffers. | Open; changing replacement semantics requires a separate prepared-engine handoff and recall tests. |
| Medium | `plugin/Source/PluginProcessor.cpp:119-125,191,231,249-259`: MIDI dispatch creates strings, JUCE messages may allocate for long messages, output stable_sort may allocate, getStateInformation builds/parses JSON. | Reserved vectors are not proof of globally allocation-free audio. A host requesting state on its audio thread can also hit the existing freshState timeout. | Open. Preserve MIDI ordering and host-state behavior until separately tested. |
| Medium | `native/host/ui_scope.hpp:13-23` writes history every quantum; `PluginEditor.cpp:141-171` marshals scope/event values on the message thread when visible. UI mirroring can fill its bounded queue. | UI CPU and background scope bookkeeping can add load. Its size does not establish the observed dropout cause. | Existing hidden-page guard and lock-free scope retained. No evidence here that WebKit is the dominant problem. |

## Implemented changes

1. `StateSnapshots` exchanges three separately owned string slots. One serialized engine producer publishes via a lock-free atomic exchange. Concurrent host readers use their own reader mutex and own the consumer slot while copying it. Audio never acquires that reader mutex. This exchange still destroys an old producer string and state generation still allocates. It is not an entirely allocation-free state save.
2. State requests use atomic generation/completion tickets. The host reader waits at most the existing timeout using 1 ms polling, then reads the newest snapshot. Audio publishes the captured generation after flushing and serializing state. Requests arriving during that save remain pending for a later quantum. This changes host waiting from a condition variable to bounded polling; audio does not notify a waiting thread.
3. Dirty checks, storage dumps and pending patch flushes call precompiled QuickJS wrappers. Globals are resolved when invoked. Flush preserves its previous promise-job drain boundary; dirty/dump calls preserve their previous lack of job drain.
4. Timer cancellation compacts in order. The existing due-list boundary, interval behavior, callback order and nested timer behavior remain intact. No incoming control event is throttled.

No native DSP sample formulas, parameter IDs, preset format or latency were edited. All production changes are in native host/shim code. The CMake changes register the two state tests under SY1_TESTS. Publication APIs require one serialized producer, as the existing lifecycle lock already provides.

## Validation performed

Environment: Linux x86_64, GCC C++17, QuickJS from the repository, Bun 1.3.3. Native DSP compiled with `-ffp-contract=off`. This task did not build a macOS VST3, run JUCE's plugin host test, pluginval, or access the user's Ableton.

- PASS: 40 full-engine bit-identical comparisons against the pinned baseline, with separate baseline/candidate shims. Scenes: idle, chord, Hold, sustain, effects tails, dense CC, drums, and rapid Cutoff/Resonance edits. Buffers: 32/64/128/256/512 at 48 kHz. The renderer is seeded equally and warmed for two seconds, then compared for one second per case. This is finite regression coverage, not every preset or automation sequence.
- PASS: 100,000 state publications with three concurrent readers; monotonic untorn variable-content snapshots. AddressSanitizer/UndefinedBehaviorSanitizer passed with leak detection disabled. LeakSanitizer could not run because this environment uses ptrace; no leak-check claim is made.
- PASS: 90 simultaneous-reader save requests during rendering and parameter changes; stopped-render timeout; immediate flush of most recent Cutoff/Resonance changes; JSON round trip and new-engine restore of those values. Wrapper tests cover replaced globals, exceptions, and flush promise order.
- PASS: 10,000 debounce cancellations retain baseline callback timing/order and remove 10,000 replacement filter arrays (zero such arrays in the candidate cancellation loop). This does not remove the timeout objects.
- PASS: existing scope concurrency/history test over 100,000 audio blocks and UI event queue test over 100,000 events.
- PASS: existing delay (4,068,864 samples), IIR (2,073,600 samples), oscillator (460,800 frames), FIR (833,280 samples), HQ scalar/stereo comparison (6,912,000 output samples), and synchronous/deferred worklet dispatch tests.
- PASS: TypeScript lint, Vite build and git diff whitespace checks. The build produced an existing Vite configuration warning about __dirname. Test registration in CMake was source-reviewed; a full CMake/JUCE build remains pending.

Raw paired benchmark results: [paired.json](../native/tests/perf/results/rt-state/paired.json). Six serial engines, 48 kHz, buffers 32 and 256, four scenes, two measured simulated seconds after two-second warmup. AB/BA order alternates each callback. This is one short trial per case on a shared Linux host, excludes editor/JUCE costs, and is not Ableton's parallel scheduler. Mean, p95/p99, worst wall time, thread CPU, and aggregate deadline misses are recorded without trimming outliers. Mean CPU savings in rapid-knob tests were small; worst wall time is inconsistent across scenes, including a regression in dense CC at 256. No across-the-board spike improvement or dropout fix is established. Both versions still exceed the serial callback budget under dense load, especially at buffer 32. Do not translate these numbers to an Ableton CPU percentage.

## Reproduce from repository root

```sh
# One-time test dependency, if bun is not already installed:
# npm install --no-save --package-lock=false bun@1.3.3
bun native/js/build.ts
git worktree add --detach ../rt-baseline c3f7c3e883b8185c543144cfa1b46c18883a6e5d
bash native/tests/perf/build.sh "$(cd ../rt-baseline && pwd)" /tmp/sy1-rt-bench
c++ -O3 -ffp-contract=off -std=c++17 native/tests/perf/engine_exact.cpp /tmp/sy1-rt-bench/before-pair.o /tmp/sy1-rt-bench/after-pair.o /tmp/sy1-rt-bench/obj/*.o -lm -pthread -o /tmp/sy1-rt-bench/engine-exact
/tmp/sy1-rt-bench/engine-exact ../rt-baseline/native/js/wa-shim.js
c++ -O2 -std=c++17 -pthread native/tests/state_snapshots.cpp -o /tmp/sy1-state-snapshots
/tmp/sy1-state-snapshots
c++ -O2 -ffp-contract=off -std=c++17 -pthread native/tests/state_runtime.cpp /tmp/sy1-rt-bench/obj/*.o -lm -o /tmp/sy1-state-runtime
/tmp/sy1-state-runtime
node native/tests/timer_cancel.mjs
bash native/tests/perf/check_cpu_fix.sh
npm run lint
npm run build
```

The benchmark's optional final argument is the baseline shim path, e.g. `/tmp/sy1-rt-bench/paired-bench 6 48000 32 knobs 2 ../rt-baseline/native/js/wa-shim.js`. Preserve the actual sample rate/buffer in any comparison. With prepared plugin resources and JUCE dependencies, configure SY1_TESTS=ON, build test targets, and run CTest; the new state-runtime test expects the bundle produced by native/js/build.ts (also invoked by plugin/prepare.sh).

## Final acceptance still needed in Ableton

After a separately authorized macOS build and candidate installation, confirm loaded binary path/hash. Use a copy of the same saved project and compare baseline/candidate at identical sample rate, output device, routing, buffer and MIDI sequence. Test one and six-to-eight instances, buffers 32/128/256, editor open/closed, repeated rapid Cutoff/Resonance movements and recorded automation. Include save during playback immediately after a knob edit, then reopen the project and verify preset/bank/mapping, macro automation, MIDI timing and recorded audio. Use at least three 60-second playback repetitions and record CPU meter, audible glitches and overload indicator. Per-callback p99/max and overrun measurements need a native timing capture or Instruments; stack-sampling counts cannot measure that latency distribution.

If buffer 256 is clean and 32 remains unreliable, report that operating limit alongside per-callback evidence. Complete removal of JSON/interpreter work from audio requires a larger design (prepared state snapshots/control handoff with preserved event timing), not merely changing GC threshold or running the same QuickJS runtime from a worker. The remaining hazards are explicitly open.

Only the candidate branch is to be published. Main, deployment workflows, installer and installed binaries are outside this change.
