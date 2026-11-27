// Exercise the actual HQ processor while the page's main thread cannot run.
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {CdpClient,sleep,waitForCdp} from "./studio-cdp.mjs";
const port=9287,profile=mkdtempSync(join(tmpdir(),"sy1-score-"));
const chrome=spawn(process.env.SY1_CHROME_BIN||"/usr/bin/chromium",["--user-data-dir="+profile,"--headless","--no-sandbox","--disable-gpu","--disable-dev-shm-usage","--autoplay-policy=no-user-gesture-required","--remote-debugging-port="+port,"about:blank"],{stdio:"ignore"});
let cdp;
try{
 cdp=new CdpClient(await waitForCdp(port));await cdp.connect();
 await cdp.send("Page.enable");await cdp.send("Page.navigate",{url:process.env.SY1_URL||"http://127.0.0.1:4178/"});
 for(let i=0;i<150;i++){if(await cdp.evaluate("!!window.SY1_STUDIO"))break;await sleep(50);}
 const report=await cdp.evaluate(`(async()=>{
  await SY1_STUDIO.ready;SY1_STUDIO.open();
  const e=SY1_STUDIO.engine,ctx=await e.ensureAudio();await ctx.resume();
  const delay=ms=>new Promise(r=>setTimeout(r,ms));
  const node=new AudioWorkletNode(ctx,"sy1-voices",{numberOfInputs:0,numberOfOutputs:1,outputChannelCount:[2]});
  node.port.postMessage({t:"patch",patch:{...e.getFocusedTrack().patch,aA:.002,aD:.03,aS:.8,aR:.005,cutoff:6000,unison:1}});
  const source="class Probe extends AudioWorkletProcessor{process(inputs){let peak=0;for(const c of inputs[0])for(const x of c)peak=Math.max(peak,Math.abs(x));this.port.postMessage({frame:currentFrame,peak});return true;}}registerProcessor('score-pcm-probe',Probe);";
  const url=URL.createObjectURL(new Blob([source],{type:"text/javascript"}));await ctx.audioWorklet.addModule(url);URL.revokeObjectURL(url);
  const probe=new AudioWorkletNode(ctx,"score-pcm-probe",{numberOfInputs:1,numberOfOutputs:1,outputChannelCount:[1]});
  const sink=ctx.createGain();sink.gain.value=0;node.connect(probe);probe.connect(sink);sink.connect(ctx.destination);
  const records=[];probe.port.onmessage=ev=>records.push(ev.data);
  try{
   const rate=ctx.sampleRate,start=Math.ceil((ctx.currentTime+.25)*rate),frames=[];
   const rows=[];
   for(let i=0;i<5;i++){const at=start+Math.round((.05+i*.13)*rate);frames.push(at);rows.push(at,1,-i-1,60+i,0,.8,at+Math.round(.045*rate),2,-i-1,60+i,0,0);}
   const ready=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error("score load timeout")),2000);node.port.onmessage=ev=>{if(ev.data.t==="score-ready"){clearTimeout(timer);resolve(ev.data.accepted);}};});
   node.port.postMessage({t:"score-load",generation:1,data:new Float64Array(rows)});
   if(!await ready)throw Error("score rejected");
   const stallFrom=ctx.currentTime,wall=performance.now();
   while(performance.now()-wall<1000){}
   const stallTo=ctx.currentTime;
   await delay(200);
   const peak=(a,b)=>records.filter(x=>x.frame>=a&&x.frame<b).reduce((m,x)=>Math.max(m,x.peak),0);
   const windows=frames.map(f=>({frame:f,peak:peak(f+128,f+.04*rate),before:peak(f-.03*rate,f-128)}));
   return {rate,stallFrom,stallTo,frames,windows,blocks:records.length};
  }finally{node.port.postMessage({t:"score-cancel",generation:1});node.disconnect();probe.disconnect();sink.disconnect();}
 })()`);
 assert(report.stallTo-report.stallFrom>.7,JSON.stringify(report));
 assert(report.frames.every(f=>f/report.rate>report.stallFrom&&f/report.rate<report.stallTo),JSON.stringify(report));
 assert(report.windows.every(x=>x.peak>.005&&x.before<.002),JSON.stringify(report));
 console.log("PASS AUDIO_CLOCK_SCORE_MAIN_THREAD_STALL",JSON.stringify(report));
}finally{cdp?.close();chrome.kill();chrome.once("exit",()=>{try{rmSync(profile,{recursive:true,force:true});}catch{}});}
