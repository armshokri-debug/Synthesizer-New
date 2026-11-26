// Measure rendered PCM blocks, not only scheduler dispatch records.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CdpClient, sleep, waitForCdp } from "./studio-cdp.mjs";
const port=9283,profile=mkdtempSync(join(tmpdir(),"sy1-pcm-"));
const chrome=spawn(process.env.SY1_CHROME_BIN||"/usr/bin/chromium",[
  "--user-data-dir="+profile,"--headless","--no-sandbox","--disable-gpu","--disable-dev-shm-usage","--enable-logging","--autoplay-policy=no-user-gesture-required",
  "--remote-debugging-port="+port,"about:blank"],{stdio:"ignore"});
const mode=process.argv[2]||"preview";
assert(["preview","arrangement","record"].includes(mode));
let cdp;
try {
  cdp=new CdpClient(await waitForCdp(port));await cdp.connect();
  await cdp.send("Page.enable");
  await cdp.send("Page.navigate",{url:process.env.SY1_URL||"http://127.0.0.1:4178/"});
  for(let i=0;i<150;i++){if(await cdp.evaluate("!!window.SY1_STUDIO"))break;await sleep(50);}
  const report=await cdp.evaluate(`(async()=>{
    await SY1_STUDIO.ready;SY1_STUDIO.open();
    const e=SY1_STUDIO.engine,t=e.getFocusedTrack(),mode=${JSON.stringify(mode)};
    e.setBpm(120);e.setTrackMachine(t.id,"kerman");
    e.setLoopEnabled(false);e.setTrackArmed(t.id,true);e.setRecordingSettings({countIn:mode==="record",metronome:false});
    t.setParam("drumSwing",0);t.setParam("revMix",0);t.setParam("delayMix",0);t.setParam("kickSend",0);
    const bank=t.getTrackDrumBank(),p=bank.patterns[bank.selected];
    for(const row of Object.values(p.steps))row.fill(0);
    p.len=16;p.steps.kick[4]=1;t.setTrackDrumBank(bank);
    const ctx=await e.ensureAudio();await ctx.resume();
    const url=URL.createObjectURL(new Blob([
      "class Probe extends AudioWorkletProcessor { process(inputs){const a=inputs[0];let peak=0;for(const c of a)for(const x of c)peak=Math.max(peak,Math.abs(x));this.port.postMessage({frame:currentFrame,peak});return true;} } registerProcessor('daw-pcm-probe',Probe);"
    ],{type:"text/javascript"}));
    await ctx.audioWorklet.addModule(url);URL.revokeObjectURL(url);
    const probe=new AudioWorkletNode(ctx,"daw-pcm-probe",{numberOfInputs:1,numberOfOutputs:1,outputChannelCount:[1]});
    const sink=ctx.createGain();sink.gain.value=0;
    const blocks=[];probe.port.onmessage=ev=>blocks.push(ev.data);
    e.getMasterBus().tap.connect(probe);probe.connect(sink);sink.connect(ctx.destination);
    const hits=[];e.setDispatchObserver(h=>{if(h.trackId===t.id&&h.event.type==="noteOn")hits.push(h);});
    const until=async predicate=>{const end=performance.now()+4000;while(!predicate()){if(performance.now()>end)throw Error("Audio measurement timeout");await new Promise(r=>setTimeout(r,4));}};
    try {
      await until(()=>blocks.length>10);
      if(mode==="preview")e.startDrumPreview(t.id);
      else if(mode==="arrangement"){e.insertDrumPattern(t.id,0);await e.play();}
      else {
        // Exercise the actual selected-instrument Record button, not a test-only
        // engine call; another track remains armed to expose wrong routing.
        const other=e.getTracks().find(x=>x.id!==t.id);
        if(other){e.setTrackArmed(t.id,false);e.setTrackArmed(other.id,true);}
        document.getElementById("st-tab-instrument").click();
        document.getElementById("sr-record").click();
        await until(()=>e.getTransportSnapshot().playing&&e.getTransportSnapshot().recording);
      }
      await until(()=>hits.length>=1);
      const oldAt=hits[0].audioTime,changedAt=ctx.currentTime;
      if(oldAt-changedAt<.04)throw Error("Test did not reach pending event before audio onset");
      e.setBpm(60);
      await until(()=>hits.length>=2);
      const newAt=hits[1].audioTime;
      await until(()=>ctx.currentTime>newAt+.18);
      await new Promise(r=>setTimeout(r,40));
      const rate=ctx.sampleRate;
      const peak=(a,b)=>blocks.filter(x=>x.frame/rate>=a&&x.frame/rate<b).reduce((m,x)=>Math.max(m,x.peak),0);
      const silentPeak=peak(oldAt-.01,newAt-.012),soundedPeak=peak(newAt,newAt+.15);
      const first=blocks.find(x=>x.frame/rate>=oldAt-.02&&x.peak>.002);
      const recorded=t.events.filter(h=>h.type==="noteOn").map(h=>h.tick);
      let wav=null;
      if(mode==="record"){
        const start=e.recordingStartAt,stop=ctx.currentTime;
        document.getElementById("sr-record").click();
        await until(()=>!e.getTransportSnapshot().recording&&!e.getTransportSnapshot().playing);
        await until(()=>!!e.getLastLiveTake());
        const take=e.getLastLiveTake();
        const header=new DataView(await take.wav.arrayBuffer());
        wav={frames:take.frames,expected:Math.round((stop-start)*ctx.sampleRate),rate:ctx.sampleRate,dataBytes:header.getUint32(40,true),warning:e.getTransportSnapshot().liveRecWarning};
        if(e.getCurrentTick()<=480)throw Error("Record completion reset the playhead");
      }
      return {mode,oldAt,newAt,changedAt,silentPeak,soundedPeak,onset:first?first.frame/rate:null,rate,recorded,wav};
    } finally {await e.stop();e.setDispatchObserver(null);probe.port.onmessage=null;e.getMasterBus().tap.disconnect(probe);probe.disconnect();sink.disconnect();}
  })()`);
  assert(report.newAt-report.oldAt>=.04,JSON.stringify(report));
  assert(report.soundedPeak>.005,JSON.stringify(report));
  assert(report.silentPeak<.001, "Stale hit audible: "+JSON.stringify(report));
  assert(report.onset>=report.newAt-.005 && report.onset-report.newAt<.04,JSON.stringify(report));
  if(mode==="record"){
    assert.deepEqual(report.recorded,[480]);
    assert(report.wav&&report.wav.frames>0,JSON.stringify(report));
    assert(Math.abs(report.wav.frames-report.wav.expected)<=256,JSON.stringify(report));
    assert.equal(report.wav.dataBytes,report.wav.frames*6);
    assert(report.wav.frames/report.wav.rate<1.5,"Count-in leaked into WAV");
  }
  console.log("PASS: real audio PCM cancellation/reschedule",JSON.stringify(report));
} finally {cdp?.close();chrome.kill();chrome.once("exit",()=>{try{rmSync(profile,{recursive:true,force:true});}catch{}});}
