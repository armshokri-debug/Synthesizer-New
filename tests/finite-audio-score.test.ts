import {describe,expect,test} from "bun:test";
import {compileFiniteScore} from "../src/studio/finite-audio-score";
import {AudioScore} from "../src/engine/worklet/audio-score";
describe("finite arrangement score",()=>{
 const events=[{type:"noteOn" as const,tick:0,midi:60,velocity:.8},{type:"noteOff" as const,tick:480,midi:60}];
 test("absolute frames, tuning, reserved identities and end clipping",()=>{
   const s=compileFiniteScore(events,1000,10,240,()=>25,-4)!;
   expect([...s.data]).toEqual([1000,1,-4,60,25,.8,3400,2,-4,60,0,0]);
   expect(s.nextId).toBe(-5);
 });
 test("unsupported controller and overlapping-note semantics fall back",()=>{
   expect(compileFiniteScore([...events,{type:"cc",tick:500,cc:64,value:127}],0,10,960,()=>0,-1)).toBeNull();
   expect(compileFiniteScore([events[0],{...events[0],tick:2},events[1]],0,10,960,()=>0,-1)).toBeNull();
 });
 test("prepared score cannot sound until armed; cancellation prevents stale start",()=>{
   const q=new AudioScore(),s=compileFiniteScore(events,1000,10,960,()=>0,-1)!;
   const out:number[]=[];
   expect(q.load(1,s.data,0,false)).toBe(true);
   q.drain(1000,128,t=>out.push(t));expect(out).toEqual([]);
   expect(q.cancel(1)).toBe(true);expect(q.arm(1)).toBe(false);
   expect(q.load(2,s.data,0,false)).toBe(true);expect(q.arm(2)).toBe(true);
   q.drain(1000,128,t=>out.push(t));expect(out).toEqual([1]);
 });
});
