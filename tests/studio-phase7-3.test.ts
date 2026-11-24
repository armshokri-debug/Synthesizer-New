import { describe, expect, test } from "bun:test";
import { DRUM_NOTES } from "../src/engine/drums";
import { getMachine, getSynthPatch, setSynthParam } from "../src/engine/synth";
import { midiToVelocity, velocityToMidi } from "../src/ui/studio-piano-roll";
import { parseStudioProjectJson, serializeStudioProject } from "../src/studio/project-io";
import { SY1StudioEngine } from "../src/studio/studio-engine";
import { getDrumLabelsForTrack, getStudioMachineDef, SY1TrackEngine } from "../src/studio/track-engine";
import { STUDIO_TICKS_PER_BAR } from "../src/studio/types";

describe("SY-1 Studio Phase 7.3 — Per-Track Instrument Editing & Isolation", () => {
  test("Two synth tracks + two drum tracks edit presets and parameters independently without touching standalone Synth", async () => {
    // Establish known standalone Synth state before Studio work
    setSynthParam("cutoff", 4200);
    setSynthParam("res", 0.25);
    const standaloneMachineBefore = getMachine().id;
    const standaloneCutoffBefore = getSynthPatch().cutoff;
    const standaloneResBefore = getSynthPatch().res;

    const engine = new SY1StudioEngine();
    engine.setActive(true);
    while (engine.getTracks().length < 4) engine.addTrack();
    const tracks = engine.getTracks();
    expect(tracks.length).toBe(4);
    const [synth1, synth2, drum1, drum2] = tracks;

    // Configure 2 synth tracks (Tabriz, Yazd) and 2 drum tracks (Kerman, Bushehr)
    engine.setTrackMachinePreset(synth1.id, "tabriz", getStudioMachineDef("tabriz").presets[1].id);
    engine.setTrackMachinePreset(synth2.id, "yazd", getStudioMachineDef("yazd").presets[2].id);
    engine.setTrackMachinePreset(drum1.id, "kerman", "kit:studio");
    engine.setTrackMachinePreset(drum2.id, "bushehr", "kit:bandari");

    // Seed distinct MIDI on each track (preserving Phase 7.1 velocity 1..127)
    engine.replaceTrackNotes(synth1.id, [
      { startTick: 0, endTick: 240, midi: 60, velocity: midiToVelocity(112) }
    ]);
    engine.replaceTrackNotes(synth2.id, [
      { startTick: 480, endTick: 960, midi: 55, velocity: midiToVelocity(64) }
    ]);
    engine.replaceTrackNotes(drum1.id, [
      { startTick: 0, endTick: 120, midi: DRUM_NOTES.kick, velocity: midiToVelocity(120) },
      { startTick: 480, endTick: 600, midi: DRUM_NOTES.snare, velocity: midiToVelocity(98) }
    ]);
    engine.replaceTrackNotes(drum2.id, [
      { startTick: 240, endTick: 360, midi: DRUM_NOTES.kick, velocity: midiToVelocity(105) },
      { startTick: 720, endTick: 840, midi: DRUM_NOTES.clap, velocity: midiToVelocity(88) }
    ]);

    // Edit Synth 1 (Tabriz)
    engine.setFocusedTrack(synth1.id);
    synth1.setParam("cutoff", 1450);
    synth1.setParam("res", 0.62);

    const s1Snapshot = {
      machineId: synth1.machineId,
      cutoff: synth1.patch.cutoff,
      res: synth1.patch.res,
      events: JSON.stringify(synth1.events)
    };

    // Edit Synth 2 (Yazd)
    engine.setFocusedTrack(synth2.id);
    synth2.setParam("cutoff", 7800);
    synth2.setParam("res", 0.14);

    // Edit Drum 1 (Kerman)
    engine.setFocusedTrack(drum1.id);
    drum1.setParam("kickTune", 0.72);
    drum1.setParam("snareTone", 0.81);

    // Edit Drum 2 (Bushehr)
    engine.setFocusedTrack(drum2.id);
    drum2.setParam("kickTune", 0.24);
    drum2.setParam("clapDecay", 0.66);

    const firstNoteVel = (t: SY1TrackEngine) => {
      const ev = t.events.find((e) => e.type === "noteOn");
      return ev && ev.type === "noteOn" ? velocityToMidi(ev.velocity) : -1;
    };

    // Verify complete cross-track isolation
    expect(synth1.machineId).toBe("tabriz");
    expect(synth1.patch.cutoff).toBe(s1Snapshot.cutoff);
    expect(synth1.patch.res).toBe(s1Snapshot.res);
    expect(JSON.stringify(synth1.events)).toBe(s1Snapshot.events);
    expect(firstNoteVel(synth1)).toBe(112);

    expect(synth2.machineId).toBe("yazd");
    expect(synth2.patch.cutoff).toBe(7800);
    expect(synth2.patch.res).toBe(0.14);
    expect(firstNoteVel(synth2)).toBe(64);

    expect(drum1.machineId).toBe("kerman");
    expect(drum1.isDrumTrack()).toBe(true);
    expect(drum1.patch.kickTune).toBe(0.72);
    expect(drum1.patch.snareTone).toBe(0.81);
    expect(drum1.getNoteCount()).toBe(2);

    expect(drum2.machineId).toBe("bushehr");
    expect(drum2.isDrumTrack()).toBe(true);
    expect(drum2.patch.kickTune).toBe(0.24);
    expect(drum2.patch.clapDecay).toBe(0.66);
    expect(drum2.getNoteCount()).toBe(2);

    // Verify per-track drum pad labels differ cleanly between Kerman and Bushehr
    const kermanLabels = getDrumLabelsForTrack(drum1.machineId, drum1.patch, drum1.presetId);
    const bushehrLabels = getDrumLabelsForTrack(drum2.machineId, drum2.patch, drum2.presetId);
    expect(kermanLabels.kick).toBe("KICK");
    expect(bushehrLabels.kick).not.toBe("KICK");

    // Verify standalone Synth global state was NEVER mutated
    expect(getMachine().id).toBe(standaloneMachineBefore);
    expect(getSynthPatch().cutoff).toBe(standaloneCutoffBefore);
    expect(getSynthPatch().res).toBe(standaloneResBefore);

    // Verify save/export JSON -> reload preserves all 4 tracks' patches, presets, and MIDI
    const savedJson = serializeStudioProject(engine.exportProject());
    const parsed = parseStudioProjectJson(savedJson);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      const reloaded = new SY1StudioEngine();
      await reloaded.loadProject(parsed.project);
      const rt = reloaded.getTracks();
      expect(rt.length).toBe(4);
      expect(rt[0].machineId).toBe("tabriz");
      expect(rt[0].patch.cutoff).toBe(1450);
      expect(rt[0].patch.res).toBe(0.62);
      expect(firstNoteVel(rt[0])).toBe(112);

      expect(rt[1].machineId).toBe("yazd");
      expect(rt[1].patch.cutoff).toBe(7800);
      expect(rt[1].patch.res).toBe(0.14);
      expect(firstNoteVel(rt[1])).toBe(64);

      expect(rt[2].machineId).toBe("kerman");
      expect(rt[2].patch.kickTune).toBe(0.72);
      expect(rt[2].patch.snareTone).toBe(0.81);
      expect(rt[2].getNoteCount()).toBe(2);

      expect(rt[3].machineId).toBe("bushehr");
      expect(rt[3].patch.kickTune).toBe(0.24);
      expect(rt[3].patch.clapDecay).toBe(0.66);
      expect(rt[3].getNoteCount()).toBe(2);
      reloaded.dispose();
    }
    engine.dispose();
  });

  test("Live MIDI input targets ONLY the selected/focused track across 2 synth + 2 drum tracks", () => {
    const engine = new SY1StudioEngine();
    engine.setActive(true);
    while (engine.getTracks().length < 4) engine.addTrack();
    const tracks = engine.getTracks();
    const [synth1, synth2, drum1, drum2] = tracks;

    engine.setTrackMachinePreset(synth1.id, "tabriz", "init");
    engine.setTrackMachinePreset(synth2.id, "kashan", "init");
    engine.setTrackMachinePreset(drum1.id, "kerman", "init");
    engine.setTrackMachinePreset(drum2.id, "bushehr", "init");

    // Spy on noteOn/noteOff across all 4 tracks
    const calls: { trackId: string; type: "on" | "off"; midi: number }[] = [];
    for (const t of tracks) {
      const origOn = t.noteOn.bind(t);
      const origOff = t.noteOff.bind(t);
      (t as SY1TrackEngine).noteOn = (midi: number, vel?: number, at?: number) => {
        calls.push({ trackId: t.id, type: "on", midi });
        return origOn(midi, vel, at);
      };
      (t as SY1TrackEngine).noteOff = (midi: number, at?: number) => {
        calls.push({ trackId: t.id, type: "off", midi });
        return origOff(midi, at);
      };
    }

    const targets: { track: SY1TrackEngine; midi: number }[] = [
      { track: synth1, midi: 60 },
      { track: synth2, midi: 67 },
      { track: drum1, midi: DRUM_NOTES.kick },
      { track: drum2, midi: DRUM_NOTES.snare }
    ];

    for (const { track, midi } of targets) {
      calls.length = 0;
      engine.setFocusedTrack(track.id);
      engine.liveNoteOn(midi, 0.85, 0);
      engine.liveNoteOff(midi, 0);

      const hitTracks = Array.from(new Set(calls.map((c) => c.trackId)));
      expect(hitTracks).toEqual([track.id]);
      expect(calls.filter((c) => c.type === "on").map((c) => c.midi)).toEqual([midi]);
      expect(calls.filter((c) => c.type === "off").map((c) => c.midi)).toEqual([midi]);
    }
    engine.dispose();
  });

  test("Switching tracks and editing preserves transport position and Phase 7.2 region copy equivalence", () => {
    const engine = new SY1StudioEngine();
    engine.setActive(true);
    engine.setBars(4);
    while (engine.getTracks().length < 4) engine.addTrack();
    const tracks = engine.getTracks();
    const drum1 = tracks[2];
    engine.setTrackMachinePreset(drum1.id, "kerman", "init");
    engine.replaceTrackNotes(drum1.id, [
      { startTick: 0, endTick: 120, midi: DRUM_NOTES.kick, velocity: midiToVelocity(118) },
      { startTick: 480, endTick: 600, midi: DRUM_NOTES.snare, velocity: midiToVelocity(95) }
    ]);

    // Seek to Bar 2 Beat 2 (2400 ticks) and verify focusing tracks never resets transport
    const targetTick = STUDIO_TICKS_PER_BAR + 480;
    engine.seekToTick(targetTick);
    expect(engine.getPlayheadPosition().currentTick).toBe(targetTick);

    for (const t of tracks) {
      engine.setFocusedTrack(t.id);
    }
    expect(engine.getPlayheadPosition().currentTick).toBe(targetTick);

    // Duplicate Kerman region (Phase 7.2 preservation check)
    const origRegion = engine.regions.regions(drum1.id)[0];
    engine.regions.select(origRegion.id);
    engine.regions.duplicate();
    const allRegions = engine.regions.regions(drum1.id).sort((a, b) => a.startTick - b.startTick);
    expect(allRegions.length).toBe(2);
    const origNotes = allRegions[0].events.filter((e) => e.type === "noteOn");
    const dupNotes = allRegions[1].events.filter((e) => e.type === "noteOn");
    expect(dupNotes.length).toBe(origNotes.length);
    for (let i = 0; i < origNotes.length; i++) {
      expect(dupNotes[i].midi).toBe(origNotes[i].midi);
      expect(dupNotes[i].velocity).toBe(origNotes[i].velocity);
      expect(dupNotes[i].tick).toBe(origNotes[i].tick);
    }
    engine.dispose();
  });
});
