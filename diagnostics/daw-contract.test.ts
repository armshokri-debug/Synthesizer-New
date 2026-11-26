// Architectural acceptance tests. These intentionally test the desired behavior,
// not the current behavior. Run separately from the legacy regression suite.
import { describe, expect, test } from "bun:test";
import { trimCaptureWindow } from "../src/studio/recording-window";
import { SY1StudioEngine, type ScheduledDispatchRecord } from "../src/studio/studio-engine";
import { patternFrom, DRUM_NOTES } from "../src/engine/drums";
import { STUDIO_PPQ, type StudioMidiEvent } from "../src/studio/types";
function fixture() {
  let now=10;
  const engine=new SY1StudioEngine({isolatedTempo:true,initialBpm:120,clockNow:()=>now});
  const track=engine.getFocusedTrack();
  engine.setTrackMachine(track.id,"kerman");
  engine.setTrackArmed(track.id,true);
  engine.setLoopEnabled(false);
  engine.setRecordingSettings({countIn:false,mode:"overdub"});
  const bank=track.getTrackDrumBank();
  bank.patterns[bank.selected]=patternFrom(16,{kick:"x...x"});
  track.setTrackDrumBank(bank);track.setParam("drumSwing",0);
  const hits:ScheduledDispatchRecord[]=[];
  engine.setDispatchObserver(e=>hits.push(e));
  function advance(end:number) {
    while(now+.025<end){now+=.025;engine.stepScheduler(now);}
    now=end;engine.stepScheduler(now);
  }
  return {engine,track,hits,advance};
}
describe("DAW acceptance contract",()=>{
  test("A01: Record on a selected drum machine records its selected pattern without a separate Live toggle",async()=>{
    const {engine,track,advance}=fixture();
    try {
      await engine.record({midiOnly:true,patternTrackId:track.id});
      advance(10.65);await engine.stop();
      expect(track.events.filter(e=>e.type==="noteOn").map(e=>e.tick)).toEqual([0,STUDIO_PPQ]);
    } finally {engine.dispose();}
  });
  test("A02: Preview → Record captures the pattern once, aligned to the recording start",async()=>{
    const {engine,track,advance}=fixture();
    try {
      engine.startDrumPreview(track.id);advance(10.2);
      await engine.record({midiOnly:true});advance(10.85);await engine.stop();
      expect(track.events.filter(e=>e.type==="noteOn").map(e=>e.tick)).toEqual([0,STUDIO_PPQ]);
    } finally {engine.dispose();}
  });
  test("A03: Tempo change inside scheduling lookahead must invalidate old dispatch timing",()=>{
    const {engine,track,hits,advance}=fixture();
    try {
      engine.startDrumPreview(track.id);
      advance(10.425);
      // Beat 2 is already dispatched by the old 120 BPM lookahead.
      expect(hits.some(h=>h.event.tick===STUDIO_PPQ)).toBe(true);
      engine.setBpm(60);
      advance(10.8);
      const beat=hits.filter(h=>h.event.type==="noteOn"&&h.event.tick===STUDIO_PPQ);
      // Observer-level necessary condition only: final dispatch must be rescheduled
      // to the new time. PCM tests must later prove the old event was cancelled.
      expect(beat.at(-1)?.audioTime).toBeCloseTo(10.575,6);
    } finally {engine.dispose();}
  });
  test("A04: Tempo change immediately before a loop seam does not jump musical position",async()=>{
    const {engine,advance}=fixture();
    try {
      engine.setBars(1);engine.setLoopRange(1,1);engine.setLoopEnabled(true);
      await engine.play();advance(11.95);
      const before=engine.getCurrentTick();
      engine.setBpm(60);
      expect(engine.getCurrentTick()).toBeCloseTo(before,6);
    } finally {engine.dispose();}
  });
  test("A05: Changing a future drum step during recording is heard and captured in the same cycle",async()=>{
    const {engine,track,advance}=fixture();
    try {
      engine.setLiveDrumEnabled(track.id,true);
      await engine.record({midiOnly:true});advance(10.2);
      const bank=track.getTrackDrumBank();
      bank.patterns[bank.selected].steps.snare[8]=1;
      track.setTrackDrumBank(bank);
      advance(11.2);await engine.stop();
      expect(track.events.some(e=>e.type==="noteOn"&&e.midi===DRUM_NOTES.snare&&e.tick===STUDIO_PPQ*2)).toBe(true);
    } finally {engine.dispose();}
  });
  test("A12: arrangement drum hit inside lookahead moves with new tempo",async()=>{
    const {engine,track,hits,advance}=fixture();
    try{
      engine.insertDrumPattern(track.id,0);
      await engine.play();advance(10.425);
      engine.setBpm(60);advance(10.8);
      const beat=hits.filter(h=>h.trackId===track.id&&h.event.type==="noteOn"&&h.event.tick===STUDIO_PPQ);
      expect(beat.at(-1)?.audioTime).toBeCloseTo(10.575,6);
    }finally{engine.dispose();}
  });
  test("A13: live pattern capture follows the rescheduled audio event",async()=>{
    const {engine,track,hits,advance}=fixture();
    try{
      await engine.record({midiOnly:true,patternTrackId:track.id});advance(10.425);
      engine.setBpm(60);advance(10.55);
      expect(track.events.filter(e=>e.type==="noteOn").map(e=>e.tick)).toEqual([0]);
      advance(10.65);await engine.stop();
      expect(track.events.filter(e=>e.type==="noteOn").map(e=>e.tick)).toEqual([0,STUDIO_PPQ]);
      const beat=hits.filter(h=>h.event.type==="noteOn"&&h.event.tick===STUDIO_PPQ);
      expect(beat.at(-1)?.audioTime).toBeCloseTo(10.575,6);
    }finally{engine.dispose();}
  });
  test("A14: future drum hit on next loop moves with the new seam",async()=>{
    const {engine,track,hits,advance}=fixture();
    try{
      engine.setBars(1);engine.setLoopRange(1,1);engine.setLoopEnabled(true);
      engine.insertDrumPattern(track.id,0);
      await engine.play();advance(11.95);engine.setBpm(60);
      expect(engine.getCurrentTick()).toBeCloseTo(1872,5);
      advance(12.1);
      const downbeat=hits.filter(h=>h.event.type==="noteOn"&&h.event.tick===0);
      expect(downbeat.at(-1)?.audioTime).toBeCloseTo(12.05,6);
      expect(engine.getCurrentTick()).toBeCloseTo(24,5);
    }finally{engine.dispose();}
  });
  test("A15: pause retains musical position, resume continues, explicit Stop rewinds",async()=>{
    const {engine,advance}=fixture();
    try {
      await engine.play();advance(10.75);
      await engine.pause();
      expect(engine.getTransportSnapshot().playing).toBe(false);
      expect(engine.getCurrentTick()).toBe(720);
      advance(11.5);expect(engine.getCurrentTick()).toBe(720);
      await engine.play();advance(12);
      expect(engine.getCurrentTick()).toBeCloseTo(1200,5);
      await engine.stop();expect(engine.getCurrentTick()).toBe(0);
    }finally{engine.dispose();}
  });
  test("A16: instrument Record arms selected drum track even when another track is armed",async()=>{
    const {engine,track,advance}=fixture();
    try{
      const other=engine.getTracks().find(t=>t.id!==track.id)!;
      engine.setTrackArmed(track.id,false);engine.setTrackArmed(other.id,true);
      const original=other.events.slice();
      await engine.record({midiOnly:true,patternTrackId:track.id});advance(10.65);
      await engine.pause();
      expect(track.events.filter(e=>e.type==="noteOn").map(e=>e.tick)).toEqual([0,STUDIO_PPQ]);
      expect(other.events).toEqual(original);
      expect(engine.getCurrentTick()).toBe(624);
      expect(engine.getTransportSnapshot().recording).toBe(false);
    }finally{engine.dispose();}
  });
  test("A17: PCM frame window excludes count-in and tail, preserves both channels across block boundaries",()=>{
    const l=[Float32Array.from([1,2,3,4]),Float32Array.from([5,6,7,8])];
    const r=[Float32Array.from([-1,-2,-3,-4]),Float32Array.from([-5,-6,-7,-8])];
    const result=trimCaptureWindow([l,r],100,103,106);
    expect(result.frames).toBe(3);
    expect(result.missingFrames).toBe(0);
    expect(result.chunks[0].flatMap(a=>Array.from(a))).toEqual([4,5,6]);
    expect(result.chunks[1].flatMap(a=>Array.from(a))).toEqual([-4,-5,-6]);
    expect(trimCaptureWindow([l,r],100,98,110).missingFrames).toBe(4);
  });
  test("A18: second pattern overdubs existing regions without duplicating matching drum hits",async()=>{
    const {engine,track,hits,advance}=fixture();
    try{
      engine.insertDrumPattern(track.id,0);
      const bank=track.getTrackDrumBank();
      bank.patterns[bank.selected].steps.snare[2]=1;
      track.setTrackDrumBank(bank);
      await engine.record({midiOnly:true,patternTrackId:track.id});
      advance(10.7);await engine.stop();
      const expected=[[0,DRUM_NOTES.kick],[240,DRUM_NOTES.snare],[480,DRUM_NOTES.kick]];
      const pairs=(events: readonly StudioMidiEvent[])=>events.filter(e=>e.type==="noteOn").map(e=>[e.tick,e.midi]).sort((a,b)=>a[0]-b[0]);
      expect(pairs(track.events)).toEqual(expected);
      expect(pairs(hits.map(h=>h.event))).toEqual(expected);
      hits.length=0;await engine.play();advance(11.4);await engine.stop();
      expect(pairs(hits.map(h=>h.event))).toEqual(expected);
    }finally{engine.dispose();}
  });
});
