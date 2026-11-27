
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {CdpClient,sleep,waitForCdp} from "./studio-cdp.mjs";
const port=9289,profile=mkdtempSync(join(tmpdir(),"sy1-four-buffered-"));
const chrome=spawn(process.env.SY1_CHROME_BIN||"/usr/bin/chromium",["--user-data-dir="+profile,"--headless","--no-sandbox","--disable-gpu","--disable-dev-shm-usage","--autoplay-policy=no-user-gesture-required","--remote-debugging-port="+port,"about:blank"],{stdio:"ignore"});
let cdp;
try{
 cdp=new CdpClient(await waitForCdp(port));await cdp.connect();await cdp.send("Page.enable");
 await cdp.send("Page.navigate",{url:process.env.SY1_URL||"http://127.0.0.1:4178/"});
 for(let i=0;i<150;i++){if(await cdp.evaluate("!!window.SY1_STUDIO"))break;await sleep(50);}
 const report=await cdp.evaluate(`(async()=>{
  await SY1_STUDIO.ready;SY1_STUDIO.open();
  const e=SY1_STUDIO.engine;
  while(e.getTracks().length<4)if(!e.addTrack())throw Error("Cannot create 4 tracks");
  e.setLoopEnabled(false);e.setBars(32);e.setBpm(120);
  const [drum,a,b,c]=e.getTracks();
  e.setTrackMachine(drum.id,"bushehr");
  e.setTrackMachinePreset(a.id,"sy1","init");e.setTrackMachinePreset(b.id,"baku","nightDrive");e.setTrackMachinePreset(c.id,"yazd","dawnGlass");
  for(const t of [drum,a,b,c]){
    t.setParam("revMix",0);t.setParam("delayMix",0);t.setParam("chorusMix",0);
    if(t!==drum){t.setParam("polyMode","poly");t.setParam("hold","off");t.setParam("aA",.002);t.setParam("aR",.005);t.setParam("aD",.03);t.setParam("aS",.8);}
    else{t.setParam("kickDecay",.4);t.setParam("kickSend",0);}
    const events=[];for(let i=0;i<256;i++){const midi=t===drum?36:60+i%3;events.push({type:"noteOn",tick:i*240,midi,velocity:.7},{type:"noteOff",tick:i*240+72,midi});}
    t.setEvents(events);
  }
  const ctx=await e.ensureAudio();await ctx.resume();
  const source="class Probe extends AudioWorkletProcessor{process(inputs){let peak=0;for(const c of inputs[0])for(const x of c)peak=Math.max(peak,Math.abs(x));this.port.postMessage({frame:currentFrame,peak});return true;}}registerProcessor('buffered-pcm-probe',Probe);";
  const url=URL.createObjectURL(new Blob([source],{type:"text/javascript"}));await ctx.audioWorklet.addModule(url);URL.revokeObjectURL(url);
  const sink=ctx.createGain();sink.gain.value=0;sink.connect(ctx.destination);
  const probes=[],records=[[],[],[],[]],taps=e.getTracks().map(t=>t.bus.tap);
  for(let i=0;i<4;i++){const p=new AudioWorkletNode(ctx,"buffered-pcm-probe",{numberOfInputs:1,numberOfOutputs:1,outputChannelCount:[1]});p.port.onmessage=ev=>records[i].push(ev.data);taps[i].connect(p);p.connect(sink);probes.push(p);}
  const delay=ms=>new Promise(r=>setTimeout(r,ms));
  try{
    e.setFiniteScoreExperiment(true);await e.play();
    const initial=e.getFiniteScoreTrackIds(),initialDrums=e.getFiniteDrumTrackIds();
    const anchor=e.anchorAudioTime,rate=ctx.sampleRate;
    const wall=performance.now();while(performance.now()-wall<1000){}
    await delay(180);
    const peak=(r,start,end)=>r.filter(x=>x.frame/rate>=start&&x.frame/rate<end).reduce((m,x)=>Math.max(m,x.peak),0);
    const windows=records.map(r=>[0,1,2].map(i=>peak(r,anchor+i*.25+.01,anchor+i*.25+.07)));
    const drumStats=e.getFiniteDrumDiagnostics();
    e.regions.select(drum.getRegions(e.getTotalTicks())[0].id);
    e.replaceTrackNotes(drum.id,[{midi:36,startTick:1920,endTick:2000,velocity:.7}]);
    const afterEdit=e.getFiniteScoreTrackIds(),afterDrumEdit=e.getFiniteDrumTrackIds();
    await e.stop();
    const afterStop=e.getFiniteScoreTrackIds(),afterDrumStop=e.getFiniteDrumTrackIds();
    e.setLoopEnabled(true);e.setLoopRange(1,1);e.setBpm(240);
    for(const t of [drum,a,b,c]){
      const events=[];for(let i=0;i<8;i++){const midi=t===drum?36:60+i%3;events.push({type:"noteOn",tick:i*240,midi,velocity:.7},{type:"noteOff",tick:i*240+72,midi});}
      t.setEvents(events);
    }
    records.forEach(r=>r.length=0);
    await e.play();
    const loopTracks=e.getFiniteScoreTrackIds(),loopDrums=e.getFiniteDrumTrackIds(),loopAnchor=e.anchorAudioTime;
    await delay(Math.max(0,(loopAnchor+.6-ctx.currentTime)*1000));
    const loopWall=performance.now();while(performance.now()-loopWall<1000){}
    await delay(100);
    const loopWindows=records.map(r=>[.75,1,1.25,1.5].map(t=>peak(r,loopAnchor+t+.008,loopAnchor+t+.035)));
    const loopStats=e.getFiniteDrumDiagnostics();
    await e.stop();
    e.setLoopRange(1,32);
    for(const t of [drum,a,b,c]){
      const events=[];for(let i=0;i<256;i++){const midi=t===drum?36:60+i%3;events.push({type:"noteOn",tick:i*240,midi,velocity:.7},{type:"noteOff",tick:i*240+72,midi});}t.setEvents(events);
    }
    await e.play();
    const longLoopTracks=e.getFiniteScoreTrackIds(),longLoopDrums=e.getFiniteDrumTrackIds();
    await e.stop();
    return {initial,initialDrums,afterEdit,afterDrumEdit,afterStop,afterDrumStop,windows,drumStats,ids:[a.id,b.id,c.id],drum:drum.id,loopTracks,loopDrums,loopWindows,loopStats,longLoopTracks,longLoopDrums};
  }finally{await e.stop();probes.forEach((p,i)=>{taps[i].disconnect(p);p.disconnect();});sink.disconnect();}
 })()`);
 assert.deepEqual(report.initial,report.ids,JSON.stringify(report));
 assert.deepEqual(report.initialDrums,[report.drum],JSON.stringify(report));
 assert(report.windows.every(w=>w.every(p=>p>.001)),JSON.stringify(report));
 assert.equal(report.drumStats.missed,0,JSON.stringify(report));
 assert.deepEqual(report.afterEdit,report.ids);assert.deepEqual(report.afterDrumEdit,[]);
 assert.deepEqual(report.afterStop,[]);assert.deepEqual(report.afterDrumStop,[]);
 assert.deepEqual(report.loopTracks,report.ids,JSON.stringify(report));
 assert.deepEqual(report.loopDrums,[report.drum],JSON.stringify(report));
 assert(report.loopWindows.every(w=>w.every(p=>p>.001)),JSON.stringify(report));
 assert.equal(report.loopStats.missed,0,JSON.stringify(report));
 assert.deepEqual(report.longLoopTracks,report.ids,JSON.stringify(report));
 assert.deepEqual(report.longLoopDrums,[report.drum],JSON.stringify(report));
 console.log("PASS FOUR_TRACK_BUFFERED_STALL_PCM",JSON.stringify(report));
}finally{cdp?.close();chrome.kill();chrome.once("exit",()=>{try{rmSync(profile,{recursive:true,force:true});}catch{}});}
