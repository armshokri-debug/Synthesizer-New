import { describe, expect, test } from "bun:test";
import { SY1StudioEngine } from "../src/studio/studio-engine";
import { buildMachinePresetPatch, engineKindForMachine, getStudioMachineDef, STUDIO_DRUM_MACHINES, SY1TrackEngine } from "../src/studio/track-engine";
import { DRUM_NOTES, DRUM_VOICES, drumVoiceForNote } from "../src/engine/drums";
import { parseStudioProjectJson } from "../src/studio/project-io";

describe("Studio recovery — heterogeneous instruments", () => {
  test("Mixed four-track identity, controller events, mix and patches survive project round trip", async () => {
    const engine = new SY1StudioEngine({ isolatedTempo: true });
    engine.addTrack(); engine.addTrack();
    const ids = ["tabriz", "yazd", "baku", "kerman"];
    engine.getTracks().forEach((track, i) => {
      const m = getStudioMachineDef(ids[i]);
      engine.setTrackMachinePreset(track.id, m.id, m.presets[0].id);
      track.setVolume(0.4 + i * 0.1); track.setPan(-0.6 + i * 0.4);
      track.replaceNoteSpans([{ midi: i === 3 ? 36 : 60 + i, startTick: 0, endTick: 240, velocity: 0.7 }]);
      track.addEvent({type:"cc",cc:1,value:45+i,tick:120});
      track.addEvent({type:"pitchBend",value:0.1*i,tick:180});
    });
    const before = engine.exportProject();
    const result = parseStudioProjectJson(engine.exportProjectJson());
    expect(result.ok).toBe(true);
    const restored = new SY1StudioEngine({isolatedTempo:true});
    await restored.loadProject(before);
    expect(restored.getTracks().map(t=>t.machineId)).toEqual(ids);
    restored.getTracks().forEach((track,i)=>{
      expect(track.patch).toEqual(engine.getTracks()[i].patch);
      expect(track.events).toEqual(engine.getTracks()[i].events);
      expect(track.volume).toBeCloseTo(0.4+i*0.1);
      expect(track.pan).toBeCloseTo(-0.6+i*0.4);
    });
    engine.dispose(); restored.dispose();
  });

  test("Every distinct engine and all drum-note mappings are reachable",()=>{
    expect(["sy1","tabriz","shiraz","kashan","nishapur","kerman"].map(id=>engineKindForMachine(getStudioMachineDef(id))))
      .toEqual(["hq","analog","strings","fm","vector","drums"]);
    expect(STUDIO_DRUM_MACHINES.map(m=>m.id)).toEqual(["kerman","bushehr","rasht","hormoz"]);
    for(const voice of DRUM_VOICES)expect(drumVoiceForNote(DRUM_NOTES[voice])).toBe(voice);
    expect(drumVoiceForNote(60)).toBeNull();
    for(const m of STUDIO_DRUM_MACHINES)for(const kit of m.kits||[]){
      const built=buildMachinePresetPatch(m.id,`kit:${kit.id}`);
      expect(built.machineId).toBe(m.id);
      for(const [key,value] of Object.entries(kit.patch))expect(built.patch[key]).toEqual(value);
    }
  });

  test("Replacing a live patch clears the previous sustain latch",()=>{
    const track=new SY1TrackEngine({id:"snapshot",name:"Snapshot"});
    track.setSustainPedal(true);
    expect(track.getSustainPedal()).toBe(true);
    const next=buildMachinePresetPatch("tabriz",getStudioMachineDef("tabriz").presets[0].id);
    track.loadPatchSnapshot(next.patch,next.presetId,next.presetName,next.machineId);
    expect(track.getSustainPedal()).toBe(false);
    track.dispose();
  });
});
