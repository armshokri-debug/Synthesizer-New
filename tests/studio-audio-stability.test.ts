import { describe, expect, test } from "bun:test";
import { createStudioEngine } from "../src/studio/studio-engine";

describe("transport underrun recovery", () => {
  test("a same-pass scheduler stall preserves a held note in an unrelated track and skips late attacks", async () => {
    let now = 0;
    const engine = createStudioEngine({ isolatedTempo:true, initialBpm:120, clockNow:()=>now });
    const [a,b] = engine.getTracks();
    a.setEvents([{type:"noteOn",tick:0,midi:60,velocity:.8},{type:"noteOff",tick:1920,midi:60}]);
    b.setEvents([{type:"noteOn",tick:240,midi:64,velocity:.8},{type:"noteOff",tick:360,midi:64}]);
    const releases:number[]=[];
    const original=a.noteOff.bind(a);
    a.noteOff=(midi,at)=>{releases.push(midi);original(midi,at);};
    const notes:number[]=[];
    engine.setDispatchObserver(r=>{if(r.trackId===b.id&&r.event.type==="noteOn")notes.push(r.event.tick);});
    await engine.play();
    now=.6;engine.stepScheduler(now);
    expect(releases).toEqual([]);
    expect(notes).toEqual([]);
    expect(engine.getSchedulerDiagnostics().severeStalls).toBe(1);
    expect(engine.getSchedulerDiagnostics().skippedNoteOns).toBe(1);
    engine.dispose();
  });
  test("a missed release is delivered, without releasing an unaffected long note", async()=>{
    let now=0;
    const engine=createStudioEngine({isolatedTempo:true,initialBpm:120,clockNow:()=>now});
    const [a,b]=engine.getTracks();
    a.setEvents([{type:"noteOn",tick:0,midi:60,velocity:.8},{type:"noteOff",tick:240,midi:60}]);
    b.setEvents([{type:"noteOn",tick:0,midi:64,velocity:.8},{type:"noteOff",tick:1920,midi:64}]);
    const releases:string[]=[];
    for(const t of [a,b]){const original=t.noteOff.bind(t);t.noteOff=(m,at)=>{releases.push(t.id);original(m,at);};}
    await engine.play();now=.6;engine.stepScheduler(now);
    expect(releases).toEqual([a.id]);
    engine.resetSchedulerDiagnostics();
    expect(engine.getSchedulerDiagnostics().severeStalls).toBe(0);
    engine.dispose();
  });
});

describe("live MIDI edit isolation", () => {
  test("editing one track preserves the unrelated sustained note and does not redispatch its queued attacks", async () => {
    let now = 0;
    const engine = createStudioEngine({isolatedTempo:true, initialBpm:120, clockNow:()=>now});
    const [a,b] = engine.getTracks();
    a.setEvents([{type:"noteOn",tick:0,midi:60,velocity:.8},{type:"noteOff",tick:1920,midi:60}]);
    b.setEvents([{type:"noteOn",tick:48,midi:64,velocity:.8},{type:"noteOff",tick:360,midi:64}]);
    let cancels=0, releases=0;
    const cancel=a.cancelRegionPlayback.bind(a), off=a.noteOff.bind(a);
    a.cancelRegionPlayback=(dest)=>{cancels++;cancel(dest);};
    a.noteOff=(midi,at)=>{releases++;off(midi,at);};
    const attacks:number[]=[];
    engine.setDispatchObserver(r=>{if(r.trackId===a.id&&r.event.type==="noteOn")attacks.push(r.event.tick);});
    await engine.play();
    now=.02;
    engine.regions.select(b.getRegions(engine.getTotalTicks())[0].id);
    engine.replaceTrackNotes(b.id,[{midi:65,startTick:96,endTick:480,velocity:.7}]);
    expect(cancels).toBe(0);
    expect(releases).toBe(0);
    expect(attacks).toEqual([0]);
    expect(engine.isPlaying()).toBe(true);
    expect(engine.getCurrentTick()).toBeCloseTo(19.2,4);
    engine.dispose();
  });
});
