import { describe, expect, test } from "bun:test";
import { SY1StudioEngine, type ScheduledDispatchRecord } from "../src/studio/studio-engine";
import { createTrackDrumBank } from "../src/studio/track-drum-patterns";
import { patternFrom, DRUM_NOTES } from "../src/engine/drums";
function setup() {
  let now=10; const e=new SY1StudioEngine({isolatedTempo:true,initialBpm:120,clockNow:()=>now});
  const track=e.getFocusedTrack();e.setTrackMachine(track.id,"kerman");
  const bank=createTrackDrumBank();bank.patterns[0]=patternFrom(16,{kick:"x...X"});track.setTrackDrumBank(bank);track.setParam("drumSwing",0);
  e.setLoopEnabled(false); const hits:ScheduledDispatchRecord[]=[];e.setDispatchObserver(x=>hits.push(x));
  return {e,track,hits,at:(t:number)=>{now=t;e.stepScheduler(now);},advance:(t:number)=>{while(now+0.025<t){now+=0.025;e.stepScheduler(now);}now=t;e.stepScheduler(now);}};
}
describe("Live pattern with the Studio transport",()=>{
  test("starts from step 1, repeats and follows tempo in tick space",async()=>{
    const {e,track,hits,advance}=setup(); e.setLiveDrumEnabled(track.id,true);await e.play();advance(12.6);
    expect(hits.map(x=>x.event.tick)).toEqual([0,480,1920,2400]);
    expect(hits.map(x=>Math.round(x.audioTime*1000))).toEqual([10000,10500,12000,12500]);
    await e.stop();expect(e.isLiveDrumEnabled(track.id)).toBe(false);e.dispose();
  });
  test("count-in aligns first hit; no recorded event before sound time or after stop",async()=>{
    const {e,track,hits,advance}=setup();e.setRecordingSettings({countIn:true});e.setLiveDrumEnabled(track.id,true);await e.record({midiOnly:true});
    advance(11.8);expect(hits.length).toBe(0);advance(11.95);expect(hits.length).toBe(1);expect(track.events.length).toBe(0);
    advance(12.1);expect(track.events.filter(x=>x.type==="noteOn").length).toBe(1);advance(12.45);await e.stop();
    expect(track.events.filter(x=>x.type==="noteOn").map(x=>x.tick)).toEqual([0]);
    expect(track.events.filter(x=>x.type==="noteOff").length).toBe(1);
    hits.length=0;await e.play();expect(hits.filter(x=>x.event.type==="noteOn").length).toBe(1);await e.stop();e.dispose();
  });
  test("existing clip is not masked or duplicated",()=>{
    const {e,track}=setup();track.addNote(DRUM_NOTES.kick,0,30);let blocked=false;try{e.setLiveDrumEnabled(track.id,true)}catch{blocked=true;}
    expect(blocked).toBe(true);expect(e.isLiveDrumEnabled(track.id)).toBe(false);expect(track.getNoteCount()).toBe(1);e.dispose();
  });
  test("empty arrangement regions are protected from live pattern playback",()=>{
    const {e,track}=setup(); track.setRegions([{id:"empty-region",trackId:track.id,startTick:0,length:480,sourceLength:480,offset:0,loop:false,events:[]}]);
    expect(track.events.length).toBe(0); let blocked=false;try{e.setLiveDrumEnabled(track.id,true)}catch{blocked=true;}
    expect(blocked).toBe(true);expect(track.getRegions(e.getTotalTicks()).length).toBe(1);e.dispose();
  });
  test("loop records each position only once and replays without live source",async()=>{
    const {e,track,advance,hits}=setup();e.setBars(1);e.setLoopEnabled(true);e.setLiveDrumEnabled(track.id,true);await e.record({midiOnly:true});advance(14.3);await e.stop();
    expect(hits.filter(x=>x.event.type==="noteOn").length).toBeGreaterThan(4);expect(track.events.filter(x=>x.type==="noteOn").map(x=>x.tick)).toEqual([0,480]);e.dispose();
  });
  test("changing tempo preserves the next musical hit",async()=>{
    const {e,track,hits,advance}=setup();e.setLiveDrumEnabled(track.id,true);await e.play();advance(10.2);e.setBpm(60);advance(11.2);
    expect(hits.map(x=>x.event.tick)).toEqual([0,480]);expect(hits[1].audioTime).toBeCloseTo(10.8,5);await e.stop();e.dispose();
  });
});
