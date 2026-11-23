import { describe, expect, it } from "bun:test";
import { parseStudioMidi } from "../src/studio/midi-io";
import { parseStudioProjectJson, serializeStudioProject } from "../src/studio/project-io";
import { SY1StudioEngine } from "../src/studio/studio-engine";
import { renderStudioInstrumentHtml } from "../src/ui/studio-instrument";
import {
  applyNumericVelocity,
  applyRelativeVelocityDelta,
  clampMidiVelocity,
  midiToVelocity,
  velocityToMidi
} from "../src/ui/studio-piano-roll";
import type { StudioMidiEvent, StudioNoteSpan } from "../src/studio/types";

describe("Phase 7.1 — MIDI Velocity (1–127, Relative Multi-Select, Playback, Save/Reload, MIDI Export)", () => {
  it("maps the full MIDI velocity range 1–127 accurately without clamping above 1", () => {
    expect(clampMidiVelocity(0)).toBe(1);
    expect(clampMidiVelocity(-25)).toBe(1);
    expect(clampMidiVelocity(1)).toBe(1);
    expect(clampMidiVelocity(64)).toBe(64);
    expect(clampMidiVelocity(127)).toBe(127);
    expect(clampMidiVelocity(200)).toBe(127);

    for (let m = 1; m <= 127; m++) {
      const norm = midiToVelocity(m);
      expect(norm).toBeGreaterThanOrEqual(1 / 127);
      expect(norm).toBeLessThanOrEqual(1);
      expect(velocityToMidi(norm)).toBe(m);
    }
  });

  it("preserves relative velocity differences for multi-selected notes even across boundary clamping", () => {
    const spans: StudioNoteSpan[] = [
      { midi: 60, startTick: 0, endTick: 480, velocity: midiToVelocity(40) },
      { midi: 64, startTick: 480, endTick: 960, velocity: midiToVelocity(80) },
      { midi: 67, startTick: 960, endTick: 1440, velocity: midiToVelocity(110) },
      { midi: 72, startTick: 1440, endTick: 1920, velocity: midiToVelocity(90) } // unselected
    ];
    const selected = new Set([0, 1, 2]);
    const origMidis = new Map<number, number>([
      [0, 40],
      [1, 80],
      [2, 110]
    ]);

    // Shift +10 within range -> exact relative diffs (40, 30) preserved
    const up10 = applyRelativeVelocityDelta(spans, selected, origMidis, 10);
    expect(up10.map((s) => velocityToMidi(s.velocity))).toEqual([50, 90, 120, 90]);

    // Drag up past 127 ceiling -> top note hits 127
    const up30 = applyRelativeVelocityDelta(spans, selected, origMidis, 30);
    expect(up30.map((s) => velocityToMidi(s.velocity))).toEqual([70, 110, 127, 90]);

    // Drag back down during same gesture (using origMidis) -> relative differences fully intact
    const down15 = applyRelativeVelocityDelta(spans, selected, origMidis, -15);
    expect(down15.map((s) => velocityToMidi(s.velocity))).toEqual([25, 65, 95, 90]);

    // Drag down past 1 floor -> bottom note hits 1
    const down50 = applyRelativeVelocityDelta(spans, selected, origMidis, -50);
    expect(down50.map((s) => velocityToMidi(s.velocity))).toEqual([1, 30, 60, 90]);

    // Pitch and timing must be completely unchanged
    for (let i = 0; i < spans.length; i++) {
      expect(down50[i].midi).toBe(spans[i].midi);
      expect(down50[i].startTick).toBe(spans[i].startTick);
      expect(down50[i].endTick).toBe(spans[i].endTick);
    }
  });

  it("applies precise numeric velocity for single notes (1–127) and relative shifts for mixed multi-select", () => {
    const spans: StudioNoteSpan[] = [
      { midi: 60, startTick: 0, endTick: 480, velocity: midiToVelocity(40) },
      { midi: 64, startTick: 480, endTick: 960, velocity: midiToVelocity(80) },
      { midi: 67, startTick: 960, endTick: 1440, velocity: midiToVelocity(100) }
    ];

    // Single note exact extremes: 1 and 127
    const minOne = applyNumericVelocity(spans, new Set([0]), 1);
    expect(velocityToMidi(minOne[0].velocity)).toBe(1);
    expect(velocityToMidi(minOne[1].velocity)).toBe(80);

    const max127 = applyNumericVelocity(spans, new Set([0]), 127);
    expect(velocityToMidi(max127[0].velocity)).toBe(127);

    // Mixed multi-select: [40, 80] avg = 60 -> target 75 (delta +15) -> [55, 95], note 2 untouched
    const shifted = applyNumericVelocity(spans, new Set([0, 1]), 75);
    expect(velocityToMidi(shifted[0].velocity)).toBe(55);
    expect(velocityToMidi(shifted[1].velocity)).toBe(95);
    expect(velocityToMidi(shifted[2].velocity)).toBe(100);
    expect(velocityToMidi(shifted[1].velocity) - velocityToMidi(shifted[0].velocity)).toBe(40);
  });

  it("persists 1–127 velocities through playback, CC preservation, undo/redo, save/reload, and SMF-1 MIDI export", async () => {
    let fakeNow = 1.0;
    const engine = new SY1StudioEngine({ clockNow: () => fakeNow });
    const track = engine.getTracks()[0];

    // Seed notes plus CC64 sustain, CC1 mod wheel, and pitchBend
    const initialEvents: StudioMidiEvent[] = [
      { type: "cc", tick: 0, cc: 64, value: 127 },
      { type: "cc", tick: 120, cc: 1, value: 88 },
      { type: "pitchBend", tick: 240, value: 0.35 },
      { type: "noteOn", tick: 0, midi: 60, velocity: midiToVelocity(80) },
      { type: "noteOff", tick: 480, midi: 60 },
      { type: "noteOn", tick: 480, midi: 64, velocity: midiToVelocity(96) },
      { type: "noteOff", tick: 960, midi: 64 },
      { type: "noteOn", tick: 960, midi: 67, velocity: midiToVelocity(112) },
      { type: "noteOff", tick: 1440, midi: 67 },
      { type: "cc", tick: 1440, cc: 64, value: 0 }
    ];
    track.setEvents(initialEvents);

    // Edit velocities to full MIDI range extremes: 1, 64, 127
    const editedSpans: StudioNoteSpan[] = [
      { midi: 60, startTick: 0, endTick: 480, velocity: midiToVelocity(1) },
      { midi: 64, startTick: 480, endTick: 960, velocity: midiToVelocity(64) },
      { midi: 67, startTick: 960, endTick: 1440, velocity: midiToVelocity(127) }
    ];
    engine.replaceTrackNotes(track.id, editedSpans);

    // Verify note pitches, timing, velocities, and all controller events are preserved
    const noteOns = track.events.filter((e) => e.type === "noteOn");
    expect(noteOns.map((e) => velocityToMidi(e.velocity))).toEqual([1, 64, 127]);
    expect(noteOns.map((e) => e.midi)).toEqual([60, 64, 67]);
    expect(noteOns.map((e) => e.tick)).toEqual([0, 480, 960]);

    const ccs = track.events.filter((e) => e.type === "cc");
    const bends = track.events.filter((e) => e.type === "pitchBend");
    expect(ccs).toEqual([
      { type: "cc", tick: 0, cc: 64, value: 127 },
      { type: "cc", tick: 120, cc: 1, value: 88 },
      { type: "cc", tick: 1440, cc: 64, value: 0 }
    ]);
    expect(bends).toEqual([{ type: "pitchBend", tick: 240, value: 0.35 }]);

    // Verify real playback scheduling dispatches exact updated 1–127 velocities to track.noteOn
    const played: { midi: number; velMidi: number }[] = [];
    const origNoteOn = track.noteOn.bind(track);
    track.noteOn = (midi: number, velocity = 0.85, at = 0) => {
      played.push({ midi, velMidi: velocityToMidi(velocity) });
      origNoteOn(midi, velocity, at);
    };
    await engine.play();
    for (let step = 0; step < 30; step++) {
      fakeNow += 0.08;
      engine.stepScheduler(fakeNow);
    }
    await engine.stop();
    expect(played).toEqual([
      { midi: 60, velMidi: 1 },
      { midi: 64, velMidi: 64 },
      { midi: 67, velMidi: 127 }
    ]);

    // Verify SMF-1 MIDI export writes exact bytes 1, 64, 127 and preserves CCs (Track 0 is Conductor, Track 1 is Studio Track 1)
    const midiBytes = engine.exportMidiBytes();
    const parsedMidi = parseStudioMidi(midiBytes);
    const exportedTrack = parsedMidi.tracks[1];
    const exportedNoteOns = exportedTrack.events.filter((e) => e.type === "noteOn");
    expect(exportedNoteOns.map((e) => velocityToMidi(e.velocity))).toEqual([1, 64, 127]);
    expect(exportedNoteOns.map((e) => e.midi)).toEqual([60, 64, 67]);
    expect(exportedTrack.events.filter((e) => e.type === "cc").length).toBe(3);
    expect(exportedTrack.events.filter((e) => e.type === "pitchBend").length).toBe(1);

    // Verify Save / Reload JSON project round-trip preserves exact 1, 64, 127
    const json = serializeStudioProject(engine.exportProject());
    const parsedProject = parseStudioProjectJson(json);
    expect(parsedProject.ok).toBe(true);
    if (parsedProject.ok) {
      const reloaded = new SY1StudioEngine();
      await reloaded.loadProject(parsedProject.project);
      const reloadedNoteOns = reloaded.getTracks()[0].events.filter((e) => e.type === "noteOn");
      expect(reloadedNoteOns.map((e) => velocityToMidi(e.velocity))).toEqual([1, 64, 127]);
      expect(reloaded.getTracks()[0].events.filter((e) => e.type === "cc").length).toBe(3);
      reloaded.dispose();
    }

    // Verify Undo / Redo restores and re-applies velocity edits cleanly
    expect(engine.regions.canUndo()).toBe(true);
    engine.regions.undo();
    expect(track.events.filter((e) => e.type === "noteOn").map((e) => velocityToMidi(e.velocity))).toEqual([80, 96, 112]);
    engine.regions.redo();
    expect(track.events.filter((e) => e.type === "noteOn").map((e) => velocityToMidi(e.velocity))).toEqual([1, 64, 127]);
  });
});

describe("Phase 7.1 — Per-Track Instrument Isolation (Tabriz, Yazd, Baku, Kerman)", () => {
  it("keeps instruments, presets, patches, and MIDI completely isolated across all four tracks", async () => {
    const engine = new SY1StudioEngine();
    while (engine.getTracks().length < 4) engine.addTrack();
    const [t1, t2, t3, t4] = engine.getTracks();

    // Assign Tabriz, Yazd, Baku, Kerman to Tracks 1–4
    engine.setTrackMachine(t1.id, "tabriz");
    engine.setTrackMachine(t2.id, "yazd");
    engine.setTrackMachine(t3.id, "baku");
    engine.setTrackMachine(t4.id, "kerman");

    // Seed distinct MIDI on each track
    engine.replaceTrackNotes(t1.id, [{ midi: 60, startTick: 0, endTick: 480, velocity: midiToVelocity(100) }]);
    engine.replaceTrackNotes(t2.id, [{ midi: 48, startTick: 240, endTick: 720, velocity: midiToVelocity(90) }]);
    engine.replaceTrackNotes(t3.id, [{ midi: 67, startTick: 480, endTick: 960, velocity: midiToVelocity(85) }]);
    engine.replaceTrackNotes(t4.id, [{ midi: 36, startTick: 0, endTick: 240, velocity: midiToVelocity(120) }]);

    // Snapshot other tracks before editing each focused track
    const snapTrack = (t: typeof t1) => ({
      machineId: t.machineId,
      presetId: t.presetId,
      patch: JSON.stringify(t.patch),
      events: JSON.stringify(t.events)
    });

    // Focus & edit Track 1 (Tabriz)
    engine.setFocusedTrack(t1.id);
    const beforeT2 = snapTrack(t2);
    const beforeT3 = snapTrack(t3);
    const beforeT4 = snapTrack(t4);
    engine.setTrackParam(t1.id, "cutoff", 1420);
    engine.setTrackParam(t1.id, "res", 0.62);
    expect(t1.patch.cutoff).toBe(1420);
    expect(t1.patch.res).toBe(0.62);
    expect(snapTrack(t2)).toEqual(beforeT2);
    expect(snapTrack(t3)).toEqual(beforeT3);
    expect(snapTrack(t4)).toEqual(beforeT4);

    // Focus & edit Track 2 (Yazd) knob
    engine.setFocusedTrack(t2.id);
    const beforeT1 = snapTrack(t1);
    const beforeT3b = snapTrack(t3);
    const beforeT4b = snapTrack(t4);
    engine.setTrackParam(t2.id, "cutoff", 680);
    engine.setTrackParam(t2.id, "envAmt", 0.77);
    expect(t2.patch.cutoff).toBe(680);
    expect(t2.patch.envAmt).toBe(0.77);
    expect(snapTrack(t1)).toEqual(beforeT1);
    expect(snapTrack(t3)).toEqual(beforeT3b);
    expect(snapTrack(t4)).toEqual(beforeT4b);

    // Focus & edit Track 3 (Baku) knob
    engine.setFocusedTrack(t3.id);
    const beforeT1c = snapTrack(t1);
    const beforeT2c = snapTrack(t2);
    const beforeT4c = snapTrack(t4);
    engine.setTrackParam(t3.id, "res", 0.81);
    expect(t3.patch.res).toBe(0.81);
    expect(snapTrack(t1)).toEqual(beforeT1c);
    expect(snapTrack(t2)).toEqual(beforeT2c);
    expect(snapTrack(t4)).toEqual(beforeT4c);

    // Focus & edit Track 4 (Kerman Drums) drum parameter
    engine.setFocusedTrack(t4.id);
    const beforeT1d = snapTrack(t1);
    const beforeT2d = snapTrack(t2);
    const beforeT3d = snapTrack(t3);
    engine.setTrackParam(t4.id, "kickTune", 7);
    expect(t4.patch.kickTune).toBe(7);
    expect(snapTrack(t1)).toEqual(beforeT1d);
    expect(snapTrack(t2)).toEqual(beforeT2d);
    expect(snapTrack(t3)).toEqual(beforeT3d);

    // Verify rendered Instrument Editor HTML always binds exact data-track-id & data-machine
    for (const [track, expectedMachine] of [
      [t1, "tabriz"],
      [t2, "yazd"],
      [t3, "baku"],
      [t4, "kerman"]
    ] as const) {
      const html = renderStudioInstrumentHtml(track, "all");
      expect(html).toContain(`data-track-id="${track.id}"`);
      expect(html).toContain(`data-machine="${expectedMachine}"`);
      expect(html).toContain(track.name);
    }

    // Verify Save / Reload preserves all 4 tracks' machines, patches, and MIDI
    const parsed = parseStudioProjectJson(serializeStudioProject(engine.exportProject()));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      const restored = new SY1StudioEngine();
      await restored.loadProject(parsed.project);
      const [r1, r2, r3, r4] = restored.getTracks();
      expect([r1.machineId, r2.machineId, r3.machineId, r4.machineId]).toEqual(["tabriz", "yazd", "baku", "kerman"]);
      expect(r1.patch.cutoff).toBe(1420);
      expect(r2.patch.cutoff).toBe(680);
      expect(r3.patch.res).toBe(0.81);
      expect(r4.patch.kickTune).toBe(7);
      expect(r1.getNoteCount()).toBe(1);
      expect(r2.getNoteCount()).toBe(1);
      expect(r3.getNoteCount()).toBe(1);
      expect(r4.getNoteCount()).toBe(1);
      restored.dispose();
    }
    engine.dispose();
  });
});
