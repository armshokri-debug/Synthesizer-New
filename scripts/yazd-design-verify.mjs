import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CdpClient, sleep, waitForCdp } from "./studio-cdp.mjs";
const port=9286,profile=mkdtempSync(join(tmpdir(),"sy1-yazd-"));
const chrome=spawn(process.env.SY1_CHROME_BIN||"/usr/bin/chromium",["--user-data-dir="+profile,"--headless","--no-sandbox","--disable-gpu","--disable-dev-shm-usage","--autoplay-policy=no-user-gesture-required","--remote-debugging-port="+port,"about:blank"],{stdio:"ignore"});
let cdp;
try{
 cdp=new CdpClient(await waitForCdp(port));await cdp.connect();
 await cdp.send("Page.enable");await cdp.send("Runtime.enable");
 await cdp.send("Emulation.setDeviceMetricsOverride",{width:1440,height:850,deviceScaleFactor:1,mobile:false});
 await cdp.send("Page.navigate",{url:process.env.SY1_URL||"http://127.0.0.1:4178/"});
 for(let i=0;i<150;i++){if(await cdp.evaluate("!!window.SY1_STUDIO"))break;await sleep(50);}
 await cdp.evaluate(`(async()=>{await SY1_STUDIO.ready;SY1_STUDIO.open();const e=SY1_STUDIO.engine;e.setTrackMachine(e.getFocusedTrack().id,"sy1");document.querySelector("#st-tab-instrument").click();})()`);
 await sleep(100);
 const geometry=()=>cdp.evaluate(`(()=>{const r=s=>{const x=document.querySelector(s).getBoundingClientRect();return {w:x.width,h:x.height,y:x.y}};return {shell:r(".sy1-shell"),keys:r(".kb-main"),bar:r(".kb-bar"),key:r(".kb .key:not(.black)")};})()`);
 const baseline=await geometry();
 await cdp.evaluate('document.querySelector("#st-inst-back-btn").click()');
 await cdp.evaluate('SY1_STUDIO.engine.setTrackMachine(SY1_STUDIO.engine.getFocusedTrack().id,"yazd");document.querySelector("#st-tab-instrument").click()');
 await sleep(100);
 const revised=await geometry();
 assert.equal(revised.keys.h,baseline.keys.h,"keyboard height must be shared");
 assert.equal(revised.shell.w,baseline.shell.w,"chassis width must be shared");
 assert(Math.abs(revised.keys.w-baseline.keys.w)<=30,"original skin padding only");
 console.log("YAZD shared geometry",JSON.stringify({baseline,revised}));
 const inspect=()=>cdp.evaluate(`(()=>{const p=document.querySelector("#sy1-panel .synth-panel"),s=p.querySelector(".synth-sections");return {machine:p.dataset.machine,sections:s.children.length,keys:[...p.querySelectorAll(".st-inst-knob")].map(k=>k.dataset.stParam),scroll:s.scrollHeight-s.clientHeight,overflow:s.scrollWidth-s.clientWidth,visible:[...s.children].filter(el=>el.getClientRects().length).length,identity:!!p.querySelector(".yazd-identity"),style:getComputedStyle(p,"::before").backgroundImage,keyboard:document.querySelector(".kb-area").getBoundingClientRect().height};})()`);
 const initial=await inspect();
 assert.equal(initial.machine,"yazd");assert.equal(initial.sections,9);assert.equal(initial.visible,9);assert.equal(initial.keys.length,35);assert(initial.identity);assert(initial.style.includes("url("));assert(initial.overflow<=2);assert(initial.scroll<=8,JSON.stringify(initial));assert(initial.keyboard>100);
 mkdirSync("design-preview",{recursive:true});
 const snap=async name=>{const shot=await cdp.send("Page.captureScreenshot",{format:"png"});writeFileSync("design-preview/"+name+".png",Buffer.from(shot.data,"base64"));};
 await snap("Yazd-desktop");
 await cdp.evaluate('document.querySelector("[data-st-page=osc]").click()');await snap("Yazd-osc");
 for(const page of ["osc","filter","motion","space","all"]){await cdp.evaluate(`document.querySelector('[data-st-page=${page}]').click()`);const state=await inspect();assert.deepEqual(state.keys,initial.keys);assert(state.visible>0);}
 await cdp.send("Emulation.setDeviceMetricsOverride",{width:1024,height:768,deviceScaleFactor:1,mobile:false});
 await sleep(100);const tablet=await inspect();assert(tablet.overflow<=2);await snap("Yazd-tablet");
 await cdp.evaluate('document.querySelector("#st-inst-back-btn").click()');
 assert(await cdp.evaluate('!document.getElementById("sy1-studio").hidden'));
 console.log("PASS: Yazd design retains all nine sections and controls, desktop fit, page tabs, tablet width and Studio return",JSON.stringify({desktop:initial,tablet}));
}finally{cdp?.close();chrome.kill();chrome.once("exit",()=>{try{rmSync(profile,{recursive:true,force:true});}catch{}});}
