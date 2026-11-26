# SY-1 Studio — DAW architecture audit and acceptance contract

Status: investigation, **not approved for release**.
Baseline: `e8358d75dad1c5d5b746223fb18f4dad7f23a7b0`.
Scope: Web Studio. Native JUCE VST3/AU, DSP algorithms, instruments, presets and existing saved projects must be preserved. The reference is the observable behavior of GarageBand, not Apple's proprietary implementation or branding.

## Sources
- Apple Beat Sequencer: https://support.apple.com/en-qa/101954
- Apple Touch Instrument recording: https://support.apple.com/en-me/guide/garageband-ipad/chs392846e9/ipados
- Apple project settings: https://support.apple.com/en-gb/guide/garageband-ipad/chs2a762fad/ipados
- Apple regions: https://support.apple.com/en-mo/guide/garageband-ipad/chsec12c15d/ipados
- W3C Web Audio recommendation: https://www.w3.org/TR/webaudio-1.0/
- IRCAM timing and scheduling: https://ircam-ismm.github.io/webaudio-tutorials/scheduling/timing-and-scheduling.html

## Findings from the baseline code
| ID | Evidence (baseline paths and lines) | Impact |
| --- | --- | --- |
| A01/A02 | src/studio/studio-engine.ts:907–945, 1101–1141, 1184–1193, 1212–1233 | Record stops Preview; a pattern only plays if Live is separately enabled. Live rejects occupied tracks. Direct record fails to capture the selected pattern. |
| A03 | studio-engine.ts:802–846, 1144–1166; src/studio/track-engine.ts:773–796; src/engine/drums.ts:471–492 | Tempo update reanchors ticks but does not retract scheduled drum hits or reset their scheduling cursor. Old timing can survive for up to the lookahead horizon. |
| A04 | studio-engine.ts:571–588, 802–846, 1058–1075 | The predicted loop wrap retains its old audio time while BPM changes. The playhead can jump before the seam. |
| A05 | src/studio/live-drum-sequence.ts:15–50; src/ui/studio-panel.ts:2023–2050 | Pattern events are compiled once per cycle and edits during Record are blocked in UI. The user cannot perform live pattern changes as in the reference. |
| A06 | studio-engine.ts:948–998; src/ui/studio-panel.ts:1783–1796 | Stop resets position to zero, clears Live selection. The Pause label actually executes Stop. Recording flag and playing flag also change on opposite sides of an asynchronous WAV finalization. |
| A07 | src/engine/midi.ts:14; src/main.ts:194–202; studio-engine.ts:1407–1468 | MIDI interceptor has no event timestamp; input capture uses callback-time audio clock. Device-to-audio timing and latency compensation not verified. |
| A08 | src/studio/track-engine.ts:237–238, 773–796, 930–955, 978–990; src/engine/worklet/sy1-processor.ts:45–99 | Worklet has a timed queue but only global alloff clears it. Drum Web Audio nodes are scheduled separately; no common selective event cancellation contract. Need inspect all adapters before implementing. |
| A09 | studio-engine.ts:907–945, 1512–1575 | Master WAV capture starts before transport/count-in anchor when recording from stop. PCM capture start/stop alignment is not established. |
| A10 | studio-engine.ts:1010–1045, 1370–1404; src/studio/track-arpeggiator.ts:44–92 | Main-thread lookahead and separate arp cursor need profiling under UI load. Timer alone is not proof of a timing bug; actual output must be measured. |
| A11 | src/ui/studio-panel.ts:789–800, 1256 onward; src/ui/studio-instrument.ts | Reusing a DOM host is not the same as one canonical instrument UI/controller. Visual and interaction parity across all 15 instruments remains unverified. |

## Proposed ownership and invariants
1. One transport state machine (stopped, preparing, count-in, playing, recording, stopping; pause/resume semantics explicit). All commands including the instrument header and arrangement route through it. Distinguish a track's selected pattern from its current playback source and from recorded regions.
2. One audio-clock timeline: an absolute audio-frame/tick mapping with immutable tempo epochs, explicit loop iteration and seek boundaries. Preserve project PPQ and file format. Convert UI/external timestamps at the boundary; UI animation never drives audio.
3. One scheduling authority: per-track producers (pattern, region, arpeggiator, metronome) produce musical events; one dispatcher owns absolute render deadlines. Define cancellation/revision per event and source, including queued worklet commands and already-created drum nodes. Never use global all-notes-off as a substitute for selective future-event cancellation during live edits.
4. Record the same accepted event stream that drives audio, with a single record start/end anchor and explicit source identity, track ID, loop iteration and unique event ID. Explicit overdub/takes/replace policies; preserve old regions by default. Prevent double monitoring without silently dropping distinct loop takes. Audio capture aligned to frame boundaries; count-in excluded by default.
5. Instruments and pattern UI consume project transport state; source selection and recording are not a three-button ritual. Pattern editor must accept live changes; define safe next-step scheduling boundary and capture exactly what is heard. Keep SY-1's existing control layouts and sound engines. UI state must not mutate standalone or native-plugin sessions.
6. Prefer incremental adapters and tested migration behind isolated branch. Do not choose a new framework or rewrite DSP before proving the timing model and adapter needs. Web browser guarantees differ from native DAWs; document actual measured behavior and platform limitations.

## Acceptance sequence (release gate)
- A01–A05: run baseline diagnostic tests; failures are evidence, not skipped or converted to passing tests.
- Extend deterministic cases: count-in from nonzero position, seeks, pause/resume, tempo changes inside lookahead at 60/90/120/180 BPM, 12/16 step patterns, loop seam, repeated takes, multiple drum tracks, mute/solo, undo, load, loss of audio context. Keep all 151 existing regression cases; explicitly review old assertions that encode the rejected workflow.
- Rendered PCM test: isolated synthetic drum clicks and metronome capture; verify event onset against expected audio frame with calibrated attack/latency. Check stale/duplicate/missing hits using actual sample stream rather than dispatch observer. Offline and real-time paths; 44.1/48 kHz, tempo transitions, long run and UI stress. Log max error, jitter, cumulative drift and underruns. Initial proposed digital-test budget: no missing/duplicate hits, no stale events after defined transition boundary, same-path timing error <= one observed render quantum, no cumulative drift; validate tolerance against measured engine attack and platform behavior. Not a claim of measured performance.
- Actual Mac/iPad browser acceptance: direct Record from the instrument, count-in, edit during recording, return to arrangement, play existing take, continue recording, change tempo during play, loop and save/reopen. User or independent DAW engineer must hear and operate it; Chromium headless is insufficient. Compare side-by-side with GarageBand behavior and design, not visual branding. No release until accepted.
- Native sources unchanged; no deployment, main merge, or project data mutation from audit branch.

## Current scope
This is a first technical audit and executable baseline contract, not completed architecture or device validation. Further profiling of audio adapters and physical-device tests are required. Diagnostic tests live outside the legacy suite to make failing contract results explicit.
