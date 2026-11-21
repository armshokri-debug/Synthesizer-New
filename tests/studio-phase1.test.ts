/**
 * SY-1 Studio — Phase 1 Automated Verification Suite (Bun)
 *
 * Covers:
 * - A1: Pure DSP Sound Parity (HQEngine standalone patch vs SY1TrackEngine patch)
 * - B1-B6: Per-track isolation (presets, cutoff/res, FX, voices, sustain/bend/mod, mute/solo, zero standalone leak)
 * - C1-C3: Audio-clock transport at 60 / 110 / 140 BPM, mid-playback tempo change, 16-cycle loop stability
 * - D1-D5: Simultaneous multi-track MIDI recording + SMF Format 1 export/parse round-trip
 * - E1-E3: 24-bit Stereo PCM WAV format, unity gain (no normalization), quantization floor, 30-min cap
 * - F1-F3: Bar timeline lengths (8, 12, 64, 128, custom 4/17/256) and non-destructive resize
 * - G-DSP: 2-track & 4-track HQEngine DSP render CPU & heap benchmark (Linux Bun runtime)
 */

import { describe, expect, test } from "bun:test";
import { HQEngine } from "../src/dsp/hq-engine";
import { encodeWav, RECORDER_MAX_SECONDS } from "../src/engine/daw";
import { synthDefaults } from "../src/engine/params";
import { SY1 } from "../src/machines/sy1";
import { encodeStudioMidi, parseStudioMidi } from "../src/studio/midi-io";
import {
  createStudioEngine,
  makeStudioMasterClipCurve,
  ScheduledDispatchRecord
} from "../src/studio/studio-engine";
import { buildSy1PresetPatch, SY1TrackEngine } from "../src/studio/track-engine";
import { STUDIO_BAR_PRESETS, STUDIO_PPQ, STUDIO_TICKS_PER_BAR } from "../src/studio/types";

function renderHQPatch(patch: Record<string, any>, sampleRate = 48000, blocks = 128): { L: Float32Array; R: Float32Array } {
  const eng = new HQEngine(sampleRate);
  for (const k in patch) eng.setParam(k, patch[k]);
  eng.snapParams();

  const blockSize = 128;
  const total = blocks * blockSize;
  const outL = new Float32Array(total);
  const outR = new Float32Array(total);
  const blkL = new Float32Array(blockSize);
  const blkR = new Float32Array(blockSize);

  eng.noteOn(1, 60, 0, 0.85, 0, 0, 0);
  const offBlock = Math.floor(blocks * 0.65);

  for (let b = 0; b < blocks; b++) {
    if (b === offBlock) eng.noteOff(1, 0, false);
    blkL.fill(0);
    blkR.fill(0);
    eng.render(blkL, blkR, blockSize);
    outL.set(blkL, b * blockSize);
    outR.set(blkR, b * blockSize);
  }
  return { L: outL, R: outR };
}

describe("A1: Pure DSP Sound Parity (Standalone SY-1 vs Studio Track)", () => {
  const presetsToVerify = ["init", "warmPad", "acidBass", "moogBass", "superSaw", "pluck"];

  for (const presetId of presetsToVerify) {
    test(`bit-exact HQEngine DSP parity for preset "${presetId}"`, () => {
      const preset = SY1.presets.find((p) => p.id === presetId)!;
      expect(preset).toBeDefined();

      // Exact standalone SY-1 patch assembly (matches src/engine/synth.ts line 343)
      const standalonePatch = Object.assign(synthDefaults(), SY1.base, preset.patch);
      standalonePatch.hold = "off";

      // Studio track patch assembly
      const track = new SY1TrackEngine({ id: "t1", name: "Track 1", presetId });

      const ref = renderHQPatch(standalonePatch, 48000, 120);
      const stu = renderHQPatch(track.patch, 48000, 120);

      let maxAbsDiff = 0;
      let peak = 0;
      for (let i = 0; i < ref.L.length; i++) {
        const p = Math.max(Math.abs(ref.L[i]), Math.abs(ref.R[i]));
        if (p > peak) peak = p;
        const dL = Math.abs(ref.L[i] - stu.L[i]);
        const dR = Math.abs(ref.R[i] - stu.R[i]);
        if (dL > maxAbsDiff) maxAbsDiff = dL;
        if (dR > maxAbsDiff) maxAbsDiff = dR;
      }

      expect(peak).toBeGreaterThan(0.01);
      expect(maxAbsDiff).toBe(0);
    });
  }

  test("StudioMasterBus soft-clipper is exact identity up to 0.98 and bounded <= 1.0", () => {
    const curve = makeStudioMasterClipCurve();
    expect(curve.length).toBe(8193);
    // Exact center zero
    expect(curve[4096]).toBe(0);
    // Exact identity for |x| <= 0.98
    let maxIdentityErr = 0;
    for (let i = 0; i < curve.length; i++) {
      const x = ((i / (curve.length - 1)) * 2 - 1) * 4;
      expect(Math.abs(curve[i])).toBeLessThanOrEqual(1.0);
      if (Math.abs(x) <= 0.98) {
        maxIdentityErr = Math.max(maxIdentityErr, Math.abs(curve[i] - x));
      }
    }
    expect(maxIdentityErr).toBeLessThan(1e-6);
  });
});

describe("B1-B6: Per-Track State & Parameter Isolation", () => {
  test("changing preset, cutoff, resonance, filter type, and FX on Track 1 never affects Track 2", () => {
    const eng = createStudioEngine({ isolatedTempo: true, initialBpm: 110 });
    const [t1, t2] = eng.getTracks();

    t1.applyPreset("softKeys");
    t2.applyPreset("moogBass");
    const t2Before = { ...t2.patch };
    const t2PresetBefore = t2.presetId;

    // Mutate Track 1 aggressively
    t1.applyPreset("acidBass");
    t1.setParam("cutoff", 120);
    t1.setParam("res", 16);
    t1.setParam("filterType", "highpass");
    t1.setParam("revMix", 0.95);
    t1.setParam("delayMix", 0.85);
    t1.setParam("chorusMix", 0.75);
    t1.setParam("drive", 0.9);
    t1.setVolume(0.35);
    t1.setPan(-0.8);

    expect(t1.patch.cutoff).toBe(120);
    expect(t1.patch.res).toBe(16);
    expect(t1.patch.filterType).toBe("highpass");
    expect(t1.patch.revMix).toBe(0.95);

    // Track 2 must remain 100% untouched
    expect(t2.presetId).toBe(t2PresetBefore);
    expect(t2.patch).toEqual(t2Before);
    expect(t2.volume).toBe(1);
    expect(t2.pan).toBe(0);
    eng.dispose();
  });

  test("sustain pedal, pitch bend, mod wheel, and poly/mono modes are isolated per track", () => {
    const eng = createStudioEngine({ isolatedTempo: true, initialBpm: 110 });
    const [t1, t2] = eng.getTracks();

    t1.setParam("polyMode", "poly");
    t2.setParam("polyMode", "mono");

    t1.setSustainPedal(true);
    t1.setPitchBend(0.75);
    t1.setModWheel(0.6);

    expect(t1.getSustainPedal()).toBe(true);
    expect(t1.getPitchBend()).toBe(0.75);
    expect(t1.getModWheel()).toBe(0.6);

    expect(t2.getSustainPedal()).toBe(false);
    expect(t2.getPitchBend()).toBe(0);
    expect(t2.getModWheel()).toBe(0);
    expect(t2.patch.polyMode).toBe("mono");
    eng.dispose();
  });

  test("Mute and Solo audibility matrix works cleanly across 2 and 4 tracks", () => {
    const eng = createStudioEngine({ isolatedTempo: true, initialBpm: 110 });
    const [t1, t2] = eng.getTracks();
    expect(t1.audible).toBe(true);
    expect(t2.audible).toBe(true);

    eng.setTrackMute(t1.id, true);
    expect(t1.audible).toBe(false);
    expect(t2.audible).toBe(true);

    // Soloing Track 1 overrides mute/unmute on all others
    eng.setTrackSolo(t1.id, true);
    expect(t1.audible).toBe(true);
    expect(t2.audible).toBe(false);

    // Expand to 4 tracks and verify solo/mute isolation
    const t3 = eng.addTrack("warmPad")!;
    const t4 = eng.addTrack("lead")!;
    expect(eng.getTracks().length).toBe(4);
    expect(eng.addTrack("pluck")).toBeNull(); // respects STUDIO_MAX_TRACKS = 4
    expect(t3.audible).toBe(false);
    expect(t4.audible).toBe(false);

    eng.setTrackSolo(t1.id, false);
    expect(t1.audible).toBe(false); // still muted
    expect(t2.audible).toBe(true);
    expect(t3.audible).toBe(true);
    expect(t4.audible).toBe(true);
    eng.dispose();
  });

  test("Studio operations never touch standalone SY-1 localStorage keys", () => {
    const store = new Map<string, string>();
    const prevLS = (globalThis as any).localStorage;
    (globalThis as any).localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => store.set(k, v),
      removeItem: (k: string) => store.delete(k)
    };
    try {
      store.set("sy1.m.sy1.patch", '{"cutoff":1234}');
      store.set("sy1.m.sy1.preset", "warmPad");

      const eng = createStudioEngine({ isolatedTempo: true, initialBpm: 110 });
      const [t1, t2] = eng.getTracks();
      t1.applyPreset("acidBass");
      t1.setParam("cutoff", 333);
      t2.applyPreset("superSaw");
      eng.dispose();

      expect(store.get("sy1.m.sy1.patch")).toBe('{"cutoff":1234}');
      expect(store.get("sy1.m.sy1.preset")).toBe("warmPad");
    } finally {
      (globalThis as any).localStorage = prevLS;
    }
  });
});

describe("C1-C3: Tempo Sync (60, 110, 140 BPM) & 16-Cycle Loop Timing", () => {
  for (const bpm of [60, 110, 140]) {
    test(`exact beat scheduling & zero drift at ${bpm} BPM`, async () => {
      let clock = 10.0;
      const eng = createStudioEngine({ clockNow: () => clock, isolatedTempo: true, initialBpm: bpm });
      eng.setBars(4);
      eng.setLoopEnabled(false);

      const [t1, t2] = eng.getTracks();
      // Beat 1 of bars 1..4 on Track 1, offbeat quarters on Track 2
      t1.setEvents([
        { type: "noteOn", tick: 0, midi: 60, velocity: 0.9 },
        { type: "noteOff", tick: 240, midi: 60 },
        { type: "noteOn", tick: STUDIO_TICKS_PER_BAR, midi: 62, velocity: 0.9 },
        { type: "noteOff", tick: STUDIO_TICKS_PER_BAR + 240, midi: 62 },
        { type: "noteOn", tick: 2 * STUDIO_TICKS_PER_BAR, midi: 64, velocity: 0.9 },
        { type: "noteOff", tick: 2 * STUDIO_TICKS_PER_BAR + 240, midi: 64 }
      ]);
      t2.setEvents([
        { type: "noteOn", tick: STUDIO_PPQ, midi: 48, velocity: 0.8 },
        { type: "noteOff", tick: STUDIO_PPQ + 240, midi: 48 }
      ]);

      const dispatched: ScheduledDispatchRecord[] = [];
      eng.setDispatchObserver((r) => dispatched.push(r));

      await eng.play();
      const barSec = (4 * 60) / bpm;
      const beatSec = 60 / bpm;

      // Step in 25ms chunks across 4 full bars
      const totalSec = barSec * 4 + 0.2;
      for (let t = 0; t <= totalSec; t += 0.025) {
        clock = 10.0 + t;
        eng.stepScheduler(clock);
      }

      const t1Ons = dispatched.filter((d) => d.trackId === t1.id && d.event.type === "noteOn");
      const t2Ons = dispatched.filter((d) => d.trackId === t2.id && d.event.type === "noteOn");

      expect(t1Ons.length).toBe(3);
      expect(Math.abs(t1Ons[0].audioTime - 10.0)).toBeLessThan(1e-6);
      expect(Math.abs(t1Ons[1].audioTime - (10.0 + barSec))).toBeLessThan(1e-6);
      expect(Math.abs(t1Ons[2].audioTime - (10.0 + 2 * barSec))).toBeLessThan(1e-6);

      expect(t2Ons.length).toBe(1);
      expect(Math.abs(t2Ons[0].audioTime - (10.0 + beatSec))).toBeLessThan(1e-6);
      eng.dispose();
    });
  }

  test("mid-playback tempo change (110 -> 140 -> 60 BPM) preserves phase continuity and syncs track LFOs", async () => {
    let clock = 0;
    const eng = createStudioEngine({ clockNow: () => clock, isolatedTempo: true, initialBpm: 110 });
    eng.setBars(8);
    const [t1, t2] = eng.getTracks();
    t1.setParam("lfoSync", 3); // 1/4 note sync
    t2.setParam("lfoSync", 4); // 1/8 note sync

    await eng.play();
    clock = 1.0; // 1 second at 110 BPM
    const tickAt1s = eng.getCurrentTick(clock);
    const expected1 = (110 / 60) * STUDIO_PPQ;
    expect(Math.abs(tickAt1s - expected1)).toBeLessThan(1e-6);

    // Switch tempo to 140 BPM at t=1.0s
    eng.setBpm(140);
    expect(Math.abs(eng.getCurrentTick(clock) - tickAt1s)).toBeLessThan(1e-6); // zero jump
    expect(Math.abs(t1.patch.lfoRate - 140 / 60)).toBeLessThan(1e-3);
    expect(Math.abs(t2.patch.lfoRate - (140 / 60) * 2)).toBeLessThan(1e-3);

    clock = 2.0; // +1 second at 140 BPM
    const tickAt2s = eng.getCurrentTick(clock);
    expect(Math.abs(tickAt2s - (expected1 + (140 / 60) * STUDIO_PPQ))).toBeLessThan(1e-6);

    // Switch tempo to 60 BPM at t=2.0s
    eng.setBpm(60);
    clock = 3.0; // +1 second at 60 BPM
    const tickAt3s = eng.getCurrentTick(clock);
    expect(Math.abs(tickAt3s - (expected1 + (140 / 60) * STUDIO_PPQ + STUDIO_PPQ))).toBeLessThan(1e-6);
    eng.dispose();
  });

  test("16 continuous loop cycles fire beat 1 every cycle with zero drift and zero stuck notes", async () => {
    let clock = 0;
    const bpm = 120; // 1 bar = 2.0s exactly
    const eng = createStudioEngine({ clockNow: () => clock, isolatedTempo: true, initialBpm: bpm });
    eng.setBars(1);
    eng.setLoopEnabled(true);

    const [t1] = eng.getTracks();
    // Put a note at beat 1 (tick 0) AND an intentionally dangling note near the loop end (tick 1800, no noteOff!)
    t1.setEvents([
      { type: "noteOn", tick: 0, midi: 60, velocity: 0.9 },
      { type: "noteOff", tick: 240, midi: 60 },
      { type: "noteOn", tick: 1800, midi: 67, velocity: 0.8 }
    ]);

    const beat1Times: number[] = [];
    eng.setDispatchObserver((r) => {
      if (r.event.type === "noteOn" && r.event.midi === 60) {
        beat1Times.push(r.audioTime);
      }
    });

    await eng.play();
    const cycleSec = 2.0;
    // Step across 16 full cycles (31.85s so cycle 16 beat 1 at t=30.0s is dispatched, not cycle 17 at 32.0s)
    for (let t = 0; t <= 31.8; t += 0.025) {
      clock = t;
      eng.stepScheduler(clock);
    }

    expect(beat1Times.length).toBe(16);
    for (let i = 0; i < 16; i++) {
      expect(Math.abs(beat1Times[i] - i * cycleSec)).toBeLessThan(1e-6);
    }

    // Stop cleanly and confirm zero stuck notes
    await eng.stop();
    expect(t1.getActiveVoiceCount()).toBe(0);
    expect(t1.isNoteSounding(60)).toBe(false);
    expect(t1.isNoteSounding(67)).toBe(false);
    eng.dispose();
  });
});

describe("D1-D5: Multi-Track MIDI Recording & SMF Format 1 Round-Trip", () => {
  test("records 2 independent tracks simultaneously (Ch 1 & Ch 2) with velocity, CC64, CC1, Pitch Bend and round-trips through SMF Format 1", async () => {
    let clock = 0;
    const bpm = 120; // 1 beat = 0.5s = 480 ticks
    const eng = createStudioEngine({ clockNow: () => clock, isolatedTempo: true, initialBpm: bpm });
    eng.setBars(4);
    const [t1, t2] = eng.getTracks();

    eng.setTrackArmed(t1.id, true);
    eng.setTrackArmed(t2.id, true);
    eng.setTrackMidiChannel(t1.id, 1);
    eng.setTrackMidiChannel(t2.id, 2);

    await eng.record();

    // t = 0.0s (tick 0): Ch 1 plays C4 vel 0.8, Ch 2 plays C2 vel 0.95
    clock = 0.0;
    eng.liveNoteOn(60, 0.8, 1);
    eng.liveNoteOn(36, 0.95, 2);

    // t = 0.25s (tick 240): Ch 1 sustain down + pitch bend +0.5
    clock = 0.25;
    eng.liveCC(64, 127, 1);
    eng.livePitchBend(0.5, 1);

    // t = 0.5s (tick 480): Ch 1 releases C4 (still sustained), Ch 2 mod wheel 90 + plays G2
    clock = 0.5;
    eng.liveNoteOff(60, 1);
    eng.liveNoteOff(36, 2);
    eng.liveCC(1, 90, 2);
    eng.liveNoteOn(43, 0.7, 2);

    // t = 1.0s (tick 960): Ch 1 sustain up, stop while Ch 2 G2 is still held (must auto-close!)
    clock = 1.0;
    eng.liveCC(64, 0, 1);
    await eng.stop();

    // Verify independent capture on Track 1 vs Track 2
    expect(t1.getNoteCount()).toBe(1);
    expect(t2.getNoteCount()).toBe(2);
    // Track 2's open G2 note must have been closed cleanly on stop()
    expect(t2.events.some((e) => e.type === "noteOff" && e.midi === 43 && e.tick === 960)).toBe(true);

    // Export SMF Format 1 and parse back
    const smfBytes = eng.exportMidiBytes("SY-1 Phase 1 Test");
    const parsed = parseStudioMidi(smfBytes);

    expect(parsed.format).toBe(1);
    expect(parsed.ppq).toBe(STUDIO_PPQ);
    expect(parsed.trackCount).toBe(3); // Conductor + Track 1 + Track 2
    expect(Math.abs(parsed.bpm - 120)).toBeLessThan(0.01);

    const pTrack1 = parsed.tracks[1];
    const pTrack2 = parsed.tracks[2];
    expect(pTrack1.channel).toBe(1);
    expect(pTrack2.channel).toBe(2);

    // Verify Track 1 note, velocity, CC64, Pitch Bend round-trip
    const t1NoteOn = pTrack1.events.find((e) => e.type === "noteOn" && e.midi === 60);
    expect(t1NoteOn).toBeDefined();
    expect(t1NoteOn!.tick).toBe(0);
    expect(Math.abs((t1NoteOn as any).velocity - Math.round(0.8 * 127) / 127)).toBeLessThan(0.001);
    expect(pTrack1.events.some((e) => e.type === "cc" && e.cc === 64 && e.value === 127 && e.tick === 240)).toBe(true);
    expect(pTrack1.events.some((e) => e.type === "pitchBend" && Math.abs(e.value - 0.5) < 0.001 && e.tick === 240)).toBe(true);

    // Verify Track 2 notes and CC1 mod wheel round-trip (zero bleed from Track 1)
    expect(pTrack2.events.filter((e) => e.type === "noteOn").length).toBe(2);
    expect(pTrack2.events.some((e) => e.type === "cc" && e.cc === 1 && e.value === 90 && e.tick === 480)).toBe(true);
    expect(pTrack2.events.some((e) => e.type === "noteOff" && e.midi === 43 && e.tick === 960)).toBe(true);
    expect(pTrack2.events.some((e) => e.type === "cc" && e.cc === 64)).toBe(false);
    eng.dispose();
  });

  test("SMF Format 1 automatically closes dangling open notes even if raw clip lacks noteOff", () => {
    const smf = encodeStudioMidi(
      [{ name: "Dangling", midiChannel: 1, events: [{ type: "noteOn", tick: 120, midi: 64, velocity: 0.75 }] }],
      110,
      1920
    );
    const parsed = parseStudioMidi(smf);
    expect(parsed.tracks[1].events.some((e) => e.type === "noteOff" && e.midi === 64 && e.tick === 1920)).toBe(true);
  });
});

describe("E1-E3: Uncompressed 24-bit Stereo PCM WAV Integrity & Safety Cap", () => {
  test("encodeWav writes valid 24-bit stereo PCM header, preserves unity gain (no normalization), and meets <-138 dBFS quantization floor", async () => {
    const sampleRate = 48000;
    const frames = 4800; // 100 ms
    const L = new Float32Array(frames);
    const R = new Float32Array(frames);
    // Put quiet -24 dBFS sine on L (~0.0631) and -1 dBFS sine on R (~0.891) to verify NO normalization
    const ampL = Math.pow(10, -24 / 20);
    const ampR = Math.pow(10, -1 / 20);
    for (let i = 0; i < frames; i++) {
      L[i] = ampL * Math.sin((2 * Math.PI * 440 * i) / sampleRate);
      R[i] = ampR * Math.cos((2 * Math.PI * 880 * i) / sampleRate);
    }

    const blob = encodeWav([[L], [R]], frames, sampleRate);
    const ab = await blob.arrayBuffer();
    const dv = new DataView(ab);
    const bytes = new Uint8Array(ab);
    const str = (o: number, n: number) => String.fromCharCode(...Array.from(bytes.subarray(o, o + n)));

    expect(str(0, 4)).toBe("RIFF");
    expect(str(8, 4)).toBe("WAVE");
    expect(str(12, 4)).toBe("fmt ");
    expect(dv.getUint32(16, true)).toBe(16);
    expect(dv.getUint16(20, true)).toBe(1); // PCM
    expect(dv.getUint16(22, true)).toBe(2); // Stereo
    expect(dv.getUint32(24, true)).toBe(sampleRate);
    expect(dv.getUint32(28, true)).toBe(sampleRate * 6); // byteRate
    expect(dv.getUint16(32, true)).toBe(6); // blockAlign
    expect(dv.getUint16(34, true)).toBe(24); // 24-bit
    expect(str(36, 4)).toBe("data");
    expect(dv.getUint32(40, true)).toBe(frames * 6);
    expect(ab.byteLength).toBe(44 + frames * 6);

    // Decode 24-bit samples and verify exact level preservation + quantization noise floor
    let maxErr = 0;
    let decPeakL = 0;
    let decPeakR = 0;
    let o = 44;
    for (let i = 0; i < frames; i++) {
      let sL = bytes[o] | (bytes[o + 1] << 8) | (bytes[o + 2] << 16);
      if (sL & 0x800000) sL -= 0x1000000;
      const fL = sL / (sL < 0 ? 8388608 : 8388607);
      o += 3;

      let sR = bytes[o] | (bytes[o + 1] << 8) | (bytes[o + 2] << 16);
      if (sR & 0x800000) sR -= 0x1000000;
      const fR = sR / (sR < 0 ? 8388608 : 8388607);
      o += 3;

      decPeakL = Math.max(decPeakL, Math.abs(fL));
      decPeakR = Math.max(decPeakR, Math.abs(fR));
      maxErr = Math.max(maxErr, Math.abs(fL - L[i]), Math.abs(fR - R[i]));
    }

    // Unity gain preserved (quiet L NOT boosted to 1.0!)
    expect(Math.abs(decPeakL - ampL)).toBeLessThan(1e-5);
    expect(Math.abs(decPeakR - ampR)).toBeLessThan(1e-5);
    // 24-bit quantization floor (< -138 dBFS)
    expect(maxErr).toBeLessThan(1.3e-7);
  });

  test("30-minute live recording safety cap remains strictly enforced", () => {
    expect(RECORDER_MAX_SECONDS).toBe(1800);
    const eng = createStudioEngine({ isolatedTempo: true });
    expect(eng.getTransportSnapshot().maxLiveSeconds).toBe(1800);
    eng.dispose();
  });
});

describe("F1-F3: Bar-Based Timeline Lengths & Non-Destructive Resize", () => {
  test("supports preset lengths (8, 12, 64, 128) and custom bar counts (4, 17, 256) non-destructively", () => {
    const eng = createStudioEngine({ isolatedTempo: true, initialBpm: 120 });
    const [t1, t2] = eng.getTracks();

    expect([...STUDIO_BAR_PRESETS]).toEqual([8, 12, 64, 128]);
    expect(eng.getTransportSnapshot().bars).toBe(8);

    // Place a note in bar 100
    eng.setBars(128);
    expect(eng.getTotalTicks()).toBe(128 * STUDIO_TICKS_PER_BAR);
    t1.setEvents([
      { type: "noteOn", tick: 99 * STUDIO_TICKS_PER_BAR, midi: 60, velocity: 0.8 },
      { type: "noteOff", tick: 99 * STUDIO_TICKS_PER_BAR + 480, midi: 60 }
    ]);
    t2.setEvents([
      { type: "noteOn", tick: 0, midi: 36, velocity: 0.9 },
      { type: "noteOff", tick: 480, midi: 36 }
    ]);

    for (const len of [8, 12, 64, 128, 4, 17, 256]) {
      eng.setBars(len);
      expect(eng.getTransportSnapshot().bars).toBe(len);
      expect(eng.getTotalTicks()).toBe(len * STUDIO_TICKS_PER_BAR);
    }

    // Events stored in bar 100 survived shortening to 4 and expanding back to 256!
    expect(t1.getNoteCount()).toBe(1);
    expect(t1.events[0].tick).toBe(99 * STUDIO_TICKS_PER_BAR);

    // Clearing Track 1 leaves Track 2 untouched
    eng.clearTrackClip(t1.id);
    expect(t1.getNoteCount()).toBe(0);
    expect(t2.getNoteCount()).toBe(1);
    eng.dispose();
  });
});

describe("G-DSP: Multi-Track HQEngine DSP CPU & Memory Benchmark (Linux Bun)", () => {
  test("2-track and 4-track heavy unison presets stay well under real-time budget", () => {
    const sampleRate = 48000;
    const blockSize = 128;
    const seconds = 5;
    const blocks = Math.floor((sampleRate * seconds) / blockSize);

    const runBench = (presetIds: string[]) => {
      const engines = presetIds.map((pid) => {
        const e = new HQEngine(sampleRate);
        const { patch } = buildSy1PresetPatch(pid);
        for (const k in patch) e.setParam(k, patch[k]);
        e.snapParams();
        // Play a 3-note chord on poly presets, 1 note on mono
        e.noteOn(1, 48, 0, 0.85, 0, 0, 0);
        if (patch.polyMode !== "mono") {
          e.noteOn(2, 55, 0, 0.85, 0, 0, 0);
          e.noteOn(3, 60, 0, 0.85, 0, 0, 0);
        }
        return e;
      });

      const L = new Float32Array(blockSize);
      const R = new Float32Array(blockSize);
      const heapBefore = process.memoryUsage().heapUsed;
      const t0 = performance.now();
      let maxBlockMs = 0;

      for (let b = 0; b < blocks; b++) {
        const bt0 = performance.now();
        for (let i = 0; i < engines.length; i++) {
          L.fill(0);
          R.fill(0);
          engines[i].render(L, R, blockSize);
        }
        const dt = performance.now() - bt0;
        if (dt > maxBlockMs) maxBlockMs = dt;
      }

      const totalMs = performance.now() - t0;
      const heapDeltaMB = (process.memoryUsage().heapUsed - heapBefore) / (1024 * 1024);
      const rtRatioPct = (totalMs / (seconds * 1000)) * 100;
      return { totalMs, avgBlockMs: totalMs / blocks, maxBlockMs, rtRatioPct, heapDeltaMB };
    };

    const twoTrack = runBench(["superSaw", "warmPad"]);
    const fourTrack = runBench(["superSaw", "warmPad", "moogBass", "tranceLead"]);

    console.log(
      `[G-DSP Benchmark @48kHz, ${seconds}s]\n` +
      `  2-track (Super Saw + Warm Pad): total=${twoTrack.totalMs.toFixed(1)}ms, avgBlock=${twoTrack.avgBlockMs.toFixed(4)}ms, maxBlock=${twoTrack.maxBlockMs.toFixed(3)}ms, RT-load=${twoTrack.rtRatioPct.toFixed(2)}%, heapDelta=${twoTrack.heapDeltaMB.toFixed(2)}MB\n` +
      `  4-track (Super Saw + Warm Pad + Ladder Bass + Trance Lead): total=${fourTrack.totalMs.toFixed(1)}ms, avgBlock=${fourTrack.avgBlockMs.toFixed(4)}ms, maxBlock=${fourTrack.maxBlockMs.toFixed(3)}ms, RT-load=${fourTrack.rtRatioPct.toFixed(2)}%, heapDelta=${fourTrack.heapDeltaMB.toFixed(2)}MB`
    );

    // Budget for 128 samples @ 48 kHz is 2.667 ms
    expect(twoTrack.rtRatioPct).toBeLessThan(50);
    expect(fourTrack.rtRatioPct).toBeLessThan(80);
  });
});
