# SY-1 Studio — Protected Checkpoint (GitHub Record)

Date: 2026-11-21
Project: separate web/iPad mini-DAW studio, **not** the native VST3 project.
Source baseline: main @ `c3f7c3e883b8185c543144cfa1b46c18883a6e5d`
Separate VST3 branch: `fix/realtime-state-publication` @ `af4d2d6b8174aff8c0747549693910512abbb075` (do not modify).
Working branch: `feature/sy1-studio-web`.

## Proven baseline features
- `src/engine/daw.ts`: Web MIDI output/clock follower, 24-bit PCM stereo WAV take recorder and MIDI file exporter, `MAX_SECONDS=1800`.
- `src/ui/daw-panel.ts`: existing record/take/download UI.
- `src/engine/tempo.ts`: shared application tempo, DAW host sync in plugin.
- `src/engine/midi.ts`: Web MIDI input.
- `src/engine/synth.ts`: machine/preset/patch state is currently singleton.
- `src/engine/bus.ts`: cached AudioContext and shared FX bus.
- `src/main.ts`: embedded plugin mode detected by `window.__SY1_PLUGIN__`.

## Product contract
A light GarageBand-like recorder/arranger alongside the existing SY-1 web synth for macOS Chrome and iPad Safari, with independent synth tracks, one tempo/transport, quantized or freely recordable MIDI, loops/arrangement in user-selected bar counts, multitrack playback/recording, and downloadable MIDI/WAV. Start with two independently playable tracks; four only after acceptance.

## Audio invariants
Do not rewrite DSP algorithms, presets, envelopes, oscillator/filter/FX curves, or the native plugin. One shared AudioContext/audio clock; track state, note allocation and FX paths must be isolated. A user must be able to hear precisely the original SY-1 sound at unity settings. Do not claim parity without signal comparisons and non-deterministic tolerances. Studio UI only available when `!window.__SY1_PLUGIN__`.

## Phase 0 reported by AI Studio (external report, not independently reproduced here)
- AI Studio reported `npm run lint` PASS and `npm run build` PASS; device tests NOT RUN.
- AI Studio created three checkpoint docs in its sandbox and local commit `24159390a10e8a19c911466f80425b9630912ab7`, **but did not push it** because write credentials were unavailable.
- This GitHub checkpoint is **reconstructed from that report and repository inspection**, not claimed to reproduce verbatim the unpublished local commit.

## Architecture proposals — NOT YET IMPLEMENTED
1. Reuse a single AudioContext, sample clock and module-loaded-once AudioWorklet.
2. Investigate per-track `sy1-voices` AudioWorkletNode engine isolation (HQEngine) against Classic fallback.
3. Extract explicit per-track patch/preset/voice/MIDI controller state rather than copying singleton DOM/localStorage code.
4. Introduce a per-track FX bus factory preserving current gain structure, while keeping the legacy standalone path untouched.
5. Mix to the Studio destination once, without unintended duplicate compression, gain or clipping.
6. Use time-stamped MIDI events and bar/beat scheduler; expose transport/loop UI in a separate Studio shell.
7. Keep the existing take recorder's 30-minute limit. Long recording needs chunked persistent storage design and tests.

## Safety and next action
Do not modify main, native, plugin, or VST3 branch. No merge, release, or deployment without explicit approval. Phase 1 begins only after two-track architecture and automated sound-parity/isolation tests are reviewed.
