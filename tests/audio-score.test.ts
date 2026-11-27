import {describe,expect,test} from "bun:test";
import {AudioScore} from "../src/engine/worklet/audio-score";
const notes=()=>new Float64Array([130,1,-1,60,0,.8,256,2,-1,60,0,0,260,1,-2,64,0,.7,400,2,-2,64,0,0]);
describe("audio-clock score",()=>{
 test("exact offsets at quantum boundaries without a host timer",()=>{
  const q=new AudioScore(),out:number[][]=[];
  expect(q.load(1,notes(),0)).toBe(true);
  for(let f=0;f<512;f+=128)q.drain(f,128,(type,id,_m,_c,_v,off)=>out.push([f+off,type,id,off]));
  expect(out).toEqual([[130,1,-1,2],[256,2,-1,0],[260,1,-2,4],[400,2,-2,16]]);
 });
 test("reject malformed, stale, unsorted and unbalanced scores atomically",()=>{
  const q=new AudioScore();
  expect(q.load(1,new Float64Array([1,1,-1,60,0,.8]),0)).toBe(false);
  expect(q.load(1,notes(),131)).toBe(false);
  expect(q.load(1,notes(),0)).toBe(true);
  expect(q.load(2,notes(),0)).toBe(false);
  expect(q.cancel(2)).toBe(false);
  expect(q.cancel(1)).toBe(true);
  expect(q.load(1,notes(),0)).toBe(false);
  expect(q.load(2,notes(),0)).toBe(true);
 });
 test("cancel suppresses future events; late attacks are not burst-fired",()=>{
  const q=new AudioScore(),out:number[]=[];
  q.load(1,notes(),0);
  q.drain(256,128,(type)=>out.push(type));
  expect(out).toEqual([2,1]);expect(q.missedAttacks).toBe(1);
  q.cancel(1);q.drain(384,128,(type)=>out.push(type));expect(out).toEqual([2,1]);
 });
});
