// Acceptance gate for GarageBand-style instrument/arrangement integration.
// Run against a disposable local production build, not the published project.
// Reference: https://support.apple.com/en-nz/guide/garageband-ipad/chs157aec9e/ipados
// Reference: https://support.apple.com/en-ph/guide/garageband-ipad/chs2a762fad/ipados
// This is intentionally a new acceptance gate, not evidence of a passing build.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CdpClient, sleep, waitForCdp } from "./studio-cdp.mjs";

const port = 9284;
const profile = mkdtempSync(join(tmpdir(), "sy1-ci-chrome-"));
const chrome = spawn(process.env.SY1_CHROME_BIN || "/usr/bin/chromium",
  ["--user-data-dir="+profile, "--headless", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--enable-logging",
   "--autoplay-policy=no-user-gesture-required",
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
  for (let i = 0; i < 150; i++) {
    if (await cdp.evaluate("!!window.SY1_STUDIO")) break;
    await sleep(50);
  }
  await cdp.evaluate(`(async()=>{await SY1_STUDIO.ready;SY1_STUDIO.open();const e=SY1_STUDIO.engine;
    const a=e.getFocusedTrack(),b=e.getTracks()[1];e.setTrackMachine(a.id,"sy1");e.setTrackMachine(b.id,"yazd");
    a.setEvents([{type:"noteOn",tick:120,midi:60,velocity:.8},{type:"noteOff",tick:360,midi:60},{type:"noteOn",tick:480,midi:64,velocity:.6},{type:"noteOff",tick:720,midi:64}]);
    window.__source=a.id;window.__destination=b.id;document.querySelector('[data-region-id]').click();})()`);
  await cdp.evaluate('document.querySelector("[data-st-action=copy-region]").click()');
  await cdp.evaluate(`document.querySelector('[data-st-action=focus-track][data-track-id="'+window.__destination+'"]').click()`);
  await cdp.evaluate('document.querySelector("[data-st-action=paste-region-in-place]").click()');
  const pasted=await cdp.evaluate(`(()=>{const e=SY1_STUDIO.engine,a=e.regions.regions(__source)[0],b=e.regions.regions(__destination)[0];return {a,b,machine:e.getFocusedTrack().machineId}})()`);
  assert.equal(pasted.machine,"yazd");assert.notEqual(pasted.a.id,pasted.b.id);assert.deepEqual(pasted.a.events,pasted.b.events);assert.equal(pasted.a.startTick,pasted.b.startTick);
  const space=()=>cdp.evaluate('document.body.dispatchEvent(new KeyboardEvent("keydown",{key:" ",code:"Space",bubbles:true,cancelable:true}))');
  await space();await sleep(180);assert(await cdp.evaluate("SY1_STUDIO.engine.isPlaying()"));
  await space();await sleep(100);assert.equal(await cdp.evaluate("SY1_STUDIO.engine.isPlaying()"),false);
  await cdp.evaluate('document.querySelector("#st-tab-pianoroll").click()');
  await cdp.evaluate(`(()=>{const g=document.querySelector("#st-pr-grid");g.focus();g.dispatchEvent(new KeyboardEvent("keydown",{key:"a",metaKey:true,bubbles:true,cancelable:true}));})()`);
  assert.equal(await cdp.evaluate('document.querySelectorAll(".st-pr-note.is-selected").length'),2);
  await cdp.evaluate(`(()=>{const q=document.getElementById("st-pr-quantize-div");q.value="240";q.dispatchEvent(new Event("change",{bubbles:true}));document.getElementById("st-pr-quantize").click();})()`);
  const notes=await cdp.evaluate('SY1_STUDIO.engine.regions.editorNotes(__destination)');
  assert(notes.every(n=>n.startTick%240===0));assert.deepEqual(await cdp.evaluate('SY1_STUDIO.engine.regions.regions(__source)[0].events'),pasted.a.events);
  await cdp.evaluate(`(()=>{const g=document.querySelector("#st-pr-grid");g.focus();g.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true,cancelable:true}));})()`);
  // Marquee across the entire grid, from a blank corner. CDP touch events exercise
  // actual browser input in the later physical-device acceptance, not a claim of iPad testing.
  const gesture=async(type)=>{
    const rect=await cdp.evaluate(`(()=>{const g=document.querySelector("#st-pr-grid"),r=g.getBoundingClientRect();return {x:r.left+1,y:r.top+1,w:r.width-2,h:r.height-2};})()`);
    const event=(name,x,y)=>cdp.evaluate(`document.querySelector("#st-pr-grid").dispatchEvent(new PointerEvent("${name}",{pointerId:9,pointerType:"${type}",button:0,buttons:${name==="pointerup"?0:1},bubbles:true,cancelable:true,clientX:${x},clientY:${y}}))`);
    await event("pointerdown",rect.x,rect.y);if(type==="touch")await sleep(360);
    await event("pointermove",rect.x+rect.w,rect.y+rect.h);await event("pointerup",rect.x+rect.w,rect.y+rect.h);
    await sleep(50);assert.equal(await cdp.evaluate('document.querySelectorAll(".st-pr-note.is-selected").length'),2,type+" marquee selects both notes");
  };
  await gesture("mouse");await gesture("touch");
  assert.deepEqual(errors,[]);console.log("PASS: cross-instrument MIDI copy/paste in place, Space transport, Select All, quantize, mouse and touch marquee");
} finally {
  cdp?.close();chrome.kill();chrome.once("exit",()=>{try{rmSync(profile,{recursive:true,force:true});}catch{}});
}
