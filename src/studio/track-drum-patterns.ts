import { DRUM_NOTES, DRUM_VOICES, emptyPattern, stepFlam, stepProb, stepRoll, type DrumPattern, type DrumVoice, type StepEdit } from "../engine/drums";
import type { SynthPatch } from "../engine/params";
import { STUDIO_PPQ, type StudioMidiEvent } from "./types";

/** Project-scoped, immutable-on-write extension; never uses the standalone pattern bank. */
export const STUDIO_DRUM_BANK_KEY = "__studioDrumBank";
export interface TrackDrumBank { selected: number; patterns: DrumPattern[] }
const boundedInt = (x: unknown, min: number, max: number, fallback: number) => typeof x === "number" && Number.isFinite(x) ? Math.max(min, Math.min(max, Math.round(x))) : fallback;
const obj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);
export function sanitizeDrumPattern(raw: unknown): DrumPattern | null {
  if (!obj(raw) || !obj(raw.steps) || (raw.len !== 12 && raw.len !== 16)) return null;
  const p = emptyPattern(raw.len);
  for (const v of DRUM_VOICES) {
    const row = raw.steps[v];
    if (!Array.isArray(row)) return null;
    p.steps[v] = Array.from({length:16}, (_,i)=>boundedInt(row[i],0,3,0));
    for (const [key,min,max,def] of [["roll",1,4,1],["flam",0,1,0],["prob",25,100,100]] as const) {
      const rec = raw[key];
      const values = obj(rec) ? rec[v] : undefined;
      if (!Array.isArray(values)) continue;
      const target = p[key] ?? (p[key] = {});
      target[v] = Array.from({length:16},(_,i)=>key === "prob" ? 25 * Math.round(boundedInt(values[i],min,max,def)/25) : boundedInt(values[i],min,max,def));
    }
  }
  return p;
}
export function createTrackDrumBank(patterns: readonly DrumPattern[] = []): TrackDrumBank {
  return {selected:0,patterns:Array.from({length:8},(_,i)=>sanitizeDrumPattern(patterns[i]) ?? emptyPattern())};
}
export function normalizeTrackDrumBank(raw: unknown): TrackDrumBank | null {
  if (!obj(raw) || !Array.isArray(raw.patterns) || raw.patterns.length !== 8 || !Number.isInteger(raw.selected) || Number(raw.selected)<0 || Number(raw.selected)>7) return null;
  const patterns = raw.patterns.map(sanitizeDrumPattern);
  if (patterns.some(p=>p===null)) return null;
  return {selected:Number(raw.selected),patterns:patterns as DrumPattern[]};
}
export function editTrackDrumStep(pattern: DrumPattern, voice: DrumVoice, index: number, mode: StepEdit): boolean {
  if (!DRUM_VOICES.includes(voice) || !Number.isInteger(index) || index<0 || index>=pattern.len) return false;
  const row=pattern.steps[voice];
  const set=(key:"roll"|"flam"|"prob",value:number,def:number)=>{const rec=pattern[key]??(pattern[key]={});(rec[voice]??(rec[voice]=Array(16).fill(def)))[index]=value;};
  switch(mode){
    case "hit": row[index]=row[index]?0:1;if(!row[index]){set("roll",1,1);set("flam",0,0);set("prob",100,100);}break;
    case "accent": row[index]=row[index]===2?1:2;break;
    case "ghost": row[index]=row[index]===3?1:3;break;
    case "roll": row[index] ||= 1;set("roll",stepRoll(pattern,voice,index)>=4?1:stepRoll(pattern,voice,index)+1,1);break;
    case "flam": row[index] ||= 1;set("flam",stepFlam(pattern,voice,index)?0:1,0);break;
    case "chance": row[index] ||= 1;set("prob",stepProb(pattern,voice,index)<=25?100:stepProb(pattern,voice,index)-25,100);break;
    default:return false;
  }
  return true;
}

/** Bake the original 16th-note groove into a bounded MIDI clip. Probability is
 * resolved once on insertion, so playback, editing and export share the same events.
 * Rolled hits that cross the pattern seam wrap into the clip's first step. */
export function drumPatternMidi(pattern: DrumPattern, patch: SynthPatch, bpm: number, random:()=>number=Math.random): {length:number;events:StudioMidiEvent[]} {
  const stepTicks=STUDIO_PPQ/4, length=pattern.len*stepTicks;
  const swing=Math.max(0,Math.min(.6,Number(patch.drumSwing)||0));
  const accent=Number.isFinite(Number(patch.drumAccent))?Math.max(0,Math.min(1,Number(patch.drumAccent))):.5;
  const grace=Math.max(1,Math.round(.022*Math.max(40,Math.min(240,bpm||110))*STUDIO_PPQ/60));
  const hits=new Map<number,Map<number,number>>();
  for(const v of DRUM_VOICES){
    const row=new Map<number,number>();hits.set(DRUM_NOTES[v],row);
    const add=(tick:number,vel:number)=>{const t=((Math.round(tick)%length)+length)%length;row.set(t,Math.max(row.get(t)??0,vel));};
    for(let i=0;i<pattern.len;i++){
      const state=pattern.steps[v][i];if(!state)continue;
      const probability=stepProb(pattern,v,i);if(probability<100&&random()*100>=probability)continue;
      const at=i*stepTicks+(i%2?swing*stepTicks:0),vel=state===2?1:state===3?.3:1-.5*accent;
      if(stepFlam(pattern,v,i))add(Math.max(0,at-grace),vel*.45);
      const n=stepRoll(pattern,v,i);for(let k=0;k<n;k++)add(at+k*stepTicks/n,k?vel*.82:vel);
    }
  }
  const events:StudioMidiEvent[]=[];
  for(const [midi,row] of hits){const sorted=[...row.entries()].sort((a,b)=>a[0]-b[0]);for(let i=0;i<sorted.length;i++){
    const [tick,velocity]=sorted[i],off=Math.min(length,tick+30,sorted[i+1]?.[0]??length);
    events.push({type:"noteOn",tick,midi,velocity},{type:"noteOff",tick:off,midi});
  }}
  return {length,events:events.sort((a,b)=>a.tick-b.tick||(a.type==="noteOff"?-1:1)-(b.type==="noteOff"?-1:1)||("midi" in a&&"midi" in b?a.midi-b.midi:0))};
}
