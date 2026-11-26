import { describe, expect, test } from "bun:test";
import { SY1StudioEngine, type ScheduledDispatchRecord } from "../src/studio/studio-engine";
import { beatsInWindow } from "../src/studio/metronome";
import { STUDIO_PPQ } from "../src/studio/types";

function fixture(bpm = 120) {
  let now = 10;
  const engine = new SY1StudioEngine({ isolatedTempo: true, initialBpm: bpm, clockNow: () => now });
  const track = engine.getFocusedTrack();
  return { engine, track, at: (t: number) => { now = t; }, step: (t: number) => { now = t; engine.stepScheduler(t); } };
}

describe("Phase 7.7A — shared recording start", () => {
  test("fresh recording uses the same audio anchor as transport and metronome", async () => {
    const { engine, track } = fixture();
    const starts: number[] = [];
    await engine.record({ midiOnly: true, onStart: at => {
      starts.push(at);
      engine.capturePerformanceMidi(track.id, [0x90, 36, 100], at);
      engine.capturePerformanceMidi(track.id, [0x80, 36, 0], at + 0.06);
    }});
    expect(starts).toEqual([10]);
    expect(engine.getCurrentTick(starts[0])).toBe(0);
    expect(beatsInWindow(10,10.1,starts[0],0,120)[0].at).toBe(starts[0]);
    expect(track.getNoteSpans(engine.getTotalTicks())[0].startTick).toBe(0);
    await engine.stop(); engine.dispose();
  });
  test("count-in defers pattern dispatch, honors revised tempo and dispatches once", async () => {
    const { engine, track, step, at } = fixture();
    const starts: number[] = [];
    engine.setRecordingSettings({ countIn: true, metronome: true });
    await engine.record({ midiOnly: true, onStart: time => starts.push(time) });
    expect(starts).toEqual([]);
    expect(engine.canCapturePerformanceAt(11.999)).toBe(false);
    engine.capturePerformanceMidi(track.id,[0x90,60,100],11);
    expect(track.events.length).toBe(0);
    at(10.5); engine.setBpm(60); // 3 remaining beats => anchor 13.5
    step(13.35); expect(starts.length).toBe(0);
    step(13.45); expect(starts).toEqual([13.5]);
    expect(engine.getCurrentTick(starts[0])).toBe(0);
    expect(engine.canCapturePerformanceAt(13.49)).toBe(false);
    expect(engine.canCapturePerformanceAt(13.5)).toBe(true);
    step(13.6); expect(starts.length).toBe(1);
    await engine.stop(); engine.dispose();
  });
  test("stop before count-in completes cancels the old pattern start", async () => {
    const { engine, step } = fixture();
    let count = 0;
    engine.setRecordingSettings({countIn:true});
    await engine.record({midiOnly:true,onStart:()=>count++});
    step(10.5); await engine.stop(); step(12.5);
    expect(count).toBe(0); expect(engine.canCapturePerformanceAt(12.5)).toBe(false);
    engine.setRecordingSettings({countIn:false});
    await engine.record({midiOnly:true,onStart:()=>count++});
    expect(count).toBe(1); await engine.stop(); engine.dispose();
  });
  test("punch-in preserves the running transport position", async () => {
    const { engine, at } = fixture();
    await engine.play(); at(10.5);
    let start = -1;
    await engine.record({midiOnly:true,onStart:t=>{start=t;}});
    expect(start).toBe(10.5); expect(engine.getCurrentTick(start)).toBe(STUDIO_PPQ);
    await engine.stop(); engine.dispose();
  });
  test("directly monitored pattern note is not triggered twice on the same pass", async () => {
    const { engine, track, step } = fixture();
    engine.setBars(1);
    engine.setLoopEnabled(true);
    engine.setLoopRange(1,1);
    const dispatch: ScheduledDispatchRecord[] = [];
    engine.setDispatchObserver(e=>dispatch.push(e));
    await engine.record({midiOnly:true,onStart:at=>{
      engine.capturePerformanceMidi(track.id,[0x90,36,100],at);
      engine.capturePerformanceMidi(track.id,[0x80,36,0],at+0.06);
    }});
    expect(dispatch.length).toBe(0);
    for(let i=1;i<=80;i++)step(10+i*0.025);
    const hits=dispatch.filter(e=>e.event.type==="noteOn");
    expect(hits.length).toBe(1); expect(hits[0].audioTime).toBeCloseTo(12);
    await engine.stop(); engine.dispose();
  });
  test("manual notes and controllers obey the same pre-roll gate", async () => {
    const { engine, track, at } = fixture();
    engine.setRecordingSettings({countIn:true});
    await engine.record({midiOnly:true});
    at(11.5);engine.liveNoteOn(60);engine.liveNoteOff(60);engine.liveCC(1,90);
    expect(track.events.length).toBe(0);
    at(12);engine.liveNoteOn(62);engine.liveCC(1,40);
    at(12.25);engine.liveNoteOff(62);
    expect(track.getNoteSpans(engine.getTotalTicks()).map(n=>[n.midi,n.startTick,n.endTick])).toEqual([[62,0,240]]);
    expect(track.events.some(e=>e.type==="cc"&&e.cc===1&&e.value===40)).toBe(true);
    await engine.stop();engine.dispose();
  });
});
