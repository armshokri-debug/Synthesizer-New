import { describe, expect, test } from "bun:test";
import { beatsInWindow } from "../src/studio/metronome";
import { SY1StudioEngine } from "../src/studio/studio-engine";
import { prepareSynthRecordingTrack } from "../src/studio/synth-recording";
import { buildMachinePresetPatch, getStudioMachineDef } from "../src/studio/track-engine";
import { onPerformanceMidi, scheduledNote, drumHit } from "../src/engine/daw";

describe("Phase 5 — shared performance recording",()=>{
  test("Arpeggiator and drum MIDI can be captured without enabling external MIDI out",()=>{
    const events:{bytes:number[];at:number}[]=[];
    const off=onPerformanceMidi((bytes,at)=>events.push({bytes:[...bytes],at}));
    scheduledNote(60,0.8,1,1.3);drumHit('kick',0.9,2);off();
    expect(events.length).toBe(4);expect(events[0].bytes[1]).toBe(60);
    expect(events[1].at).toBe(1.3);expect(events[2].bytes[1]).toBe(36);expect(events[3].at).toBe(2.06);
    scheduledNote(61,0.8,3,3.2);expect(events.length).toBe(4);
  });
  test("Audio-clock beat planner accents bars, count-in and fractional song positions",()=>{
    const beats=beatsInWindow(0,2,2,0,120);
    expect(beats.map(b=>b.beat)).toEqual([-4,-3,-2,-1,0]);
    expect(beats.map(b=>b.at)).toEqual([0,0.5,1,1.5,2]);
    expect(beats.filter(b=>b.accent).map(b=>b.beat)).toEqual([-4,0]);
    expect(beatsInWindow(15.02,15.12,0,0,120)).toEqual([]);
    expect(beatsInWindow(0,0.5,0,0.5,120)[0].at).toBeCloseTo(0.25);
    expect(beatsInWindow(0,1,0,0,240).length).toBe(5);
  });
  test("Count-in rejects early notes; sample-clock MIDI timing, velocity and controllers survive",async()=>{
    let now=0;const e=new SY1StudioEngine({clockNow:()=>now,isolatedTempo:true,initialBpm:120});
    const t=e.getFocusedTrack();e.setRecordingSettings({countIn:true});
    await e.record({midiOnly:true});
    expect(e.getCountInBeat()).toBe(1);
    e.capturePerformanceMidi(t.id,[0x90,60,90],0.3);
    expect(t.events.length).toBe(0);
    now=1.5;expect(e.getCountInBeat()).toBe(4);
    now=2;e.capturePerformanceMidi(t.id,[0x90,60,100],now);
    e.capturePerformanceMidi(t.id,[0xb0,1,75],2.125);
    e.capturePerformanceMidi(t.id,[0xe0,0,96],2.25);
    e.capturePerformanceMidi(t.id,[0x80,60,0],2.5);
    const notes=t.getNoteSpans(e.getTotalTicks());
    expect(notes.length).toBe(1);expect(notes[0].startTick).toBe(0);expect(notes[0].endTick).toBe(480);expect(notes[0].velocity).toBeCloseTo(100/127);
    expect(t.events.some(x=>x.type==='cc'&&x.cc===1&&x.tick===120)).toBe(true);
    expect(t.events.some(x=>x.type==='pitchBend'&&x.value===0.5&&x.tick===240)).toBe(true);
    await e.stop();e.dispose();
  });
  test("Overdub adds notes, stop closes held notes, count-in cancel cannot capture late input",async()=>{
    let now=0;const e=new SY1StudioEngine({clockNow:()=>now,isolatedTempo:true,initialBpm:120});const t=e.getFocusedTrack();
    t.replaceNoteSpans([{midi:64,startTick:0,endTick:240,velocity:0.7}]);
    await e.record({midiOnly:true});now=0.25;e.capturePerformanceMidi(t.id,[0x90,67,127],now);now=0.5;await e.stop();
    expect(t.getNoteSpans(e.getTotalTicks()).length).toBe(2);
    const saved=t.events.length;
    e.setRecordingSettings({countIn:true});await e.record({midiOnly:true});await e.stop();
    now=20;e.capturePerformanceMidi(t.id,[0x90,70,100],now);
    expect(t.events.length).toBe(saved);expect(e.getCountInBeat()).toBe(0);expect(e.isPlaying()).toBe(false);e.dispose();
  });
  test("Tempo change and audio interruptions preserve the remaining count-in beats",async()=>{
    let now=0;const e=new SY1StudioEngine({clockNow:()=>now,isolatedTempo:true,initialBpm:120});
    e.setRecordingSettings({countIn:true});await e.record({midiOnly:true});
    now=0.5;e.setBpm(60);expect(e.getCountInBeat()).toBe(2);
    e.handleAudioContextStateChange('suspended',now);e.handleAudioContextStateChange('running',now);
    now=3.49;expect(e.getCountInBeat()).toBe(4);now=3.5;expect(e.getCountInBeat()).toBe(0);expect(e.getCurrentTick()).toBe(0);e.dispose();
  });
  test("Machine/patch-matched reuse; mixed instruments and full projects never overwrite a performance",()=>{
    const e=new SY1StudioEngine({isolatedTempo:true});const prepared=[];
    for(const id of ['tabriz','yazd','baku','kerman']){
      const m=getStudioMachineDef(id),built=buildMachinePresetPatch(id,m.presets[0].id);
      const t=prepareSynthRecordingTrack(e,id,built.patch,built.presetId);prepared.push(t);
      t.replaceNoteSpans([{midi:id==='kerman'?36:60,startTick:0,endTick:240,velocity:0.8}]);
      expect(prepareSynthRecordingTrack(e,id,{...built.patch},built.presetId).id).toBe(t.id);
    }
    expect(e.getTracks().map(t=>t.machineId)).toEqual(['tabriz','yazd','baku','kerman']);
    const before=e.exportProjectJson();let message='';
    const m=getStudioMachineDef('shiraz'),b=buildMachinePresetPatch(m.id,m.presets[0].id);
    try{prepareSynthRecordingTrack(e,m.id,b.patch,b.presetId);}catch(error){message=String(error);}
    expect(message).toContain('nothing was overwritten');
    expect(e.exportProject().tracks).toEqual(JSON.parse(before).tracks);e.dispose();
  });
  test("Stop cancels a pending asynchronous Play request",async()=>{
    const e=new SY1StudioEngine({isolatedTempo:true});let release:()=>void=()=>{};
    (e as any).ensureAudio=()=>new Promise<void>(r=>{release=r;});
    const pending=e.play();await e.stop();release();await pending;expect(e.isPlaying()).toBe(false);e.dispose();
  });
  test("Recording settings round-trip while old v1 projects retain safe defaults",async()=>{
    const e=new SY1StudioEngine({isolatedTempo:true});
    e.setRecordingSettings({metronome:true,countIn:true,clickVolume:0.12});
    const data=e.exportProject(),restored=new SY1StudioEngine({isolatedTempo:true});
    await restored.loadProject(data);expect(restored.getRecordingSettings()).toEqual(e.getRecordingSettings());
    delete data.recordingSettings;await restored.loadProject(data);
    expect(restored.getRecordingSettings()).toEqual({metronome:false,countIn:false,clickVolume:0.25});
    e.dispose();restored.dispose();
  });
});
