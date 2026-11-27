import {describe,test,expect} from "bun:test";
import {maxDrumWindowHits} from "../src/studio/drum-window-density";
describe("bounded drum lookahead density",()=>{
 test("long arrangements do not consume the window budget",()=>{
   const hits=Array.from({length:1024},(_,i)=>i*120);
   expect(maxDrumWindowHits(hits,1440)).toBe(12);
   expect(maxDrumWindowHits(hits,1440,122880)).toBe(12);
 });
 test("counts seam clusters and complete cycles",()=>{
   const hits=[0,5,990,995];
   expect(maxDrumWindowHits(hits,20,1000)).toBe(4);
   expect(maxDrumWindowHits(hits,1000,1000)).toBe(4);
   expect(maxDrumWindowHits(hits,1020,1000)).toBe(8);
   expect(maxDrumWindowHits(hits,20)).toBe(2);
 });
 test("rejectable dense patterns are counted, not silently truncated",()=>{
   expect(maxDrumWindowHits(Array.from({length:161},()=>0),10,1920)).toBe(161);
 });
});
