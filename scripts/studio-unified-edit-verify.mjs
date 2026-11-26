// Acceptance gate for GarageBand-style instrument/arrangement integration.
// Run against a disposable local production build, not the published project.
// Reference: https://support.apple.com/en-nz/guide/garageband-ipad/chs157aec9e/ipados
// Reference: https://support.apple.com/en-ph/guide/garageband-ipad/chs2a762fad/ipados
// This is intentionally a new acceptance gate, not evidence of a passing build.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { CdpClient, sleep, waitForCdp } from "./studio-cdp.mjs";

const port = 9281;
const chrome = spawn(process.env.SY1_CHROME_BIN || "/usr/bin/chromium",
  ["--headless", "--no-sandbox", "--disable-gpu",
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
  const baseline = await cdp.evaluate(`(async () => {
    await SY1_STUDIO.ready;
    window.__originalInstrumentHost = document.getElementById("sy1-panel");
    const panel = document.querySelector("#sy1-panel .synth-panel");
    const keys = [...panel.querySelectorAll(".sk")].map(el => el.getAttribute("data-param") || el.getAttribute("data-st-param"));
    const machine = panel.dataset.machine;
    SY1_STUDIO.open();
    const e = SY1_STUDIO.engine;
    const a = e.getFocusedTrack();
    const b = e.getTracks().find(t => t.id !== a.id) || e.addTrack();
    if (!b) throw new Error("Two independent tracks required");
    e.setTrackMachine(a.id, machine);
    e.setTrackMachine(b.id, machine);
    e.setBpm(93);
    e.seekToTick(480);
    return { machine, keys, a: a.id, b: b.id, bpm: e.getBpm(), tick: e.getCurrentTick(),
      bPatch: JSON.parse(JSON.stringify(b.patch)),
      regions: e.getTracks().map(t => [t.id,e.regions.regions(t.id)]) };
  })()`);
  assert(baseline.keys.length > 0, "Original instrument must expose its controls");

  const inspect = () => cdp.evaluate(`(() => {
    const e = SY1_STUDIO.engine;
    const root = document.getElementById("sy1-panel");
    const panel = root.querySelector(".synth-panel");
    const visible = !!panel && !root.hidden && panel.getClientRects().length > 0;
    return { visible, sameHost: root === window.__originalInstrumentHost, active: e.isActive(), focused: e.getFocusedTrack().id,
      machine: panel?.dataset.machine,
      keys: panel ? [...panel.querySelectorAll(".sk")].map(el => el.getAttribute("data-param") || el.getAttribute("data-st-param")) : [],
      bpm: e.getBpm(), tick: e.getCurrentTick(),
      regions: e.getTracks().map(t => [t.id,e.regions.regions(t.id)]) };
  })()`);
  const edit = id => cdp.evaluate(`document.querySelector('[data-st-action="open-track-instrument"][data-track-id=' + CSS.escape(${JSON.stringify(id)}) + ']').click()`);
  await edit(baseline.a);
  let view = await inspect();
  assert(view.visible && view.sameHost, "Edit must reuse the original instrument host element");
  assert(view.active, "Edit must keep the Studio project active");
  assert.equal(view.focused, baseline.a);
  assert.equal(view.machine, baseline.machine);
  assert.deepEqual(view.keys, baseline.keys, "Original controls must be retained");
  assert.equal(view.bpm, baseline.bpm);
  assert.equal(view.tick, baseline.tick);
  assert.deepEqual(view.regions, baseline.regions);

  // Exercise a real faceplate control via its existing keyboard interaction.
  const editResult = await cdp.evaluate(`(() => {
    const e = SY1_STUDIO.engine;
    const t = e.getFocusedTrack();
    const knobs = [...document.querySelectorAll("#sy1-panel .sk")].filter(k => k.getClientRects().length);
    for (const k of knobs) {
      const key = k.getAttribute("data-param") || k.getAttribute("data-st-param");
      if (!key || typeof t.patch[key] !== "number") continue;
      const before = t.patch[key];
      k.dispatchEvent(new KeyboardEvent("keydown", {key:"ArrowUp",bubbles:true,cancelable:true}));
      if (t.patch[key] !== before) return {key, before, after:t.patch[key]};
      k.dispatchEvent(new KeyboardEvent("keydown", {key:"ArrowDown",bubbles:true,cancelable:true}));
      if (t.patch[key] !== before) return {key, before, after:t.patch[key]};
    }
    return null;
  })()`);
  assert(editResult, "Original instrument control must edit the selected track directly");
  const back = () => cdp.evaluate(`(() => {
    const button = document.querySelector("#sy1-panel #open-studio-btn");
    if (!button || !button.getClientRects().length) throw new Error("Original Studio button unavailable");
    button.click();
  })()`);
  await back();
  view = await inspect();
  assert(!view.visible && view.sameHost && view.active, "Studio button must restore the same host and active arrangement");
  assert.equal(view.tick, baseline.tick);
  assert.equal(view.bpm, baseline.bpm);
  assert.deepEqual(view.regions, baseline.regions);

  await edit(baseline.b);
  view = await inspect();
  assert(view.visible && view.active);
  assert.equal(view.focused, baseline.b);
  const states = await cdp.evaluate(`(() => {
    const e = SY1_STUDIO.engine;
    return {a:e.getTrack(${JSON.stringify(baseline.a)}).patch[${JSON.stringify(editResult.key)}],
      b:JSON.parse(JSON.stringify(e.getTrack(${JSON.stringify(baseline.b)}).patch))};
  })()`);
  assert.equal(states.a, editResult.after, "Track A edit must persist");
  assert.deepEqual(states.b, baseline.bPatch, "Track B must not inherit Track A edits");
  await back();
  assert.deepEqual((await inspect()).regions, baseline.regions);
  assert.deepEqual(errors, []);
  console.log("PASS: original instrument Edit, track isolation and lossless return to arrangement");
} finally {
  cdp?.close();
  chrome.kill();
}
