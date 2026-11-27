import {describe,test,expect} from "bun:test";
import {editTrackRegions,trackEditorNotes} from "../src/studio/track-midi-editor";
import {noteEvents,type MidiRegion} from "../src/studio/midi-regions";
import {createStudioEngine} from "../src/studio/studio-engine";
const bar=1920;
const region=(id:string,startTick:number,loop=false):MidiRegion=>({id,trackId:"track-1",startTick,length:loop?bar*2:bar,sourceLength:bar,offset:0,loop,events:[...noteEvents([{midi:60,startTick:0,endTick:240,velocity:.8}]),{type:"cc",tick:120,cc:1,value:64}]});
describe("continuous track MIDI",()=>{
 test("materializes absolute notes from all regions and repeated loop content",()=>{
   const a=region("a",bar),b=region("b",bar*3,true);
   const spans=trackEditorNotes([a,b],bar*8);
   expect(spans.map(n=>n.startTick)).toEqual([bar,bar*3,bar*4]);
   const same=editTrackRegions([a,b],spans,bar*8,a.trackId);
   expect(same[0]).toBe(a);expect(same[1]).toBe(b);
 });
 test("edits one occurrence without changing any other region or controllers",()=>{
   const a=region("a",0),b=region("b",bar,true);
   const spans=trackEditorNotes([a,b],bar*8);
   spans[2]={...spans[2],midi:64};
   const after=editTrackRegions([a,b],spans,bar*8,a.trackId);
   expect(after[0]).toBe(a);expect(after[1].id).toBe(b.id);expect(after[1].loop).toBe(false);
   expect(trackEditorNotes(after,bar*8).map(n=>[n.startTick,n.midi])).toEqual([[0,60],[bar,60],[bar*2,64]]);
   expect(after[1].events.filter(e=>e.type==="cc").map(e=>e.tick)).toEqual([120,bar+120]);
 });
 test("moves between regions and creates a region in empty space without overwriting neighbors",()=>{
   const a=region("a",0),b=region("b",bar*3);
   const spans=trackEditorNotes([a,b],bar*8);
   const next=[{...spans[0],startTick:bar,endTick:bar+240},spans[1]];
   const result=editTrackRegions([a,b],next,bar*8,a.trackId);
   expect(result.length).toBe(3);expect(result[2]).toBe(b);
   expect(result[1].startTick).toBe(bar);expect(trackEditorNotes(result,bar*8)).toEqual(next);
 });
 test("whole-track edits are one undo operation and retain the original source editor",()=>{
   const e=createStudioEngine({isolatedTempo:true}),t=e.getTracks()[0];
   const a={...region("a",0),trackId:t.id},b={...region("b",bar*2,true),trackId:t.id};
   t.setRegions([a,b]);e.regions.select(b.id);
   expect(e.regions.editorLength(t.id)).toBe(bar);
   const notes=e.regions.wholeTrackNotes(t.id);
   e.replaceTrackNotes(t.id,notes.map((n,i)=>i===2?{...n,midi:67}:n),true);
   expect(e.regions.wholeTrackNotes(t.id)[2].midi).toBe(67);
   e.regions.undo();expect(e.regions.regions(t.id)).toEqual([a,b]);e.dispose();
 });
});
