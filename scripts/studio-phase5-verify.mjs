import {spawn} from "node:child_process";
import fs from "node:fs";
import {CdpClient,waitForCdp,sleep} from "./studio-cdp.mjs";

const bin=process.env.SY1_CHROME_BIN, out=process.env.SY1_EVIDENCE_DIR||"/tmp/sy1-phase5-after";
if(!bin||!fs.existsSync(bin))throw Error("Set SY1_CHROME_BIN");
fs.mkdirSync(out,{recursive:true});
const chrome=spawn(bin,["--headless","--no-sandbox","--disable-gpu","--disable-dev-shm-usage","--autoplay-policy=no-user-gesture-required","--remote-debugging-port=9225","about:blank"],{stdio:"ignore"});
let c;const errors=[],checks=[];
const assert=(name,value,detail)=>{checks.push({name,pass:!!value,detail});if(!value)throw Error(name+": "+JSON.stringify(detail));};
try{
  c=new CdpClient(await waitForCdp(9225));await c.connect();await c.send("Page.enable");await c.send("Runtime.enable");
  c.on("Runtime.exceptionThrown",e=>errors.push(e.exceptionDetails.exception?.description||e.exceptionDetails.text));
  await c.send("Page.addScriptToEvaluateOnNewDocument",{source:`
    window.__phase5Midi={id:'phase5-input',name:'Automated MIDI fixture',state:'connected',connection:'open',type:'input',onmidimessage:null};
    Object.defineProperty(navigator,'requestMIDIAccess',{configurable:true,value:async()=>({inputs:new Map([['phase5-input',window.__phase5Midi]]),outputs:new Map(),onstatechange:null})});
  `});
  await c.send("Page.addScriptToEvaluateOnNewDocument",{source:"window.__audioContextCount=0;const OriginalAudioContext=window.AudioContext;window.AudioContext=new Proxy(OriginalAudioContext,{construct(target,args){window.__audioContextCount++;return Reflect.construct(target,args);}});"});
  const viewport=async(w,h)=>c.send("Emulation.setDeviceMetricsOverride",{width:w,height:h,deviceScaleFactor:1,mobile:false});
  const wait=async expression=>{for(let i=0;i<200;i++){if(await c.evaluate(expression))return;await sleep(50);}throw Error("Timeout: "+expression);};
  const click=async selector=>{
    const p=await c.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Missing control');e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
    await c.send("Input.dispatchMouseEvent",{type:"mousePressed",...p,button:"left",clickCount:1});await c.send("Input.dispatchMouseEvent",{type:"mouseReleased",...p,button:"left",clickCount:1});
  };
  const shot=async name=>{const {data}=await c.send("Page.captureScreenshot",{format:"png"});fs.writeFileSync(`${out}/${name}.png`,Buffer.from(data,"base64"));};
  const key=async()=>{await click("#kb .key:not(.black)");await sleep(80);};
  await viewport(1440,900);await c.send("Page.navigate",{url:process.env.SY1_URL||"http://127.0.0.1:3000"});await wait("!!window.SY1_STUDIO");
  await c.evaluate("window.SY1_STUDIO.ready");await shot("synth");
  await c.evaluate("window.SY1.setMachine('tabriz');window.SY1_STUDIO.engine.setBpm(240)");
  await click("#sr-count-in");await click("#sr-click");await click("#sr-record");
  await wait("window.SY1_STUDIO.engine.getCountInBeat()>0");await shot("count-in");await key();
  assert("Count-in does not record early input",await c.evaluate("window.SY1_STUDIO.engine.getFocusedTrack().events.length===0"));
  await wait("window.SY1_STUDIO.engine.getCountInBeat()===0");
  await shot("recording");await key();await sleep(120);await click("#sr-stop");await wait("!window.SY1_STUDIO.engine.isPlaying()");
  const first=await c.evaluate("(()=>{const e=window.SY1_STUDIO.engine,t=e.getFocusedTrack();return {id:t.id,machine:t.machineId,notes:t.getNoteSpans(e.getTotalTicks()),patch:JSON.stringify(t.patch),source:JSON.stringify(window.SY1.getPatch())};})()");
  assert("Synth records instrument, notes and exact patch",first.machine==='tabriz'&&first.notes.length===1&&first.patch===first.source,first);
  await click("#sr-edit");await wait("window.SY1_STUDIO.isOpen()");await click("#st-tab-pianoroll");
  assert("Record → Stop → Studio → Piano Roll",await c.evaluate("document.querySelectorAll('.st-pr-note').length>0&&!document.getElementById('sy1-studio').hidden"));await shot("studio");
  await click("#st-back-btn");await click("#sr-count-in");
  await click("#sr-record");await wait("window.SY1_STUDIO.engine.getTransportSnapshot().recording");await key();await click("#sr-stop");
  await wait("!window.SY1_STUDIO.engine.isPlaying()");
  assert("Overdub preserves the preceding performance",await c.evaluate("window.SY1_STUDIO.engine.getFocusedTrack().getNoteSpans(window.SY1_STUDIO.engine.getTotalTicks()).length===2"));
  await c.evaluate("window.SY1.requestMidi()");await click("#sr-record");await wait("window.SY1_STUDIO.engine.getTransportSnapshot().recording");
  await c.evaluate("(()=>{const send=data=>window.__phase5Midi.onmidimessage({data:new Uint8Array(data),timeStamp:performance.now()});send([0xb0,64,127]);send([0xe0,0,96]);send([0x90,60,99]);})()");
  await sleep(70);
  await c.evaluate("(()=>{const send=data=>window.__phase5Midi.onmidimessage({data:new Uint8Array(data),timeStamp:performance.now()});send([0x80,60,0]);send([0xb0,64,0]);})()");
  await click("#sr-stop");await wait("!window.SY1_STUDIO.engine.isPlaying()");
  const midiInput=await c.evaluate("(()=>{const e=window.SY1_STUDIO.engine,t=e.getFocusedTrack();return {notes:t.getNoteSpans(e.getTotalTicks()),sustain:t.events.some(x=>x.type==='cc'&&x.cc===64&&x.value===127),bend:t.events.some(x=>x.type==='pitchBend'&&x.value===0.5)};})()");
  assert("Simulated Web MIDI input preserves velocity, sustain and bend",midiInput.notes.some(n=>n.midi===60&&Math.abs(n.velocity-99/127)<1e-9)&&midiInput.sustain&&midiInput.bend,midiInput);
  for(const machine of ['yazd','baku','kerman']){
    await c.evaluate(`window.SY1.setMachine(${JSON.stringify(machine)})`);await click("#sr-record");await wait("window.SY1_STUDIO.engine.getTransportSnapshot().recording");
    await key();await sleep(100);await click("#sr-stop");await wait("!window.SY1_STUDIO.engine.isPlaying()");
  }
  const mixed=await c.evaluate("(()=>{const e=window.SY1_STUDIO.engine;return e.getTracks().map(t=>({machine:t.machineId,count:t.getNoteSpans(e.getTotalTicks()).length}));})()");
  assert("Mixed synth/drum performances stay in separate tracks",JSON.stringify(mixed.map(t=>t.machine))===JSON.stringify(['tabriz','yazd','baku','kerman'])&&mixed.every(t=>t.count>0),mixed);
  assert("One shared live AudioContext",await c.evaluate("window.__audioContextCount===1"),await c.evaluate("window.__audioContextCount"));
  const audio=await c.evaluate(`(async()=>{
    const {StudioMetronome}=await import('/src/studio/metronome.ts');
    const ctx=new OfflineAudioContext(1,100800,48000),m=new StudioMetronome();
    for(let i=0;i<=200;i++)m.schedule(ctx,i/100,0,0,120,true,null,null);
    const rendered=await ctx.startRendering(),data=rendered.getChannelData(0);
    const peak=(a,b)=>{let p=0;for(let i=Math.floor(a*48000);i<Math.floor(b*48000);i++)p=Math.max(p,Math.abs(data[i]));return p;};
    const peaks=[0,0.5,1,1.5,2].map(t=>peak(t,t+0.04)),quiet=peak(0.1,0.4),voices=m.voices.size;m.dispose();
    const e=window.SY1_STUDIO.engine;e.getTracks().forEach(t=>{t.setParam('revMix',0);t.setParam('delayMix',0);});
    e.setRecordingSettings({metronome:true});const withClick=new Uint8Array(await (await e.bounceArrangementWav({bars:1,sampleRate:48000})).wav.arrayBuffer());
    e.setRecordingSettings({metronome:false});const withoutClick=new Uint8Array(await (await e.bounceArrangementWav({bars:1,sampleRate:48000})).wav.arrayBuffer());
    const wav=new DataView(withClick.buffer);let diff=0;for(let i=0;i<withClick.length;i++)if(withClick[i]!==withoutClick[i])diff++;
    return {peaks,quiet,voices,exportDifference:diff,bits:wav.getUint16(34,true),midi:String.fromCharCode(...e.exportMidiBytes().slice(0,4))};
  })()`);
  assert("Audio-clock clicks, downbeat accent and click resource cleanup",audio.peaks.every(p=>p>0.05)&&audio.peaks[0]>audio.peaks[1]*1.3&&audio.quiet<1e-7&&audio.voices===0,audio);
  assert("Metronome excluded from WAV; MIDI and 24-bit export",audio.exportDifference===0&&audio.bits===24&&audio.midi==='MThd',audio);
  await c.evaluate("window.SY1_STUDIO.engine.setRecordingSettings({metronome:false,countIn:true,clickVolume:0.12})");
  assert("Save completed",await c.evaluate("window.SY1_STUDIO.saveProject()"));
  const expectedTracks=await c.evaluate("JSON.stringify(window.SY1_STUDIO.engine.exportProject().tracks)");
  const loaded=c.once("Page.loadEventFired");await c.send("Page.reload");await loaded;await wait("!!window.SY1_STUDIO");await c.evaluate("window.SY1_STUDIO.ready");
  const restored=await c.evaluate("window.SY1_STUDIO.engine.getTracks().map(t=>t.machineId)");
  assert("Save → Refresh → Restore mixed identity",JSON.stringify(restored)===JSON.stringify(mixed.map(t=>t.machine)),restored);
  assert("Recording preferences survive refresh",await c.evaluate("window.SY1_STUDIO.engine.getRecordingSettings().countIn&&window.SY1_STUDIO.engine.getRecordingSettings().clickVolume===0.12&&Number(document.getElementById('sr-click-volume').value)===0.12"));
  assert("Recorded notes, controllers and patches survive refresh exactly",expectedTracks===await c.evaluate("JSON.stringify(window.SY1_STUDIO.engine.exportProject().tracks)"));
  for(const [w,h] of [[1440,900],[1280,800],[1024,768],[768,1024],[390,844]]){
    await viewport(w,h);if(await c.evaluate("window.SY1_STUDIO.isOpen()"))await click("#st-back-btn");
    await sleep(80);await shot(`${w}x${h}-synth`);
    const layout=await c.evaluate("(()=>{const root=document.getElementById('synth-recording');return {overflow:document.documentElement.scrollWidth>innerWidth,clipped:[...root.querySelectorAll('button,input,output,summary')].filter(e=>e.checkVisibility()&&e.getBoundingClientRect().width>0).filter(e=>{const r=e.getBoundingClientRect();return r.x<0||r.right>innerWidth||r.top<0||r.bottom>innerHeight;}).map(e=>e.id||e.tagName)};})()");
    assert(`${w}x${h} compact transport fits`,!layout.overflow&&layout.clipped.length===0,layout);
    await click("#synth-recording summary");await shot(`${w}x${h}-options`);
    const optionsFit=await c.evaluate("(()=>{const e=document.getElementById('sr-click-volume'),r=e.getBoundingClientRect();return e.checkVisibility()&&r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight;})()");
    assert(`${w}x${h} click-volume options accessible`,optionsFit);
    await click("#synth-recording summary");
    await click("#sr-edit");await wait("window.SY1_STUDIO.isOpen()");await shot(`${w}x${h}-studio`);
    await click("#st-export-menu-btn");await shot(`${w}x${h}-more`);
    const menu=await c.evaluate("(()=>{const r=document.getElementById('st-export-menu').getBoundingClientRect();return {x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:innerWidth,height:innerHeight};})()");
    assert(`${w}x${h} More panel fits`,menu.x>=0&&menu.y>=0&&menu.right<=menu.width&&menu.bottom<=menu.height,menu);
    await click("#st-export-menu-btn");
  }
  await click("#st-back-btn");
  const memoryBefore=await c.evaluate("JSON.stringify(window.SY1_STUDIO.engine.exportProject().tracks)");
  await c.evaluate("window.__originalSave=window.SY1_STUDIO.storage.saveProject;window.SY1_STUDIO.storage.saveProject=async()=>({ok:false,kind:'quota',message:'Simulated full storage'})");
  await click("#sr-stop");await wait("document.getElementById('sr-status').textContent.includes('Save failed')");
  assert("Save failure is visible and keeps the performance in memory",memoryBefore===await c.evaluate("JSON.stringify(window.SY1_STUDIO.engine.exportProject().tracks)"));
  await c.evaluate("window.SY1_STUDIO.storage.saveProject=window.__originalSave;delete window.__originalSave");await click("#sr-stop");
  assert("No uncaught browser errors",errors.length===0,errors);
}finally{
  fs.writeFileSync(`${out}/report.json`,JSON.stringify({environment:"Linux Chromium; viewport emulation, not physical devices",checks,errors},null,2));
  console.log(JSON.stringify({checks,errors},null,2));c?.close();chrome.kill('SIGKILL');
}
