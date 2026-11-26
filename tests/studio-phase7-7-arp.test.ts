import { describe, expect, test } from "bun:test";
import { TrackArpeggiator } from "../src/studio/track-arpeggiator";
import { SY1StudioEngine } from "../src/studio/studio-engine";
import { renderArpPanelHtml } from "../src/ui/arp-view";
import { renderInstrumentControl } from "../src/ui/instrument-controls";
const patch = (extra: Record<string,unknown> = {}) => ({arpOn:"on",arpMode:"up",arpRate:6,arpOct:1,arpGate:0.5,arpSwing:0,hold:"off",...extra});
const collect = (a:TrackArpeggiator,p:ReturnType<typeof patch>, count=6) => Array.from({length:count},(_,i)=>a.drain(p,120,10+i*0.125,0.001)).flat();
describe("Phase 7.7C independent track ARP",()=>{
  test("up, down, up/down and played order preserve velocity and gate",()=>{
    for (const [mode,expected] of [["up",[60,64,67,60,64,67]],["down",[67,64,60,67,64,60]],["updown",[60,64,67,64,60,64]],["played",[67,60,64,67,60,64]]] as const) {
      const p=patch({arpMode:mode}),a=new TrackArpeggiator();
      a.noteOn(67,.8,p,10);a.noteOn(60,.4,p,10);a.noteOn(64,.6,p,10);
      const pulses=collect(a,p);
      expect(pulses.map(n=>n.midi)).toEqual([...expected]);
      expect(pulses.every(n=>Math.abs(n.off-n.at-.06125)<1e-8)).toBe(true);
      expect(pulses.find(n=>n.midi===60)?.velocity).toBe(.4);
    }
  });
  test("independent chord, latch, release and disable",()=>{
    const a=new TrackArpeggiator(),b=new TrackArpeggiator(),p=patch({hold:"on"}),q=patch();
    a.noteOn(60,.7,p,10);b.noteOn(72,.5,q,10);
    a.noteOff(60,p);b.noteOff(72,q);
    expect(a.running).toBe(true);expect(b.running).toBe(false);
    expect(a.drain(p,120,10)[0].midi).toBe(60);expect(b.drain(q,120,10)).toEqual([]);
    a.releaseLatched();expect(a.running).toBe(false);
    a.noteOn(62,.7,p,11);a.drain({...p,arpOn:"off"},120,11);
    expect(a.noteOff(62,p)).toBe(true);expect(a.running).toBe(false);
  });
  test("octaves, tempo, swing and stall never emit out of range or stale bursts",()=>{
    const a=new TrackArpeggiator(),p=patch({arpOct:4,arpSwing:.25});a.noteOn(120,1,p,10);
    expect(a.drain(p,120,10)[0].midi).toBe(120);
    expect(a.drain(p,120,10.125,.01)).toEqual([]);
    expect(a.drain(p,120,10.15625,.001)[0].at).toBeCloseTo(10.15625,6);
    const resumed=a.drain(p,60,30,.06);expect(resumed.length).toBe(1);expect(resumed[0].at).toBeGreaterThanOrEqual(30);
  });
  test("Euclidean rings honor pulses, octave and velocity",()=>{
    const a=new TrackArpeggiator(),p=patch({arpMode:"euclid",eucRate:6,euc1Steps:4,euc1Pulses:2,euc1Rot:0,euc1Oct:1,euc2On:"off",euc3On:"off"});
    a.noteOn(60,.5,p,10);
    expect(collect(a,p,4).map(x=>[x.midi,x.velocity])).toEqual([[72,.5],[72,.39]]);
  });
  test("live input routes ARP to its owning track and stops cleanly",async()=>{
    let now=10;const e=new SY1StudioEngine({isolatedTempo:true,initialBpm:120,clockNow:()=>now});
    const a=e.getFocusedTrack(),b=e.addTrack()!;a.setParam("arpOn","on");b.setParam("arpOn","off");
    const pulses:number[]=[];a.playArpPulse=p=>pulses.push(p.midi);
    e.liveNoteOn(60,.5);e.stepLiveArpeggiators(now);expect(pulses).toEqual([60]);
    e.setFocusedTrack(b.id);e.liveNoteOff(60);now+=.2;e.stepLiveArpeggiators(now);
    expect(pulses).toEqual([60]);expect(a.liveArpeggiator.running).toBe(false);
    await e.stop();e.dispose();
  });
  test("record generated notes, not the original chord or a second arpeggiation",async()=>{
    let now=10;const e=new SY1StudioEngine({isolatedTempo:true,initialBpm:120,clockNow:()=>now});const t=e.getFocusedTrack();
    t.setParam("arpOn","on");t.setParam("arpRate",6);t.setParam("arpGate",.5);t.setParam("hold","off");
    await e.record({midiOnly:true});e.liveNoteOn(60,.7);e.liveNoteOn(64,.8);
    now=10.1;e.stepLiveArpeggiators(now);now=10.225;e.stepLiveArpeggiators(now);
    e.liveNoteOff(60);e.liveNoteOff(64);now=10.5;await e.stop();
    const notes=t.getNoteSpans(e.getTotalTicks());expect(notes.map(n=>n.midi)).toEqual([60,64]);expect(notes.every(n=>n.endTick-n.startTick<120)).toBe(true);
    e.dispose();
  });
  test("unstarted ARP follows a changed count-in anchor",async()=>{
    let now=10;const e=new SY1StudioEngine({isolatedTempo:true,initialBpm:120,clockNow:()=>now});
    const t=e.getFocusedTrack();t.setParam("arpOn","on");t.setParam("hold","off");
    const starts:number[]=[];t.playArpPulse=p=>starts.push(p.at);
    e.setRecordingSettings({countIn:true});await e.record({midiOnly:true});
    now=10.1;e.liveNoteOn(60);e.stepLiveArpeggiators(now);
    now=10.5;e.setBpm(60);now=12;e.stepLiveArpeggiators(now);expect(starts).toEqual([]);
    now=13.45;e.stepLiveArpeggiators(now);expect(starts).toEqual([13.5]);
    await e.stop();now=14;e.stepLiveArpeggiators(now);expect(starts).toEqual([13.5]);e.dispose();
  });
  test("live pulse releases the exact voice on the audio clock despite latch",()=>{
    const e=new SY1StudioEngine({isolatedTempo:true});const t=e.getFocusedTrack();
    t.patch.arpOn="on";t.patch.hold="on";const internal=t as any;
    internal.ctx={currentTime:10};internal.bus={};const releases:number[]=[];
    internal.startVoice=(m:number,v:number,at:number)=>{expect(m).toBe(60);expect(v).toBe(.5);expect(at).toBe(10.1);return {release:(off:number)=>releases.push(off)}};
    t.playArpPulse({midi:60,velocity:.5,at:10.1,off:10.2});expect(releases).toEqual([10.2]);
    expect(internal.heldVoices.size).toBe(0);internal.ctx=null;internal.bus=null;e.dispose();
  });
  test("shared ARP panel uses track-only actions and separate parameter values",()=>{
    const p=patch();const s=renderArpPanelHtml(p,120,c=>renderInstrumentControl({kind:"track",patch:p},c),true);
    expect(s).toContain('data-st-action="param-toggle"');expect(s).toContain('data-st-param="arpGate"');
    expect(s).toContain('data-st-action="bpm-up"');expect(s.includes('data-action="synth-toggle"')).toBe(false);
  });
});
