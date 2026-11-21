# SY-1 Studio (Web) — Phase 0 Protected Checkpoint & Architecture

**Date:** 2026-11-20  
**Repository:** `https://github.com/armshokri-debug/Synthesizer-New`  
**Phase:** Phase 0 — Protected Checkpoint, Baseline Audit & Technical Architecture  
**Code Changes in Phase 0:** None (documentation only; zero changes to DSP, Web Audio engine, UI, or native VST3/AU code)

---

## 1. Protected Baseline & Branch Status

| Item | Value / Status |
|---|---|
| Known Web Baseline (`main`) | `c3f7c3e883b8185c543144cfa1b46c18883a6e5d` (*Optimize native Intel stereo DSP and add validated Mac VST3 build*) |
| Separate Native VST3 Branch (`fix/realtime-state-publication`) | `af4d2d6b8174aff8c0747549693910512abbb075` — **strictly untouched** |
| Active Studio Development Branch | `feature/sy1-studio-web` (branched directly from `c3f7c3e883b8185c543144cfa1b46c18883a6e5d`) |
| Workspace Source Integrity vs `origin/main` | **100% byte-for-byte identical** across `src/`, `docs/`, `public/`, `native/`, `plugin/`, `scripts/`, `index.html`, `package.json`, `tsconfig.json`, `vite.config.ts`, `metadata.json` |
| Non-Source Environment Artifacts in AI Studio | `bun.lock` (untracked), `package-lock.json` (lockfile delta from container install), `.aistudio/` (platform metadata) — **preserved untouched, not committed** |
| Native VST3 / Plugin (`native/`, `plugin/`) | **Zero modifications permitted** during Web Studio work |

### GitHub Synchronization Notes
- The AI Studio container snapshot originally did not contain a `.git` directory.
- A read-only comparison against `https://github.com/armshokri-debug/Synthesizer-New.git` (`main`) verified zero source drift.
- Local git metadata was initialized cleanly against `origin/main` (`c3f7c3e883b8185c543144cfa1b46c18883a6e5d`) without overwriting or deleting any workspace file, and `feature/sy1-studio-web` was created from that exact commit.
- Remote push status from the sandbox is recorded in `docs/SY1_STUDIO_PROGRESS.md` (if the sandbox lacks GitHub write credentials, the local commit on `feature/sy1-studio-web` is ready for authenticated push via AI Studio GitHub sync or local git).

---

## 2. Existing Web Application Audit

### 2.1 Current Capabilities
- **15 Machines** (`src/machines/index.ts`): `SY1` (flagship HQ/Classic subtractive), `YAZD`, `TABRIZ` (3-osc analog ladder), `BAKU`, `MERV`, `ISFAHAN`, `SHIRAZ` (strings), `KASHAN` (FM), `KONYA` (Euclidean), `NISHAPUR` (vector), `BAM`, `KERMAN` / `BUSHEHR` / `RASHT` / `HORMOZ` (synthesized drum machines).
- **DSP Engines**:
  - **HQ Engine** (`src/dsp/hq-engine.ts` + `src/engine/worklet/sy1-processor.ts` + `src/engine/hq.ts`): 24-voice pool (max 10 sounding, 16 active incl. tails), band-limited mip-mapped wavetables, up to 7-voice stereo unison, ZDF TPT SVF (`lowpass`, `lp24`, `bandpass`, `highpass`) + 2x oversampled stereo transistor `Ladder`, filter drive, key tracking, analog drift, microtonal/dastgah tuning + ornaments (`scoop`, `tahrir`, delayed vibrato), sample-accurate event queue (`QUEUE = 512`).
  - **Classic Fallback Engine** (`src/engine/voice.ts`): Native Web Audio oscillator + biquad fallback used when HQ worklet is loading or unavailable.
  - **Special Engines**: Analog (`sy1-analog`), Strings (`sy1-strings`), FM (`sy1-fm`), Vector (`sy1-vector`), Drum synthesis (`drums.ts` + `drum-models.ts`).
- **Audio Context & Shared FX Bus** (`src/engine/bus.ts`):
  - Single lazily-created `AudioContext({ latencyHint: "interactive" })` with iOS gesture unlock + `navigator.audioSession.type = "playback"`.
  - Fixed signal chain per `SynthFXBus`:
    ```
    input
      -> drive (WaveShaper 2x oversample)
      -> driveComp (gain = 1 / (1 + drive * 1.5))
      -> eqLow (lowshelf 220 Hz)
      -> eqMid (peaking 1100 Hz, Q = 0.8)
      -> eqHigh (highshelf 4200 Hz)
      +---> sum (dry)
      +---> mainToFx (1 synths / 0 drums) + sendIn (drum sends) -> fxIn
              +---> Tape Delay (DelayNode 2s -> LP 4500 Hz Q=0.707 -> HP 180 Hz Q=0.707 -> delayWet [delayMix*0.7] -> sum;
              |                 feedback branch: delayHP -> delaySat [tanh k=1.6, 2x] -> fb [min(0.95, delayFb)] -> delay)
              +---> Stereo Chorus (dl/dr 12ms +/- 4ms*depth, opp-phase triangle LFO -> ChannelMerger(2) -> chorusWet [chorusMix*0.9] -> sum)
              +---> Algorithmic Freeverb (combInputScale 0.14 -> 8 modulated damped combs w/ one-pole IIR 4500 Hz
                                          + exact measureDampPeakGain compensation -> 4 series Schroeder allpasses g=0.5 -> revWet [revMix*0.9] -> sum)
    sum
      -> master (gain = patch.volume)
      -> limiter (DynamicsCompressor: threshold -6 dB, ratio 12, attack 3 ms, release 200 ms)
      -> clipIn (gain = 1/4)
      -> clip (8193-pt softClip: identity for |x| <= 0.9, 0.9 + 0.1*tanh((|x|-0.9)/0.1), oversample="none")
      -> tap (unity — recorder tap, pre-master-volume)
      -> out (app master volume: masterVol^2)
      -> analyser (fftSize = 2048)
      -> ctx.destination
    ```
- **Global Tempo** (`src/engine/tempo.ts`): Shared `bpm` (40–240, default 110), tap tempo, `onTempoChange`, plus plugin-only DAW `SYNC` (`hostBpm`).
- **MIDI Input & Mapping** (`src/engine/midi.ts`, `src/engine/cc-map.ts`): Web MIDI input with device/channel filter, loopback port echo suppression, MIDI Learn, pickup/relative CC modes, realtime clock forwarding (`0xF8..0xFC`).
- **DAW & Take Recorder** (`src/engine/daw.ts`, `src/ui/daw-panel.ts`):
  - Real-time MIDI Out + DAW MIDI clock follower.
  - Inline `AudioWorkletProcessor` (`"sy1-recorder"`) tapping `bus.tap` (pre-master-volume, unity).
  - Exports **uncompressed 24-bit Stereo PCM WAV** at `ctx.sampleRate` (`encodeWav`, no normalization, no hidden compression).
  - Exports **SMF Format 0 MIDI** (`PPQ = 480`, piecewise tempo map, aligned to `rec.startAt` audio sample 0).
- **Plugin / Web Separation** (`src/main.ts`, `src/engine/mirror.ts`, `src/engine/calls.ts`):
  - Clean boundary via `const plugin = (window as any).__SY1_PLUGIN__`.
  - Web Studio features must be strictly gated to `!plugin`.

---

## 3. Identified Constraints & Singletons Blocking Multi-Track Studio

| File | Current Singleton / Constraint | Impact on Multi-Track Studio |
|---|---|---|
| `src/engine/bus.ts` | `synthBuses = new WeakMap<AudioContext, SynthFXBus>()` caches **only 1 bus** per `AudioContext`. | Two tracks sharing one `SynthFXBus` would share Drive, EQ, Delay, Chorus, Reverb, Volume, and Limiter — violating isolation. |
| `src/engine/synth.ts` | Single module-level `synthPatch`, `machine`, `synthPresetId`, `heldVoices`, `monoStack`, `monoVoice`, `sustainPedal`, `downKeys`, and direct DOM calls (`markKey`, `syncKeyHighlights`) + `localStorage` writes (`sy1.m.<id>.patch`). | Cannot hold two independent patches, presets, mono stacks, or active voice tables; background playback would flicker keyboard DOM and clobber standalone saved patches. |
| `src/engine/hq.ts` | Single module-level `node: AudioWorkletNode | null`, `state`, `nextId`. | All notes/params post to one worklet node. **Crucial positive finding:** `SY1Processor` (`src/engine/worklet/sy1-processor.ts`) already creates `new HQEngine(sampleRate)` *per `AudioWorkletNode`* with zero shared mutable DSP state! |
| `src/engine/voice.ts` | Global `activeSynthVoices`, `currentPitchBend`, `currentModWheel`, hardcoded `getSynthBus(ctx, synthPatch)`. | Classic fallback voices from Track 1 and Track 2 would share voice stealing, pitch bend, mod wheel, and FX bus. |
| `src/engine/arp.ts` | Single global timer, `held[]`, `stepIndex`, `hooks`. | Only one arpeggiator can run at once (acceptable for Phase 1; per-track Arp can be encapsulated later if needed). |
| `src/engine/midi.ts` & `src/engine/cc-map.ts` | Dispatches directly to singleton `synth.noteOn/noteOff/setPitchBend/setSynthParam`. | Must route to focused/armed Studio track(s) (with optional per-track MIDI channel routing for simultaneous multi-track recording). |
| `src/engine/daw.ts` | Hard limit `MAX_SECONDS = 30 * 60` (line 349). Buffers stereo Float32 chunks in RAM (`rec.chunks`) and allocates a full contiguous `ArrayBuffer` during `encodeWav()`. | **Critical RAM constraint:** At 48 kHz stereo, 30 min = ~691 MB Float32 + ~518 MB 24-bit WAV buffer ≈ **1.21 GB peak RAM**. On iPadOS Safari (Jetsam tab memory cap), removing this limit without chunked OPFS/IndexedDB storage will crash the tab. **Keep the 30-min cap** until safe streaming storage is designed. |
| `src/engine/daw.ts` | `encodeMidi()` writes SMF Format 0 only and relies on `syncHeldNotes()` (which extends note duration for sustain instead of emitting raw CC64 events). No MIDI file importer exists yet. | Studio requires SMF Format 1 (multi-track + conductor tempo track), explicit CC64/CC1/PitchBend recording, and an SMF parser for re-import. |
| Browser / iPadOS Safari | No Web MIDI API (`requestMIDIAccess`), no `AudioContext.setSinkId`, strict gesture unlock & memory ceiling. | Must never assume Web MIDI works on iPad; touch-first Studio controls (`>= 44px`) and proactive RAM guardrails are mandatory. |

---

## 4. Low-Risk Technical Architecture for Independent Dual SY-1 Instances (Phase 1 -> 4 Tracks)

### 4.1 Core Architectural Decisions
1. **Single `AudioContext`, Zero `iframe`s**:
   - All Studio tracks run inside the existing single `AudioContext` (`getAudioCtx()`).
   - Every track shares the exact hardware sample clock (`ctx.currentTime`) and 128-frame render quantum: **zero inter-context drift**, no Safari multi-context throttling, lower memory/CPU overhead.
2. **Zero DSP Formula Changes & Standalone Preservation**:
   - `src/dsp/hq-engine.ts` and `src/engine/worklet/sy1-processor.ts` remain **completely unchanged**.
   - When Studio is closed/inactive, the standalone SY-1 path and `localStorage` slots work identically to baseline `c3f7c3e883b8185c543144cfa1b46c18883a6e5d`.
   - When `Boolean((window as any).__SY1_PLUGIN__)` is true, Studio is completely disabled.

### 4.2 Per-Track Audio Graph & Isolation (`SY1TrackEngine`)
Each Studio track instantiates an encapsulated `SY1TrackEngine` (starting with 2 tracks in Phase 1, scaling cleanly to 4 tracks in Phase 4):

```
[Track N: SY1TrackEngine]
  ├── patch: SynthPatch (deep copy of synthDefaults() + SY1.base + preset.patch)
  ├── presetId: string
  ├── voiceState: { heldVoices, heldNotesOrder, physicallyHeld, sustainedNotes,
  │                 monoStack, monoVoice, monoMidi, lastMonoHz, sustainPedal,
  │                 pitchBend, modWheel, tuningState }
  ├── hqNode: new AudioWorkletNode(ctx, "sy1-voices", { outputs: 1, outputChannelCount: [2] })
  │     (worklet module loaded ONCE per AudioContext via shared ensureHQWorkletLoaded(ctx))
  ├── classicPool: isolated Set<SynthVoice> (fallback only, wired to trackBus.input)
  └── trackBus: createSynthBus(ctx, patch, { connectToDestination: false })
        (IDENTICAL FX chain to standalone bus.ts:
         input -> drive -> driveComp -> EQ -> dry + delay + chorus + freeverb
         -> master(patch.volume) -> limiter(-6dB/12:1) -> clipIn -> softClip -> trackBus.tap)
        │
        ├──> [Optional Stem Recorder Tap] (unity, exact standalone SY-1 signal)
        └──> trackStrip: GainNode(trackVol=1.0) -> StereoPannerNode(pan=0) -> muteGate(0|1)
               │
               ▼
[Studio Master Bus] (inside same AudioContext)
  studioMasterSum (GainNode, unity = 1.0 — NO extra DynamicsCompressor!)
    -> masterClipIn (1/4) -> masterSoftClip (exact identity for |x| <= 0.9, ceiling 1.0)
    -> studioMasterTap (unity — Mix WAV Recorder taps here)
    -> appMasterOut (masterVol^2, existing VOL knob)
    -> analyser (oscilloscope)
    -> ctx.destination
```

#### Why This Preserves Exact Sound Parity & Gain Staging
- Each `SY1TrackEngine` runs its own `HQEngine` instance inside its own `"sy1-voices"` `AudioWorkletNode` and its own `SynthFXBus` with identical node parameters and smoothing time constants.
- Because `studioMasterSum` is unity (`1.0`), has **no second compressor**, and `masterSoftClip` is exact mathematical identity (`y = x`) for `|x| <= 0.9` (and each track's `trackBus` is already limited and soft-clipped to `<= 1.0`), playing a single track at unity fader (`1.0`) and center pan (`0`) matches standalone SY-1 transfer characteristics with zero hidden normalization or double-compression.
- Summing 2–4 tracks retains clean headroom via user-controllable track faders, while `masterSoftClip` prevents harsh digital wrap-around on speakers without altering normal-level signals.

### 4.3 Shared Audio-Clock Transport & Timeline (`StudioTransport`)
- **Single Timebase**: `AudioContext.currentTime` + shared BPM from `src/engine/tempo.ts`.
- **Musical Resolution**: `PPQ = 480` ticks per quarter note; 4/4 time signature (`1920` ticks/bar).
- **Project Length Presets**: `8`, `12`, `64`, `128` bars + custom bar count (`1..512`).
- **Lookahead Scheduler**: 25 ms timer with 100 ms audio-clock lookahead (`[now, now + 0.10]`).
  - Converts each event's tick to exact `at = anchorAudioTime + (eventTick - anchorTick) * (60 / (bpm * PPQ))`.
  - Dispatches `track.noteOnAt(midi, vel, at)` / `track.noteOffAt(midi, at)` / `track.setPitchBendAt(...)` / `track.setModWheelAt(...)` directly into `"sy1-voices"`'s sample-accurate event queue (`Math.round((at - currentTime) * sampleRate)`).
  - **Mid-playback Tempo Changes**: Atomically updates `(anchorAudioTime, anchorTick)` at `ctx.currentTime` before applying the new BPM so all tracks remain phase-locked with zero jump or cumulative drift.
  - **Loop Handling**: At `loopEndTick`, cleanly terminates active notes scheduled across the boundary and wraps `cursorTick` to `loopStartTick` within the same lookahead pass so beat 1 of the next loop lands sample-accurately.

### 4.4 Recording, Export & Persistence Strategy
- **MIDI Recording**:
  - Live notes (on-screen keys, computer keyboard, Web MIDI) are stamped immediately using `ctx.currentTime` -> `audioTimeToTick(now)`.
  - Supports simultaneous multi-track recording when multiple tracks are armed (e.g., per-track MIDI channel filter `All / Ch 1..16`, or Omni routing to armed tracks).
  - Captures `Note On` (pitch + velocity `1..127`), `Note Off`, `CC 64` (Sustain Pedal), `CC 1` (Mod Wheel), and 14-bit `Pitch Bend`.
  - Exports **SMF Format 1** (Conductor tempo track + 1 `MTrk` per Studio track) and includes a strict SMF parser for lossless re-import.
- **WAV Recording & Stem Export**:
  - Reuses the `"sy1-recorder"` AudioWorklet pattern (`24-bit Stereo PCM`, `ctx.sampleRate`, no normalization, no hidden compression).
  - **Mix WAV**: Taps `studioMasterTap`.
  - **Per-Track Stems (Optional/Architecture-Verified)**: Taps each track's `trackBus.tap` (or performs synchronized clean pass/offline bounce to avoid 4x simultaneous RAM buffers on iPad!). On desktop Chrome, simultaneous stem capture is bounded by memory budget; offline/per-track `OfflineAudioContext` bounce is preferred for long multi-track stems on iPad to stay within Jetsam RAM limits.
  - **30-Minute Cap Policy**: `MAX_SECONDS = 30 * 60` remains enforced in Phase 1–3; additionally, an estimated RAM meter + soft warning will protect iPad Safari users well before browser memory limits. Removing the 30-minute limit requires a dedicated OPFS/IndexedDB chunked PCM storage phase.
- **Project Save / Load**:
  - Self-contained JSON schema (`sy1-studio-project`, `version: 1`) containing BPM, bar length, loop range, and per-track `{ id, name, machineId, presetId, patch, volume, pan, mute, solo, armed, midiChannel, events[] }`.
  - Stored in `IndexedDB` (preferred over `localStorage` for larger MIDI projects) plus `.sy1studio.json` file download/import. Never mutates standalone `sy1.m.*` keys.

### 4.5 UI Integration Principles (Preserving Existing Appearance)
- The existing SY-1 panel, knobs, oscilloscope, and keyboard keep their exact visual design and responsive rules.
- Studio adds a lightweight, toggleable **Studio Bar / Drawer** (docked cleanly or switchable via a compact header mode toggle) providing:
  - Transport (`Play`, `Stop`, `Record`, `Loop`, Bar:Beat clock, BPM linked to `tempo.ts`, Bars selector `8 / 12 / 64 / 128 / Custom`).
  - Compact Track Lanes (2 tracks initially -> 4 tracks): Track Select (binds the existing SY-1 panel & keyboard to edit/play that track!), Preset selector, Arm (REC), Mute (M), Solo (S), Volume, Pan, MIDI activity/level indicator, simple clip/note overview bar.
  - Export/Project actions: Save/Open Project, Export MIDI (SMF-1), Export Mix WAV (+ Stems when enabled).
  - Touch-friendly hit targets (`>= 44×44 px`, `touch-action: manipulation`/`none`) for iPad Safari.

---

## 5. Phase 0 Baseline Verification Results

| Check | Command | Result | Details |
|---|---|---|---|
| Git Baseline Match | `diff -rq` vs `origin/main` (`c3f7c3e...`) | **PASS** | 0 source diffs; only `bun.lock` & `package-lock.json` env artifacts |
| TypeScript Typecheck (`lint`) | `npm run lint` (`tsc --noEmit`) | **PASS** | Exit code 0, zero errors |
| Production Build (`build`) | `npm run build` (`vite build`) | **PASS** | Exit code 0, 62 modules transformed in 583 ms (`dist/assets/index-XIsmCQtf.js` 334.84 kB, all 5 worklets built) |
| Automated Layout Audit | `bun scripts/layout-audit` | **NOT RUN** | `playwright` JS package not installed in sandbox (`playwright` / `/root/.bun/install/global/node_modules/playwright/index.mjs` missing); not installed in Phase 0 to keep `package.json` & environment clean |
| Native C++ / VST3 Tests | `native/tests/*`, `plugin/tests/*` | **NOT RUN (OUT OF SCOPE)** | Explicitly excluded — no native VST3 changes or builds in Web Studio track |

---

## 6. Phased Delivery Roadmap

- **Phase 0 (Complete — Committed `2415939`):** Baseline audit, `feature/sy1-studio-web` branch creation, Checkpoint / Test Plan / Progress docs, baseline `lint` & `build` verification, dual-SY-1 architecture sign-off.
- **Phase 1 (Verified GitHub Commit `079b29f2392d7381c21f997601239fbe2bb9b61a`):** Multi-Track SY-1 Audio Engine (2 truly independent SY-1 tracks, expandable to 4), shared `AudioContext` + audio-clock transport (`Play`/`Stop`/`Record`/`Loop`, BPM, `8/12/64/128/custom` bars), multi-track MIDI recording + SMF Format 1 export/parser, 24-bit Stereo PCM WAV live recording & deterministic `OfflineAudioContext` bounce, touch-ready Studio UI, and automated Bun + real headless Chromium verification.
- **Phase 2 (Verified GitHub `main` Commit `20340c00c5de9c857a5c52debdd68f9edbd782b1`):** Project Save / Open (`IndexedDB` `sy1-studio-db`), rolling Autosave & browser-refresh crash recovery, versioned `.sy1studio` Export / Import with strict pre-apply validation, sample-aligned separate 24-bit Stereo PCM WAV Stem export (`bounceTrackStemsWav`, 2-track & 4-track null-tested to `< -117 dBFS`), preserved 24-bit WAV Mix + SMF-1 MIDI exports, project-scoped BPM isolation from standalone SY-1, and live recording RAM guardrails (`256 MB` desktop / `128 MB` mobile/iPad) alongside the strictly preserved 30-minute cap (`RECORDER_MAX_SECONDS = 1800`).
- **Phase 3 (Complete — Local Unpushed Working Tree, Stopped Before Push):** Audio Stability & Performance for 4 simultaneous SY-1 tracks on macOS Chrome and iPadOS Safari without altering any DSP formulas, FX algorithms, gain staging, or presets: 100% AudioNode/cyclic-feedback-loop teardown in `disposeSynthBus()` (`91 leaked -> 0 leaked`), `O(log N + K)` zero-allocation MIDI scheduler (`67.26 ms -> 8.76 ms`, 7.68x faster on 8,000 events), main-thread stall/background recovery guard, iPadOS Safari `"interrupted"`/`"suspended"` -> `"running"` AudioContext recovery, zero idle `rAF` loop, non-destructive range slider drag & touch ruler scrubbing, and automated 4-track stress/disposal suites (Bun + Headless Chromium).

---

## 7. Phase 1 Local Checkpoint — Multi-Track Audio Engine (2026-11-21)

**Branch:** `feature/sy1-studio-web` (local only — **NOT pushed, NOT merged, NOT deployed**)  
**Protected Baseline (`main`):** `c3f7c3e883b8185c543144cfa1b46c18883a6e5d`  
**Untouched Native VST3 Branch:** `fix/realtime-state-publication` (`af4d2d6b8174aff8c0747549693910512abbb075`)

### 7.1 Protected Files Verified Byte-for-Byte Unchanged vs `c3f7c3e...`
- `src/dsp/hq-engine.ts` — **0 diffs**
- `src/engine/worklet/sy1-processor.ts` — **0 diffs**
- `native/**` — **0 diffs**
- `plugin/**` — **0 diffs**

### 7.2 Modified Existing Files (Backward-Compatible Hooks Only)
| File | Summary of Phase 1 Changes |
|---|---|
| `index.html` | Added `<div id="sy1-studio" hidden></div>` container inside `.sy1-shell`. |
| `src/engine/bus.ts` | Generalized `SynthFXBus` factory to `BaseAudioContext`, exported `CLIP_RANGE`, `makeSoftClipCurve()`, `createSynthBus(ctx, patch, opts)`, `applyBusParam(bus, key, val)`, `disposeSynthBus(bus)`. Standalone `getSynthBus()` delegates to `createSynthBus(..., { connectToDestination: true })` with zero signal-chain changes. |
| `src/engine/hq.ts` | Added per-context `WeakMap` cache `ensureHQModule(ctx)` and exported `createHQNode(ctx, busInput, initialPatch)` to spawn isolated `"sy1-voices"` `AudioWorkletNode`s. |
| `src/engine/voice.ts` | Added optional `VoiceRoutingOptions` (`busInput`, `voicePool`, `getPitchBend`, `getModWheel`) for isolated Classic fallback voices. |
| `src/engine/daw.ts` | Exported `RECORDER_MAX_SECONDS = 30 * 60` (30-min cap strictly preserved) and `ensureRecorderWorklet(ctx)`. |
| `src/engine/midi.ts` | Added optional `setMidiInputInterceptor(fn \| null)` to route multi-channel Web MIDI into Studio when active without mutating standalone `synth.ts`. |
| `src/ui/keyboard.ts` | Added `KeyboardTarget` routing adapter (`setKeyboardTarget`, `syncKeyboardHighlights`) so on-screen keys, QWERTY keys, PB/MOD wheels, and HOLD play the active Studio track(s) when Studio is open. |
| `src/ui/panel.ts` | Added compact web-only `Studio` button (`#open-studio-btn`) in `.synth-top` and `setStudioOpenHandler`. |
| `src/main.ts` | Wired `enterStudioMode`/`exitStudioMode`, `window.SY1_STUDIO`, keyboard target, and MIDI interceptor strictly inside `if (!plugin)`. |

### 7.3 New Phase 1 Files
| File | Role |
|---|---|
| `src/studio/types.ts` | Shared Studio types & constants (`STUDIO_PPQ = 480`, `STUDIO_TICKS_PER_BAR = 1920`, `STUDIO_MAX_TRACKS = 4`, `STUDIO_BAR_PRESETS = [8, 12, 64, 128]`). |
| `src/studio/midi-io.ts` | Binary SMF Format 1 multi-track encoder (`encodeStudioMidi`), note span extractor (`extractNoteSpans`), and SMF Format 0/1 parser (`parseStudioMidi`). |
| `src/studio/track-engine.ts` | `SY1TrackEngine`: per-track isolated `SynthPatch`, `"sy1-voices"` `AudioWorkletNode`, `SynthFXBus`, Classic fallback pool, channel strip (`fader -> StereoPannerNode -> muteGate`), poly/mono/legato/sustain/bend/mod state, tempo-synced LFO, and MIDI clip events. |
| `src/studio/studio-engine.ts` | `SY1StudioEngine` + `createStudioMasterBus` (unity sum + transparent `makeStudioMasterClipCurve` identity for `\|x\| <= 0.98`, ceiling `1.0`, zero extra compression), shared audio-clock lookahead transport, simultaneous multi-track MIDI recording, live 24-bit WAV mix recorder (30-min cap preserved), and deterministic `OfflineAudioContext` 24-bit WAV arrangement bounce (`bounceArrangementWav`). |
| `src/studio/parity-probe.ts` | Real `OfflineAudioContext` diagnostics (`runOfflineParityProbe`, `runOfflineIsolationProbe`, `runOfflineBounceProbe`) exposed on `window.SY1_STUDIO.diagnostics`. |
| `src/ui/studio-panel.ts` | Dedicated web-only Studio UI: Master Transport (`Play`, `Stop`, `Rec`, `Loop`, BPM stepper/Tap, Bars `8/12/64/128/custom`, MIDI & 24-bit WAV exports), 2-track arrangement (`+ Track` up to 4) with per-track SY-1 preset selector, `R`/`M`/`S`, Volume/Pan, MIDI Ch, Clear, clickable bar timeline with `rAF` playhead, and focused-track SY-1 synth inspector. |
| `src/ui/studio.css` | SY-1 hardware-matched Studio stylesheet with `>= 44×44 px` touch hit targets on iPad/coarse pointers and `touch-action: none` on rotary controls and timeline lanes. |
| `tests/bun-shim.d.ts` | Minimal ambient TypeScript declarations for `bun` / `bun:test` so `tsc --noEmit` stays clean without modifying `package.json`. |
| `tests/vite-url-preload.ts` | Bun test preload stub for Vite `?worker&url` imports during non-browser unit/DSP tests. |
| `tests/studio-phase1.test.ts` | Automated Bun verification suite (22 tests, 8,349 assertions: A1, B1–B6, C1–C3, D1–D5, E1–E3, F1–F3, G-DSP benchmark). |
| `scripts/studio-chromium-verify.mjs` | Headless Chromium CDP verification runner executing real `OfflineAudioContext` + `"sy1-voices"` `AudioWorklet` parity, isolation, 24-bit WAV bounce, and Studio UI E2E checks. |

### 7.4 Known Defects & Remaining Risks
1. **Chromium `OfflineAudioContext` Cyclic-Graph Jitter in Untouched Freeverb (`buildReverb`):** Across separate `OfflineAudioContext` runs, Chromium Blink's `AudioNodeInput` `HashSet<AudioNodeOutput*>` cycle-break order on Freeverb's 8 comb + 4 Schroeder allpass feedback loops introduces a random 0/128-sample offset per loop (causing up to ~1.4 dB RMS bucket variance even when comparing two runs of untouched standalone SY-1 against itself). Because `buildReverb` is untouched and shared verbatim by standalone and Studio, this is an engine-neutral Chromium artifact rather than a Studio bug; non-reverb chain parity (HQEngine + drive + EQ + delay + chorus + limiter + softClip + track strip + StudioMasterBus) is proven bit-exact (`0.0000000`).
2. **Real Hardware / Real-Time Audio Not Yet Verified:** macOS Intel Chrome (real speakers, real Web MIDI hardware, sustained 60s/120s real-time callback dropout monitoring) and iPadOS Safari (multi-touch, iOS gesture unlock, Jetsam RAM ceiling) are `NOT RUN` in this container.
3. **Phase 2 Features Not Yet Implemented:** Project persistence (IndexedDB / `.sy1studio.json`), MIDI re-import UI button (parser exists and is tested in `midi-io.ts`), separate per-track stem WAV export UI, and per-track Arpeggiator/Step-Sequencer.
4. **30-Minute Live WAV Cap Retained:** `RECORDER_MAX_SECONDS = 1800` remains strictly enforced until chunked OPFS/IndexedDB streaming storage is engineered.

---

## 8. Phase 2 Local Checkpoint — Project Persistence & Multitrack Export (2026-11-21)

**Branch:** `feature/sy1-studio-web` (local only — **NOT pushed, NOT merged, NOT deployed**)  
**Verified Phase 1 Commit Reference:** `079b29f2392d7381c21f997601239fbe2bb9b61a`  
**Protected Baseline (`main`):** `c3f7c3e883b8185c543144cfa1b46c18883a6e5d`  
**Protected Files Still 100% Untouched:** `src/dsp/hq-engine.ts`, `src/engine/worklet/sy1-processor.ts`, `native/**`, `plugin/**` (**0 diffs**).

### 8.1 New Phase 2 Files
| File | Role |
|---|---|
| `src/studio/project-io.ts` | Versioned `.sy1studio` JSON serializer (`format: "sy1-studio-project"`, `version: 1`) and strict pre-apply validator (`validateStudioProject`, `parseStudioProjectJson`, `STUDIO_MAX_IMPORT_BYTES = 16 MB`, `STUDIO_MAX_EVENTS_PER_TRACK = 100_000`, `SYNTH_PARAMS` + `PARAM_CHOICES` sanitization, forced `hold: "off"`). |
| `src/studio/storage.ts` | IndexedDB persistence & autosave adapter (`sy1-studio-db`, object stores `projects` and `autosave`) with structured `StorageResult<T>` responses and error classification (`quota`, `unavailable`, `corrupt`, `io`). Never touches standalone `localStorage` keys. |
| `tests/studio-phase2.test.ts` | Automated Bun Phase 2 suite (9 tests: project round-trip, post-restore 60/110/140 BPM MIDI timing, corrupted/malformed `.sy1studio` rejection & atomic live-state preservation, IndexedDB CRUD + `QuotaExceededError` / `SecurityError` / corrupt-record handling, and recording safety guardrails). |

### 8.2 Modified Phase 2 Files
| File | Summary of Phase 2 Changes |
|---|---|
| `src/studio/types.ts` | Added `.sy1studio` format constants, `StudioStemTake`, `StudioProjectTrackData`, `StudioProjectData`, `StudioSavedProjectMeta`, `StorageErrorKind`, and extended `StudioTransportSnapshot` with `projectId`, `projectName`, `liveRecBytes`, `maxLiveBytes`, and `liveRecWarning`. |
| `src/studio/studio-engine.ts` | Added project metadata & `exportProject()` / `exportProjectJson()` / `exportProjectBlob()` / atomic `loadProject(raw)`, shared `renderTracksOffline()` powering both `bounceArrangementWav()` (`useMasterBus: true`) and sequential sample-aligned `bounceTrackStemsWav()` (`useMasterBus: false`, zero normalization), live recording RAM safety ceiling (`STUDIO_LIVE_BYTES_PER_FRAME = 14`, `256 MB` desktop / `128 MB` mobile/iPad) alongside preserved `RECORDER_MAX_SECONDS = 1800`, and project-scoped BPM isolation (`isolatedTempo: true` + `tapBpm()`) so Studio projects never overwrite standalone SY-1's `sy1_bpm`. |
| `src/studio/parity-probe.ts` | Added `decodeWav24()`, `runOfflineStemsProbe(2 \| 4, bpm, bars, sampleRate)` (2-track & 4-track stem header/alignment/null-test), and `runPostRestoreParityProbe(sampleRate)` (pre-save vs post-restore bit-exact parity & post-restore Track 2 isolation). |
| `src/ui/studio-panel.ts` | Added compact project toolbar (project name input, `Save`, `Open`, `Export Project`, `Import .sy1studio`, inline Saved Projects + Autosave Recovery drawer, and `Export Stems` button), debounced `800 ms` IndexedDB autosave + `pagehide`/`visibilitychange` flush, and startup `hydrateStudioFromStorage()`. |
| `src/ui/studio.css` | Styled `.st-project-bar`, `.st-drawer`, `.st-proj-btn`, `.st-name-input`, and status indicators matching SY-1 hardware chrome with `>= 40px` touch target sizing on tablet/coarse pointers. |
| `src/main.ts` | Wired startup `hydrateStudioFromStorage()` inside `if (!plugin)` and exposed `storage`, `ready`, `saveProject`, `importProjectJson`, `diagnostics.runOfflineStemsProbe`, and `diagnostics.runPostRestoreParityProbe` on `window.SY1_STUDIO`. |
| `scripts/studio-chromium-verify.mjs` | Extended headless Chromium CDP runner with full Phase 2 suite: 2-track & 4-track stem alignment/null-test, post-restore parity & isolation, real IndexedDB Save -> `Page.reload` -> Restore (with standalone tempo preservation check), `.sy1studio` Export/Import + corrupt rejection, and Chromium `QuotaExceededError` handling. |

### 8.3 Phase 2 Remaining Risks
1. **Real Browser / Hardware Testing Pending:** Real macOS Intel Chrome (physical audio output, multi-file download prompt behavior when exporting 2–4 stems sequentially, real Web MIDI hardware) and real iPadOS Safari (multi-download behavior, iOS Safari IndexedDB eviction/quota limits, Jetsam RAM under long takes) remain **`NOT RUN`**.
2. **Sequential Multi-File Stem Downloads:** `Export Stems` triggers sequential anchor downloads spaced by 250 ms; Chrome may ask the user to allow multiple downloads from the origin on first use, and iPadOS Safari may prompt per file.
3. **30-Minute Live Recording Cap Retained:** `RECORDER_MAX_SECONDS = 1800` and the `256 MB` / `128 MB` live capture RAM cap remain active until chunked OPFS/IndexedDB PCM streaming is designed in a future phase.

---

## 9. Phase 3 Local Checkpoint — Audio Stability & Performance (2026-11-21)

**Verified `origin/main` Base Commit:** `20340c00c5de9c857a5c52debdd68f9edbd782b1`  
**Protected Pre-Studio Baseline:** `c3f7c3e883b8185c543144cfa1b46c18883a6e5d`  
**Protected Files Still 100% Untouched:** `src/dsp/hq-engine.ts`, `src/engine/worklet/sy1-processor.ts`, `native/**`, `plugin/**` (**0 diffs**).  
**Git Status:** Local working tree only — **NOT pushed, NOT merged, NOT deployed**.

### 9.1 Modified & New Phase 3 Files
| File | Summary of Phase 3 Changes |
|---|---|
| `src/engine/bus.ts` | Cached immutable `makeSoftClipCurve()`, `makeTanhCurve()`, and `measureDampPeakGain()` per sampleRate/filter kind; tracked `lastDriveApplied` to skip redundant 1024-sample WaveShaper curve allocations; tracked all internal AudioNodes in `SynthFXBus._nodes` so `disposeSynthBus()` stops all 9 oscillators and disconnects **100% of internal nodes (95/95, 0 leaked)** breaking all 13 cyclic feedback loops; used `fftSize = 256` on unused non-destination track analysers (standalone stays `2048`); added `onAudioContextStateChange()` and hardened `unlockAudio()` / `installAudioUnlock()` for iPadOS Safari `"interrupted"` recovery (`pageshow`, `focus`, `visibilitychange`, resetting `unlockedOnce` on non-running state, disconnecting 1-sample unlock `BufferSourceNode` on `onended`). |
| `src/studio/track-engine.ts` | Added lazy-sorted MIDI events with zero-allocation `O(log N + K)` binary-search `forEachEventInRange()`, O(1) cached `getNoteCount()`, no-op short-circuit in `setParam()` when identical values are written during rapid scrubbing, full `detachAudio()` teardown (`hqNode.port.onmessage = null`, `classicVoices.clear()`), and `dispose()` clearing listeners & retained buffers. |
| `src/studio/studio-engine.ts` | Cached `makeStudioMasterClipCurve()`; added `disposeStudioMasterBus()` (called on `dispose()`, master replacement, and end of `renderTracksOffline()`); replaced `O(N)` per-tick linear scan + array allocation + sort in `scheduleSegment()` with zero-allocation `forEachEventInRange()`; added `SCHEDULER_STALL_THRESHOLD_SEC = 0.35` recovery guard to prevent backlog burst-fire clicks after main-thread stalls or background sleep; wired `onAudioContextStateChange` / `handleAudioContextStateChange()` to release active voices cleanly on `"interrupted"`/`"suspended"` and re-anchor cleanly on `"running"`; cleared `playbackOpenNotes` on `setTrackPreset()`; cleared `rec.chunks` & `onmessage` immediately in `stopLiveMixRecorder()`; called `old.dispose()` in `loadProject()`/`dispose()`; added lightweight `isPlaying()` and `getPlayheadPosition()`. |
| `src/ui/studio-panel.ts` | Stopped idle `rAF` playhead loop completely when transport is not playing; cached `[data-st-playhead]` & `#st-clock` DOM refs and skipped unchanged DOM writes; fixed Volume/Pan `<input type="range">` DOM-destruction bug during drags (`draggingRange` guard updates inline labels without full `innerHTML` rebuild); deferred autosave timer churn during active knob/slider drags; added pointer-captured touch scrubbing on `[data-st-ruler]`. |
| `src/ui/studio.css` | Added `-webkit-touch-callout: none` on `.st-panel` and `touch-action: pan-x` on `.st-range` for smooth iPadOS Safari touch interaction. |
| `src/studio/parity-probe.ts` | Added `runOffline4TrackStressProbe(sampleRate, durationSec)` testing 4 simultaneous heavy AudioWorklet + SynthFXBus tracks under polyphonic chords, rapid Cutoff/Resonance sweeps, and mid-render preset switching; added clean `disposeSynthBus()` / `disposeStudioMasterBus()` calls in probes. |
| `src/main.ts` | Exposed `runOffline4TrackStressProbe` and `isPlayheadLoopActive` on `window.SY1_STUDIO.diagnostics`. |
| `tests/studio-phase3.test.ts` | New automated Bun Phase 3 suite (10 tests: 4-track 32-loop stress + sweeps/presets/recording, 4-instance `HQEngine` DSP stress, 8,000-event `O(log N + K)` scheduler timing, `+2.0s` stall recovery, 100% AudioNode/oscillator disposal across `disposeSynthBus`/`disposeStudioMasterBus`/12x `loadProject`, drive curve cache, `setParam` no-op guard, and iPadOS `"interrupted"` -> `"running"` recovery). |
| `scripts/studio-chromium-verify.mjs` | Extended headless Chromium CDP runner with Phase 3 real 4-track AudioWorklet stress probe, idle `rAF` check, Volume slider DOM-preservation drag test, and 10x 4-track `loadProject()` JS heap stability check. |

### 9.2 Remaining Risks & Hardware Validation Needed
1. **Real Hardware Tests Remain `NOT RUN`:** Physical macOS Intel Chrome (real-time audio callback jitter over 60–120 s on speakers, real Web MIDI input) and physical iPadOS Safari (real touch gestures, app-switch `"interrupted"` unlock, Jetsam memory ceiling under 4 tracks + long takes) cannot be executed in this Linux container and must be validated on actual hardware.
2. **Real-Time 4-Track CPU Headroom on Older Hardware:** Software headless Chromium rendered 2.0 s of 4 simultaneous heavy AudioWorklet + Freeverb tracks in `1.58 s` (`RTF = 0.791`, under real-time even without hardware acceleration). Real iPad thermal throttling or older Intel Macs running 7-voice unison chords across all 4 tracks simultaneously may still require keeping total simultaneous voices reasonable.
3. **30-Minute Live WAV Cap Retained:** `RECORDER_MAX_SECONDS = 1800` and live RAM caps (`256 MB` / `128 MB`) remain enforced until chunked OPFS/IndexedDB storage is implemented.



