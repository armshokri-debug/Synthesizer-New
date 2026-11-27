import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
const reference = "23a22f1c8e1c8ede28f54268c2f7e74f7baada7a";
const transpiler = new Bun.Transpiler({loader:"ts"});
function instantiate(source:string, rate:number) {
  const js=transpiler.transformSync(source);
  const Base=class {port={onmessage:null,postMessage:()=>{}}};
  let ctor:any;
  new Function("sampleRate","AudioWorkletProcessor","registerProcessor","currentTime",js)(rate,Base,(_name:string,c:any)=>ctor=c,0);
  assert(ctor);
  return new ctor();
}
for(const name of ["fm","vector"]){
 const path="src/engine/worklet/"+name+"-processor.ts";
 const before=execFileSync("git",["show",reference+":"+path],{encoding:"utf8"});
 const after=readFileSync(path,"utf8");
 for(const rate of [44100,48000,96000]){
  const a=instantiate(before,rate),b=instantiate(after,rate);
  const send=(m:any)=>{a.port.onmessage({data:m});b.port.onmessage({data:m});};
  let peak=0;
  for(let block=0;block<180;block++){
   if(block===0)for(let i=0;i<8;i++)send({t:"on",id:i+1,midi:48+i*3,vel:.7,at:0});
   if(block===20)send({t:"mod",v:.7});
   if(block===40)send({t:"bend",v:.3});
   if(block===60)send({t:"glide",id:1,midi:62,cents:15,glide:.08,at:0});
   if(block===80)for(let i=0;i<8;i++)send({t:"on",id:i+9,midi:60+i,vel:.8,at:64/rate});
   if(block===100)send({t:"kill",id:9,at:48/rate});
   if(block===110)send({t:"off",id:10,at:32/rate});
   if(block===130)send({t:"alloff"});
   const x=[new Float32Array(128),new Float32Array(128)],y=[new Float32Array(128),new Float32Array(128)];
   a.process([], [x]);b.process([], [y]);
   for(let c=0;c<2;c++)for(let i=0;i<128;i++){
    assert(Number.isFinite(x[c][i]));
    assert(Object.is(x[c][i],y[c][i]),name+" PCM mismatch at "+rate+" block "+block+" sample "+i);
    peak=Math.max(peak,Math.abs(x[c][i]));
   }
  }
  assert(peak>0.001,name+" rendered silence");
  console.log("PASS bit-exact "+name+" PCM at "+rate+" Hz (180 blocks)");
 }
}
