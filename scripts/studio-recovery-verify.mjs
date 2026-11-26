/** Local, disposable Chromium session; no deployment or user-browser access. */
import { spawn } from "node:child_process";
import fs from "node:fs";
import { CdpClient, sleep, waitForCdp } from "./studio-cdp.mjs";

const bin = process.env.SY1_CHROME_BIN;
if (!bin || !fs.existsSync(bin)) throw new Error("Set SY1_CHROME_BIN to a Chromium headless shell executable");
const out = process.env.SY1_EVIDENCE_DIR || "/tmp/sy1-recovery-evidence";
fs.mkdirSync(out, { recursive: true });
const chrome = spawn(bin, ["--headless", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--autoplay-policy=no-user-gesture-required", "--remote-debugging-port=9224", "about:blank"], { stdio: "ignore" });
let cdp;
const results = [], errors = [];
try {
  cdp = new CdpClient(await waitForCdp(9224));
  await cdp.connect();
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  cdp.on("Runtime.exceptionThrown", e => errors.push(e.exceptionDetails.exception?.description || e.exceptionDetails.text));
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await cdp.send("Page.navigate", { url: process.env.SY1_URL || "http://127.0.0.1:3000" });
  for (let i = 0; i < 200; i++) {
    if (await cdp.evaluate("!!window.SY1_STUDIO")) break;
    await sleep(100);
  }
  await cdp.evaluate(`(async()=>{ await window.SY1_STUDIO.ready; window.SY1_STUDIO.open(); })()`);
  const shot = async name => {
    const {data} = await cdp.send("Page.captureScreenshot", {format:"png"});
    fs.writeFileSync(`${out}/${name}.png`, Buffer.from(data,"base64"));
  };
  for (const [width,height] of [[1440,900],[1280,800],[1024,768],[768,1024],[390,844]]) {
    await cdp.send("Emulation.setDeviceMetricsOverride", {width,height,deviceScaleFactor:1,mobile:false});
    for (const mode of ["pianoroll","instrument","mixer","export"]) {
      await cdp.evaluate(`(()=>{
        const menu=document.getElementById('st-export-menu-btn');
        if(menu?.getAttribute('aria-expanded')==='true')menu.click();
        ${mode === "export" ? "document.getElementById('st-export-menu-btn').click()" : `document.getElementById('st-tab-${mode}').click()`};
      })()`);
      await sleep(100);
      const metrics = await cdp.evaluate(`(()=>{
        const box=el=>el?(()=>{const r=el.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom};})():null;
        const list=box(document.getElementById('st-browser-list'));
        const menu=box(document.getElementById('st-export-menu'));
        const ctl=box(document.querySelector('.st-track-ctl')),lane=box(document.querySelector('.st-lane'));
        const visible=[...document.querySelectorAll('.st-topbar button,.st-topbar input,.st-topbar select')].filter(el=>el.getBoundingClientRect().width>0);
        return {list,menu,aligned:Math.abs(ctl.y-lane.y)<2,overflow:document.documentElement.scrollWidth>innerWidth,
          clippedTransport:visible.filter(el=>{const r=el.getBoundingClientRect();return r.x<0||r.right>innerWidth||r.bottom>innerHeight;}).map(el=>el.id||el.textContent),
          menuFits:!menu||menu.width===0||(menu.x>=0&&menu.right<=innerWidth&&menu.y>=0&&menu.bottom<=innerHeight),
          menuUnobstructed:!menu||menu.width===0||[...document.querySelectorAll('#st-export-menu [role="menuitem"]')].every(el=>{const r=el.getBoundingClientRect();return el.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));}),
          presetAreaVisible:!!list&&list.height>=100&&list.bottom<=innerHeight,
          };
      })()`);
      results.push({width,height,mode,...metrics});
      await shot(`${width}x${height}-${mode}`);
    }
    if(width<=768){
      await cdp.evaluate("(()=>{document.getElementById('st-tab-pianoroll').click();document.getElementById('st-browser-toggle').click();})()");
      await shot(`${width}x${height}-arrangement-unobstructed`);
      await cdp.evaluate("document.getElementById('st-browser-toggle').click()");
    }
  }
  await cdp.send("Emulation.setDeviceMetricsOverride", {width:1440,height:900,deviceScaleFactor:1,mobile:false});
  await cdp.evaluate("document.getElementById('st-tab-instrument').click()");
  const machines = await cdp.evaluate(`(async()=>{const {STUDIO_MACHINES}=await import('/src/studio/track-engine.ts');return STUDIO_MACHINES.map(m=>({id:m.id,preset:m.presets[0].id}));})()`);
  for (const m of machines) {
    await cdp.evaluate(`(()=>{const e=window.SY1_STUDIO.engine;e.setTrackMachinePreset(e.getFocusedTrack().id,${JSON.stringify(m.id)},${JSON.stringify(m.preset)});})()`);
    await sleep(80);
    await shot(`editor-${m.id}`);
  }
  // Real keyboard events exercise menu focus and dismissal (not just CSS bounds).
  await cdp.evaluate("(()=>{const b=document.getElementById('st-export-menu-btn');if(b.getAttribute('aria-expanded')!=='true')b.click();})()");
  const firstItem = await cdp.evaluate("document.activeElement.id");
  await cdp.send("Input.dispatchKeyEvent", {type:"keyDown",key:"ArrowDown",code:"ArrowDown",windowsVirtualKeyCode:40});
  const secondItem = await cdp.evaluate("document.activeElement.id");
  await cdp.send("Input.dispatchKeyEvent", {type:"keyDown",key:"Escape",code:"Escape",windowsVirtualKeyCode:27});
  const keyboardPass = firstItem === "st-export-wav" && secondItem === "st-export-stems" && await cdp.evaluate("document.activeElement.id==='st-export-menu-btn'&&document.getElementById('st-export-menu').hidden");
  const mixed = await cdp.evaluate(`(async()=>{
    const eng=window.SY1_STUDIO.engine;
    eng.stop(); while(eng.getTracks().length<4)eng.addTrack();
    const {getStudioMachineDef}=await import('/src/studio/track-engine.ts');
    const ids=['tabriz','yazd','baku','kerman'];
    const tracks=eng.getTracks();
    tracks.forEach((t,i)=>{
      const m=getStudioMachineDef(ids[i]); eng.setTrackMachinePreset(t.id,m.id,m.presets[0].id);
      t.replaceNoteSpans([{midi:i===3?36:60+i,startTick:0,endTick:240,velocity:0.7}]);
      t.setParam('revMix',0); t.setParam('delayMix',0); t.setParam('choMix',0);
    });
    const names=[], Original=window.AudioWorkletNode;
    window.AudioWorkletNode=new Proxy(Original,{construct(target,args){names.push(args[1]);return Reflect.construct(target,args);}});
    const opts={sampleRate:48000,bars:1,tailSec:0.1};
    const inspect=async take=>{
      const bytes=new Uint8Array(await take.wav.arrayBuffer()),d=new DataView(bytes.buffer);
      let peak=0,finite=true;for(let i=44;i+2<bytes.length;i+=3){let n=bytes[i]|bytes[i+1]<<8|bytes[i+2]<<16;if(n&0x800000)n-=0x1000000;peak=Math.max(peak,Math.abs(n)/8388608);finite=finite&&Number.isFinite(n);}
      return {bits:d.getUint16(34,true),channels:d.getUint16(22,true),rate:d.getUint32(24,true),frames:take.frames,peak,finite,bytes};
    };
    let stems,mix,otherDiff=0,changedDiff=0;
    try{
      stems=await eng.bounceTrackStemsWav(opts);mix=await inspect(await eng.bounceArrangementWav(opts));
      const baseline=await Promise.all(stems.map(inspect));
      tracks[0].setParam('cutoff',150);
      const changed=await Promise.all((await eng.bounceTrackStemsWav(opts)).map(inspect));
      for(let i=0;i<4;i++)for(let j=44;j<baseline[i].bytes.length;j++)if(baseline[i].bytes[j]!==changed[i].bytes[j]){if(i===0)changedDiff++;else otherDiff++;}
      stems=baseline.map(({bytes,...stats})=>stats);
    } finally{window.AudioWorkletNode=Original;}
    const {bytes,...mixStats}=mix;
    await window.SY1_STUDIO.saveProject();
    const json=eng.exportProjectJson(); await window.SY1_STUDIO.importProjectJson(json);
    const midi=eng.exportMidiBytes();
    return {ids:eng.getTracks().map(t=>t.machineId),processors:[...new Set(names)],stems,mix:mixStats,otherDiff,changedDiff,midiHeader:String.fromCharCode(...midi.slice(0,4)),project:json};
  })()`);
  await cdp.evaluate("document.getElementById('st-inst-back-btn')?.click()");
  await cdp.evaluate("(()=>{const e=window.SY1_STUDIO.engine;e.setFocusedTrack(e.getTracks()[3].id);document.getElementById('st-tab-pianoroll').click();e.clearTrackClip(e.getFocusedTrack().id);})()");
  const gridPoint=await cdp.evaluate("(()=>{const r=document.getElementById('st-pr-grid').getBoundingClientRect();return {x:r.x+24,y:r.y+12};})()");
  await cdp.send("Input.dispatchMouseEvent",{type:"mousePressed",...gridPoint,button:"left",clickCount:1});
  await cdp.send("Input.dispatchMouseEvent",{type:"mouseReleased",...gridPoint,button:"left",clickCount:1});
  const drumEdit=await cdp.evaluate("(()=>{const t=window.SY1_STUDIO.engine.getFocusedTrack();const notes=t.getNoteSpans(window.SY1_STUDIO.engine.getTotalTicks());return {isDrum:document.getElementById('st-piano-roll')?.dataset.prMode==='drums',notes};})()");
  const resizePoint=await cdp.evaluate("(()=>{const r=document.getElementById('st-dock-resizer').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()");
  await cdp.send("Input.dispatchMouseEvent",{type:"mousePressed",...resizePoint,button:"left",clickCount:1});
  await cdp.send("Input.dispatchMouseEvent",{type:"mouseMoved",x:resizePoint.x,y:resizePoint.y-55,button:"left",buttons:1});
  await cdp.send("Input.dispatchMouseEvent",{type:"mouseReleased",x:resizePoint.x,y:resizePoint.y-55,button:"left",clickCount:1});
  const resizeAfter=await cdp.evaluate("document.getElementById('st-dock-resizer').getBoundingClientRect().y");
  const resizePass=resizeAfter<resizePoint.y-30;
  await shot("mixed-four-tracks");
  const restoredLoad=cdp.once("Page.loadEventFired");
  await cdp.send("Page.reload");await restoredLoad;
  for(let i=0;i<200;i++){if(await cdp.evaluate("!!window.SY1_STUDIO"))break;await sleep(100);}
  const restored=await cdp.evaluate("(async()=>{await window.SY1_STUDIO.ready;return window.SY1_STUDIO.engine.getTracks().map(t=>t.machineId);})()");
  delete mixed.project;
  const mixedPass=JSON.stringify(mixed.ids)===JSON.stringify(['tabriz','yazd','baku','kerman'])&&JSON.stringify(restored)===JSON.stringify(mixed.ids)&&mixed.processors.includes('sy1-analog')&&mixed.processors.includes('sy1-voices')&&mixed.otherDiff===0&&mixed.changedDiff>0&&mixed.midiHeader==='MThd'&&[...mixed.stems,mixed.mix].every(s=>s.bits===24&&s.channels===2&&s.rate===48000&&s.peak>0.00001&&s.finite);
  const engines=await cdp.evaluate(`(async()=>{
    const {SY1TrackEngine,getStudioMachineDef}=await import('/src/studio/track-engine.ts');
    const results=[];
    for(const id of ['sy1','tabriz','shiraz','kashan','nishapur','kerman']){
      const m=getStudioMachineDef(id),ctx=new OfflineAudioContext(2,24000,48000);
      const t=new SY1TrackEngine({id:'probe-'+id,name:id,machineId:id,presetId:m.presets[0].id,forceHQ:true});
      t.setParam('revMix',0);t.setParam('delayMix',0);
      await t.attachAudio(ctx,ctx.destination);
      const realEngine=id==='kerman'?!!t.drumBus:!!t.workletNode;
      const hold=ctx.suspend(128/48000).then(async()=>{
        t.noteOn(id==='kerman'?36:60,0.8,256/48000);t.noteOff(60,0.25);
        await new Promise(r=>setTimeout(r,30));await ctx.resume();
      });
      const audio=await ctx.startRendering();await hold;
      let peak=0,finite=true;for(const x of audio.getChannelData(0)){peak=Math.max(peak,Math.abs(x));finite=finite&&Number.isFinite(x);}
      t.setSustainPedal(true);t.loadPatchSnapshot({...t.patch},t.presetId,t.presetName,t.machineId);
      results.push({id,realEngine,kind:t.engineKind,peak,finite,released:t.getActiveVoiceCount()===0&&!t.getSustainPedal()});t.dispose();
    }
    const ctx=new OfflineAudioContext(2,128,48000),t=new SY1TrackEngine({id:'race',name:'race',forceHQ:true});
    const pending=[t.attachAudio(ctx,ctx.destination)];
    for(const id of ['tabriz','kashan','shiraz','nishapur','kerman']){const m=getStudioMachineDef(id);t.applyMachinePreset(id,m.presets[0].id);pending.push(t.ready());}
    await Promise.all(pending);
    const racePass=t.engineKind==='drums'&&!!t.drumBus&&t.workletNode===null;
    t.dispose();return {results,racePass};
  })()`);
  const enginesPass=engines.racePass&&engines.results.every(r=>r.realEngine&&r.peak>0.00001&&r.finite&&r.released);
  const drumEditPass=drumEdit.isDrum&&drumEdit.notes.length===1&&[36,37,38,39,42,45,46,56].includes(drumEdit.notes[0].midi);
  const report = {environment:"Linux headless Chromium; viewport emulation, not hardware",errors,results,mixed,restored,mixedPass,keyboardPass,drumEdit,drumEditPass,resizePass,engines,enginesPass};
  fs.writeFileSync(`${out}/report.json`,JSON.stringify(report,null,2));
  const failures=results.filter(r=>r.overflow||!r.aligned||!r.menuFits||!r.menuUnobstructed||!r.presetAreaVisible||r.clippedTransport.length);
  console.log(JSON.stringify({cases:results.length,failures,errors,mixed,restored,mixedPass,keyboardPass,drumEdit,drumEditPass,resizePass,engines,enginesPass},null,2));
  if(errors.length||failures.length||!mixedPass||!keyboardPass||!drumEditPass||!resizePass||!enginesPass)process.exitCode=1;
} finally {cdp?.close();chrome.kill("SIGKILL");}
