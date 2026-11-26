// Architectural acceptance tests. These intentionally test the desired behavior,
// not the current behavior. Run separately from the legacy regression suite.
import { describe, expect, test } from "bun:test";
import { SY1StudioEngine, type ScheduledDispatchRecord } from "../src/studio/studio-engine";
import { patternFrom, DRUM_NOTES } from "../src/engine/drums";
import { STUDIO_PPQ } from "../src/studio/types";
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
describe("DAW acceptance contract — current baseline",()=>{
  test("A01: Record on a selected drum machine records its selected pattern without a separate Live toggle",async()=>{
    const {engine,track,advance}=fixture();
    try {
      await engine.record({midiOnly:true});
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
});
