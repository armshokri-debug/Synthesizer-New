// Verify the production UI and Web Audio graph in a disposable Chromium session.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CdpClient, sleep, waitForCdp } from "./studio-cdp.mjs";

const port = 9278;
const profile = mkdtempSync(join(tmpdir(), "sy1-ci-chrome-"));
const chrome = spawn(process.env.SY1_CHROME_BIN || "/usr/bin/chromium",
  ["--user-data-dir="+profile, "--headless", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--enable-logging", "--autoplay-policy=no-user-gesture-required",
    `--remote-debugging-port=${port}`, "about:blank"], { stdio: "ignore" });
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
  await cdp.evaluate(`(async () => {
    const studio = window.SY1_STUDIO;
    await studio.ready;
    studio.open();
    const engine = studio.engine;
    engine.setBpm(120);
    const track = engine.getFocusedTrack();
    engine.setTrackMachine(track.id, "kerman");
    const bank = track.getTrackDrumBank();
    const pattern = bank.patterns[bank.selected];
    for (const steps of Object.values(pattern.steps)) steps.fill(0);
    pattern.len = 16;
    pattern.steps.kick[0] = 1;
    pattern.steps.kick[4] = 1;
    track.setTrackDrumBank(bank);
    engine.insertDrumPattern(track.id, 0);
    window.__drumDispatch = [];
    engine.setDispatchObserver(hit => window.__drumDispatch.push(hit));
    document.querySelector("#st-tab-instrument").click();
  })()`);
  const click = name => cdp.evaluate(`document.querySelector('[data-st-action="${name}"]').click()`);
  const playing = () => cdp.evaluate("window.SY1_STUDIO.engine.getTransportSnapshot().playing");
  const regions = () => cdp.evaluate("(()=>{const e=window.SY1_STUDIO.engine;return e.regions.regions(e.getFocusedTrack().id);})()");
  const before = await regions();
  // The original drum faceplate's tempo controls must update the same project BPM.
  const tempo = () => cdp.evaluate(`(() => {
    const e = SY1_STUDIO.engine;
    return [e.getBpm(), Number(document.querySelector("#sy1-panel [data-st-project-bpm]").textContent)];
  })()`);
  assert.deepEqual(await tempo(), [120, 120]);
  await cdp.evaluate('document.querySelector("#sy1-panel [data-st-action=bpm-down]").click()');
  assert.deepEqual(await tempo(), [119, 119]);
  await cdp.evaluate('document.querySelector("#sy1-panel [data-st-action=bpm-up]").click()');
  assert.deepEqual(await tempo(), [120, 120]);
  // Compact sequencer is the first section, and can hide/show without affecting the pattern.
  assert(await cdp.evaluate('document.querySelector(".synth-sections").firstElementChild.querySelector(".st-seq-grid")!==null'));
  assert(await cdp.evaluate('!document.querySelector(".st-seq-grid").hidden'));
  await click("track-seq-toggle");
  assert(await cdp.evaluate('document.querySelector(".st-seq-grid").hidden'));
  await click("track-seq-toggle");
  assert(await cdp.evaluate('!document.querySelector(".st-seq-grid").hidden'));
  await click("track-seq-options");
  assert(await cdp.evaluate('!document.querySelector(".st-seq-settings").hidden'));
  await click("track-seq-options");
  await cdp.evaluate('document.querySelector("[data-st-page=sound]").click()');
  const knobTest=await cdp.evaluate(`(()=>{const k=document.querySelector(".synth-sec.is-on-page .st-inst-knob"),e=SY1_STUDIO.engine,t=e.getFocusedTrack(),key=k.dataset.stParam,before=t.patch[key];k.dispatchEvent(new WheelEvent("wheel",{deltaY:100,bubbles:true,cancelable:true}));return {before,after:t.patch[key]};})()`);
  assert.equal(knobTest.before,knobTest.after,"ordinary scrolling must not alter sound");
  await cdp.evaluate('document.querySelector("[data-st-page=steps]").click()');
  console.log("PASS: compact top sequencer, fold/unfold, explicit settings and safe scroll");
  await click("track-drum-preview");
  assert.equal(await cdp.evaluate("document.querySelector('[data-st-action=track-drum-preview]').getAttribute('aria-pressed')"), "true");
  const signal = await cdp.evaluate(`(async () => {
    let peak = 0;
    for (let i = 0; i < 28; i++) {
      peak = Math.max(peak, SY1_STUDIO.engine.readMasterMeterLevel());
      await new Promise(r => setTimeout(r, 25));
    }
    return peak;
  })()`);
  assert(signal > 0.001, "Preview should produce Web Audio output");
  assert.equal(await playing(), false);
  assert.deepEqual(await regions(), before);
  const preview = await cdp.evaluate("window.__drumDispatch.filter(hit => hit.event.type === 'noteOn')");
  assert(preview.length >= 2 && preview.every(hit => hit.source === "drum-preview"));
  assert(Math.abs(preview[1].audioTime - preview[0].audioTime - 0.5) < 0.005);

  // Measure actual audio-clock dispatch spacing at a second, non-default tempo.
  await click("track-drum-preview");
  await cdp.evaluate("SY1_STUDIO.engine.setBpm(90); window.__drumDispatch.length = 0");
  assert.deepEqual(await tempo(), [90, 90]);
  await click("track-drum-preview");
  await sleep(900);
  const slower = await cdp.evaluate("window.__drumDispatch.filter(hit => hit.event.type === 'noteOn')");
  assert(slower.length >= 2 && slower.every(hit => hit.source === "drum-preview"));
  assert(Math.abs(slower[1].audioTime - slower[0].audioTime - 2/3) < 0.005);
  await click("track-drum-preview");
  // Change the project tempo while a preview is actually sounding.
  const dynamic = await cdp.evaluate(`(async()=>{
    const e=SY1_STUDIO.engine;
    e.setBpm(120);window.__drumDispatch.length=0;
    const track=e.getFocusedTrack(), ctx=e.prepareAudioSync();
    e.startDrumPreview(track.id);
    const until=async(test,ms=2500)=>{
      const end=performance.now()+ms;
      while(!test()){
        if(performance.now()>end)throw Error("Timed out waiting for audio dispatch");
        await new Promise(r=>setTimeout(r,5));
      }
    };
    await until(()=>window.__drumDispatch.length>=1);
    const first=window.__drumDispatch[0].audioTime;
    await until(()=>ctx.currentTime>=first+.15);
    const before=ctx.currentTime;
    e.setBpm(60);
    const after=ctx.currentTime;
    await until(()=>window.__drumDispatch.length>=2);
    const second=window.__drumDispatch[1];
    const active=e.isDrumPreviewEnabled(track.id);
    const shown=Number(document.querySelector("#sy1-panel [data-st-project-bpm]").textContent);
    e.stopDrumPreview();
    return {first,before,after,second,active,shown};
  })()`);
  assert(dynamic.active);
  assert.equal(dynamic.shown,60);
  assert.equal(dynamic.second.source,"drum-preview");
  assert.equal(dynamic.second.event.tick,480);
  // At 120 BPM the first quarter note lasts .5s. At 60 BPM the
  // remaining fraction lasts twice as long, without restarting the pattern.
  const expected=dynamic.first+1-(dynamic.before-dynamic.first);
  assert(Math.abs(dynamic.second.audioTime-expected)<.04+dynamic.after-dynamic.before,
    "Live BPM change should preserve beat phase");
  await cdp.evaluate("SY1_STUDIO.engine.setBpm(120)");
  await click("track-drum-preview");
  await cdp.evaluate("window.__drumDispatch.length = 0; window.SY1_STUDIO.engine.play()");
  await sleep(680);
  assert.equal(await playing(), true);
  const hits = await cdp.evaluate("window.__drumDispatch.filter(hit => hit.event.type === 'noteOn')");
  assert.deepEqual(hits.map(hit => hit.event.tick), [0, 480]);
  assert(hits.every(hit => hit.source === undefined));
  await cdp.evaluate("SY1_STUDIO.engine.stop()");

  await click("track-drum-preview");
  await cdp.evaluate("window.__drumDispatch.length=0; SY1_STUDIO.engine.setRecordingSettings({countIn:false,mode:'overdub'}); SY1_STUDIO.engine.record({midiOnly:true})");
  await sleep(680);
  const recordHandoff=await cdp.evaluate(`(()=>{
    const e=SY1_STUDIO.engine;
    return {recording:e.getTransportSnapshot().recording,preview:e.isDrumPreviewEnabled(e.getFocusedTrack().id),
      hits:window.__drumDispatch.filter(h=>h.event.type==="noteOn")};
  })()`);
  assert(recordHandoff.recording && !recordHandoff.preview);
  assert.deepEqual(recordHandoff.hits.map(h=>h.event.tick),[0,480]);
  assert(recordHandoff.hits.every(h=>h.source===undefined));
  await cdp.evaluate("SY1_STUDIO.engine.stop()");
  assert.deepEqual(await regions(),before);
  await click("track-seq-options");
  await click("track-drum-insert");
  const after = await regions();
  assert.deepEqual(after[0], before[0]);
  assert.equal(after.length, 2);
  assert.equal(after[1].startTick, 1920);
  assert.deepEqual(errors, []);
  console.log("PASS: occupied-track Preview, live tempo change, exclusive Play/Record handoff, + MIDI preserves old region, zero browser exceptions");
} finally {
  cdp?.close();
  chrome.kill();
  chrome.once("exit",()=>{try{rmSync(profile,{recursive:true,force:true});}catch{}});
}
