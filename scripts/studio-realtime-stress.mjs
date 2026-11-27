// Four-track realtime PCM diagnostic, not an offline DSP timing proxy.
// Report actual deadline misses and pre-clip peaks, without inferring device CPU load.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CdpClient, sleep, waitForCdp } from "./studio-cdp.mjs";
const port=9286, profile=mkdtempSync(join(tmpdir(),"sy1-stress-"));
const chrome=spawn(process.env.SY1_CHROME_BIN||"/usr/bin/chromium",[
 "--user-data-dir="+profile,"--headless","--no-sandbox","--disable-gpu","--disable-dev-shm-usage",
 "--autoplay-policy=no-user-gesture-required","--remote-debugging-port="+port,"about:blank"
],{stdio:"ignore"});
let cdp;
try {
 cdp=new CdpClient(await waitForCdp(port));await cdp.connect();
 await cdp.send("Page.enable");
 await cdp.send("Page.navigate",{url:process.env.SY1_URL||"http://127.0.0.1:4178/"});
 for(let i=0;i<150;i++){if(await cdp.evaluate("!!window.SY1_STUDIO"))break;await sleep(50);}
 const report=await cdp.evaluate(`(async()=>{
   await SY1_STUDIO.ready; SY1_STUDIO.open();
   const e=SY1_STUDIO.engine;
   while(e.getTracks().length<4){if(!e.addTrack())throw Error("Cannot create four tracks");}
   e.setBars(32);e.setBpm(110);e.setLoopEnabled(false);
   e.setRecordingSettings({metronome:false,countIn:false});
   const [drum,pad,arp,ambient]=e.getTracks();
   e.setTrackMachine(drum.id,"bushehr");
   e.setTrackMachinePreset(pad.id,"sy1","warmPad");
   e.setTrackMachinePreset(arp.id,"baku","nightDrive");
   e.setTrackMachinePreset(ambient.id,"yazd","dawnGlass");
   const BAR=e.getTotalTicks()/32;
   // Build dense 32-bar arrangements without exercising import or UI in the timing loop.
   const phrase=e.getTracks().slice(1);
   for(let i=0;i<32;i++){
     e.insertDrumPattern(drum.id,i*BAR);
   }
   for(const t of phrase){
     const events=[];
     for(let i=0;i<32;i++){
       const start=i*BAR;
       if(t===arp){
         for(let j=0;j<16;j++){const at=start+j*BAR/16;events.push({type:"noteOn",tick:at,midi:48+j%4*3,velocity:.65},{type:"noteOff",tick:at+BAR/32,midi:48+j%4*3});}
       }else{
         for(const m of [48,55,60,64])events.push({type:"noteOn",tick:start,midi:m,velocity:.65},{type:"noteOff",tick:start+BAR-1,midi:m});
       }
     }
     t.setEvents(events);
   }
   const ctx=await e.ensureAudio();await ctx.resume();
   const bus=e.getMasterBus();
   const source="class Probe extends AudioWorkletProcessor { constructor(){super();this.n=0;this.peak=0;this.squares=0;this.samples=0;this.over=0;this.invalid=0;} process(inputs){const a=inputs[0];for(const c of a)for(const x of c){if(!Number.isFinite(x)){this.invalid++;continue;}const p=Math.abs(x);this.peak=Math.max(this.peak,p);this.squares+=x*x;this.samples++;if(p>.98)this.over++;}if(++this.n>=16){this.port.postMessage({frame:currentFrame,peak:this.peak,rms:Math.sqrt(this.squares/Math.max(1,this.samples)),over:this.over,samples:this.samples,invalid:this.invalid});this.n=0;this.peak=this.squares=this.samples=this.over=this.invalid=0;}return true;} } registerProcessor('sy1-stress-probe',Probe);";
   const url=URL.createObjectURL(new Blob([source],{type:"text/javascript"}));
   await ctx.audioWorklet.addModule(url);URL.revokeObjectURL(url);
   const inputs=[bus.sum,bus.tap], records=[[],[]], probes=[];
   const sink=ctx.createGain();sink.gain.value=0;sink.connect(ctx.destination);
   for(let i=0;i<inputs.length;i++){
     const probe=new AudioWorkletNode(ctx,"sy1-stress-probe",{numberOfInputs:1,numberOfOutputs:1,outputChannelCount:[1]});
     probe.port.onmessage=ev=>records[i].push(ev.data);
     inputs[i].connect(probe);probe.connect(sink);probes.push(probe);
   }
   const delay=ms=>new Promise(r=>setTimeout(r,ms));
   const stats=()=>e.getSchedulerDiagnostics();
   const summarize=(arr,start,end)=>{const a=arr.filter(x=>x.frame/ctx.sampleRate>=start&&x.frame/ctx.sampleRate<end);return {blocks:a.length,peak:Math.max(0,...a.map(x=>x.peak)),silentBlocks:a.filter(x=>x.rms<.00001).length,overSamples:a.reduce((s,x)=>s+x.over,0),samples:a.reduce((s,x)=>s+x.samples,0),invalid:a.reduce((s,x)=>s+x.invalid,0)};};
   try{
     e.resetSchedulerDiagnostics();await e.play();await delay(1400);
     const start=ctx.currentTime;
     await delay(1600);
     const end=ctx.currentTime,normal=stats();
     // Force exactly one controlled UI stall to distinguish scheduler starvation
     // from signal clipping. No edits or network operations during this probe.
     const stallStart=ctx.currentTime, wall=performance.now();
     while(performance.now()-wall<480){}
     await delay(700);
     const stallEnd=ctx.currentTime;
     return {rate:ctx.sampleRate,tracks:e.getTracks().map(t=>({machine:t.machineId,state:t.getAudioState(),events:t.events.length})),normal,afterStall:stats(),normalPCM:records.map(a=>summarize(a,start,end)),stallPCM:records.map(a=>summarize(a,stallStart,stallEnd)),normalAudioSeconds:end-start};
   }finally{
     await e.stop();
     probes.forEach((p,i)=>{p.port.onmessage=null;inputs[i].disconnect(p);p.disconnect();});
     sink.disconnect();
   }
 })()`);
 assert.equal(report.tracks.length,4);
 assert(report.tracks.every(t=>t.events>0),JSON.stringify(report));
 assert(report.normalPCM.every(x=>x.blocks>0&&x.peak>.001&&x.invalid===0),JSON.stringify(report));
 assert(report.stallPCM.every(x=>x.blocks>0&&x.invalid===0),JSON.stringify(report));
 assert(report.normalPCM[1].peak<=1.00001,JSON.stringify(report));
 // Forced stall is an intentionally failing real-world deadline scenario.
 // Report underruns and PCM, not a claim of gap-free audio on a physical device.
 console.log("FOUR_TRACK_REALTIME_DIAGNOSTIC",JSON.stringify(report));
} finally {
 cdp?.close();chrome.kill();chrome.once("exit",()=>{try{rmSync(profile,{recursive:true,force:true});}catch{}});
}
