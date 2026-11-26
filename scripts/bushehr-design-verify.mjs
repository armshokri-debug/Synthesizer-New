import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CdpClient, sleep, waitForCdp } from "./studio-cdp.mjs";
const port=9289,profile=mkdtempSync(join(tmpdir(),"sy1-bushehr-"));
const chrome=spawn(process.env.SY1_CHROME_BIN||"/usr/bin/chromium",["--user-data-dir="+profile,"--headless","--no-sandbox","--disable-gpu","--disable-dev-shm-usage","--autoplay-policy=no-user-gesture-required","--remote-debugging-port="+port,"about:blank"],{stdio:"ignore"});
let cdp;
try {
 cdp=new CdpClient(await waitForCdp(port));await cdp.connect();
 await cdp.send("Page.enable");await cdp.send("Runtime.enable");
 await cdp.send("Emulation.setDeviceMetricsOverride",{width:1440,height:900,deviceScaleFactor:1,mobile:false});
 await cdp.send("Page.navigate",{url:process.env.SY1_URL||"http://127.0.0.1:4178/"});
 for(let i=0;i<150;i++){if(await cdp.evaluate("!!window.SY1_STUDIO"))break;await sleep(50);}
 await cdp.evaluate(`(async()=>{await SY1_STUDIO.ready;SY1_STUDIO.open();const e=SY1_STUDIO.engine;const t=e.getFocusedTrack();e.setTrackMachine(t.id,"bushehr");const b=t.getTrackDrumBank();b.patterns[b.selected].len=16;t.setTrackDrumBank(b);document.querySelector("#st-tab-instrument").click();})()`);
 await sleep(100);
 const inspect=()=>cdp.evaluate(`(()=>{const p=document.querySelector("#sy1-panel .synth-panel"),s=p.querySelector(".synth-sections");return {machine:p.dataset.machine,rows:p.querySelectorAll(".bushehr-lane").length,cells:p.querySelectorAll("[data-grid-voice]").length,pads:p.querySelectorAll(".bushehr-pad").length,knobs:p.querySelectorAll(".st-inst-knob").length,hero:getComputedStyle(p.querySelector(".synth-top")).backgroundImage,overflow:s.scrollWidth-s.clientWidth};})()`);
 const init=await inspect();assert.equal(init.machine,"bushehr");assert.equal(init.rows,8);assert.equal(init.cells,128);assert.equal(init.pads,8);assert(init.knobs>=12);assert(init.hero.includes("url("));assert(init.overflow<=2);
 mkdirSync("design-preview",{recursive:true});
 const snap=async name=>{const shot=await cdp.send("Page.captureScreenshot",{format:"png"});writeFileSync("design-preview/"+name+".png",Buffer.from(shot.data,"base64"));};
 await snap("Bushehr-desktop");
 const edit=await cdp.evaluate(`(()=>{const t=SY1_STUDIO.engine.getFocusedTrack();const before=t.getTrackDrumBank();document.querySelector("[data-grid-voice=tom][data-index='2']").click();const after=t.getTrackDrumBank();return {before:before.patterns[before.selected].steps,after:after.patterns[after.selected].steps};})()`);
 assert.notEqual(edit.before.tom[2],edit.after.tom[2]);assert.deepEqual(edit.before.kick,edit.after.kick);
 await cdp.evaluate('document.querySelector("[data-st-action=track-seq-options]").click();document.querySelector("[data-st-action=track-drum-len][data-len=12]").click()');
 assert.equal((await inspect()).cells,96);
 await cdp.evaluate('document.querySelector("[data-st-action=track-seq-options]").click()');
 await cdp.send("Emulation.setDeviceMetricsOverride",{width:1024,height:768,deviceScaleFactor:1,mobile:false});await sleep(100);
 assert((await inspect()).overflow<=2);await snap("Bushehr-tablet");
 await cdp.evaluate('document.querySelector("#st-inst-back-btn").click()');assert(await cdp.evaluate('!document.getElementById("sy1-studio").hidden'));
 console.log("PASS: Bushehr reference artwork, eight real pads, complete 16/12-step voice matrix, cross-voice edit isolation and tablet width");
} finally {cdp?.close();chrome.kill();chrome.once("exit",()=>{try{rmSync(profile,{recursive:true,force:true});}catch{}});}
