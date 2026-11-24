import { describe, expect, it } from "bun:test";
import { extractNoteSpans } from "../src/studio/midi-io";
import { flattenRegions, regionPlayback, type MidiRegion } from "../src/studio/midi-regions";
import { SY1StudioEngine, type ScheduledDispatchRecord } from "../src/studio/studio-engine";
import { STUDIO_TICKS_PER_BAR, type StudioMidiEvent } from "../src/studio/types";

function relativeEvents(region: MidiRegion): StudioMidiEvent[] {
  return [...region.events].sort((a, b) => a.tick - b.tick || a.type.localeCompare(b.type));
}

describe("Phase 7.2 — MIDI Copy Sound Consistency", () => {
  it("keeps original, duplicated, and pasted Kerman drum regions MIDI- and patch-equivalent", () => {
    const engine = new SY1StudioEngine({ isolatedTempo: true, initialBpm: 120 });
    engine.setBars(4);
    const drumTrack = engine.getTracks()[0];
    engine.setTrackMachine(drumTrack.id, "kerman");
    engine.setTrackParam(drumTrack.id, "kickTune", 4);
    engine.setTrackParam(drumTrack.id, "snareTone", 0.65);

    const patchBefore = JSON.stringify(drumTrack.patch);
    const groove: StudioMidiEvent[] = [
      { type: "cc", tick: 0, cc: 1, value: 42 },
      { type: "pitchBend", tick: 0, value: 0.1 },
      { type: "noteOn", tick: 0, midi: 36, velocity: 112 / 127 },
      { type: "noteOff", tick: 120, midi: 36 },
      { type: "noteOn", tick: 0, midi: 42, velocity: 84 / 127 },
      { type: "noteOff", tick: 120, midi: 42 },
      { type: "noteOn", tick: 480, midi: 38, velocity: 104 / 127 },
      { type: "noteOff", tick: 600, midi: 38 },
      { type: "noteOn", tick: 480, midi: 42, velocity: 78 / 127 },
      { type: "noteOff", tick: 600, midi: 42 },
      { type: "noteOn", tick: 960, midi: 36, velocity: 108 / 127 },
      { type: "noteOff", tick: 1080, midi: 36 },
      { type: "noteOn", tick: 1440, midi: 38, velocity: 110 / 127 },
      { type: "noteOff", tick: 1560, midi: 38 },
      { type: "noteOn", tick: 1680, midi: 46, velocity: 92 / 127 },
      { type: "noteOff", tick: 1860, midi: 46 }
    ];
    drumTrack.setEvents(groove);

    const [orig] = engine.regions.regions(drumTrack.id);
    expect(orig).toBeDefined();
    expect(orig.startTick).toBe(0);
    expect(orig.length).toBe(STUDIO_TICKS_PER_BAR);

    // Duplicate Bar 1 -> Bar 2
    engine.regions.select(orig.id);
    engine.regions.duplicate();

    // Copy Bar 1 and Paste -> Bar 3
    engine.regions.select(orig.id);
    engine.regions.copy();
    engine.regions.paste(drumTrack.id, STUDIO_TICKS_PER_BAR * 2);

    const allRegions = engine.regions.regions(drumTrack.id).sort((a, b) => a.startTick - b.startTick);
    expect(allRegions.length).toBe(3);
    expect(allRegions.map((r) => r.startTick)).toEqual([0, STUDIO_TICKS_PER_BAR, STUDIO_TICKS_PER_BAR * 2]);

    const [r1, r2, r3] = allRegions;
    expect(relativeEvents(r2)).toEqual(relativeEvents(r1));
    expect(relativeEvents(r3)).toEqual(relativeEvents(r1));
    expect(r2.length).toBe(r1.length);
    expect(r3.length).toBe(r1.length);
    expect(JSON.stringify(drumTrack.patch)).toBe(patchBefore);
    expect(drumTrack.machineId).toBe("kerman");

    // Same-tick controller sort priority: cc & pitchBend precede noteOn at every bar boundary
    for (const barStart of [0, STUDIO_TICKS_PER_BAR, STUDIO_TICKS_PER_BAR * 2]) {
      const atBoundary = drumTrack.events.filter((e) => e.tick === barStart);
      const types = atBoundary.map((e) => e.type);
      const firstNoteOn = types.indexOf("noteOn");
      const lastCc = types.lastIndexOf("cc");
      const lastPb = types.lastIndexOf("pitchBend");
      expect(firstNoteOn).toBeGreaterThan(-1);
      expect(lastCc).toBeLessThan(firstNoteOn);
      expect(lastPb).toBeLessThan(firstNoteOn);
    }

    engine.dispose();
  });

  it("schedules identical repeated playback timing, velocities, and counts across original and copied regions", async () => {
    let fakeNow = 10.0;
    const engine = new SY1StudioEngine({
      clockNow: () => fakeNow,
      isolatedTempo: true,
      initialBpm: 120
    });
    engine.setBars(4);
    engine.setLoopEnabled(true);
    engine.setLoopRange(1, 2);

    const drumTrack = engine.getTracks()[0];
    engine.setTrackMachine(drumTrack.id, "kerman");
    engine.replaceTrackNotes(drumTrack.id, [
      { midi: 36, startTick: 0, endTick: 120, velocity: 118 / 127 },
      { midi: 42, startTick: 0, endTick: 120, velocity: 82 / 127 },
      { midi: 38, startTick: 480, endTick: 600, velocity: 102 / 127 },
      { midi: 36, startTick: 960, endTick: 1080, velocity: 114 / 127 },
      { midi: 38, startTick: 1440, endTick: 1560, velocity: 106 / 127 }
    ]);

    const [orig] = engine.regions.regions(drumTrack.id);
    engine.regions.select(orig.id);
    engine.regions.duplicate(); // Bar 2 = ticks 1920..3840

    const dispatched: ScheduledDispatchRecord[] = [];
    engine.setDispatchObserver((rec) => dispatched.push(rec));

    await engine.play();
    // Advance 8 seconds (2 full 2-bar loop cycles at 120 BPM = 4 bars total)
    for (let i = 0; i < 400; i++) {
      fakeNow += 0.02;
      engine.stepScheduler(fakeNow);
    }
    await engine.stop();

    const noteOns = dispatched.filter((d) => d.event.type === "noteOn");
    // 5 notes per bar * 4 bars = 20 noteOns (within [10.0, 18.0) window)
    const barSlices = [0, 1, 2, 3].map((barIdx) => {
      const barStart = 10.0 + barIdx * 2.0;
      const barEnd = barStart + 2.0 - 1e-6;
      return noteOns
        .filter((d) => d.audioTime >= barStart - 1e-6 && d.audioTime < barEnd)
        .map((d) => ({
          midi: d.event.type === "noteOn" ? d.event.midi : -1,
          vel: d.event.type === "noteOn" ? Math.round(d.event.velocity * 127) : -1,
          relTimeMs: (Math.round((d.audioTime - barStart) * 1000 * 100) / 100) + 0
        }));
    });

    expect(barSlices[0].length).toBe(5);
    expect(barSlices[1]).toEqual(barSlices[0]);
    expect(barSlices[2]).toEqual(barSlices[0]);
    expect(barSlices[3]).toEqual(barSlices[0]);

    engine.dispose();
  });

  it("prevents double-triggering when copied regions overlap/stack and preserves overlapping same-pitch Note Off behavior", () => {
    const engine = new SY1StudioEngine({ isolatedTempo: true, initialBpm: 120 });
    engine.setBars(4);
    const drumTrack = engine.getTracks()[0];
    engine.setTrackMachine(drumTrack.id, "kerman");
    engine.replaceTrackNotes(drumTrack.id, [
      { midi: 36, startTick: 0, endTick: 240, velocity: 110 / 127 },
      { midi: 42, startTick: 0, endTick: 240, velocity: 80 / 127 },
      { midi: 38, startTick: 480, endTick: 720, velocity: 100 / 127 }
    ]);

    const baselineEvents = drumTrack.events.map((e) => ({ ...e }));
    const [orig] = engine.regions.regions(drumTrack.id);

    // Copy + Paste directly at tick 0 (common accidental stack after Stop resets playhead to 0)
    engine.regions.select(orig.id);
    engine.regions.copy();
    engine.regions.paste(drumTrack.id, 0);

    expect(engine.regions.regions(drumTrack.id).length).toBe(2);
    // Flattened playback must NOT double-fire any same-tick noteOn
    expect(drumTrack.events).toEqual(baselineEvents);

    // Partial same-pitch overlap across two regions:
    // Region A holds MIDI 60 from 0..400; Region B triggers MIDI 60 at 200..600.
    const rA: MidiRegion = {
      id: "rA",
      trackId: "track-1",
      startTick: 0,
      length: 480,
      sourceLength: 480,
      offset: 0,
      loop: false,
      events: [
        { type: "noteOn", tick: 0, midi: 60, velocity: 0.7 },
        { type: "noteOff", tick: 400, midi: 60 }
      ]
    };
    const rB: MidiRegion = {
      id: "rB",
      trackId: "track-1",
      startTick: 200,
      length: 480,
      sourceLength: 480,
      offset: 0,
      loop: false,
      events: [
        { type: "noteOn", tick: 0, midi: 60, velocity: 0.9 },
        { type: "noteOff", tick: 400, midi: 60 }
      ]
    };

    const flat = flattenRegions([rA, rB]);
    expect(flat).toEqual([
      { type: "noteOn", tick: 0, midi: 60, velocity: 0.7 },
      { type: "noteOff", tick: 200, midi: 60 },
      { type: "noteOn", tick: 200, midi: 60, velocity: 0.9 },
      { type: "noteOff", tick: 600, midi: 60 }
    ]);

    // extractNoteSpans must also preserve the newer overlapping note's full duration (not cut it at tick 400)
    const rawOverlap: StudioMidiEvent[] = [
      { type: "noteOn", tick: 0, midi: 60, velocity: 0.7 },
      { type: "noteOn", tick: 200, midi: 60, velocity: 0.9 },
      { type: "noteOff", tick: 400, midi: 60 },
      { type: "noteOff", tick: 600, midi: 60 }
    ];
    expect(extractNoteSpans(rawOverlap, 1920)).toEqual([
      { midi: 60, startTick: 0, endTick: 200, velocity: 0.7 },
      { midi: 60, startTick: 200, endTick: 600, velocity: 0.9 }
    ]);

    engine.dispose();
  });

  it("closes dangling notes and stuck sustain pedal at untrimmed region boundaries before copied/following regions", () => {
    const danglingRegion: MidiRegion = {
      id: "dangling",
      trackId: "track-1",
      startTick: 0,
      length: STUDIO_TICKS_PER_BAR,
      sourceLength: STUDIO_TICKS_PER_BAR,
      offset: 0,
      loop: false,
      events: [
        { type: "cc", tick: 0, cc: 64, value: 127 },
        { type: "noteOn", tick: 1440, midi: 46, velocity: 0.85 }
        // Missing noteOff for 46 and missing cc64=0!
      ]
    };

    const played = regionPlayback(danglingRegion);
    expect(played.some((e) => e.type === "noteOff" && e.tick === STUDIO_TICKS_PER_BAR && e.midi === 46)).toBe(true);
    expect(played.some((e) => e.type === "cc" && e.tick === STUDIO_TICKS_PER_BAR && e.cc === 64 && e.value === 0)).toBe(true);

    // Clean region with already-closed notes and sustain should NOT gain extra boundary events
    const cleanRegion: MidiRegion = {
      id: "clean",
      trackId: "track-1",
      startTick: 0,
      length: STUDIO_TICKS_PER_BAR,
      sourceLength: STUDIO_TICKS_PER_BAR,
      offset: 0,
      loop: false,
      events: [
        { type: "cc", tick: 0, cc: 64, value: 127 },
        { type: "noteOn", tick: 0, midi: 36, velocity: 0.9 },
        { type: "noteOff", tick: 240, midi: 36 },
        { type: "cc", tick: 480, cc: 64, value: 0 }
      ]
    };
    expect(regionPlayback(cleanRegion)).toEqual(cleanRegion.events);
  });
});
