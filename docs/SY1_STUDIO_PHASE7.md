# SY-1 Studio — Phase 7: GarageBand Workflow, Project Safety & Audio Performance

**Repository:** `armshokri-debug/Synthesizer-New`  
**Verified `main` Baseline:** `7545e2d6e7d5d2de9cf863ce31b8520f193afdfa` (Phase 6.1 merged)  
**Status:** Complete locally (unpushed, pending review/approval)  
**Protected Scope (Unchanged):** `native/**`, `plugin/**`, `src/dsp/**`, `src/machines/**`, `src/ui/panel.ts`, `src/index.css`, `src/ui/skins.css`, `docs/evidence/**`

---

## 1. Verified Defects & Architectural Gaps Found During Pre-Edit Audit

1. **Single-Project Overwrite Risk (`sy1-default`):** `SY1StudioEngine` defaulted to a single hard-coded project ID (`"sy1-default"`), with no `New Project`, `Duplicate / Save As`, `Rename`, or in-app `Delete` workflow. Starting fresh or importing an existing project ID risked silently overwriting Project A.
2. **Unsaved-Changes & Mid-Recording Hazards:** Switching/loading projects had no unsaved-changes guard modal and did not block `loadProject()` while recording or during count-in.
3. **Concurrent IndexedDB Write Races:** Rapid saves/autosaves/deletes could interleave `readwrite` transactions without serialization.
4. **Recording Mode Limitations:** Recording only supported merge/overdub; users had no GarageBand-style Separate Takes or explicit undoable Replace mode, and clicking a track header did not automatically arm that track exclusively for fast iPad single-track recording.
5. **Unnecessary Audio Graph & Main-Thread Overhead:**
   - Every track's 95-node `SynthFXBus` connected and ran cyclic tape-delay feedback (with 2× oversampled saturation), stereo modulated chorus delays, and 8-comb + 4-allpass Freeverb feedback loops even when `delayMix === 0`, `chorusMix === 0`, or `revMix === 0` (4-track mixed offline bounce ran at `1681.9 ms` / `RTF 0.841` on 2-vCPU Headless Chromium).
   - Editing another track during playback called `detachAudio()` + `attachAudio()` on Kerman drum tracks, tearing down and rebuilding the entire 95-node `SynthFXBus`.
   - `makeDriveCurve(amount)` reallocated a 1024-sample `Float32Array` on every drive change without bounded caching.
   - `StudioMetronome.cancel()` stopped oscillators without disconnecting them or clearing `voices`.
   - Every live MIDI event received during recording triggered `requestRender()` full `#sy1-studio` `innerHTML` rebuilds and rescheduled IndexedDB autosave churn.
   - Muted tracks still scheduled `noteOn` voice triggers during playback even though their mute gate was `0`.

---

## 2. Implemented Changes

### 2.1 Safe Independent Projects (`My Projects`)
- **Collision-Free Unique IDs (`src/studio/project-io.ts`):** Added `createProjectId()` combining timestamp, monotonic counter, and random/UUID suffix (`proj-...`). Preserved full backward compatibility with legacy `"sy1-default"` and v1 `.sy1studio` files.
- **Serialized Storage Queue & CRUD (`src/studio/storage.ts`):** Serialized all IndexedDB `readwrite` operations via a per-adapter promise queue (`enqueueWrite`) and added `renameProject(id, name)` and `duplicateProject(sourceId, newName?)` (always assigning a brand-new project ID). Structured `QuotaExceededError`, unavailable-storage, and corrupt-record handling remains intact without ever discarding in-memory recordings.
- **Engine Project Lifecycle Guards (`src/studio/studio-engine.ts`):** Added `createNewProject(opts?)` and `duplicateCurrentProject(newName?)`. Explicitly blocked `loadProject()`, `createNewProject()`, and `duplicateCurrentProject()` while recording or preparing count-in.
- **My Projects Drawer & Accessible In-App Modals (`src/ui/studio-panel.ts`, `src/ui/studio.css`):**
  - Clear local-only disclosure: *"Saved locally in this browser · No cloud sync"*.
  - Actions: `+ New Project`, `Save As / Duplicate`, `Rename Current`, `Import .sy1studio` (with ID-collision protection), `Autosave Recovery` (`Recover`), and per-project `Open`, `Duplicate`, `Rename`, and `Delete` (all disabled while recording).
  - Compact dirty/save status indicator (`#st-save-state`: `Saved` / `Unsaved` / `Saving…` / `Save failed`) backed by content-signature tracking.
  - Zero native `window.confirm` / `window.alert` / `window.prompt`: all flows use accessible, focus-trapped in-app modals (`#st-unsaved-dialog` with Cancel / Discard / Save & Continue, `#st-project-name-dialog`, `#st-delete-project-dialog`, `#st-clear-dialog`).

### 2.2 GarageBand-Style Per-Track Recording
- **Recording Modes (`src/studio/types.ts`, `src/studio/track-engine.ts`, `src/studio/studio-engine.ts`):**
  - `overdub` (default, v1-compatible): preserves existing regions/notes and merges/appends cleanly.
  - `takes`: keeps existing regions untouched and creates a distinct new take region.
  - `replace`: suppresses armed track clip playback during capture, replaces armed regions cleanly with full Undo/Redo support, and preserves existing regions if 0 notes were recorded.
- **GarageBand Track Focus Arming (`src/ui/studio-panel.ts`):** Selecting a track header while stopped (and when tracks use Omni MIDI Ch `All`) automatically arms that track exclusively; the explicit `R` button continues to support multi-track arming.
- **Direct Access Controls (`src/ui/studio-panel.ts`, `src/ui/synth-recording.ts`):** Compact `Click` (`#st-click-btn`), `1-Bar In` (`#st-countin-btn`), and active Recording Mode indicator surfaced directly in the Studio timeline toolbar; Recording Mode radio controls placed cleanly inside `More ▾` (viewport-bounded with internal scroll). Synth view (`#synth-recording`) stays synced with active project name and recording mode on the same shared `SY1StudioEngine`.

### 2.3 Measured Audio Stability & CPU Efficiency (Zero DSP / Sound Changes)
- **Lazy Zero-Mix FX Branch Activation (`src/engine/bus.ts`):** Tape delay feedback loop, stereo modulated chorus delay/merger branch, and Freeverb 8-comb/4-allpass graph activate only when `delayMix > 0`, `chorusMix > 0`, or `revMix > 0` respectively (activating immediately in `applyBusParam()` on first rise above `0`). Produces mathematically `0.0` bit-identical dry output and identical wet audio when active.
- **Bounded Drive Curve Cache (`src/engine/bus.ts`):** Exact-key 64-entry cache in `makeDriveCurve(amount)`.
- **Lightweight Drum Cancel (`src/studio/track-engine.ts`):** `cancelRegionPlayback()` on drum tracks now clears timers and swaps only the 4-node `TrackDrumBus` instead of tearing down and rebuilding the 95-node `SynthFXBus`.
- **Muted Playback Voice Skip (`src/studio/studio-engine.ts`):** `scheduleSegment()` skips `noteOn` dispatch on muted tracks (`!track.audible && !dispatchObserver`) while keeping `noteOff` cleanup active.
- **Metronome Cleanup (`src/studio/metronome.ts`):** `cancel()` disconnects stopped oscillators and clears `this.voices`.
- **Zero-Rebuild Live Recording UI (`src/ui/studio-panel.ts`):** While recording is active, incoming MIDI events update only targeted `[data-st-meta]` counts and save indicator in place (`0` full `#sy1-studio` DOM rebuilds during live capture), deferring IndexedDB autosave until `stop()`.

---

## 3. Measured Audio & CPU Benchmarks (Before vs After)

**Environment:** Linux Headless Chromium (`HeadlessChrome/155.0.8059.12`), 2 logical vCPUs, 48 kHz offline bounces (2.0 s = 96,000 frames, best of 2 runs) + live `AudioContext` (44.1 kHz, `baseLatency = 10 ms`, `outputLatency = 32 ms`).

| Benchmark / Metric | Before Phase 7 (`7545e2d6e7`) | After Phase 7 | Delta | Notes |
|---|---|---|---|---|
| Sound Parity (`softKeys`, `chainMaxAbsDiff`) | `0` | **`0`** | `0.0` (Bit-Exact) | Identical onset sample & peak |
| 4-Track HQ Stress (`runOffline4TrackStressProbe`, 2.0 s) | `1560.2 ms` (`RTF 0.780`) | **`1359.6–1480.4 ms`** (`RTF 0.680–0.740`) | **−5.1% to −12.9%** | `0` non-finite samples, `0` leaked voices |
| 1-Track Tabriz (Analog, 2.0 s) | `364.7 ms` (`RTF 0.182`) | **`342.6 ms`** (`RTF 0.171`) | **−6.1%** | `0` clips |
| 1-Track Kashan (FM, 2.0 s) | `612.6 ms` (`RTF 0.306`) | **`538.7 ms`** (`RTF 0.269`) | **−12.1%** | `0` clips |
| 1-Track Nishapur (Vector, 2.0 s) | `549.1 ms` (`RTF 0.275`) | **`479.7 ms`** (`RTF 0.240`) | **−12.6%** | `0` clips |
| 1-Track Shiraz (Strings, 2.0 s) | `541.5 ms` (`RTF 0.271`) | **`514.8 ms`** (`RTF 0.257`) | **−4.9%** | `0` clips |
| 1-Track Kerman (Drums, 2.0 s) | `356.7 ms` (`RTF 0.178`) | **`308.9 ms`** (`RTF 0.154`) | **−13.4%** | `0` clips |
| 2-Track Tabriz + Yazd (2.0 s) | `964.7 ms` (`RTF 0.482`) | **`928.8 ms`** (`RTF 0.464`) | **−3.7%** | `0` clips |
| **4-Track Tabriz + Yazd + Baku + Kerman (2.0 s)** | **`1681.9 ms` (`RTF 0.841`)** | **`1577.7 ms` (`RTF 0.789`)** | **−6.2%** | `0` clips, `rmsDeltaL = 0.00005` |
| 4-Track Mixed w/ 2 Tracks Muted (2.0 s) | `642.0 ms` (`RTF 0.321`) | **`583.6 ms`** (`RTF 0.292`) | **−9.1%** | `0` clips |
| Live Recording DOM Rebuilds (60 MIDI events) | Full rebuild per event | **`0`** | **−100% mid-rec rebuilds** | Verified via `MutationObserver` |
| Kerman `SynthFXBus` preserved on other-track edit | Torn down & rebuilt | **Preserved (`busBefore === busAfter`)** | Zero 95-node churn | Swaps only 4-node `TrackDrumBus` |
| JS Heap (Benchmark Session) | `12.11 MB` (`Δ 0.00 MB`) | **`12.11 MB` (`Δ 0.00 MB`)** | Bounded | 0 leaked AudioNodes/oscillators |

---

## 4. Automated Test Suites Executed

- **`npm run lint` (`tsc --noEmit`) & `npm run build` (`vite build`):** **PASS** (0 errors).
- **All 8 Bun Unit Suites (`studio-phase1` .. `studio-phase7` + `studio-recovery`):** **81/81 PASS** (`11,112` assertions, 0 fail).
- **All 5 Real Headless Chromium E2E Suites:**
  - `scripts/studio-phase7-verify.mjs`: **21/21 PASS** (My Projects A/B isolation, Unsaved modal, Save As, Delete modal, Reload persistence, 4-track Tabriz+Yazd+Baku+Kerman recording, Takes, `0` live recording DOM rebuilds, drum bus preservation, WAV/Stems/MIDI export, sound parity `0`, 4-track stress `RTF 0.680`, 5 responsive viewports `1440×900`..`390×844`, `0` native dialogs, `0` errors).
  - `scripts/studio-phase6-verify.mjs`: **PASS** (0 errors).
  - `scripts/studio-phase5-verify.mjs`: **PASS** (0 errors).
  - `scripts/studio-recovery-verify.mjs`: **PASS** (0 errors).
  - `scripts/studio-chromium-verify.mjs`: **PASS** (6-preset `chainMaxAbsDiff === 0`, Track 2 isolation `0`, 2- & 4-track stems `-119.55 dB` / `-117.02 dB`, post-restore parity `0`, 4-track stress `RTF 0.703`, desktop + iPad viewports, 0 errors).

---

## 5. Hardware-Only Tests (`NOT RUN`)

The following require physical hardware outside this Linux container and are honestly marked **`NOT RUN`**:
- Real macOS Intel Chrome audio speaker listening (60–120 s continuous 4-track glitch/dropout audition + physical USB Web MIDI controller recording).
- Real physical iPadOS Safari touch ergonomics, multi-touch keyboard + recording gestures, background/app-switch `AudioContext` `"interrupted"` recovery, and real Safari IndexedDB quota/Jetsam memory limits.
- External desktop DAW import verification (GarageBand / Logic Pro / Ableton Live) of exported `.mid` and 24-bit `.wav` stems.
