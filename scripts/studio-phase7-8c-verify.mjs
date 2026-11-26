// Verify the production UI and Web Audio graph in a disposable Chromium session.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { CdpClient, sleep, waitForCdp } from "./studio-cdp.mjs";

const port = 9278;
const chrome = spawn(process.env.SY1_CHROME_BIN || "/usr/bin/chromium",
  ["--headless", "--no-sandbox", "--disable-gpu", "--autoplay-policy=no-user-gesture-required",
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
  await cdp.evaluate("SY1_STUDIO.engine.setBpm(120)");
  await click("track-drum-preview");
  await cdp.evaluate("window.__drumDispatch.length = 0; window.SY1_STUDIO.engine.play()");
  await sleep(680);
  assert.equal(await playing(), true);
  const hits = await cdp.evaluate("window.__drumDispatch.filter(hit => hit.event.type === 'noteOn')");
  assert.deepEqual(hits.map(hit => hit.event.tick), [0, 480]);
  assert(hits.every(hit => hit.source === undefined));
  await cdp.evaluate("SY1_STUDIO.engine.stop()");

  await click("track-drum-insert");
  const after = await regions();
  assert.deepEqual(after[0], before[0]);
  assert.equal(after.length, 2);
  assert.equal(after[1].startTick, 1920);
  assert.deepEqual(errors, []);
  console.log("PASS: occupied-track Preview signal and tempo, exclusive Play handoff, + MIDI preserves old region, zero browser exceptions");
} finally {
  cdp?.close();
  chrome.kill();
}
