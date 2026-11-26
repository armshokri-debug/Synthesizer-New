import { describe, expect, test } from "bun:test";
import { DRUM_NOTES, emptyPattern, patternFrom, stepFlam, stepProb, stepRoll } from "../src/engine/drums";
import { SY1TrackEngine } from "../src/studio/track-engine";
import { SY1StudioEngine, type ScheduledDispatchRecord } from "../src/studio/studio-engine";
import { STUDIO_DRUM_BANK_KEY, createTrackDrumBank, normalizeTrackDrumBank, editTrackDrumStep, drumPatternMidi } from "../src/studio/track-drum-patterns";
import { parseStudioProjectJson } from "../src/studio/project-io";
import { renderDrumStepsHtml } from "../src/ui/drum-steps-view";
import { renderStudioInstrumentHtml } from "../src/ui/studio-instrument";

describe("Phase 7.7D independent drum patterns",()=>{
  test("separate banks, slots, immutable-on-write snapshots and kit changes",()=>{
    for(const machineId of ["kerman","bushehr","rasht","hormoz"]){
      const a=new SY1TrackEngine({id:"a",name:"A",machineId}), b=new SY1TrackEngine({id:"b",name:"B",machineId});
      const first=a.getTrackDrumBank(), before=JSON.stringify(b.getTrackDrumBank());
      first.selected=3;first.patterns[3]=emptyPattern(12);editTrackDrumStep(first.patterns[3],"kick",0,"accent");
      expect(a.setTrackDrumBank(first)).toBe(true);first.patterns[3].steps.kick[0]=0;
      expect(a.getTrackDrumBank().patterns[3].steps.kick[0]).toBe(2);
      expect(JSON.stringify(b.getTrackDrumBank())).toBe(before);
      const bank=a.getTrackDrumBank(); bank.patterns[3].steps.kick[0]=0;expect(a.getTrackDrumBank().patterns[3].steps.kick[0]).toBe(2);
      a.dispose();b.dispose();
    }
  });
  test("kit selection preserves pattern; switching machines clears the old bank",()=>{
    const a=new SY1TrackEngine({id:"a",name:"A",machineId:"kerman"});
    const before=a.getTrackDrumBank();before.selected=5;a.setTrackDrumBank(before);
    a.setParam("drumSwing",.25);a.setParam("drumAccent",.7);
    a.applyMachinePreset("kerman","kit:808");expect(a.getTrackDrumBank()).toEqual(before);expect(a.patch.drumSwing).toBe(.25);expect(a.patch.drumAccent).toBeCloseTo(.7);
    a.applyMachinePreset("bushehr","init");expect(a.getTrackDrumBank().selected).toBe(0);a.dispose();
  });
  test("all six edit modes and bounds",()=>{
    const p=emptyPattern(12);expect(editTrackDrumStep(p,"kick",12,"hit")).toBe(false);
    editTrackDrumStep(p,"kick",0,"hit");expect(p.steps.kick[0]).toBe(1);
    editTrackDrumStep(p,"kick",0,"accent");expect(p.steps.kick[0]).toBe(2);
    editTrackDrumStep(p,"kick",0,"ghost");expect(p.steps.kick[0]).toBe(3);
    editTrackDrumStep(p,"kick",0,"roll");expect(stepRoll(p,"kick",0)).toBe(2);
    editTrackDrumStep(p,"kick",0,"flam");expect(stepFlam(p,"kick",0)).toBe(1);
    editTrackDrumStep(p,"kick",0,"chance");expect(stepProb(p,"kick",0)).toBe(75);
    editTrackDrumStep(p,"kick",0,"hit");expect(p.steps.kick[0]).toBe(0);expect(stepRoll(p,"kick",0)).toBe(1);expect(stepFlam(p,"kick",0)).toBe(0);expect(stepProb(p,"kick",0)).toBe(100);
  });
  test("MIDI render preserves swing, rolls, flams, accent and deterministic chance",()=>{
    const p=patternFrom(12,{kick:"Xg2f?",snare:"...x"});
    const r=drumPatternMidi(p,{drumSwing:.25,drumAccent:.5},120,()=>.9);
    expect(r.length).toBe(1440);const notes=r.events.filter(e=>e.type==="noteOn"&&e.midi===DRUM_NOTES.kick);
    expect(notes.map(e=>e.tick)).toEqual([0,150,240,300,369,390]);
    expect(notes.map(e=>e.type==="noteOn"?e.velocity:0)).toEqual([1,.3,.75,.75*.82,.75*.45,.75]);
    expect(r.events.every(e=>e.tick>=0&&e.tick<=r.length)).toBe(true);
    expect(drumPatternMidi(p,{drumSwing:.25,drumAccent:.5},120,()=>0).events.filter(e=>e.type==="noteOn").length).toBe(8);
  });
  test("last-step swung rolls stay in range, note-offs close each hit",()=>{
    const p=patternFrom(16,{kick:"...............4"});
    const r=drumPatternMidi(p,{drumSwing:.6},120,()=>0);
    const ons=r.events.filter(e=>e.type==="noteOn"),offs=r.events.filter(e=>e.type==="noteOff");expect(ons.length).toBe(4);expect(offs.length).toBe(4);
    expect(ons.every(e=>e.tick>=0&&e.tick<1920)).toBe(true);
    expect(offs.every((e,i)=>e.tick>ons[i].tick&&e.tick<=1920)).toBe(true);
  });
  test("project roundtrip keeps bank, rejects invalid extensions",async()=>{
    const e=new SY1StudioEngine({isolatedTempo:true});const a=e.getFocusedTrack();e.setTrackMachine(a.id,"bushehr");
    const b=createTrackDrumBank();b.selected=6;b.patterns[6]=patternFrom(12,{kick:"x...X"});a.setTrackDrumBank(b);
    const parsed=parseStudioProjectJson(e.exportProjectJson());expect(parsed.ok).toBe(true);if(!parsed.ok)throw Error("parse failed");
    const restored=new SY1StudioEngine({isolatedTempo:true});await restored.loadProject(parsed.project);expect(restored.getFocusedTrack().getTrackDrumBank()).toEqual(b);
    const invalid=JSON.parse(e.exportProjectJson());invalid.tracks.find((t:any)=>t.id===a.id).patch[STUDIO_DRUM_BANK_KEY]={selected:99,patterns:[]};const sanitized=parseStudioProjectJson(JSON.stringify(invalid));expect(sanitized.ok).toBe(true);if(sanitized.ok)expect(sanitized.project.tracks.find(t=>t.id===a.id)?.patch[STUDIO_DRUM_BANK_KEY]).toBe(undefined);
    expect(normalizeTrackDrumBank({selected:0,patterns:[]})).toBeNull();e.dispose();restored.dispose();
  });
  test("insert exact length on owning track, snap, undo/redo and protect existing clips",()=>{
    const e=new SY1StudioEngine({isolatedTempo:true});const a=e.getFocusedTrack();e.setTrackMachine(a.id,"kerman");const b=e.getTracks()[1];
    const r=drumPatternMidi(patternFrom(12,{kick:"x...x...x"}),{},120);e.regions.grid=480;
    e.regions.insertPattern(a.id,500,r.length,r.events);const regs=e.regions.regions(a.id);expect(regs.length).toBe(1);expect(regs[0].startTick).toBe(480);expect(regs[0].length).toBe(1440);expect(e.regions.regions(b.id).length).toBe(0);
    let failed=false;try{e.regions.insertPattern(a.id,500,r.length,r.events)}catch{failed=true}expect(failed).toBe(true);expect(e.regions.regions(a.id)).toEqual(regs);
    e.regions.undo();expect(e.regions.regions(a.id).length).toBe(0);e.regions.redo();expect(e.regions.regions(a.id)).toEqual(regs);e.dispose();
  });
  test("inserted pattern plays once through the existing tempo-synced scheduler",async()=>{
    let now=10;const e=new SY1StudioEngine({isolatedTempo:true,initialBpm:120,clockNow:()=>now});const a=e.getFocusedTrack();e.setTrackMachine(a.id,"kerman");e.setLoopEnabled(false);
    const r=drumPatternMidi(patternFrom(16,{kick:"x...X"}),{},120);e.regions.insertPattern(a.id,0,r.length,r.events);
    const dispatch:ScheduledDispatchRecord[]=[];e.setDispatchObserver(x=>dispatch.push(x));await e.play();
    for(let i=1;i<=32;i++){now=10+i*.025;e.stepScheduler(now);}
    const hits=dispatch.filter(x=>x.event.type==="noteOn");expect(hits.length).toBe(2);expect(hits.map(x=>x.audioTime)).toEqual([10,10.5]);
    await e.stop();e.dispose();
  });
  test("shared step grid has the original classes and isolated actions on every drum machine",()=>{
    const p=patternFrom(12,{kick:"X2f?"});const original=renderDrumStepsHtml(p,"kick",v=>v),track=renderDrumStepsHtml(p,"kick",v=>v,true);
    expect(original).toContain('data-action="drum-step"');expect(track).toContain('data-st-action="track-drum-step"');expect(track).not.toContain('data-action="drum-step"');expect(track).toContain('data-mark="×2"');
    for(const machineId of ["kerman","bushehr","rasht","hormoz"]){const a=new SY1TrackEngine({id:machineId,name:machineId,machineId});const html=renderStudioInstrumentHtml(a,"steps",true);expect(html).toContain('data-st-action="track-drum-insert"');expect(html).toContain('data-st-action="track-drum-step"');expect(html).toContain('id="st-inst-back-btn"');a.dispose();}
  });
});
