import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {CdpClient,sleep,waitForCdp} from "./studio-cdp.mjs";
const port=9288,profile=mkdtempSync(join(tmpdir(),"sy1-finite-"));
const chrome=spawn(process.env.SY1_CHROME_BIN||"/usr/bin/chromium",["--user-data-dir="+profile,"--headless","--no-sandbox","--disable-gpu","--disable-dev-shm-usage","--autoplay-policy=no-user-gesture-required","--remote-debugging-port="+port,"about:blank"],{stdio:"ignore"});
let cdp;
try{
 cdp=new CdpClient(await waitForCdp(port));await cdp.connect();await cdp.send("Page.enable");
 await cdp.send("Page.navigate",{url:process.env.SY1_URL||"http://127.0.0.1:4178/"});
 for(let i=0;i<150;i++){if(await cdp.evaluate("!!window.SY1_STUDIO"))break;await sleep(50);}
 const report=await cdp.evaluate(`(async()=>{
  await SY1_STUDIO.ready;SY1_STUDIO.open();
  const e=SY1_STUDIO.engine;e.setLoopEnabled(false);e.setBars(4);e.setBpm(120);
  const [a,b]=e.getTracks();
  e.setTrackMachinePreset(a.id,"sy1","init");e.setTrackMachinePreset(b.id,"sy1","init");
  for(const t of [a,b]){
    t.setParam("polyMode","poly");t.setParam("hold","off");
    t.setParam("aA",.002);t.setParam("aR",.005);t.setParam("aD",.03);t.setParam("aS",.8);
    t.setParam("revMix",0);t.setParam("delayMix",0);
    const events=[];for(let i=0;i<12;i++){events.push({type:"noteOn",tick:i*120,midi:60+i%3,velocity:.7},{type:"noteOff",tick:i*120+48,midi:60+i%3});}
    t.setEvents(events);
  }
  const ctx=await e.ensureAudio();await ctx.resume();
  const source="class Probe extends AudioWorkletProcessor{process(inputs){let peak=0;for(const c of inputs[0])for(const x of c)peak=Math.max(peak,Math.abs(x));this.port.postMessage({frame:currentFrame,peak});return true;}}registerProcessor('finite-pcm-probe',Probe);";
  const url=URL.createObjectURL(new Blob([source],{type:"text/javascript"}));await ctx.audioWorklet.addModule(url);URL.revokeObjectURL(url);
  const probe=new AudioWorkletNode(ctx,"finite-pcm-probe",{numberOfInputs:1,numberOfOutputs:1,outputChannelCount:[1]});
  const sink=ctx.createGain();sink.gain.value=0;const bus=e.getMasterBus();bus.tap.connect(probe);probe.connect(sink);sink.connect(ctx.destination);
  const records=[];probe.port.onmessage=ev=>records.push(ev.data);
  const delay=ms=>new Promise(r=>setTimeout(r,ms));
  try{
    e.setFiniteScoreExperiment(true);await e.play();
    const initial=e.getFiniteScoreTrackIds();
    const anchor=e.anchorAudioTime,rate=ctx.sampleRate;
    const wall=performance.now();while(performance.now()-wall<1000){}
    await delay(100);
    const peak=(start,end)=>records.filter(x=>x.frame/rate>=start&&x.frame/rate<end).reduce((m,x)=>Math.max(m,x.peak),0);
    const windows=Array.from({length:5},(_,i)=>peak(anchor+(i+1)*.125+.005,anchor+(i+1)*.125+.04));
    e.regions.select(b.getRegions(e.getTotalTicks())[0].id);
    e.replaceTrackNotes(b.id,[{midi:67,startTick:1440,endTick:1560,velocity:.7}]);
    const afterEdit=e.getFiniteScoreTrackIds();
    await e.stop();return {initial,afterEdit,afterStop:e.getFiniteScoreTrackIds(),windows,playing:e.isPlaying(),a:a.id,b:b.id};
  }finally{await e.stop();bus.tap.disconnect(probe);probe.disconnect();sink.disconnect();}
 })()`);
 assert.deepEqual(report.initial,[report.a,report.b],JSON.stringify(report));
 assert(report.windows.every(p=>p>.002),JSON.stringify(report));
 assert.deepEqual(report.afterEdit,[report.a]);
 assert.deepEqual(report.afterStop,[]);assert.equal(report.playing,false);
 console.log("PASS FINITE_STUDIO_SCORE_STALL_AND_TRACK_ISOLATION",JSON.stringify(report));
}finally{cdp?.close();chrome.kill();chrome.once("exit",()=>{try{rmSync(profile,{recursive:true,force:true});}catch{}});}
