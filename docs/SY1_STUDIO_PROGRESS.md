> **Phase 6.1 — 2026-11-22 (Local Unpushed, Pending Approval):** Safety & UX fixes on top of `main` (`9bad2de323`): replaced native `window.confirm()` Clear Track prompt with accessible in-app `#st-clear-dialog` (`alertdialog`, Escape/Cancel/Tab trap), added compact always-accessible Undo/Redo controls (including touch-only operation when 0 regions remain), and fixed `clearTrackClip()` to delegate to undoable `RegionEditor.clearTrack()` without wiping unrelated Undo/Redo history.
>
> **Phase 6 — 2026-11-21 (Merged to `main` `9bad2de323`):** Non-destructive MIDI region editing (move, trim, split, merge, copy/cut/paste, duplicate, loop, repeat, undo/redo, region-scoped Piano Roll & Drum Grid, touch long-press menu); see [Phase 6 report](SY1_STUDIO_PHASE6.md).
>
> **Phase 5 — 2026-11-21 (Merged to `main` `0ba71fc54b`):** Synth-view MIDI recording and shared audio-clock metronome; see [Phase 5 report](SY1_STUDIO_PHASE5.md).
>
> **Phase 4 Stabilization — 2026-11-21 (Merged to `main` `82e8b700b2`):** Studio recovery & independent 8-instrument architecture (SY-1 + 7 city synths including Kerman Drum Machine); see [Studio recovery report](SY1_STUDIO_RECOVERY_2026-11-21.md). Historical sections below are retained for audit history.

# SY-1 Studio (Web) — Engineering Progress Log

**Repository:** `https://github.com/armshokri-debug/Synthesizer-New`  
**Verified `main` Baseline:** `9bad2de323` (`Merge pull request #3 from armshokri-debug/feat/midi-region-editing`)  
**Protected Native/VST3 Scope:** `native/**`, `plugin/**`, `src/dsp/**`, `src/machines/**`, `src/ui/panel.ts`, `src/index.css`, `src/ui/skins.css` (unchanged)

---

## Current Phase Status

| Phase | Scope | Status | Gate |
|---|---|---|---|
| **Phase 0** | Protected Checkpoint, Baseline Audit, Branch Setup, Architecture Blueprint, Test Plan | **COMPLETE** (`2415939`) | Signed off |
| **Phase 1** | Multi-Track SY-1 Audio Engine (2 isolated tracks expandable to 4), Shared `AudioContext` + Transport (`Play`/`Stop`/`Rec`/`Loop`, BPM, `8/12/64/128/custom` bars), MIDI Rec + SMF-1 Export, 24-bit WAV Live & Bounce Export, Studio UI, Automated Bun + Chromium Verification | **COMPLETE** (`079b29f2392d7381c21f997601239fbe2bb9b61a`) | Signed off & merged |
| **Phase 2** | Project Save / Open (`IndexedDB`), Autosave & Refresh Recovery, Versioned `.sy1studio` Export / Import with Validation, Separate 24-bit Stereo WAV Stems (`bounceTrackStemsWav`), Preserved Mix WAV + SMF-1 MIDI, Recording RAM Safety Guardrails (30-min cap preserved), Minimal Project UI | **COMPLETE** (`20340c00c5de9c857a5c52debdd68f9edbd782b1`) | Signed off & merged |
| **Phase 3** | Audio Stability & Performance for 4 Simultaneous Tracks (Zero-Leak Bus/Master/Track Disposal, `O(log N + K)` Scheduler + Stall Guard, iPadOS Safari Interrupt/Background Recovery, Idle `rAF` Elimination & Non-Destructive Slider Drag, 4-Track Automated Stress & Regression Suites) | **COMPLETE** (`26242cf02cf9960638f8bf6dc1016d305aa71725`) | Signed off & merged |
| **Phase 4** | Professional DAW UI/UX + Recovery Stabilization (Full-Width Arrangement Timeline, Integrated Resizable MIDI Piano Roll & Kerman Drum Grid, Collapsible 8-Instrument Browser, Independent Per-Track Engines, Mixer with Live Meters, Unchanged Original Synth Instrument View, 5-Viewport Responsive Layout) | **COMPLETE** (`82e8b700b2`) | Merged to `main` ([Recovery Report](SY1_STUDIO_RECOVERY_2026-11-21.md)) |
| **Phase 5** | Record Directly from Standalone Synth View into Studio + Shared Audio-Clock Metronome & 1-Bar Count-In | **COMPLETE** (`0ba71fc54b`) | Merged to `main` ([Phase 5 Report](SY1_STUDIO_PHASE5.md)) |
| **Phase 6** | Non-Destructive MIDI Region Editing (Select, Move, Trim Left/Right, Loop, Repeat, Split, Merge, Copy/Cut/Paste, Duplicate, Undo/Redo, Region-Scoped Piano Roll/Drum Grid, Touch Context Menu, Legacy Project Compatibility) | **COMPLETE** (`9bad2de323`) | Merged to `main` ([Phase 6 Report](SY1_STUDIO_PHASE6.md)) |
| **Phase 6.1** | Safety & UX Fixes (In-App Accessible Clear Track Confirmation Dialog replacing `window.confirm()`, Always-Accessible Touch & Desktop Undo/Redo Controls including Zero-Region State, `clearTrackClip()` History Preservation via `RegionEditor.clearTrack()`) | **COMPLETE — Local Unpushed, Pending Approval** | Stopped before push/merge/deploy |

---

## Phase 4 Log — 2026-11-21

### Completed Implementation (Zero DSP / Synth Redesign Changes)
1. **Full-Width Multitrack Arrangement Timeline (`src/ui/studio-panel.ts`, `src/ui/studio.css`)**
   - Edge-to-edge DAW arrangement (no decorative card wrapper) with unified horizontal/vertical scrolling, bar ruler, horizontal zoom (`1x–4x` slider, `−`/`+`, `Fit`), draggable loop start/end handles on the bar ruler, synchronized playhead, and sticky track headers aligned 1:1 with track lanes.
   - Track headers display color-coded track indicator, focus title, city synth quick-jump button, preset selector, `R`/`M`/`S`, inline Volume/Pan sliders (non-destructive drag), slim horizontal live level meter, MIDI channel selector, and Clear; track lanes show clean MIDI clip regions with note bars and double-click-to-open Piano Roll.
2. **Integrated Resizable MIDI Piano Roll (`src/ui/studio-piano-roll.ts`, `src/studio/track-engine.ts`, `src/studio/studio-engine.ts`)**
   - Embedded directly in the resizable bottom dock with pointer-captured horizontal splitter handle (`--st-dock-h`) and Expand/Split/Hide controls.
   - Interactive note editing: click empty grid to create snapped notes, click/Shift+click selection, drag to move pitch/time with live audition, drag right handle to resize duration, Delete/Backspace/double-click/right-click deletion, Snap (`Off`, `1/4`, `1/8`, `1/16`, `1/32`), Quantize (selected or all notes), horizontal zoom, sticky audition piano keyboard (`C6..C2`, auto-expanding), and scroll-synced draggable Velocity Lane (`0.05..1.0`).
   - All edits preserve existing CC64/CC1/pitchBend events (`replaceNoteSpans`, `quantizeNotes`).
3. **Collapsible Left Instrument Browser (`src/ui/studio-panel.ts`)**
   - Supports all **7 authentic HQEngine Iranian city synthesizers** (`SY-1`, `Yazd`, `Baku`, `Merv`, `Isfahan`, `Konya`, `Bam` — 169 presets) with `machineArt()` hardware previews, category filter tabs, instant search, and Studio-isolated favorites (`sy1_studio_favs`, never touching standalone `localStorage`).
   - Persists per-track `machineId` cleanly in `.sy1studio` project files and IndexedDB while maintaining backward compatibility with older v1 files (defaulting to `"sy1"`).
4. **Bottom Dock Modes: Piano Roll · Mixer · Unchanged Original Synth Instrument View (`src/ui/studio-instrument.ts`, `src/ui/knob.ts`)**
   - **Instrument View:** Renders the focused track's original `.synth-panel`, `.synth-sections`, `.synth-sec`, 3D `.sk` knobs with `.sk-scale`/`.sk-skirt`/`.sk-cap`/`.sk-rotor`, `.synth-choice` switches, and `[data-machine]`/`[data-skin]` hardware materials **100% unchanged**, bound exclusively to the focused `SY1TrackEngine` (plus `Expand` toggle for full-height instrument focus and `#sy1-studio` event guards in `knob.ts`).
   - **Mixer View:** Independent vertical channel strips for all tracks + Master strip with Pan, `R`/`M`/`S`, vertical Volume fader + dB readout, and zero-allocation live meters (`readMeterLevel()` / `readMasterMeterLevel()`) updated only during active playback (preserving `idleRafWhileStopped === false`).
5. **Fixed Top Transport & Responsive Behavior**
   - Fixed brushed-metal transport bar (`← Synth`, `Browser`, Project Name, `Play`/`Stop`/`Rec`/`Loop`, Bar:Beat LCD, BPM `−`/Tap/`+`, Bars `8/12/64/128/custom`, `Save`, `Open`, `Export ▾` menu with 24-bit WAV Mix/Stems/MIDI/Live WAV/Project `.sy1studio` export & import, and `Keys` toggle).
   - Responsive across Desktop (`1440×900`), iPad Landscape (`1024×768`), and iPad Portrait (`768×1024`) with zero horizontal overflow, adaptive overlay browser on portrait screens, and accessible touch targets (`>= 40px` on portrait/touch).

### Automated Verification Executed (Simulated / Headless)
- **`npm run lint` (`tsc --noEmit`) & `npm run build` (`vite build`):** **PASS** (0 errors).
- **Protected-path check (`native/**`, `plugin/**`, `src/dsp/hq-engine.ts`, `src/engine/worklet/sy1-processor.ts`, `src/index.css`, `src/ui/skins.css`):** **PASS** (0 diffs).
- **Bun Automated Suite (`studio-phase1` + `studio-phase2` + `studio-phase3` + `studio-phase4`):** **47/47 PASS** (0 fail, 8,645 assertions).
- **Real Headless Chromium CDP Verification (`node scripts/studio-chromium-verify.mjs`):** **ALL Phase 1, Phase 2, Phase 3 & Phase 4 CHECKS PASS** (`0` page errors, `0` console errors; 6-preset `chainMaxAbsDiff === 0.0`; Track 2 isolation `0.0`; 2- & 4-track stems `-119.55 dB` / `-117.02 dB`; 4-track stress `RTF = 0.747`; `idleRafWhileStopped = false`; standalone synth visual regression identical before/after Studio; Yazd city synth original faceplate `.st-embedded-synth[data-machine="yazd"]` with 9 sections & 35 `.sk` knobs; Piano Roll note create + quantize + save; Mixer 4 strips + Master + 5 meters; Desktop `1440×900`, iPad Landscape `1024×768`, and iPad Portrait `768×1024` all `scrollWidth === innerWidth` with zero clipping).
- **Real Physical Hardware Tests (macOS Chrome speakers/Web MIDI & physical iPadOS Safari touch/gestures):** **`NOT RUN`** (physical hardware unavailable in container).

---

## Phase 3 Log — 2026-11-21

### Completed Implementation (Zero DSP / Gain-Staging Changes)
1. **100% AudioNode, Oscillator & Buffer Disposal (`src/engine/bus.ts`, `src/studio/track-engine.ts`, `src/studio/studio-engine.ts`)**
   - Fixed a critical leak in `disposeSynthBus()` that previously left **91 of 95 internal AudioNodes and all 13 cyclic feedback loops** (tape delay, 8 Freeverb combs, 4 Schroeder allpasses) connected on every track detach/project reload. All internal nodes are now tracked and disconnected (`95/95` disconnected, `0` leaked).
   - Cached immutable `makeSoftClipCurve()`, `makeTanhCurve()`, `makeStudioMasterClipCurve()`, and per-sampleRate `measureDampPeakGain()` probe results; tracked `lastDriveApplied` to eliminate redundant 1024-sample `makeDriveCurve()` allocations.
   - Added `disposeStudioMasterBus()`, full `SY1TrackEngine.dispose()` (clearing `hqNode.port.onmessage`, `classicVoices`, `listeners`, and event buffers), called `old.dispose()` on `loadProject()`/`dispose()`, and immediately cleared `rec.chunks` + `onmessage` after `encodeWav()` in `stopLiveMixRecorder()`.
2. **Scheduler `O(log N + K)` Performance & Stall / Stuck-Note Protection (`src/studio/track-engine.ts`, `src/studio/studio-engine.ts`)**
   - Replaced per-25ms `O(N)` linear scan + array allocation + re-sort in `scheduleSegment()` with lazy-sorted zero-allocation `forEachEventInRange()` binary search — reducing 1,000-step 8,000-event scheduler time from **`67.26 ms` to `8.76 ms` (7.68× faster, −87.0% CPU)**.
   - Added `SCHEDULER_STALL_THRESHOLD_SEC = 0.35` recovery guard in `stepScheduler()` to cleanly release active playback notes and phase-lock re-anchor after main-thread stalls or iPad background sleep without burst-firing stale backlog events.
   - Cleared `playbackOpenNotes` / `playbackSustainDown` on mid-playback `setTrackPreset()`, and short-circuited identical parameter writes in `SY1TrackEngine.setParam()` to eliminate redundant worklet messages and UI churn.
3. **iPadOS Safari Audio Init, Interrupt & Touch Ergonomics (`src/engine/bus.ts`, `src/studio/studio-engine.ts`, `src/ui/studio-panel.ts`, `src/ui/studio.css`)**
   - Exported `onAudioContextStateChange()` and wired `SY1StudioEngine.handleAudioContextStateChange()` so `"interrupted"` / `"suspended"` cleanly releases all voices (`0` stuck notes) and resets `unlockedOnce` for re-unlock, while returning to `"running"` cleanly re-anchors the audio clock without backlog burst. Added `pageshow` & `focus` resume hooks and `onended` disconnect on the 1-sample silent unlock buffer.
   - Eliminated idle 60–120 Hz `rAF` loop when stopped, cached playhead & clock DOM references using lightweight `getPlayheadPosition()`, fixed Volume/Pan `<input type="range">` DOM destruction during drags (`draggingRange` guard), deferred autosave timer churn during active knob/slider drags, and added pointer-captured touch ruler scrubbing + `-webkit-touch-callout: none` / `touch-action: pan-x`.
4. **Automated 4-Track Stress & Regression Suites (`tests/studio-phase3.test.ts`, `src/studio/parity-probe.ts`, `scripts/studio-chromium-verify.mjs`)**
   - Added 10 new Bun tests covering 4-track 32-loop stress + sweeps/presets/recording, 4-instance `HQEngine` DSP stress, 8,000-event scheduler performance & `+2.0 s` stall recovery, 100% AudioNode/oscillator disposal across 12× 4-track `loadProject()` cycles, and iPad `"interrupted"` -> `"running"` recovery.
   - Extended real headless Chromium CDP verification with `runOffline4TrackStressProbe(48000, 2.0)` (4 simultaneous full AudioWorklet tracks, `RTF = 0.791`, `0` NaN/Inf, peak `<= 1.0`), idle `rAF` check, range slider DOM-preservation check, and 10× 4-track reload heap check (`26.45 MB -> 13.04 MB`).

### Automated Verification Executed (Simulated / Headless)
- **`npm run lint` (`tsc --noEmit`) & `npm run build` (`vite build`):** **PASS** (0 errors).
- **Protected-file check (`git diff c3f7c3e... -- native plugin src/dsp/hq-engine.ts src/engine/worklet/sy1-processor.ts`):** **PASS** (0 diffs).
- **Bun Automated Suite (`studio-phase1` + `studio-phase2` + `studio-phase3`):** **41/41 PASS** (0 fail, 8,568 assertions).
- **Real Headless Chromium CDP Verification (`node scripts/studio-chromium-verify.mjs`):** **ALL Phase 1, Phase 2 & Phase 3 CHECKS PASS** (`0` page errors, `0` console errors; 6-preset `chainMaxAbsDiff === 0.0`; Track 2 isolation `0.0`; 2- & 4-track stems `-119.55 dB` / `-117.02 dB`; 4-track stress `RTF = 0.791`, `nonFiniteSamples = 0`, `peak <= 1.0`; `idleRafWhileStopped = false`; `sliderConnectedDuringDrag = true`; 10× reload heap `-13.41 MB`).
- **Real Hardware Tests (macOS Chrome speakers/Web MIDI & iPadOS Safari real touch/interrupt/Jetsam):** **`NOT RUN`** (physical hardware unavailable in container).

---

## Phase 2 Log — 2026-11-21

### Completed Implementation
1. **Save / Open Project & IndexedDB Autosave (`src/studio/storage.ts`, `src/studio/project-io.ts`)**
   - Implemented versioned `sy1-studio-project` (`v1`) JSON serialization covering project ID/name, BPM, bars, loop enable/range, focused track, and all track presets, full `SYNTH_PARAMS` patches, volume, pan, mute, solo, record-arm, MIDI channel, and all MIDI events (`noteOn`, `noteOff`, `cc`, `pitchBend`).
   - Built IndexedDB storage adapter (`sy1-studio-db`, stores `projects` & `autosave`) with structured error classification (`quota`, `unavailable`, `corrupt`, `io`), zero unhandled rejections, debounced `800 ms` autosave + `pagehide`/`visibilitychange` flush, and startup recovery (`hydrateStudioFromStorage()`).
   - Isolated Studio project BPM (`studioEngine` uses `isolatedTempo: true` + project-local `tapBpm()`) so loading or saving a Studio project never leaks BPM into standalone SY-1's `localStorage` (`sy1_bpm`).
2. **Project Export / Import (`.sy1studio`) with Strict Pre-Apply Validation**
   - Added `.sy1studio` download & file import backed by strict `validateStudioProject` / `parseStudioProjectJson` (rejects malformed JSON, unsupported format/version, out-of-range BPM/bars/track count, duplicate IDs, bad patches, invalid MIDI ticks/pitches/events, and `>16 MB` payloads before touching live engine state).
3. **Separate Sample-Aligned 24-bit Stereo WAV Stems (`bounceTrackStemsWav`)**
   - Refactored deterministic `OfflineAudioContext` rendering into shared `renderTracksOffline()` powering both full mix (`bounceArrangementWav`, `useMasterBus: true`) and sequential per-track stems (`bounceTrackStemsWav`, `useMasterBus: false`, sample-aligned to frame 0, exact `24-bit Stereo PCM`, zero normalization, zero extra compression, low peak RAM).
   - Preserved existing 24-bit WAV Mix export, Live WAV capture, and SMF Format 1 MIDI export unchanged.
4. **Recording Safety & Minimal UI (`src/studio/studio-engine.ts`, `src/ui/studio-panel.ts`, `src/ui/studio.css`)**
   - Preserved `RECORDER_MAX_SECONDS = 1800` (30-min cap) and added live RAM safety guardrails (`14 bytes/frame`, `256 MB` desktop / `128 MB` mobile/iPad) stopping live capture gracefully before browser OOM.
   - Added compact hardware-matched project toolbar (`Project Name`, `Save`, `Open`, `Export Project`, `Import .sy1studio`, inline Saved Projects / Autosave Recovery drawer) and `Export Stems` button with `>= 40px` touch targets on tablet/coarse pointers.

### Automated Verification Executed
- **`npm run lint` (`tsc --noEmit`) & `npm run build` (`vite build`):** **PASS** (0 errors).
- **Protected-file check (`git diff c3f7c3e... -- src/dsp/hq-engine.ts src/engine/worklet/sy1-processor.ts native plugin`):** **PASS** (0 diffs).
- **Bun Automated Suite (`tests/studio-phase1.test.ts` + `tests/studio-phase2.test.ts`):** **31/31 PASS** (0 fail, 8,484 assertions):
  - All 22 Phase 1 regression tests PASS.
  - All 9 Phase 2 tests PASS (4-track project round-trip, post-restore 60/110/140 BPM MIDI timing `< 1e-6 s`, invalid/corrupted `.sy1studio` rejection with zero live-state mutation, IndexedDB CRUD + `QuotaExceededError` / `SecurityError` / corrupt-record handling, and 30-min + desktop/mobile RAM safety guardrails).
- **Real Headless Chromium CDP Verification (`node scripts/studio-chromium-verify.mjs`):** **ALL CHECKS PASS** (0 page errors, 0 console errors):
  - All Phase 1 regression checks PASS (standalone SY-1, 6-preset `chainMaxAbsDiff === 0.0`, Track 2 isolation `0.0`, 2-bar bounce exact `192000` frames, UI E2E).
  - **2-Track WAV Stems:** exact `96000` frames, valid 24-bit stereo headers, sum-vs-mix `maxDiff = 3.576e-7` (**`-119.55 dB`**).
  - **4-Track WAV Stems:** exact `96000` frames, valid 24-bit stereo headers, sum-vs-mix `maxDiff = 4.768e-7` (**`-117.02 dB`**).
  - **Post-Restore Parity & Isolation:** pre-save vs post-restore **`0.0` bit-exact**; post-restore Track 2 isolation **`0.0` bit-exact**.
  - **Save -> Real CDP `Page.reload` -> Restore:** standalone tempo remained `110 BPM` before opening Studio; all 3 tracks, custom name, `132 BPM`, `12 bars`, loop `2..10`, presets/cutoffs/res/mixer/MIDI notes, and Open drawer restored cleanly.
  - **Export -> Import -> Restore & Invalid Import Rejection:** corrupted JSON/schema rejected atomically with `.is-error` status and zero state mutation; valid `.sy1studio` restored cleanly.
  - **Chromium `QuotaExceededError` Handling:** classified cleanly as `kind: "quota"` with zero unhandled errors; clean IndexedDB teardown (`JS Heap: 32.47 MB / 35.91 MB`).

### Unexecuted Tests, Remaining Risks & Stop Boundary
- **`NOT RUN`:** Real macOS Intel Chrome manual testing (real audio speakers, multi-file stem download permission prompt, physical Web MIDI), real iPadOS Safari testing (multi-file download UX, iOS Safari IndexedDB quota/eviction, long-take Jetsam ceiling), and external DAW import of stems/MIDI.
- **Git Policy:** Local working tree only on `feature/sy1-studio-web`. Nothing pushed, merged, or deployed. **Stopped after Phase 2.**

---

## Phase 1 Log — 2026-11-21

### Completed Implementation
1. **True Per-Track Isolation Without Duplicated Iframes or DSP Rewrites**
   - Generalized `src/engine/bus.ts` (`createSynthBus`, `applyBusParam`, `disposeSynthBus`), `src/engine/hq.ts` (`ensureHQModule`, `createHQNode`), and `src/engine/voice.ts` (`VoiceRoutingOptions`) while keeping standalone `getSynthBus()` / `initHQ()` / `synth.ts` behavior untouched.
   - Built `SY1TrackEngine` (`src/studio/track-engine.ts`) owning an isolated `SynthPatch`, independent `"sy1-voices"` `AudioWorkletNode` (`HQEngine`), independent `SynthFXBus`, isolated Classic fallback pool, channel strip (`fader -> StereoPannerNode -> muteGate`), poly/mono/legato/sustain/bend/mod state, tempo-synced LFO, and MIDI clip events.
   - Built `SY1StudioEngine` & `createStudioMasterBus` (`src/studio/studio-engine.ts`) inside the single shared `AudioContext`: unity master summing bus with transparent safety soft-clipper (exact identity `y = x` for `|x| <= 0.98`, ceiling `1.0`, **no second DynamicsCompressor**).
2. **Master Transport, Timeline & Recording/Export**
   - Audio-clock lookahead transport (`25 ms` interval / `100 ms` lookahead) with `Play`, `Stop`, `Record`, `Loop`, shared `tempo.ts` BPM (with drift-free mid-playback tempo re-anchoring), and bar-based timeline (`8`, `12`, `64`, `128`, or custom `1..512` bars).
   - Simultaneous multi-track MIDI recording (per-track Arm + MIDI Ch `All / 1..16`), binary SMF Format 1 multi-track export (`src/studio/midi-io.ts`) + parser, live 24-bit Stereo PCM WAV mix recording (preserving `RECORDER_MAX_SECONDS = 1800`), and deterministic `OfflineAudioContext` 24-bit Stereo WAV arrangement bounce (`bounceArrangementWav`).
3. **Web-Only Touch-Ready Studio UI**
   - Dedicated Studio view (`#sy1-studio`, `src/ui/studio-panel.ts`, `src/ui/studio.css`) toggled via a compact `Studio` button in standalone `.synth-top` (strictly disabled when `window.__SY1_PLUGIN__` is set).
   - Starts with 2 tracks (`SY-1 Track 1` + `SY-1 Track 2`), expandable up to 4 tracks via `+ Track`, with per-track SY-1 preset selector (all 30 presets), `R`/`M`/`S`, Volume, Pan, MIDI Ch, Clear, clickable bar timeline with `rAF` playhead, and focused-track SY-1 synth inspector (OSC, Filter, Env, LFO, FX).
   - Reuses the on-screen keyboard, QWERTY keys, PB/MOD wheels, and Web MIDI via clean routing adapters (`src/ui/keyboard.ts`, `src/engine/midi.ts`) without mutating standalone `synth.ts` or `localStorage`.

### Automated Verification Executed
- **`npm run lint` (`tsc --noEmit`) & `npm run build` (`vite build`):** **PASS** (0 errors).
- **Protected-file check (`git diff c3f7c3e... -- src/dsp/hq-engine.ts src/engine/worklet/sy1-processor.ts native plugin`):** **PASS** (0 diffs).
- **Bun Automated Suite (`bun test --preload ./tests/vite-url-preload.ts tests/studio-phase1.test.ts`):** **22/22 PASS** (8,349 assertions):
  - A1 pure DSP parity (`maxAbsDiff === 0.0` across 6 presets), B1–B6 isolation, C1–C3 tempo (60/110/140 BPM + mid-play change + 16 loop cycles), D1–D5 multi-track MIDI & SMF-1 round-trip, E1–E3 24-bit WAV + 30-min cap, F1–F3 bar lengths, G-DSP Linux Bun benchmark (`17.77%` RT-load 2-track, `17.14%` RT-load 4-track, `0.00 MB` heap delta).
- **Real Headless Chromium Verification (`node scripts/studio-chromium-verify.mjs`):** **ALL CHECKS PASS** (0 page errors, 0 console errors):
  - Standalone regression & post-Studio state preservation: **PASS**.
  - A2a bit-exact Chromium `OfflineAudioContext` chain parity (`revMix=0`, full `AudioWorklet` + `SynthFXBus` + `StudioMasterBus`): **`0.0000000` (`-Infinity dB`)** across all 6 presets.
  - A2b full-preset parity (with untouched Freeverb): `-0.35` to `+0.65 dB` RMS (within standalone SY-1's own Chromium Blink `HashSet` cycle-break variance of up to `+1.38 dB`; `init` hit `0.000 dB` / `4.77e-7`).
  - B2/B3 Chromium `OfflineAudioContext` track isolation: **`0.0000000` (`-Infinity dB`)** Track 2 delta while Track 1 blasts `superSaw` + `cutoff=120` + `res=16` + `revMix=0.9` + `delayMix=0.8`.
  - E2 Chromium `OfflineAudioContext` 24-bit Stereo WAV bounce: exact `192000` frames (`4.000 s` @ 48 kHz), valid RIFF/WAVE PCM header, active stereo signal (`peakL=0.592`, `peakR=0.595`).
  - Studio UI E2E + live take capture + JS Heap (`17.37 MB / 22.89 MB`): **PASS**.

### Known Defects, Unexecuted Tests & Remaining Risks
- **Unexecuted (`NOT RUN`):** Real macOS Intel Chrome speakers/Web MIDI/60s–120s real-time dropout listening (A3, G1–G4, H), real iPadOS Safari touch/Jetsam RAM testing (H), external DAW `.mid` import check (D5 DAW).
- **Known Artifact (Engine-Neutral):** Chromium Blink's `AudioNodeInput` `HashSet` pull order inside Freeverb's feedback cycles produces discrete 0/128-sample comb phase buckets across separate `OfflineAudioContext` runs for both standalone SY-1 and Studio equally.
- **Not Yet Built (Planned for Phase 2):** IndexedDB / `.sy1studio.json` project save/load, MIDI import UI, per-track stem WAV export UI, streaming storage to lift the 30-minute live recording cap safely.
- **Git Remote Policy:** Nothing pushed, merged, or deployed. Stopped after Phase 1 report.

---

## Phase 0 Log — 2026-11-20

### Completed Actions
1. **Verified GitHub Baseline & Workspace Integrity**
   - Queried remote `https://github.com/armshokri-debug/Synthesizer-New.git`:
     - `refs/heads/main` = `c3f7c3e883b8185c543144cfa1b46c18883a6e5d`
     - `refs/heads/fix/realtime-state-publication` = `af4d2d6b8174aff8c0747549693910512abbb075`
   - Confirmed `/app/applet` originally had no `.git` folder.
   - Performed full recursive diff against `origin/main`:
     - Zero differences across all source files (`src/`), docs (`docs/`), native (`native/`), plugin (`plugin/`), public (`public/`), scripts (`scripts/`), and build configs.
     - Only container/lockfile artifacts differed (`bun.lock`, `package-lock.json`, `.aistudio/`). None were deleted or overwritten.
2. **Created Independent Studio Branch**
   - Anchored local `main` at `c3f7c3e883b8185c543144cfa1b46c18883a6e5d` without touching working tree files.
   - Created and checked out `feature/sy1-studio-web` from `c3f7c3e883b8185c543144cfa1b46c18883a6e5d`.
3. **Audited Existing Web Audio & Engine Architecture**
   - Inspected `src/engine/daw.ts`, `src/ui/daw-panel.ts`, `src/engine/tempo.ts`, `src/engine/midi.ts`, `src/engine/cc-map.ts`, `src/engine/synth.ts`, `src/engine/bus.ts`, `src/engine/hq.ts`, `src/engine/voice.ts`, `src/engine/arp.ts`, `src/engine/worklet/sy1-processor.ts`, `src/dsp/hq-engine.ts`, `src/engine/mirror.ts`, `src/engine/calls.ts`, and `src/main.ts`.
   - Verified `SY1Processor` (`"sy1-voices"`) already creates an isolated `HQEngine` per `AudioWorkletNode`, enabling true multi-instance SY-1 inside a single `AudioContext` with zero DSP modifications.
   - Identified the existing 30-minute recorder cap (`MAX_SECONDS = 30 * 60` in `src/engine/daw.ts:349`) and quantified its RAM profile (~1.21 GB peak at 48 kHz stereo) as a critical iPad Safari constraint.
4. **Created Phase 0 Documentation**
   - `docs/SY1_STUDIO_CHECKPOINT.md`
   - `docs/SY1_STUDIO_TEST_PLAN.md`
   - `docs/SY1_STUDIO_PROGRESS.md`
5. **Ran Baseline Project Verification**
   - `npm run lint` (`tsc --noEmit`): **PASS** (0 errors).
   - `npm run build` (`vite build`): **PASS** (62 modules, 583 ms, all 5 AudioWorklet bundles built cleanly).
   - `bun scripts/layout-audit`: **NOT RUN** (`playwright` JS module not installed in container).
   - Native VST3/AU builds & tests: **NOT RUN** (intentionally untouched per Phase 0 boundary).

### Open Risks & Guardrails Going Into Phase 1
- **Audio Gain Staging Parity:** Master summing bus must NOT insert a second `DynamicsCompressorNode` (which would alter single-track dynamics vs standalone SY-1). Use unity sum + existing soft-clip safety ceiling (identity for `|x| <= 0.9`).
- **iPadOS Safari Memory Budget:** Do not remove `MAX_SECONDS = 30 * 60` without implementing chunked OPFS/IndexedDB PCM recording. For multi-track stem WAV export on iPad, prefer offline/per-track bounce over 4 simultaneous in-RAM stereo Float32 recorders.
- **CPU Budget (Intel Mac Chrome & iPad Safari):** Measure 2-track CPU and glitch-free headroom first (with heavy `Super Saw` + `Dream Pad` + `Ladder Bass` presets) before unlocking 4 tracks.
- **Plugin Isolation:** Guard all Studio initialization behind `!(window as any).__SY1_PLUGIN__`.
- **GitHub Push Access:** AI Studio sandbox has read access to GitHub (`git fetch` works), but lacks interactive GitHub push credentials. Commit will be created cleanly on local `feature/sy1-studio-web`; push will be attempted and exact result reported.

