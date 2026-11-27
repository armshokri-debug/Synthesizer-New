/**
 * Continuous arrangement editor, reimplemented from the V10 bundle's
 * patch10.py behavior. The original per-region source editor remains available.
 * No audio scheduling, DOM or storage dependencies.
 */
import {extractNoteSpans} from "./midi-io";
import {noteEvents,regionId,regionPlayback,type MidiRegion} from "./midi-regions";
import {STUDIO_TICKS_PER_BAR,type StudioNoteSpan} from "./types";

type Entry={region:MidiRegion;note:StudioNoteSpan;visible:StudioNoteSpan|null};
const key=(n:StudioNoteSpan)=>[n.midi,n.startTick,n.endTick,n.velocity].join(":");
const compare=(a:StudioNoteSpan,b:StudioNoteSpan)=>a.startTick-b.startTick||a.midi-b.midi||a.endTick-b.endTick||a.velocity-b.velocity;

function entries(regions:readonly MidiRegion[],total:number):Entry[]{
  return regions.flatMap(region=>extractNoteSpans(regionPlayback(region),region.length)
    .map(n=>{
      const note={...n,startTick:region.startTick+n.startTick,endTick:region.startTick+Math.min(region.length,n.endTick)};
      return {region,note,visible:note.startTick<total&&note.endTick>note.startTick?{...note,endTick:Math.min(total,note.endTick)}:null};
    }).filter(e=>e.note.endTick>e.note.startTick))
    .sort((a,b)=>compare(a.note,b.note));
}

export function trackEditorNotes(regions:readonly MidiRegion[],total:number):StudioNoteSpan[]{
  return entries(regions,total).flatMap(e=>e.visible?[e.visible]:[]).sort(compare);
}

/** Exact multiset diff of the visible notes. Unmodified regions keep identity,
 * source, offsets, loops and controllers; modified regions materialize their
 * audible content. Undo can restore their complete original source. */
export function editTrackRegions(regions:readonly MidiRegion[],next:readonly StudioNoteSpan[],total:number,trackId:string,activeId?:string):MidiRegion[]{
  const all=[...regions],old=new Map<string,Entry[]>(),kept=new Map<string,StudioNoteSpan[]>(),dirty=new Set<string>();
  for(const r of regions)kept.set(r.id,[]);
  for(const e of entries(regions,total)){
    if(!e.visible){kept.get(e.region.id)!.push(e.note);continue;}
    const k=key(e.visible),q=old.get(k)??[];q.push(e);old.set(k,q);
  }
  const additions:StudioNoteSpan[]=[];
  for(const raw of next){
    if(![raw.startTick,raw.endTick,raw.midi,raw.velocity].every(Number.isFinite))throw Error("Invalid MIDI note.");
    const n={midi:Math.max(0,Math.min(127,Math.round(raw.midi))),startTick:Math.round(raw.startTick),endTick:Math.min(total,Math.round(raw.endTick)),velocity:Math.max(1/127,Math.min(1,raw.velocity))};
    if(n.startTick<0||n.startTick>=total||n.endTick<=n.startTick)throw Error("Note is outside the song.");
    // Match before normalization as well, so exact existing sub-MIDI velocities
    // (including imported zero-velocity data) aren't accidentally rewritten.
    const q=old.get(key(raw))??old.get(key(n));
    if(q?.length){const e=q.shift()!;kept.get(e.region.id)!.push(e.note);}
    else additions.push(n);
  }
  for(const q of old.values())for(const e of q)dirty.add(e.region.id);
  for(const n of additions.sort(compare)){
    const candidates=all.filter(r=>n.startTick>=r.startTick&&n.startTick<r.startTick+r.length);
    let r=candidates.find(r=>r.id===activeId)??candidates.sort((a,b)=>b.startTick-a.startTick)[0];
    if(!r){
      const left=Math.max(0,Math.floor(n.startTick/STUDIO_TICKS_PER_BAR)*STUDIO_TICKS_PER_BAR,...all.filter(r=>r.startTick+r.length<=n.startTick).map(r=>r.startTick+r.length));
      const right=Math.min(total,Math.max(left+1,Math.ceil(n.endTick/STUDIO_TICKS_PER_BAR)*STUDIO_TICKS_PER_BAR),...all.filter(r=>r.startTick>n.startTick).map(r=>r.startTick));
      r={id:regionId(),trackId,startTick:left,length:right-left,sourceLength:right-left,offset:0,loop:false,events:[]};
      all.push(r);kept.set(r.id,[]);
    }
    const endTick=Math.min(n.endTick,r.startTick+r.length);
    if(endTick<=n.startTick)throw Error("Note is outside the destination region.");
    kept.get(r.id)!.push({...n,endTick});dirty.add(r.id);
  }
  if(!dirty.size)return [...regions];
  return all.map(r=>{
    if(!dirty.has(r.id))return r;
    const notes=kept.get(r.id)!.map(n=>({...n,startTick:n.startTick-r.startTick,endTick:n.endTick-r.startTick})).sort(compare);
    const controls=regionPlayback(r).filter(e=>e.type==="cc"||e.type==="pitchBend");
    return {...r,loop:false,offset:0,sourceLength:r.length,events:[...controls,...noteEvents(notes)]};
  }).sort((a,b)=>a.startTick-b.startTick);
}
