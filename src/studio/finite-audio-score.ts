import type {StudioMidiEvent} from "./types";
import {SCORE_STRIDE} from "../engine/worklet/audio-score";

/** Pure finite-arrangement compiler. Unsupported note/controller semantics
 * deliberately remain on the legacy path; never silently drop MIDI data. */
export function compileFiniteScore(events:readonly StudioMidiEvent[],startFrame:number,framesPerTick:number,totalTicks:number,cents:(midi:number)=>number,firstId:number): {data:Float64Array,nextId:number}|null {
  if(!events.length||events.length>8192||!Number.isSafeInteger(startFrame)||startFrame<0||!(framesPerTick>0)||!(totalTicks>0))return null;
  const rows:number[]=[],held=new Map<number,number>();
  let next=firstId,previousTick=0;
  for(const e of events){
    if(e.tick<previousTick||e.tick<0||!Number.isFinite(e.tick))return null;
    previousTick=e.tick;
    if(e.type!=="noteOn"&&e.type!=="noteOff")return null;
    if(!Number.isInteger(e.midi)||e.midi<0||e.midi>127)return null;
    if(e.tick>=totalTicks)continue;
    const frame=startFrame+Math.round(e.tick*framesPerTick);
    if(e.type==="noteOn"){
      if(held.has(e.midi)||next< -2147483647||!Number.isFinite(e.velocity))return null;
      const offset=cents(e.midi);
      if(!Number.isFinite(offset)||Math.abs(offset)>1200)return null;
      const id=next--;held.set(e.midi,id);
      rows.push(frame,1,id,e.midi,offset,Math.max(1/127,Math.min(1,e.velocity)));
    }else{
      const id=held.get(e.midi);
      if(id===undefined)return null;
      rows.push(frame,2,id,e.midi,0,0);held.delete(e.midi);
    }
  }
  const end=startFrame+Math.round(totalTicks*framesPerTick);
  for(const [midi,id] of held)rows.push(end,2,id,midi,0,0);
  if(!rows.length||rows.length/SCORE_STRIDE>8192)return null;
  return {data:new Float64Array(rows),nextId:next};
}
