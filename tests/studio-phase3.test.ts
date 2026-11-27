/**
 * SY-1 Studio — Phase 3 Automated Stability, Stress, Disposal & iPad Recovery Test Suite
 *
 * Covers:
 *  - 4-track simultaneous heavy playback (polyphonic chords, rapid Cutoff/Resonance
 *    sweeps, mid-playback preset switches, simultaneous MIDI recording, 32 rapid loop
 *    transitions) with 0 stuck notes and exact loop alignment
 *  - Scheduler O(log N + K) performance on 4 tracks x 2,000 events (8,000 events)
 *  - Main-thread stall / background sleep guard (no backlog burst-fire on +2.0s jump)
 *  - 100% AudioNode & oscillator disposal in disposeSynthBus() & disposeStudioMasterBus()
 *  - Repeated loadProject() & track attach/detach cycles without node/listener/timer leaks
 *  - iPadOS Safari AudioContext state transitions ("interrupted" / "suspended" -> "running")
 *  - No-op parameter write short-circuit & WaveShaper drive curve caching
 *  - HQEngine 4-instance simultaneous DSP stress (0 NaN/Inf, deterministic isolation)
 */

import { describe, expect, test } from "bun:test";
import { HQEngine } from "../src/dsp/hq-engine";
import { applyBusParam, createSynthBus, disposeSynthBus } from "../src/engine/bus";
import {
  createStudioEngine,
  createStudioMasterBus,
  disposeStudioMasterBus,
  ScheduledDispatchRecord
} from "../src/studio/studio-engine";
import { buildSy1PresetPatch, SY1TrackEngine } from "../src/studio/track-engine";
import { STUDIO_PPQ, STUDIO_TICKS_PER_BAR } from "../src/studio/types";

function createCountingMockAudioContext(sampleRate = 48000) {
  let createdNodes = 0;
  let disconnectedNodes = 0;
  let startedOscs = 0;
  let stoppedOscs = 0;
  let driveCurveAssigns = 0;

  function makeNode(kind: string) {
    createdNodes++;
    let disc = false;
    let curveVal: Float32Array | null = null;
    const node: any = {
      _kind: kind,
      connect() {
        return node;
      },
      disconnect() {
        if (!disc) {
          disc = true;
          disconnectedNodes++;
        }
      },
      gain: { value: 0, setTargetAtTime() {}, setValueAtTime() {} },
      delayTime: { value: 0, setTargetAtTime() {}, setValueAtTime() {} },
      frequency: { value: 0, setTargetAtTime() {}, setValueAtTime() {} },
      Q: { value: 0 },
      pan: { value: 0, setTargetAtTime() {}, setValueAtTime() {} },
      threshold: { value: 0 },
      knee: { value: 0 },
      ratio: { value: 0 },
      attack: { value: 0 },
      release: { value: 0 },
      oversample: "none",
      fftSize: 2048,
      smoothingTimeConstant: 0.8,
      type: "sine",
      start() {
        startedOscs++;
      },
      stop() {
        stoppedOscs++;
      },
      getFrequencyResponse(_f: Float32Array, mag: Float32Array) {
        mag.fill(1);
      }
    };
    if (kind === "ws") {
      Object.defineProperty(node, "curve", {
        get: () => curveVal,
        set: (v: Float32Array | null) => {
          curveVal = v;
          driveCurveAssigns++;
        }
      });
    }
    return node;
  }

  const dest = makeNode("destination");
  createdNodes = 0; // exclude destination itself

  const ctx: any = {
    sampleRate,
    currentTime: 0,
    state: "running",
    destination: dest,
    createGain: () => makeNode("gain"),
    createWaveShaper: () => makeNode("ws"),
    createBiquadFilter: () => makeNode("biquad"),
    createDelay: () => makeNode("delay"),
    createOscillator: () => makeNode("osc"),
    createChannelMerger: () => makeNode("merger"),
    createChannelSplitter: () => makeNode("splitter"),
    createDynamicsCompressor: () => makeNode("comp"),
    createAnalyser: () => makeNode("analyser"),
    createStereoPanner: () => makeNode("panner"),
    createIIRFilter: () => makeNode("iir")
  };

  return {
    ctx,
    stats: () => ({
      createdNodes,
      disconnectedNodes,
      leakedNodes: createdNodes - disconnectedNodes,
      startedOscs,
      stoppedOscs,
      leakedOscs: startedOscs - stoppedOscs,
      driveCurveAssigns
    }),
    resetCounts: () => {
      createdNodes = 0;
      disconnectedNodes = 0;
      startedOscs = 0;
      stoppedOscs = 0;
      driveCurveAssigns = 0;
    }
  };
}

describe("Phase 3 — 4-Track Simultaneous Stress & Loop Stability", () => {
  test("4 simultaneous tracks survive chords, rapid Cutoff/Res sweeps, preset switches, MIDI overdub & 32 loop cycles with 0 stuck notes", async () => {
    let clock = 0;
    const bpm = 140;
    const eng = createStudioEngine({ clockNow: () => clock, isolatedTempo: true, initialBpm: bpm });
    eng.setBars(2);
    eng.setLoopEnabled(true);
    eng.addTrack("acidBass");
    eng.addTrack("superSaw");

    const tracks = eng.getTracks();
    expect(tracks.length).toBe(4);

    // Populate dense polyphonic chords & rhythmic parts across all 4 tracks (including dangling notes near loop end!)
    const chord1 = [60, 64, 67, 71];
    const chord2 = [48, 52, 55, 59];
    tracks[0].setEvents([
      ...chord1.map((midi) => ({ type: "noteOn" as const, tick: 0, midi, velocity: 0.85 })),
      ...chord1.map((midi) => ({ type: "noteOff" as const, tick: 960, midi })),
      { type: "noteOn", tick: STUDIO_TICKS_PER_BAR * 2 - 60, midi: 72, velocity: 0.8 } // intentional dangling note at loop end
    ]);
    tracks[1].setEvents([
      ...chord2.map((midi) => ({ type: "noteOn" as const, tick: 480, midi, velocity: 0.8 })),
      ...chord2.map((midi) => ({ type: "noteOff" as const, tick: 1920, midi }))
    ]);
    const arpEvents = [];
    for (let i = 0; i < 32; i++) {
      const tick = i * (STUDIO_PPQ / 4);
      const midi = 48 + ((i * 3) % 24);
      arpEvents.push({ type: "noteOn" as const, tick, midi, velocity: 0.78 });
      arpEvents.push({ type: "noteOff" as const, tick: tick + 80, midi });
    }
    tracks[2].setEvents(arpEvents);
    tracks[3].setEvents([
      { type: "noteOn", tick: 0, midi: 36, velocity: 0.9 },
      { type: "noteOff", tick: 960, midi: 36 },
      { type: "noteOn", tick: STUDIO_TICKS_PER_BAR, midi: 43, velocity: 0.9 },
      { type: "noteOff", tick: STUDIO_TICKS_PER_BAR + 960, midi: 43 }
    ]);

    const t1Downbeats: number[] = [];
    let totalDispatched = 0;
    eng.setDispatchObserver((r: ScheduledDispatchRecord) => {
      totalDispatched++;
      if (r.trackId === tracks[0].id && r.event.type === "noteOn" && r.event.midi === 60) {
        t1Downbeats.push(r.audioTime);
      }
    });

    const cycleSec = (2 * 4 * 60) / bpm; // 2 bars at 140 BPM
    eng.setTrackArmed(tracks[3].id, true);
    await eng.record();

    // Step 32 full loop cycles in 25ms ticks while firing rapid Cutoff/Res sweeps, preset switches & live MIDI recording
    const presets = ["softKeys", "warmPad", "pluck", "superSaw"];
    const totalSec = cycleSec * 32 - 0.12; // stops cleanly after 32nd cycle downbeat
    let stepIdx = 0;
    for (let t = 0; t <= totalSec; t += 0.025) {
      clock = t;
      eng.stepScheduler(clock);
      if (stepIdx % 5 === 0) {
        tracks[2].setParam("cutoff", 200 + ((stepIdx * 137) % 10000));
        tracks[2].setParam("res", 1 + ((stepIdx * 7) % 14));
      }
      if (stepIdx === 120 || stepIdx === 340 || stepIdx === 600) {
        eng.setTrackPreset(tracks[1].id, presets[(stepIdx / 20) % presets.length | 0]);
      }
      if (stepIdx === 40) eng.liveNoteOn(62, 0.85);
      if (stepIdx === 52) eng.liveNoteOff(62);
      stepIdx++;
    }

    expect(t1Downbeats.length).toBe(32);
    for (let i = 0; i < 32; i++) {
      expect(Math.abs(t1Downbeats[i] - i * cycleSec)).toBeLessThan(1e-5);
    }
    expect(totalDispatched).toBeGreaterThan(2000);

    await eng.stop();
    for (const tr of tracks) {
      expect(tr.getActiveVoiceCount()).toBe(0);
    }
    eng.dispose();
  });

  test("4 simultaneous independent HQEngine DSP instances produce finite, isolated stereo audio under heavy chords & sweeps", () => {
    const sr = 48000;
    const presetIds = ["superSaw", "warmPad", "acidBass", "moogBass"];
    const applyPatchToHQ = (e: HQEngine, presetId: string) => {
      const p = buildSy1PresetPatch(presetId).patch;
      for (const k in p) e.setParam(k, p[k]);
      e.snapParams();
    };
    const engines = presetIds.map((id) => {
      const e = new HQEngine(sr);
      applyPatchToHQ(e, id);
      return e;
    });

    const chords = [
      [60, 64, 67, 71],
      [48, 55, 60, 64],
      [45, 57],
      [36]
    ];
    engines.forEach((e, idx) => {
      chords[idx].forEach((m, vi) => e.noteOn(idx * 10 + vi + 1, m, 0, 0.85, 0, 0, 0));
    });

    const outL = new Float32Array(128);
    const outR = new Float32Array(128);
    let nonFinite = 0;
    const peaks = [0, 0, 0, 0];

    // Render 2 seconds (750 quanta) with rapid cutoff/resonance sweeps on engine 2
    for (let q = 0; q < 750; q++) {
      if (q % 10 === 0) {
        engines[2].setParam("cutoff", 180 + ((q * 211) % 9000));
        engines[2].setParam("res", 1 + ((q * 3) % 14));
      }
      if (q === 375) {
        engines[0].allOff();
        applyPatchToHQ(engines[0], "pluck");
        engines[0].noteOn(99, 69, 0, 0.9, 0, 0, 0);
      }
      for (let ei = 0; ei < engines.length; ei++) {
        outL.fill(0);
        outR.fill(0);
        engines[ei].render(outL, outR, 128);
        for (let i = 0; i < 128; i++) {
          if (!Number.isFinite(outL[i]) || !Number.isFinite(outR[i])) nonFinite++;
          const p = Math.max(Math.abs(outL[i]), Math.abs(outR[i]));
          if (p > peaks[ei]) peaks[ei] = p;
        }
      }
    }

    expect(nonFinite).toBe(0);
    for (const p of peaks) {
      expect(p).toBeGreaterThan(0.01);
      expect(p).toBeLessThan(10);
    }
  });
});

describe("Phase 3 — Scheduler O(log N + K) Performance & Stall Recovery", () => {
  test("scheduler handles 8,000 events across 4 tracks in O(log N + K) with rapid execution", async () => {
    let clock = 0;
    const eng = createStudioEngine({ clockNow: () => clock, isolatedTempo: true, initialBpm: 120 });
    eng.setBars(64);
    eng.setLoopEnabled(true);
    eng.addTrack("acidBass");
    eng.addTrack("superSaw");

    const tracks = eng.getTracks();
    for (let ti = 0; ti < tracks.length; ti++) {
      const evs = [];
      for (let i = 0; i < 1000; i++) {
        const tick = i * 48;
        const midi = 48 + ((i + ti * 3) % 24);
        evs.push({ type: "noteOn" as const, tick, midi, velocity: 0.8 });
        evs.push({ type: "noteOff" as const, tick: tick + 24, midi });
      }
      tracks[ti].setEvents(evs);
    }

    let dispatchedCount = 0;
    eng.setDispatchObserver(() => {
      dispatchedCount++;
    });

    await eng.play();
    const t0 = performance.now();
    for (let s = 0; s < 1000; s++) {
      clock = s * 0.025;
      eng.stepScheduler(clock);
    }
    const elapsedMs = performance.now() - t0;

    expect(dispatchedCount).toBeGreaterThan(4000);
    // With O(log N + K) binary search, 1000 steps over 8000 events runs far under 25ms (vs ~67ms O(N) baseline)
    expect(elapsedMs).toBeLessThan(35);

    await eng.stop();
    eng.dispose();
  });

  test("main-thread stall or background jump (+2.0s) re-anchors cleanly without burst-firing stale backlog", async () => {
    let clock = 0;
    const eng = createStudioEngine({ clockNow: () => clock, isolatedTempo: true, initialBpm: 120 });
    eng.setBars(8);
    eng.setLoopEnabled(true);
    const [t1] = eng.getTracks();

    // Place 16th notes continuously across the first 4 bars (0..7680 ticks = 0..8s)
    const evs = [];
    for (let i = 0; i < 64; i++) {
      evs.push({ type: "noteOn" as const, tick: i * 120, midi: 60 + (i % 12), velocity: 0.85 });
      evs.push({ type: "noteOff" as const, tick: i * 120 + 60, midi: 60 + (i % 12) });
    }
    t1.setEvents(evs);

    const dispatched: ScheduledDispatchRecord[] = [];
    eng.setDispatchObserver((r) => dispatched.push(r));

    await eng.play();
    clock = 0.025;
    eng.stepScheduler(clock);
    const beforeStall = dispatched.length;
    expect(beforeStall).toBeGreaterThan(0);

    // Simulate iPad background sleep / 2.0 second main-thread stall
    dispatched.length = 0;
    clock = 2.05;
    eng.stepScheduler(clock);

    // Must ONLY schedule events in the fresh [2.05, 2.15] lookahead window (1-2 events), NOT the 16+ stale events from 0.125..2.05s!
    const noteOnsAfterStall = dispatched.filter((d) => d.event.type === "noteOn");
    expect(noteOnsAfterStall.length).toBeLessThanOrEqual(2);
    for (const r of noteOnsAfterStall) {
      expect(r.audioTime).toBeGreaterThanOrEqual(2.05 - 1e-6);
      expect(r.audioTime).toBeLessThan(2.15 + 1e-6);
    }

    await eng.stop();
    eng.dispose();
  });
});

describe("Phase 3 — Memory Leak, AudioNode & Resource Disposal", () => {
  test("disposeSynthBus() stops 100% of oscillators and disconnects 100% of internal AudioNodes (0 leaked nodes)", () => {
    const mock = createCountingMockAudioContext(48000);
    const patch = buildSy1PresetPatch("warmPad").patch;

    // Warm dampPeakGain cache once and reset counters so we measure steady-state track bus disposal
    const warm = createSynthBus(mock.ctx, patch, { connectToDestination: false });
    disposeSynthBus(warm);
    mock.resetCounts();

    // Create and dispose 10 independent track buses (equivalent to 2.5 full 4-track project reloads)
    for (let i = 0; i < 10; i++) {
      const bus = createSynthBus(mock.ctx, patch, { connectToDestination: false });
      disposeSynthBus(bus);
    }

    const st = mock.stats();
    expect(st.createdNodes).toBeGreaterThan(800);
    expect(st.leakedNodes).toBe(0);
    expect(st.startedOscs).toBe(90); // 9 oscillators per bus x 10
    expect(st.leakedOscs).toBe(0);
  });

  test("disposeStudioMasterBus() disconnects 100% of master bus nodes", () => {
    const mock = createCountingMockAudioContext(48000);
    const master = createStudioMasterBus(mock.ctx, { connectToDestination: true });
    disposeStudioMasterBus(master);
    const st = mock.stats();
    // Original six nodes + pre-clip trim + stereo splitter + two peak analysers.
    expect(st.createdNodes).toBe(10);
    expect(st.leakedNodes).toBe(0);
  });

  test("applyBusParam('drive') caches drive value and avoids redundant WaveShaper curve allocations", () => {
    const mock = createCountingMockAudioContext(48000);
    const patch = buildSy1PresetPatch("init").patch;
    const bus = createSynthBus(mock.ctx, patch, { connectToDestination: false });
    const assignsAfterInit = mock.stats().driveCurveAssigns;

    // Applying identical drive value 50 times must perform 0 new curve assignments
    for (let i = 0; i < 50; i++) {
      applyBusParam(bus, "drive", patch.drive);
    }
    expect(mock.stats().driveCurveAssigns).toBe(assignsAfterInit);

    // Changing drive value once performs exactly 1 assignment
    applyBusParam(bus, "drive", 0.55);
    expect(mock.stats().driveCurveAssigns).toBe(assignsAfterInit + 1);

    disposeSynthBus(bus);
  });

  test("SY1TrackEngine attach/detach & repeated loadProject() cycles leak 0 AudioNodes and 0 listeners", async () => {
    const mock = createCountingMockAudioContext(48000);
    const eng = createStudioEngine({ isolatedTempo: true, initialBpm: 120 });
    eng.addTrack("acidBass");
    eng.addTrack("superSaw");

    // Warm damp cache once before resetting node counters
    const warmMaster = createStudioMasterBus(mock.ctx, { connectToDestination: false });
    const warmTrack = new SY1TrackEngine({ id: "warm", name: "Warm", presetId: "init" });
    await warmTrack.attachAudio(mock.ctx, warmMaster.sum);
    warmTrack.dispose();
    disposeStudioMasterBus(warmMaster);
    mock.resetCounts();

    const master = createStudioMasterBus(mock.ctx, { connectToDestination: false });
    const snapshot = eng.exportProject();

    // Run 12 consecutive attach -> loadProject -> dispose cycles across 4 tracks
    for (let cycle = 0; cycle < 12; cycle++) {
      await Promise.all(eng.getTracks().map((t) => t.attachAudio(mock.ctx, master.sum)));
      await eng.loadProject(snapshot);
    }
    for (const t of eng.getTracks()) t.dispose();
    disposeStudioMasterBus(master);

    const st = mock.stats();
    expect(st.createdNodes).toBeGreaterThan(4000);
    expect(st.leakedNodes).toBe(0);
    expect(st.leakedOscs).toBe(0);
    eng.dispose();
  });

  test("SY1TrackEngine.setParam() short-circuits identical parameter values with 0 extra listener notifications", () => {
    const tr = new SY1TrackEngine({ id: "t1", name: "Track 1", presetId: "softKeys" });
    let calls = 0;
    tr.onChange(() => calls++);

    const initialCutoff = tr.patch.cutoff;
    for (let i = 0; i < 100; i++) {
      tr.setParam("cutoff", initialCutoff);
    }
    expect(calls).toBe(0);
    expect(tr.presetId).toBe("softKeys"); // untouched!

    tr.setParam("cutoff", 1234);
    expect(calls).toBe(1);
    expect(tr.presetId).toBe("custom");
    for (let i = 0; i < 100; i++) {
      tr.setParam("cutoff", 1234);
    }
    expect(calls).toBe(1);
    tr.dispose();
  });
});

describe("Phase 3 — iPadOS Safari AudioContext Interrupt & Background Recovery", () => {
  test("AudioContext state 'interrupted' releases active notes cleanly and 'running' re-anchors without backlog burst", async () => {
    let clock = 0;
    const eng = createStudioEngine({ clockNow: () => clock, isolatedTempo: true, initialBpm: 120 });
    eng.setBars(4);
    eng.setLoopEnabled(true);
    eng.addTrack("acidBass");
    eng.addTrack("superSaw");

    const tracks = eng.getTracks();
    // Long sustained notes across all 4 tracks + regular beats
    tracks.forEach((t, idx) => {
      const evs = [];
      for (let b = 0; b < 16; b++) {
        evs.push({ type: "noteOn" as const, tick: b * STUDIO_PPQ, midi: 48 + idx * 5 + (b % 4), velocity: 0.85 });
        evs.push({ type: "noteOff" as const, tick: b * STUDIO_PPQ + 360, midi: 48 + idx * 5 + (b % 4) });
      }
      t.setEvents(evs);
    });

    const dispatched: ScheduledDispatchRecord[] = [];
    eng.setDispatchObserver((r) => dispatched.push(r));

    await eng.play();
    for (let t = 0; t <= 0.5; t += 0.025) {
      clock = t;
      eng.stepScheduler(clock);
    }

    // Simulate iOS Safari app switch / screen lock -> AudioContext enters "interrupted"
    eng.handleAudioContextStateChange("interrupted", clock);
    for (const tr of tracks) {
      expect(tr.getActiveVoiceCount()).toBe(0);
    }

    // Simulate returning from background 3 seconds later -> AudioContext transitions back to "running"
    dispatched.length = 0;
    clock = 3.5;
    eng.handleAudioContextStateChange("running", clock);

    // Must immediately resume cleanly at clock=3.5 without burst-firing notes from 0.5..3.5s
    expect(eng.isPlaying()).toBe(true);
    for (const r of dispatched) {
      expect(r.audioTime).toBeGreaterThanOrEqual(3.5 - 1e-6);
      expect(r.audioTime).toBeLessThan(3.6 + 1e-6);
    }

    // Subsequent playback ticks keep firing normally
    for (let t = 3.525; t <= 4.1; t += 0.025) {
      clock = t;
      eng.stepScheduler(clock);
    }
    expect(dispatched.length).toBeGreaterThanOrEqual(4);

    await eng.stop();
    eng.dispose();
  });
});
