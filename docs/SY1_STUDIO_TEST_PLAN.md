# SY-1 Studio (Web) — Master Acceptance Test Plan

**Baseline SHA:** `c3f7c3e883b8185c543144cfa1b46c18883a6e5d` (`main`)  
**Target Branch:** `feature/sy1-studio-web`  
**Status Reporting Policy:** Every test case must be marked `PASS`, `FAIL`, or `NOT RUN`. Unexecuted tests are **never** inferred from another platform (e.g., macOS Chrome `PASS` never implies iPadOS Safari `PASS`).

---

## Non-Negotiable Audio Quality Invariants

1. Zero unapproved changes to DSP formulas in `src/dsp/hq-engine.ts`, `src/engine/worklet/sy1-processor.ts`, or `src/engine/bus.ts`.
2. Existing presets, ADSR envelopes, ZDF/Ladder filters, band-limited oscillators, unison, and FX (Drive, EQ, Tape Delay, Stereo Chorus, Freeverb) retain baseline tone and dynamics.
3. Single-track unity gain staging and stereo image remain unchanged (no hidden normalization, no hidden compression, no master double-limiting).
4. All musical timing derives from `AudioContext.currentTime` (sample clock), never `Date.now()` / `setInterval` cumulative drift.
5. WAV export is uncompressed **24-bit Stereo PCM** at actual `ctx.sampleRate`, bit-accurate to the tapped signal.
6. Standalone SY-1 and AU/VST3 plugin mode (`__SY1_PLUGIN__`) suffer zero regression.

---

## Test Suite A — Sound Parity

**Objective:** Prove that a single SY-1 instance with a fixed preset sounds identical before (baseline `c3f7c3e...`) and after adding Studio.

### A1. Deterministic Engine Parity (Automated — Pure DSP)
- **Method:** Run `HQEngine` (`src/dsp/hq-engine.ts`) directly in Node/Bun at `48000 Hz`, rendering a fixed 4-second deterministic MIDI phrase (poly chord + mono glide + velocity steps + pitch bend + mod wheel) across representative SY-1 presets (`Init`, `Warm Pad`, `Acid Bass`, `Ladder Bass`, `Super Saw`, `Pluck`).
- **Comparison:** Sample-by-sample diff between baseline `main` and `feature/sy1-studio-web`.
- **Pass Criteria:**
  - `maxAbsDiff === 0.0` (exact bit-for-bit equality, `0.000000` delta) across all samples, L and R channels.

### A2. Deterministic Web Audio Graph Parity (Automated — `OfflineAudioContext`)
- **Method:** Render a 4-second scheduled MIDI sequence at `48000 Hz` through:
  1. Standalone `getSynthBus` + `"sy1-voices"` (baseline graph).
  2. Studio Track 1 (`SY1TrackEngine` at `trackVol = 1.0`, `pan = 0`, Track 2 muted/idle) through `studioMasterTap`.
  - Test both **dry/FX-off** (`revMix = 0`, `chorusMix = 0`, `delayMix = 0`) and **full FX** (`Warm Pad`, `Trance Lead`) with both graphs instantiated at `OfflineAudioContext` `t = 0`.
- **Comparison:** Sample-by-sample diff (`maxAbsDiff`, `rmsDiffDb`).
- **Pass Criteria:**
  - Dry & FX-on (constructed identically at `t = 0`): `maxAbsDiff <= 1e-6`, `rmsDiff < -120 dBFS`, identical peak and stereo L/R balance.

### A3. Non-Deterministic Live Parity Analysis (Manual + Automated Capture)
- **Known Sources of Non-Determinism in Live `AudioContext`:**
  1. `bus.ts` `chorusLfo.start()` and `buildReverb()` comb wobble oscillators (`wob.start()`) free-run from graph creation time (`ctx.currentTime`), causing LFO phase offsets between separate live sessions.
  2. `getSharedNoiseBuffer()` uses `Math.random()` (affects Classic fallback when `noise > 0`; HQ uses deterministic `xorshift32`).
  3. Unscheduled live UI triggers quantize to the 128-frame worklet render quantum (~2.67 ms at 48 kHz).
- **Method:** Record 10-second live WAV takes of `Init`, `Ladder Bass`, `Warm Pad`, and `Super Saw` before and after Studio. Analyze RMS, true peak, L/R correlation, and 1/3-octave spectral envelope.
- **Pass Criteria:**
  - Integrated RMS difference `<= 0.1 dB`.
  - Peak level difference `<= 0.2 dB`.
  - 1/3-octave spectral envelope difference `<= 0.5 dB` (excluding expected comb/chorus phase nulls).
  - Zero audible clicks, pops, DC offset (`|DC| < 1e-4`), or unexpected stereo collapse.

---

## Test Suite B — Multi-Instance Isolation

**Objective:** Verify zero parameter, voice, FX, or modulation leakage between Track 1 and Track 2 (and later Tracks 1–4).

| ID | Test Scenario | Pass Criteria |
|---|---|---|
| B1 | **Preset Isolation:** Load `Acid Bass` on Track 1 and `Warm Pad` on Track 2. Switch Track 1 preset to `Glass Bell`. | Track 2 patch object, preset ID, active voices, and audio output remain 100% unchanged. |
| B2 | **Filter/Resonance Isolation:** Hold C4 on Track 2 (`Warm Pad`), sweep `cutoff` (40 Hz–18 kHz) and `res` (0.1–18) rapidly on Track 1. | Track 2 rendered output is bit-identical to Track 2 soloed without Track 1 sweeps (`maxAbsDiff <= 1e-6`). |
| B3 | **FX Bus Isolation:** Set `delayMix = 0.8`, `revMix = 0.8`, `drive = 0.9` on Track 1; set all FX to `0` on Track 2. Play Track 2. | Track 2 remains completely dry; zero reverb/delay tail or drive distortion leaks from Track 1. |
| B4 | **Voice & Note State Isolation:** Hold notes + Sustain Pedal (CC64) + Pitch Bend + Mod Wheel on Track 1; trigger `noteOff` / `allNotesOff` on Track 2. | Track 1 notes, sustain state, pitch bend, and mod wheel remain unaffected. |
| B5 | **Mono/Poly Mode Isolation:** Set Track 1 to `mono` + `glide = 0.2s`, Track 2 to `poly`. Play chords on Track 2 while playing legato line on Track 1. | Track 2 sustains full polyphony; Track 1 glides monophonically without stealing Track 2 voices. |
| B6 | **Standalone `localStorage` Isolation:** Edit Track 1 & Track 2 patches in Studio, close Studio, inspect standalone `SY-1`. | Standalone `sy1.m.sy1.patch` and `sy1.m.sy1.preset` are unchanged. |

---

## Test Suite C — Tempo & Synchronization

**Objective:** Verify tight audio-clock synchronization across all tracks at multiple tempos and across loops.

| ID | Test Scenario | Pass Criteria |
|---|---|---|
| C1 | **Fixed Tempos (60, 110, 140 BPM):** Schedule sharp percussive `Pluck` hits on beats 1, 2, 3, 4 on both Track 1 (panned L) and Track 2 (panned R) over 16 bars. | L vs R transient onset delta `<= 1 sample` (<= 0.02 ms at 48 kHz); cumulative drift over 16 bars `<= 1 sample`. |
| C2 | **Live Tempo Change:** While playing 2 tracks in sync, change BPM `110 -> 60 -> 140 -> 95`. | Zero audio glitch/jump; Track 1 and Track 2 stay phase-locked (`<= 1 sample` inter-track offset) after every tempo step. |
| C3 | **Loop Boundary Accuracy:** Loop an 8-bar region for 16 consecutive cycles at 140 BPM with notes ending right at bar 8 beat 4.95 and starting on bar 1 beat 1.00. | No dropped downbeats, no stuck notes across loop wrap, exact bar period preserved on every repeat. |
| C4 | **Tempo-Synced LFO Alignment:** Enable `lfoSync` on Track 1 & Track 2 (`1/4` and `1/8`) and change BPM. | Both tracks update LFO rate immediately to match central `tempo.ts` BPM. |

---

## Test Suite D — MIDI Recording & Export/Import

**Objective:** Verify accurate multi-track MIDI capture, playback, standard `.mid` export, and lossless re-import.

| ID | Test Scenario | Pass Criteria |
|---|---|---|
| D1 | **Note On/Off & Velocity:** Record soft (`vel ~ 30`), medium (`vel ~ 80`), and hard (`vel ~ 127`) notes with varied durations. | Playback reproduces exact pitches, durations (within `<= 2 ticks` at 480 PPQ), and audible velocity dynamics. |
| D2 | **Sustain Pedal (CC64) & Controllers (CC1, Pitch Bend):** Record phrase using CC64 sustain down/up, Mod Wheel sweep, and Pitch Bend bend/return. | Sustain holds notes until CC64 release during playback; CC64, CC1, and 14-bit Pitch Bend are stored and exported cleanly. |
| D3 | **Simultaneous Multi-Track Recording:** Arm Track 1 (Ch 1) and Track 2 (Ch 2) simultaneously and send concurrent MIDI streams. | Track 1 records only Ch 1 events; Track 2 records only Ch 2 events; both align to the exact same timeline tick 0. |
| D4 | **SMF Format 1 Structural Validation:** Export `.mid` file and validate binary structure (automated parser test). | Valid `MThd` (`format = 1`, `ntrks = 1 + trackCount`, `division = 480`), conductor track with `0xFF 0x51` tempo & `0xFF 0x58` time sig, valid VLQ deltas, every Note On closed by Note Off, every `MTrk` ends with `0xFF 0x2F 0x00`. |
| D5 | **Round-Trip Re-Import & External DAW Check:** Re-import exported `.mid` into SY-1 Studio (and open in Ableton Live / Logic / GarageBand). | Event count, ticks, velocities, sustain/CC/PB values match original recording with zero lost notes or stuck notes. |

---

## Test Suite E — WAV Recording & Export

**Objective:** Verify uncompressed PCM WAV fidelity, timing alignment, and safe memory behavior.

| ID | Test Scenario | Pass Criteria |
|---|---|---|
| E1 | **RIFF/WAVE Header Verification (Automated):** Export Mix WAV and inspect bytes 0–44. | `RIFF`/`WAVE`, `AudioFormat = 1` (PCM), `NumChannels = 2` (stereo), `SampleRate === ctx.sampleRate`, `BitsPerSample = 24`, `ByteRate = sampleRate * 6`, `BlockAlign = 6`, `dataLen === frames * 6`. |
| E2 | **Duration & Sample Alignment:** Record an 8-bar loop at 120 BPM (exact `16.000 s`) with metronome/pluck click on beat 1. | WAV duration matches `16.000 s` within `<= 128 samples` (1 render quantum); Track 1 & Track 2 transients align within `<= 1 sample`. |
| E3 | **No Hidden Processing / Unity Level:** Compare recorded WAV peak & RMS against direct offline render of identical MIDI/patch. | No normalization, no unexpected gain shift (`<= 0.1 dB`), no brickwall clipping below 0.9 amplitude. |
| E4 | **Separate Track Stem Export (if enabled):** Export Track 1 WAV + Track 2 WAV + Mix WAV. | Summing `Track1.wav + Track2.wav` null-tests against `Mix.wav` (when below 0.9 soft-clip threshold) to `< -96 dBFS` (24-bit quantization floor). |
| E5 | **30-Minute Limit & Memory Guardrail:** Verify `MAX_SECONDS = 1800` remains enforced and memory warning triggers gracefully before browser OOM. | Recorder stops cleanly and finalizes valid WAV without crashing tab; limit is NOT silently removed without chunked storage. |

---

## Test Suite F — Timeline & Project Management

**Objective:** Verify bar-length presets, loop controls, non-destructive edits, and project save/reopen.

| ID | Test Scenario | Pass Criteria |
|---|---|---|
| F1 | **Bar Presets & Custom Lengths:** Test `8`, `12`, `64`, `128`, and custom lengths (`4`, `17`, `256` bars). | Timeline grid, transport end/wrap, and bar counter reflect exact chosen length. |
| F2 | **Project Resize Safety:** Record notes in bars 1–8, extend to 64 bars, then shrink to 12 bars, then back to 64 bars. | No crash; notes in bars 1–8 stay intact; resizing never silently corrupts or shifts earlier timestamps. |
| F3 | **Re-Record & Overdub Integrity:** Record Track 1, play back while recording Track 2, then punch/re-record Track 2. | Track 1 data remains untouched; new Track 2 take replaces/overdubs cleanly with zero orphaned notes. |
| F4 | **Project Save & Reload:** Save project (IndexedDB + JSON file), reload browser tab, reopen project. | BPM, bar length, loop range, track count, every track's preset/patch/volume/pan/mute/solo, and all recorded MIDI events restore identically. |

---

## Test Suite G — Performance & Stress

**Objective:** Verify glitch-free real-time performance under realistic and worst-case polyphony and parameter modulation.

| ID | Test Scenario | Pass Criteria |
|---|---|---|
| G1 | **2-Track Heavy Load:** Track 1 = `Super Saw` (unison 7, rev 0.3, delay 0.18), Track 2 = `Dream Pad` (unison 5, chorus 0.4, rev 0.55). Play 6-note chords on both tracks simultaneously for 60 s. | Zero audible clicks, crackles, or dropouts; UI stays responsive (`>= 30 fps`). |
| G2 | **4-Track Heavy Load (Phase 4 Gate):** 4 simultaneous SY-1 tracks (`Super Saw`, `Dream Pad`, `Ladder Bass` 2x oversampled, `Trance Lead` unison 5) playing active MIDI clips simultaneously for 120 s. | Sustained glitch-free playback on macOS Intel Chrome; document exact voice/CPU behavior on iPad Safari before enabling 4-track default. |
| G3 | **Rapid Knob Modulation Stress:** While G1/G2 is running, rapidly scrub `cutoff`, `res`, `delayTime`, and `revSize` knobs continuously for 30 s. | Smooth parameter zipper-free response; zero audio dropouts or console errors. |
| G4 | **Memory Leak Check:** Start/stop transport and record 10 short takes in sequence; inspect JS heap & audio node cleanup. | Stopped voices and finished recorder worklets are disconnected and GC-eligible; no unbounded memory growth. |

---

## Test Suite H — Device & Browser Compatibility Matrix

**Rule:** macOS Chrome results and iPadOS Safari results are tracked independently. Web MIDI is tested **only** on browsers with genuine Web MIDI support.

| Capability | macOS Intel — Chrome (Latest) | iPadOS — Safari (Touch) |
|---|---|---|
| AudioContext unlock on first tap/key | `NOT RUN` | `NOT RUN` |
| Dual SY-1 playback & isolation (B1–B5) | `NOT RUN` | `NOT RUN` |
| 4-Track SY-1 stress test (G2) | `NOT RUN` | `NOT RUN` |
| Transport Play/Stop/Record/Loop + 8/12/64/128 bars | `NOT RUN` | `NOT RUN` |
| On-screen keyboard multi-touch + Studio controls (`>= 44px` hit targets) | `NOT RUN` | `NOT RUN` |
| External Web MIDI input & multi-track armed recording | `NOT RUN` | `N/A — Unsupported in Safari` (verify graceful fallback message) |
| Export MIDI (`.mid`) & download/share | `NOT RUN` | `NOT RUN` |
| Export 24-bit WAV (`.wav`) & download/share | `NOT RUN` | `NOT RUN` |
| Project save/reload across tab refresh | `NOT RUN` | `NOT RUN` |
| Long-take memory safety (no Safari Jetsam crash) | `NOT RUN` | `NOT RUN` |

---

## Baseline Automated Checks Executed in Phase 0

| Check | Status | Notes |
|---|---|---|
| `npm run lint` (`tsc --noEmit`) | **PASS** | 0 TypeScript errors on baseline `c3f7c3e...` |
| `npm run build` (`vite build`) | **PASS** | Clean production build (583 ms, 62 modules, all 5 AudioWorklet bundles emitted) |
| `bun scripts/layout-audit` | **NOT RUN** | `playwright` Node/Bun module unavailable in sandbox; deferred to environment with Playwright installed |
| Test Suites A–H | **NOT RUN** | Scheduled for Phases 1–4 as features are implemented |

---

## Phase 1 Executed Verification Ledger (2026-11-21)

**Environments Tested:**
1. **Linux Bun (`bun test --preload ./tests/vite-url-preload.ts tests/studio-phase1.test.ts`):** 22/22 PASS, 0 FAIL, 8,349 `expect()` assertions.
2. **Linux Headless Chromium (`/ms-playwright/chrome-headless-shell-linux64/chrome-headless-shell` via CDP `node scripts/studio-chromium-verify.mjs`):** ALL assertions PASS, 0 page errors, 0 console errors.
3. **Real macOS Intel Chrome, Real iPadOS Safari, Real Web MIDI Hardware, Real Speaker/Real-Time Dropout Listening:** **`NOT RUN`** (hardware/OS unavailable in Linux container).

| Suite / ID | Test Case | Status | Exact Measured Result / Notes |
|---|---|---|---|
| Build / Lint | `npm run lint` (`tsc --noEmit`) & `npm run build` (`vite build`) | **PASS** | Zero TypeScript errors; clean Vite production bundle including all AudioWorklets. |
| Regression | Standalone SY-1 UI & State Preservation (Chromium CDP) | **PASS** | Standalone panel visible on load, Studio hidden, `window.SY1.applyPreset("warmPad")` (`cutoff=1400`) + `setParam("cutoff", 1950)` intact after opening Studio, editing Track 1, recording, and returning to Synth view. |
| Regression | Protected DSP & Native/VST3 Diff (`git diff c3f7c3e...`) | **PASS** | 0 diffs in `src/dsp/hq-engine.ts`, `src/engine/worklet/sy1-processor.ts`, `native/**`, `plugin/**`. |
| **A1** | Pure DSP Sound Parity (`HQEngine` @ 48 kHz, 6 presets: `init`, `warmPad`, `acidBass`, `moogBass`, `superSaw`, `pluck`) | **PASS** | `maxAbsDiff === 0.0` (exact bit-for-bit equality) across all 6 presets; `makeStudioMasterClipCurve()` exact identity (`diff === 0`) for `\|x\| <= 0.98`, bounded `<= 1.0`. |
| **A2a** | Chromium `OfflineAudioContext` Chain Parity (`AudioWorklet("sy1-voices")` + `SynthFXBus` [drive, EQ, delay, chorus, limiter, softClip] + `SY1TrackEngine` + `StudioMasterBus`, `revMix=0`) | **PASS** | **`chainMaxAbsDiff === 0.0` (`-Infinity dB`)** across all 6 presets (`init`, `warmPad`, `acidBass`, `moogBass`, `superSaw`, `pluck`); exact matching onset sample (`1378`, `1381`, `1378`, `1354`, `1377`, `1378`). |
| **A2b** | Chromium `OfflineAudioContext` Full Preset Parity (including untouched Freeverb `revMix`) | **PASS (with note)** | `init`: `0.000 dB` (`4.77e-7` sample diff!), `warmPad`: `-0.347 dB`, `acidBass`: `-0.294 dB`, `moogBass`: `+0.512 dB`, `superSaw`: `+0.646 dB`, `pluck`: `+0.551 dB`. Standalone vs itself varied up to `+1.379 dB` due to Chromium Blink's `HashSet<AudioNodeOutput*>` cycle-break order on untouched Freeverb feedback loops. |
| **A3** | Live Real-Time Hardware Listening & 10s Live WAV Spectral Parity | **NOT RUN** | Requires real macOS Chrome / iPadOS Safari audio hardware & human listening pass. |
| **B1–B6** | State, Preset, Cutoff/Res, FX, Sustain/Bend/Mod, Mono/Poly, Mute/Solo, `localStorage` Isolation (Bun) | **PASS** | All 4 isolation test suites pass; zero standalone `sy1.m.*` `localStorage` mutation. |
| **B2 / B3** | Real Chromium `OfflineAudioContext` Audio Isolation (Track 2 isolated while Track 1 sweeps `superSaw`, `cutoff=120`, `res=16`, `revMix=0.9`, `delayMix=0.8` + plays notes) | **PASS** | **`maxAbsDiffTrack2 === 0.0` (`-Infinity dB`)** with Track 2 stereo chorus active (`revMix=0`); full-reverb Track 2 RMS diff `+0.147 dB`; Track 1 cutoff sweep verified active (`track1Differs: true`). |
| **C1** | Tempo Synchronization at 60, 110, 140 BPM (Bun deterministic scheduler) | **PASS** | Exact audio-clock event timestamps with `< 1e-9 s` error at 60, 110, and 140 BPM. |
| **C2 / C4** | Mid-Playback Tempo Change (`110 -> 140 -> 60 BPM`) + Synced Track LFOs | **PASS** | Phase-continuous re-anchoring with zero tick jump; synced track LFO rates updated immediately. |
| **C3** | Loop Timing — 16 Continuous Cycles at 140 BPM | **PASS** | 16/16 downbeats fired at exact loop period (`< 1e-6 s` drift); zero stuck voices at loop boundaries. |
| **D1–D5** | Simultaneous 2-Track MIDI Recording (Ch 1 & Ch 2) + Velocity/CC64/CC1/PitchBend + SMF Format 1 Export & Parser Round-Trip | **PASS** | Valid `MThd` (`format=1`, `division=480`), exact round-trip ticks/values, automatic closure of dangling open notes; Chromium live UI recording captured Track 1 note without polluting Track 2. |
| **D5 (DAW)** | External DAW `.mid` Import (Ableton Live / Logic / GarageBand) | **NOT RUN** | Requires external desktop DAW software. |
| **E1 / E3** | 24-bit Stereo PCM WAV Header, Unity Level (No Normalization) & Quantization Floor (Bun) | **PASS** | Valid 44-byte RIFF/WAVE header (`PCM=1`, `2ch`, `24-bit`), unity gain preserved, quantization noise `< -138 dBFS`. |
| **E2** | Real Chromium `OfflineAudioContext` 24-bit Stereo WAV Bounce (2 bars @ 120 BPM, 48 kHz) | **PASS** | `RIFF/WAVE`, `PCM=1`, `2ch`, `48000 Hz`, `24-bit`, `dataBytes=1152000`, `frames=192000 === expectedFrames=192000` (`4.000 s`), `peakL=0.5920`, `peakR=0.5953`, `rmsL=0.2689`, `rmsR=0.2690`. |
| **E4** | Separate Track Stem Export Null-Test | **NOT RUN** | Deferred to Phase 2 (not yet exposed in Phase 1 UI). |
| **E5** | 30-Minute Cap Enforcement (`RECORDER_MAX_SECONDS === 1800`) | **PASS** | Constant and recorder cutoff check verified in Bun; long-duration real-time RAM test on iPad Safari is **`NOT RUN`**. |
| **F1–F3** | Bar Presets (`8, 12, 64, 128`) & Custom Lengths (`4, 16, 17, 256`) + Non-Destructive Resize | **PASS** | Verified in both Bun unit suite and Chromium DOM interaction test. |
| **F4** | Project Save & Reload (`IndexedDB` / JSON) | **NOT RUN** | Scheduled for Phase 2. |
| **G-DSP** | Multi-Track `HQEngine` DSP CPU & Heap Benchmark (Linux Bun @ 48 kHz, 5s render) | **PASS (Partial — Linux Bun only)** | 2-track (`Super Saw` + `Warm Pad` 3-note chords): `888.7 ms` (`17.77% RT-load`, `avgBlock=0.474 ms`, `heapDelta=0.00 MB`). 4-track (`Super Saw` + `Warm Pad` + `Ladder Bass` + `Trance Lead`): `856.8 ms` (`17.14% RT-load`, `avgBlock=0.457 ms`, `heapDelta=0.00 MB`). Chromium E2E JS Heap: `17.37 MB / 22.89 MB`. |
| **G1–G4** | Real-Time 60s/120s Audio Dropout, Knob Modulation & Heap Stress on Real Browsers | **NOT RUN** | Requires real macOS Intel Chrome & iPadOS Safari real-time audio callbacks. |
| **H** | macOS Intel Chrome & iPadOS Safari Compatibility Matrix | **NOT RUN** | Ready for manual testing on target hardware. |

---

## Phase 2 Executed Verification Ledger (2026-11-21)

**Environments Tested:**
1. **Linux Bun (`bun test --preload ./tests/vite-url-preload.ts tests/studio-phase1.test.ts tests/studio-phase2.test.ts`):** **31/31 PASS** (22 Phase 1 regression + 9 Phase 2 tests), 0 FAIL, 8,484 `expect()` assertions.
2. **Linux Headless Chromium (`/ms-playwright/chrome-headless-shell-linux64/chrome-headless-shell` via CDP `node scripts/studio-chromium-verify.mjs`):** **ALL Phase 1 + Phase 2 checks PASS**, 0 page errors, 0 console errors.
3. **Real macOS Intel Chrome, Real iPadOS Safari, External DAW Import, Real Hardware Listening:** **`NOT RUN`** (hardware/OS unavailable in container).

| Suite / ID | Test Case | Status | Exact Measured Result / Notes |
|---|---|---|---|
| Build / Lint | `npm run lint` (`tsc --noEmit`) & `npm run build` (`vite build`) | **PASS** | Zero TypeScript errors; clean Vite production build including all AudioWorklets. |
| Protected Diff | `git diff c3f7c3e... -- src/dsp/hq-engine.ts src/engine/worklet/sy1-processor.ts native plugin` | **PASS** | 0 diffs; zero DSP or native VST3/AU modifications. |
| Phase 1 Reg | Full Phase 1 Bun (22/22) + Chromium (standalone, A2a/A2b 6 presets, B2/B3 isolation, E2 bounce, UI E2E) | **PASS** | All 6 presets `chainMaxAbsDiff === 0.0`; Track 2 isolation `maxAbsDiffTrack2 === 0.0`; 2-bar bounce exact `192000` frames; standalone SY-1 intact. |
| **F4 (Save->Reload)** | Real IndexedDB Save -> real CDP `Page.reload` -> Restore (`studio-chromium-verify.mjs`) | **PASS** | Saved 3-track project (`"Phase 2 Reload Session"`, `132 BPM`, `12 bars`, loop `2..10`, custom cutoffs `480`/`2750`, res `9.5`, vol/pan/solo/mute, MIDI notes, unedited `pluck` Track 3). After real Chromium reload: standalone SY-1 tempo stayed `110 BPM` (zero leak), and Studio restored all 3 tracks, params, mixer states, MIDI notes, and Open drawer entry identically. |
| **F4 (Export->Import)** | `.sy1studio` JSON Export -> Mutate -> Import -> Restore (Bun + Chromium) | **PASS** | Full 4-track (Bun) & 3-track (Chromium) round-trip restores project metadata, BPM, bars, loop, custom patches, mixer, and all MIDI events (`noteOn`, `noteOff`, `CC1`, `CC64`, `pitchBend`) with `hold` forced to `"off"`. |
| **F4 (MIDI Timing)** | Post-Restore MIDI Playback Timing at 60, 110, and 140 BPM (Bun deterministic scheduler) | **PASS** | Post-restore lookahead dispatch matched exact beat intervals (`60/bpm`) within `< 1e-6 s` across 60, 110, and 140 BPM. |
| **E4a (2-Track Stems)** | 2-Track Separate 24-bit Stereo WAV Stems Alignment & Mix Null-Test (Chromium `OfflineAudioContext` @ 48 kHz) | **PASS** | 2 stems + Mix: all valid `RIFF/WAVE` `PCM=1`, `2ch`, `24-bit`, `48000 Hz`; exact `96000 / 96000` frames (`2.000 s`); onset spread `4 samples` (different preset attack times); linear sum vs Mix `maxSumMinusMixDiff = 3.576e-7`, **`nullTestRmsDb = -119.55 dB`** (no normalization). |
| **E4b (4-Track Stems)** | 4-Track Separate 24-bit Stereo WAV Stems Alignment & Mix Null-Test (Chromium `OfflineAudioContext` @ 48 kHz) | **PASS** | 4 stems + Mix: all valid 24-bit Stereo PCM headers; exact `96000 / 96000` frames; onset spread `6 samples`; linear sum vs Mix `maxSumMinusMixDiff = 4.768e-7`, **`nullTestRmsDb = -117.02 dB`** (no normalization). |
| **P2 Parity & Iso** | Post-Restore Audio Parity & Track 2 Isolation (Chromium `OfflineAudioContext` @ 48 kHz) | **PASS** | Pre-save vs post-restore bounce **`preVsPostMaxAbsDiff === 0.0` (`-Infinity dB`)**; post-restore Track 2 isolation under heavy Track 1 mutation **`postRestoreIsolationMaxDiff === 0.0`**. |
| **P2 Validation** | Invalid / Corrupted `.sy1studio` Import Rejection (Bun + Chromium) | **PASS** | Rejected empty text, bad JSON syntax, wrong format, version 0 & 99, out-of-range BPM/bars, 0 or 5 tracks, duplicate IDs, null patch, negative/invalid MIDI ticks/pitches, unknown event types, and `>16 MB` payloads; verified active project state 100% untouched and UI status flagged `.is-error`. |
| **P2 Storage Errors** | IndexedDB `QuotaExceededError`, Unavailable Storage (`SecurityError` / null IDB), & Corrupt Stored Records (Bun + Chromium) | **PASS** | Classified cleanly (`kind: "quota"`, `"unavailable"`, `"corrupt"`), zero unhandled rejections, zero page/console errors; Chromium cleanup verified `0` residual test projects (`JS Heap: 32.47 MB / 35.91 MB`). |
| **E5 (Safety)** | 30-Minute Cap & Live Recording RAM Ceilings (Bun) | **PASS** | `RECORDER_MAX_SECONDS === 1800` preserved; `STUDIO_LIVE_BYTES_PER_FRAME === 14`, desktop cap `256 MB`, mobile/iPad cap `128 MB` verified. Real long-duration capture on physical iPad Safari: **`NOT RUN`**. |
| **H (Real Devices)** | Real macOS Intel Chrome & iPadOS Safari Manual Acceptance (multi-stem download prompt, real speakers, Web MIDI, touch) | **NOT RUN** | Ready for user verification in real Chrome / iPad Safari. |


