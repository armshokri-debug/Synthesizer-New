import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import assert from "node:assert/strict";
const reference = "23a22f1c8e1c8ede28f54268c2f7e74f7baada7a";
const transpiler = new Bun.Transpiler({loader:"ts"});
function instantiate(source:string, rate:number) {
  const js=transpiler.transformSync(source).replace(/^\s*export\s*\{\s*\}\s*;?\s*$/gm,"");
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

 // Compare portable DSP classes against the exact parent sources. Keep the
 // reference beside the real source so its relative analog import is identical.
for(const [file,klass] of [["hq-engine","HQEngine"],["analog-engine","AnalogEngine"]]){
 const path="src/dsp/"+file+".ts";
 const temporary="src/dsp/."+file+"-parity-reference.ts";
 writeFileSync(temporary,execFileSync("git",["show","da1379322d5394f1d8551ec09f983714bc2461d7:"+path],{encoding:"utf8"}),{flag:"wx"});
 try{
  const A=(await import("../"+temporary))[klass];
  const B=(await import("../"+path))[klass];
  for(const rate of [44100,48000,96000]){
   for(const mode of ["stable","modulated","ladder"]){
    const a=new A(rate),b=new B(rate);
    const both=(method:string,...args:any[])=>{a[method](...args);b[method](...args);};
    both("setParam","unison",3);
    both("setParam","keyTrack",.35);
    both("setParam","lfoTarget",mode==="modulated"?"pitch":"filter");
    both("setParam","lfoDepth",.3);
    if(mode==="ladder")both("setParam","filterType","ladder");
    both("snapParams");
    let peak=0;
    for(let block=0;block<220;block++){
     if(block===0)for(let i=0;i<8;i++)both("noteOn",i+1,48+i*3,0,.7,i*3,0,0);
     if(block===50)both("setBend",.3);
     if(block===70)both("glideTo",1,65,12,.08);
     if(block===100)both("setMod",.6);
     if(block===130)both("setParam","cutoff",800);
     if(block===160)for(let i=1;i<=8;i++)both("noteOff",i,i*2,i%2===0);
     const x=[new Float32Array(128),new Float32Array(128)],y=[new Float32Array(128),new Float32Array(128)];
     a.render(x[0],x[1],128);b.render(y[0],y[1],128);
     for(let c=0;c<2;c++)for(let i=0;i<128;i++){
      assert(Number.isFinite(x[c][i]));
      assert(Object.is(x[c][i],y[c][i]),file+" "+mode+" PCM mismatch "+rate+" block "+block+" sample "+i);
      peak=Math.max(peak,Math.abs(x[c][i]));
     }
    }
    assert(peak>.001,file+" rendered silence");
    console.log("PASS bit-exact "+file+" "+mode+" PCM at "+rate+" Hz");
   }
  }
 }finally{unlinkSync(temporary);}
}
