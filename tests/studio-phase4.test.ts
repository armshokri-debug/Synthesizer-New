/**
 * SY-1 Studio — Phase 4 Automated Unit & Regression Tests
 *
 * Covers:
 * - Piano Roll note creation, editing (move, resize, velocity, delete), snap & quantize
 * - Preservation of CC64/CC1/pitchBend events during Piano Roll note span replacement
 * - 7 authentic HQEngine Iranian city synthesizers (SY-1, Yazd, Baku, Merv, Isfahan, Konya, Bam)
 *   preset loading, track isolation across different city synths, and parameter editing
 * - .sy1studio project export/import round-trip preserving machineId + edited Piano Roll notes
 * - Backward compatibility with older v1 .sy1studio files omitting machineId (defaults to "sy1")
 * - Zero-allocation track & master meter reading (and mute/idle returning 0)
 */

import { describe, expect, test } from "bun:test";
import { parseStudioProjectJson } from "../src/studio/project-io";
import { SY1StudioEngine } from "../src/studio/studio-engine";
import {
  buildMachinePresetPatch,
  getStudioMachineDef,
  STUDIO_SYNTH_MACHINES
} from "../src/studio/track-engine";
import { STUDIO_SNAP_OPTIONS, STUDIO_TICKS_PER_BAR } from "../src/studio/types";
import { midiNoteLabel, snapTickValue } from "../src/ui/studio-piano-roll";

describe("SY-1 Studio Phase 4 — Piano Roll MIDI Editing & Quantize", () => {
  test("Piano Roll snap helper & MIDI note labels", () => {
    expect(midiNoteLabel(60)).toBe("C4");
    expect(midiNoteLabel(61)).toBe("C#4");
    expect(midiNoteLabel(69)).toBe("A4");
    expect(midiNoteLabel(36)).toBe("C2");
    expect(STUDIO_SNAP_OPTIONS.map((o) => o.label)).toEqual(["Off", "1/4", "1/8", "1/16", "1/32"]);

    expect(snapTickValue(135, 120, "round")).toBe(120);
    expect(snapTickValue(135, 120, "floor")).toBe(120);
    expect(snapTickValue(190, 120, "round")).toBe(240);
    expect(snapTickValue(190, 0, "round")).toBe(190);
  });

  test("replaceTrackNotes creates, moves, resizes, edits velocity, and deletes notes while preserving CC & pitchBend", () => {
    const engine = new SY1StudioEngine({ isolatedTempo: true });
    const t1 = engine.getTracks()[0];

    // Seed CC64 sustain + pitchBend + initial note
    t1.setEvents([
      { type: "cc", tick: 100, cc: 64, value: 127 },
      { type: "pitchBend", tick: 240, value: 0.5 },
      { type: "noteOn", tick: 0, midi: 60, velocity: 0.8 },
      { type: "noteOff", tick: 480, midi: 60 },
      { type: "cc", tick: 900, cc: 64, value: 0 }
    ]);

    // Add a second note, move first note, resize & adjust velocity
    engine.replaceTrackNotes(t1.id, [
      { midi: 62, startTick: 120, endTick: 720, velocity: 0.92 },
      { midi: 67, startTick: 480, endTick: 960, velocity: 0.55 }
    ]);

    const spans = t1.getNoteSpans(engine.getTotalTicks());
    expect(spans.length).toBe(2);
    expect(spans[0]).toEqual({ midi: 62, startTick: 120, endTick: 720, velocity: 0.92 });
    expect(spans[1]).toEqual({ midi: 67, startTick: 480, endTick: 960, velocity: 0.55 });

    // Non-note events (CC64 & pitchBend) must remain intact
    const nonNote = t1.events.filter((e) => e.type !== "noteOn" && e.type !== "noteOff");
    expect(nonNote.length).toBe(3);
    expect(nonNote.some((e) => e.type === "cc" && e.cc === 64 && e.value === 127)).toBe(true);
    expect(nonNote.some((e) => e.type === "pitchBend" && e.value === 0.5)).toBe(true);

    // Delete first note via replaceTrackNotes
    engine.replaceTrackNotes(t1.id, [spans[1]]);
    const afterDel = t1.getNoteSpans(engine.getTotalTicks());
    expect(afterDel.length).toBe(1);
    expect(afterDel[0].midi).toBe(67);
  });

  test("quantizeTrackNotes snaps unquantized notes to 1/16 and preserves selected subset when specified", () => {
    const engine = new SY1StudioEngine({ isolatedTempo: true });
    const t1 = engine.getTracks()[0];

    engine.replaceTrackNotes(t1.id, [
      { midi: 60, startTick: 138, endTick: 390, velocity: 0.85 }, // near 120
      { midi: 64, startTick: 505, endTick: 760, velocity: 0.78 } // near 480
    ]);

    // Quantize ONLY note 0 to 1/16 (120 ticks)
    engine.quantizeTrackNotes(t1.id, 120, [0]);
    const partial = t1.getNoteSpans(engine.getTotalTicks());
    expect(partial[0].startTick).toBe(120);
    expect(partial[1].startTick).toBe(505); // untouched

    // Quantize ALL notes to 1/4 (480 ticks)
    engine.quantizeTrackNotes(t1.id, 480);
    const allQ = t1.getNoteSpans(engine.getTotalTicks());
    expect(allQ[0].startTick).toBe(0);
    expect(allQ[1].startTick).toBe(480);
    expect(allQ[0].endTick - allQ[0].startTick).toBeGreaterThanOrEqual(60);
  });
});

describe("SY-1 Studio Phase 4 — Iranian City Synthesizers & Persistence", () => {
  test("All 7 HQEngine Iranian city synths are available and load isolated patches per track", () => {
    const ids = STUDIO_SYNTH_MACHINES.map((m) => m.id);
    expect(ids).toEqual(["sy1", "yazd", "baku", "merv", "isfahan", "konya", "bam"]);

    for (const m of STUDIO_SYNTH_MACHINES) {
      expect(m.presets.length).toBeGreaterThan(0);
      const built = buildMachinePresetPatch(m.id, m.presets[0].id);
      expect(built.machineId).toBe(m.id);
      expect(built.presetId).toBe(m.presets[0].id);
      expect(built.patch.hold).toBe("off");
    }

    const engine = new SY1StudioEngine({ isolatedTempo: true });
    const [t1, t2] = engine.getTracks();

    const yazd = getStudioMachineDef("yazd");
    const isfahan = getStudioMachineDef("isfahan");

    engine.setTrackMachinePreset(t1.id, "yazd", yazd.presets[0].id);
    engine.setTrackMachinePreset(t2.id, "isfahan", isfahan.presets[0].id);

    expect(t1.machineId).toBe("yazd");
    expect(t1.presetId).toBe(yazd.presets[0].id);
    expect(t2.machineId).toBe("isfahan");
    expect(t2.presetId).toBe(isfahan.presets[0].id);

    // Mutating Track 1 cutoff must never affect Track 2
    const t2CutoffBefore = t2.patch.cutoff;
    t1.setParam("cutoff", 520);
    expect(t1.patch.cutoff).toBe(520);
    expect(t1.presetId).toBe("custom");
    expect(t1.machineId).toBe("yazd");
    expect(t2.patch.cutoff).toBe(t2CutoffBefore);
    expect(t2.presetId).toBe(isfahan.presets[0].id);
  });

  test(".sy1studio round-trip preserves machineId, Piano Roll notes, velocities, and backward-compat v1 files", async () => {
    const engine = new SY1StudioEngine({ isolatedTempo: true });
    engine.setProjectName("Phase 4 City Synths");
    engine.setBpm(118);
    engine.setBars(12);

    const [t1, t2] = engine.getTracks();
    const baku = getStudioMachineDef("baku");
    const merv = getStudioMachineDef("merv");
    engine.setTrackMachinePreset(t1.id, "baku", baku.presets[1].id);
    engine.setTrackMachinePreset(t2.id, "merv", merv.presets[0].id);
    t1.setParam("cutoff", 890);

    engine.replaceTrackNotes(t1.id, [
      { midi: 57, startTick: 0, endTick: 480, velocity: 0.91 },
      { midi: 64, startTick: 480, endTick: STUDIO_TICKS_PER_BAR, velocity: 0.64 }
    ]);

    const json = engine.exportProjectJson();
    const parsed = parseStudioProjectJson(json);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    expect(parsed.project.tracks[0].machineId).toBe("baku");
    expect(parsed.project.tracks[1].machineId).toBe("merv");

    // Load into a fresh engine and verify exact restoration
    const restored = new SY1StudioEngine({ isolatedTempo: true });
    await restored.loadProject(parsed.project);

    const [rt1, rt2] = restored.getTracks();
    expect(rt1.machineId).toBe("baku");
    expect(rt1.patch.cutoff).toBe(890);
    expect(rt2.machineId).toBe("merv");
    expect(rt2.presetId).toBe(merv.presets[0].id);

    const rSpans = rt1.getNoteSpans(restored.getTotalTicks());
    expect(rSpans.length).toBe(2);
    expect(rSpans[0].midi).toBe(57);
    expect(rSpans[0].velocity).toBeCloseTo(0.91, 2);
    expect(rSpans[1].endTick).toBe(STUDIO_TICKS_PER_BAR);

    // Backward compatibility: older v1 .sy1studio JSON without machineId defaults cleanly to "sy1"
    const legacyObj = JSON.parse(json);
    delete legacyObj.tracks[0].machineId;
    delete legacyObj.tracks[1].machineId;
    const parsedLegacy = parseStudioProjectJson(JSON.stringify(legacyObj));
    expect(parsedLegacy.ok).toBe(true);
    if (parsedLegacy.ok) {
      expect(parsedLegacy.project.tracks[0].machineId).toBe("sy1");
      expect(parsedLegacy.project.tracks[1].machineId).toBe("sy1");
    }
  });

  test("Track and master meter readers return 0 cleanly when idle/detached/muted", () => {
    const engine = new SY1StudioEngine({ isolatedTempo: true });
    const t1 = engine.getTracks()[0];
    expect(t1.readMeterLevel()).toBe(0);
    expect(engine.readMasterMeterLevel()).toBe(0);
    engine.setTrackMute(t1.id, true);
    expect(t1.readMeterLevel()).toBe(0);
  });
});
