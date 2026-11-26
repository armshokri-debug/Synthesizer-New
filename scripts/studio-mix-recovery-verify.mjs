// Browser acceptance: actual 3-track project, IndexedDB restore, MIDI and WAV exports.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CdpClient, sleep, waitForCdp } from "./studio-cdp.mjs";

const port = 9281;
const profile = mkdtempSync(join(tmpdir(), "sy1-ci-chrome-"));
const chrome = spawn(process.env.SY1_CHROME_BIN || "/usr/bin/chromium",
  ["--user-data-dir="+profile, "--headless", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--enable-logging", "--autoplay-policy=no-user-gesture-required",
   "--remote-debugging-port=" + port, "about:blank"], { stdio: "ignore" });
let cdp;
const errors = [];
try {
  cdp = new CdpClient(await waitForCdp(port));
  await cdp.connect();
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  cdp.on("Runtime.exceptionThrown", e => errors.push(e.exceptionDetails.exception?.description ?? e.exceptionDetails.text));
  await cdp.send("Page.navigate", { url: process.env.SY1_URL || "http://127.0.0.1:4178/" });
  for(let i=0;i<150;i++){
    if(await cdp.evaluate("!!window.SY1_STUDIO")) break;
    await sleep(50);
  }
  const report = await cdp.evaluate(`(async()=>{
    const studio=window.SY1_STUDIO;
    await studio.ready;studio.open();
    const e=studio.engine, storage=studio.storage;
    e.setProjectName("Integration acceptance");
    e.setBpm(96);e.setBars(1);
    const [a,b]=e.getTracks();
    const d=e.addTrack();
    if(!d) throw Error("Third track unavailable");
    e.setTrackMachine(d.id,"kerman");
    a.applyPreset("softKeys");b.applyPreset("moogBass");
    a.setParam("revMix",0);b.setParam("revMix",0);
    a.setParam("cutoff",1200);b.setParam("cutoff",2400);
    a.setVolume(.31);b.setVolume(.27);d.setVolume(.24);
    a.setPan(-.4);b.setPan(.4);d.setPan(0);
    a.addNote(60,0,240);b.addNote(48,0,240);
    const bank=d.getTrackDrumBank();
    for(const row of Object.values(bank.patterns[bank.selected].steps))row.fill(0);
    bank.patterns[bank.selected].steps.kick[0]=1;
    bank.patterns[bank.selected].steps.kick[4]=1;
    d.setTrackDrumBank(bank);e.insertDrumPattern(d.id,0);
    const snapshot=e.exportProject(), id=snapshot.id;
    const signature=p=>JSON.stringify({bpm:p.bpm,bars:p.bars,tracks:p.tracks.map(t=>({id:t.id,machineId:t.machineId,patch:t.patch,volume:t.volume,pan:t.pan,events:t.events,regions:t.regions}))});
    const before=signature(snapshot);
    const saved=await storage.saveProject(snapshot);
    if(!saved.ok) throw Error("IndexedDB save: "+JSON.stringify(saved));
    e.setBpm(120);a.setVolume(.8);b.setParam("cutoff",600);
    const loaded=await storage.loadProject(id);
    if(!loaded.ok||!loaded.data) throw Error("IndexedDB load failed");
    await e.loadProject(loaded.data);
    const after=signature(e.exportProject());
    if(before!==after) throw Error("Project restore changed project data");
    const rate=48000, opts={sampleRate:rate,bars:1,tailSec:0};
    async function wav(t){
      const bytes=await t.wav.arrayBuffer(),v=new DataView(bytes);
      const ascii=(off,n)=>String.fromCharCode(...new Uint8Array(bytes,off,n));
      let data=-1,size=0,format;
      for(let off=12;off+8<=bytes.byteLength;){
        const tag=ascii(off,4),n=v.getUint32(off+4,true);
        if(tag==="fmt ")format=[v.getUint16(off+8,true),v.getUint16(off+10,true),v.getUint32(off+12,true),v.getUint16(off+22,true)];
        if(tag==="data"){data=off+8;size=n;break;}
        off+=8+n+(n%2);
      }
      if(ascii(0,4)!=="RIFF"||ascii(8,4)!=="WAVE"||JSON.stringify(format)!==JSON.stringify([1,2,rate,24])||data<0||size!==t.frames*6)throw Error("Invalid PCM24 WAV");
      let peak=0,first=-1;
      for(let off=data;off+2<data+size;off+=3){
        let x=v.getUint8(off)|(v.getUint8(off+1)<<8)|(v.getUint8(off+2)<<16);
        if(x&0x800000)x-=0x1000000;
        peak=Math.max(peak,Math.abs(x)/8388608);
        if(first<0&&Math.abs(x)>84)first=Math.floor((off-data)/6);
      }
      return {frames:t.frames,peak,first,bpm:t.bpm};
    }
    const mix=await wav(await e.bounceArrangementWav(opts));
    const raw=await e.bounceTrackStemsWav(opts);
    const stems=await Promise.all(raw.map(async t=>({id:t.trackId,...await wav(t)})));
    const midi=e.exportMidiBytes();
    const midiHeader=String.fromCharCode(...midi.slice(0,4));
    const midiTracks=(midi[10]<<8)|midi[11];
    e.setTrackMute(d.id,true);
    const muted=(await e.bounceTrackStemsWav(opts)).map(t=>t.trackId);
    e.setTrackSolo(d.id,true);
    const solo=(await e.bounceTrackStemsWav(opts)).map(t=>t.trackId);
    e.setTrackSolo(d.id,false);e.setTrackMute(d.id,false);
    return {saved:true,restored:true,bpm:e.getBpm(),mix,stems,midiHeader,midiTracks,muted,solo,drumId:d.id};
  })()`);
  assert.equal(report.bpm,96);
  assert.equal(report.mix.frames,120000);
  assert(report.mix.peak>.0001);
  assert.equal(report.stems.length,3);
  for(const stem of report.stems){assert.equal(stem.frames,report.mix.frames);assert.equal(stem.bpm,96);assert(stem.peak>.0001);assert(stem.first>=0);}
  assert.equal(report.midiHeader,"MThd");assert.equal(report.midiTracks,4);
  assert.equal(report.muted.length,2);assert(!report.muted.includes(report.drumId));
  assert.deepEqual(report.solo,[report.drumId]);
  assert.deepEqual(errors,[]);
  console.log("PASS: three-track IndexedDB save/restore, 96 BPM, PCM24 Mix/Stems, MIDI and mixer routing",JSON.stringify(report));
} finally { cdp?.close();chrome.kill();
  chrome.once("exit",()=>{try{rmSync(profile,{recursive:true,force:true});}catch{}}); }
