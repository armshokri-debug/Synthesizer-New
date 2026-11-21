# SY-1 Studio — Phase 1 Acceptance Plan

Status: PLANNED / NOT RUN on real Mac and iPad.
Baseline: `c3f7c3e883b8185c543144cfa1b46c18883a6e5d`.
Track count: 2 initially, then 4 only if stable.

| ID | Test | Acceptance focus | Status |
| --- | --- | --- | --- |
| A | Sound parity | Compare matched preset, note/velocity, sample rate and FX using identical deterministic conditions; waveform/null test where possible, tolerant spectral/level comparison when noise/random/modulation is involved. No unintended gain, pitch or timbre change | NOT RUN |
| B | Isolation | Track 1 note/preset/cutoff/resonance/sustain/pitch bend/mute cannot change track 2 state or audio | NOT RUN |
| C | Sync | One audio clock; 60/110/140 BPM; simultaneous events; loops and live tempo changes with measured drift | NOT RUN |
| D | MIDI | Accurate note-on/off, velocities, sustain, channel, SMF export/reimport and tempo metadata | NOT RUN |
| E | WAV | Stereo PCM 24-bit, proper duration/sample rate, sample-aligned outputs and independent stems with no hidden mastering | NOT RUN |
| F | Timeline | 8/12/64/128 arbitrary bar lengths, loop boundary safety, overdub and persistence | NOT RUN |
| G | Load | 1/2/4 heavy patches, simultaneous performance, rapid filter/knob motion; observe xruns/dropouts/clicks and CPU/memory | NOT RUN |
| H | Browser | Chrome/macOS Intel with Web MIDI USB; iPad Safari with touch; don't assume external Web MIDI on Safari | NOT RUN |

Prerequisites:
- Pin source revision, browser, OS, actual device, sample rate, output route and preset identities in each test report.
- Distinguish TESTED vs NOT RUN vs BLOCKED. lint/build do not prove audio parity.
- Playback/recording must use sample-clock-based scheduling, never setInterval timing as the sole clock.
- Inspect browser memory ceiling before extending `MAX_SECONDS`. At 48kHz stereo 30 min Float32 capture + WAV encoding can exceed 1 GB peak allocation depending on copying.
- Preserve independent native/VST3 source untouched.

Reported Phase 0 (from AI Studio): lint PASS; Vite build PASS; Playwright layout audit and A-H device tests NOT RUN.
