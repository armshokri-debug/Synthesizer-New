# Audio stability checkpoint 1

Base: c063b7dadbc00f78c713af91f4caac65742e0ac8 (Bushehr V1 source). V2–V10 were generated as browser distributions; they are not contained in this source branch. Do not release this branch over V10 or merge into main without recovering those source changes.

This checkpoint preserves sustained notes on a same-pass severe scheduler stall, skips stale attacks, applies missed releases, and keeps conservative loop-seam recovery. It adds bounded scheduler telemetry and reduces meter/render pressure. It does not make the main-thread scheduler independent of the UI or prove realtime DSP performance. No voice count, preset, master gain, quality or DSP changes.

Next architecture milestone: move transport timing and event dispatch to an audio-clock-owned queue with explicit per-track generations and cancellation (including drums, automation, loop boundaries and recording). Validate 4 tracks with 32/64/128 bars, foreground editing, audio discontinuity measurement, pre-clip peaks, and actual Mac/iPad realtime processing. Do not infer CPU saturation from timer lateness alone.

## Checkpoint 2
Region transactions now report changed track IDs. Their queued drum events are cancelled and their existing scheduling window is refilled without resetting unrelated tracks or the shared transport cursor. Edited tracks can still release their own held voices; this is not the final generation-based audio-thread event architecture. Loop seam and recording regression tests remain required.
