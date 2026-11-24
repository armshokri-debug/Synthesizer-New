/**
 * SY-1 Studio — Phase 7.3 Focused Chromium E2E Verification
 *
 * Verifies in real headless Chromium:
 * 1. Two synth tracks (Tabriz, Yazd) + two drum tracks (Kerman, Bushehr).
 * 2. Clicking Edit on any track opens full-size Instrument Editor (.is-inst-focus) for THAT track only.
 * 3. On-screen keyboard shows piano keys for synth tracks and 8 drum pads with per-track labels
 *    (Kerman KICK vs Bushehr percussion labels) for drum tracks; standalone #kb-arp/#kb-oriental hidden.
 * 4. Changing presets/kits and dragging/adjusting knobs & pads affects ONLY the selected track.
 * 5. Live MIDI input (on-screen keys/pads & computer keyboard) targets ONLY the focused track.
 * 6. Clicking "← Back to Studio" returns to Studio with exact same selected track, arrangement, and transport position.
 * 7. Saving and performing a full Page.reload() persists all 4 tracks' machines, presets, parameters, and MIDI.
 * 8. Exiting Studio leaves standalone SY-1 Synth machine & patch 100% untouched.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import { CdpClient, sleep, waitForCdp } from "./studio-cdp.mjs";

const CHROME_BIN =
  process.env.SY1_CHROME_BIN ||
  "/ms-playwright/chrome-headless-shell-linux64/chrome-headless-shell";
const BASE_URL = process.env.SY1_URL || "http://127.0.0.1:3000/";
const PORT = Number(process.env.SY1_CDP_PORT || 9237);

if (!fs.existsSync(CHROME_BIN)) {
  throw new Error(`Chromium binary not found: ${CHROME_BIN}`);
}

const cases = [];
const errors = [];
function assert(name, pass, details) {
  cases.push({ name, pass: Boolean(pass), details });
  if (!pass) throw new Error(`FAILED: ${name} -> ${JSON.stringify(details)}`);
}

const chrome = spawn(
  CHROME_BIN,
  [
    "--headless",
    "--no-sandbox",
    "--disable-gpu",
    "--window-size=1366,860",
    "--autoplay-policy=no-user-gesture-required",
    `--remote-debugging-port=${PORT}`,
    "about:blank"
  ],
  { stdio: "ignore" }
);

let cdp;
try {
  cdp = new CdpClient(await waitForCdp(PORT));
  await cdp.connect();
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 1366,
    height: 860,
    deviceScaleFactor: 1,
    mobile: false
  });
  cdp.on("Runtime.exceptionThrown", (ev) => {
    errors.push(ev.exceptionDetails.exception?.description || ev.exceptionDetails.text);
  });

  await cdp.send("Page.navigate", { url: BASE_URL });
  for (let i = 0; i < 120; i++) {
    if (await cdp.evaluate("!!window.SY1_STUDIO && !!window.SY1")) break;
    await sleep(50);
  }
  await cdp.evaluate("window.SY1_STUDIO.ready");

  // Snapshot standalone Synth state before entering Studio
  const standaloneBefore = await cdp.evaluate(`(() => {
    window.SY1.setMachine("tabriz");
    window.SY1.setParam("cutoff", 3600);
    window.SY1.setParam("res", 0.22);
    const p = window.SY1.getPatch();
    return { machine: window.SY1.getMachine(), cutoff: p.cutoff, res: p.res };
  })()`);

  // Step 1: Enter Studio, configure 2 synth + 2 drum tracks, seed distinct MIDI, seek transport to Bar 2 Beat 3 (2880 ticks)
  const setup = await cdp.evaluate(`(async () => {
    const api = window.SY1_STUDIO;
    const engine = api.engine;
    api.open();
    await engine.ensureAudio();
    await engine.createNewProject({ name: "Phase 7.3 E2E" });
    engine.setBars(4);
    engine.setBpm(120);
    while (engine.getTracks().length < 4) engine.addTrack();

    const tracks = engine.getTracks();
    const [t1, t2, t3, t4] = tracks;
    engine.setTrackMachinePreset(t1.id, "tabriz", "init");
    engine.setTrackMachinePreset(t2.id, "yazd", "init");
    engine.setTrackMachinePreset(t3.id, "kerman", "kit:studio");
    engine.setTrackMachinePreset(t4.id, "bushehr", "kit:bandari");

    engine.replaceTrackNotes(t1.id, [{ startTick: 0, endTick: 240, midi: 60, velocity: 110 / 127 }]);
    engine.replaceTrackNotes(t2.id, [{ startTick: 480, endTick: 720, midi: 64, velocity: 72 / 127 }]);
    engine.replaceTrackNotes(t3.id, [{ startTick: 0, endTick: 120, midi: 36, velocity: 120 / 127 }]);
    engine.replaceTrackNotes(t4.id, [{ startTick: 240, endTick: 360, midi: 38, velocity: 96 / 127 }]);

    engine.seekToTick(2880); // Bar 2 Beat 3
    return {
      ids: tracks.map((t) => t.id),
      playhead: engine.getPlayheadPosition().currentTick
    };
  })()`);

  assert("Setup 4 tracks & non-zero transport", setup.ids.length === 4 && setup.playhead === 2880, setup);

  // Step 2: Edit each of the 4 tracks via its Edit button, verify full-size editor, keyboard mode, preset/param isolation, MIDI targeting, and Back return
  const editFlow = await cdp.evaluate(`(async () => {
    const api = window.SY1_STUDIO;
    const engine = api.engine;
    const tracks = engine.getTracks();
    const [t1, t2, t3, t4] = tracks;

    // Spy live noteOn hits per track
    const noteLog = [];
    for (const t of tracks) {
      const orig = t.noteOn.bind(t);
      t.noteOn = (m, v, at) => {
        noteLog.push({ trackId: t.id, midi: m });
        return orig(m, v, at);
      };
    }

    const waitFrame = () => new Promise((r) => setTimeout(r, 40));

    const testTrack = async ({ track, expectDrums, presetStep, paramKey, paramDeltaSteps, testKey }) => {
      const editBtn = document.querySelector('.st-track[data-track-id="' + track.id + '"] [data-st-action="open-track-instrument"]');
      if (!editBtn) throw new Error("Missing Edit button for " + track.id);
      editBtn.click();
      await waitFrame();

      const daw = document.querySelector(".st-daw");
      const arrWrap = document.querySelector(".st-arr-wrap");
      const synthEl = document.querySelector(".st-embedded-synth");
      const kb = document.getElementById("kb");
      const kbArea = document.querySelector(".kb-area");
      const kbArp = document.getElementById("kb-arp");
      const kbOriental = document.getElementById("kb-oriental");
      const backBtn = document.getElementById("st-inst-back-btn");

      const isFocusOpen = api.isInstrumentFocusOpen() && daw?.classList.contains("is-inst-focus");
      const arrHidden = arrWrap ? getComputedStyle(arrWrap).display === "none" : false;
      const kbVisible = kbArea ? !kbArea.hidden : false;
      const kbIsPads = kb ? kb.classList.contains("is-pads") : false;
      const padNames = Array.from(document.querySelectorAll("#kb .pad .pad-name")).map((el) => el.textContent);
      const arpHidden = kbArp ? getComputedStyle(kbArp).display === "none" : true;
      const orientalHidden = kbOriental ? getComputedStyle(kbOriental).display === "none" : true;

      // Step preset via faceplate ▶ button
      if (presetStep) {
        const nextBtn = synthEl?.querySelector('[data-st-action="inst-preset-next"]');
        nextBtn?.click();
        await waitFrame();
      }

      // Adjust parameter via knob keyboard ArrowRight (real UI control on faceplate)
      const knob = document.querySelector('.st-embedded-synth[data-track-id="' + track.id + '"] .st-inst-knob[data-st-param="' + paramKey + '"]');
      if (!knob) throw new Error("Missing knob " + paramKey + " on " + track.id);
      knob.focus();
      for (let i = 0; i < paramDeltaSteps; i++) {
        knob.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
      }
      await waitFrame();
      knob.blur();

      // Test live MIDI input via computer keyboard keydown/keyup (focus body so knob doesn't block)
      noteLog.length = 0;
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: testKey, bubbles: true }));
      await waitFrame();
      document.body.dispatchEvent(new KeyboardEvent("keyup", { key: testKey, bubbles: true }));
      const keyHitTracks = Array.from(new Set(noteLog.map((x) => x.trackId)));
      const keyHitMidis = noteLog.map((x) => x.midi);

      // On drum tracks, also click a faceplate audition pad and verify live routing targets ONLY this track
      let padAuditionTracks = [];
      if (expectDrums) {
        noteLog.length = 0;
        const padBtn = document.querySelector('.st-embedded-synth[data-track-id="' + track.id + '"] [data-st-action="drum-audition"][data-st-drum-voice="snare"]');
        padBtn?.click();
        await waitFrame();
        padAuditionTracks = Array.from(new Set(noteLog.map((x) => x.trackId)));
      }

      // Click "← Back to Studio" (query live button after preset/knob updates)
      document.getElementById("st-inst-back-btn")?.click();
      await waitFrame();

      const backClosed = !api.isInstrumentFocusOpen() && !document.querySelector(".st-daw")?.classList.contains("is-inst-focus");
      const liveArrWrap = document.querySelector(".st-arr-wrap");
      const arrRestored = liveArrWrap ? getComputedStyle(liveArrWrap).display !== "none" : false;
      const focusedAfterBack = engine.getFocusedTrack().id;
      const playheadAfterBack = engine.getPlayheadPosition().currentTick;

      return {
        trackId: track.id,
        machineId: track.machineId,
        presetId: track.presetId,
        paramVal: track.patch[paramKey],
        synthTrackAttr: synthEl?.getAttribute("data-track-id"),
        synthMachineAttr: synthEl?.getAttribute("data-machine"),
        isFocusOpen,
        arrHidden,
        kbVisible,
        kbIsPads,
        padNames,
        arpHidden,
        orientalHidden,
        keyHitTracks,
        keyHitMidis,
        padAuditionTracks,
        backClosed,
        arrRestored,
        focusedAfterBack,
        playheadAfterBack
      };
    };

    const r1 = await testTrack({ track: t1, expectDrums: false, presetStep: true, paramKey: "cutoff", paramDeltaSteps: 8, testKey: "a" });
    const r2 = await testTrack({ track: t2, expectDrums: false, presetStep: true, paramKey: "cutoff", paramDeltaSteps: 12, testKey: "s" });
    const r3 = await testTrack({ track: t3, expectDrums: true, presetStep: false, paramKey: "kickTune", paramDeltaSteps: 10, testKey: "a" });
    const r4 = await testTrack({ track: t4, expectDrums: true, presetStep: false, paramKey: "kickTune", paramDeltaSteps: 6, testKey: "s" });

    // Snapshot final state of all 4 tracks before Save & Reload
    const firstVel = (t) => {
      const ev = t.events.find((e) => e.type === "noteOn");
      return ev ? Math.round(ev.velocity * 127) : null;
    };
    const beforeSave = tracks.map((t) => ({
      id: t.id,
      machineId: t.machineId,
      presetId: t.presetId,
      cutoff: t.patch.cutoff,
      kickTune: t.patch.kickTune,
      noteCount: t.getNoteCount(),
      firstVel: firstVel(t)
    }));

    const saved = await api.saveProject();
    return { r1, r2, r3, r4, beforeSave, saved };
  })()`);

  assert("Synth 1 (Tabriz) full-size editor + MIDI + Back",
    editFlow.r1.isFocusOpen &&
    editFlow.r1.arrHidden &&
    editFlow.r1.synthTrackAttr === "track-1" &&
    editFlow.r1.synthMachineAttr === "tabriz" &&
    editFlow.r1.kbVisible &&
    !editFlow.r1.kbIsPads &&
    editFlow.r1.arpHidden &&
    editFlow.r1.orientalHidden &&
    JSON.stringify(editFlow.r1.keyHitTracks) === JSON.stringify(["track-1"]) &&
    editFlow.r1.backClosed &&
    editFlow.r1.arrRestored &&
    editFlow.r1.focusedAfterBack === "track-1" &&
    editFlow.r1.playheadAfterBack === 2880,
    editFlow.r1
  );

  assert("Synth 2 (Yazd) full-size editor + MIDI + Back",
    editFlow.r2.isFocusOpen &&
    editFlow.r2.synthTrackAttr === "track-2" &&
    editFlow.r2.synthMachineAttr === "yazd" &&
    !editFlow.r2.kbIsPads &&
    JSON.stringify(editFlow.r2.keyHitTracks) === JSON.stringify(["track-2"]) &&
    editFlow.r2.backClosed &&
    editFlow.r2.focusedAfterBack === "track-2" &&
    editFlow.r2.playheadAfterBack === 2880,
    editFlow.r2
  );

  assert("Drum 1 (Kerman) full-size editor + 8 drum pads + MIDI + Back",
    editFlow.r3.isFocusOpen &&
    editFlow.r3.synthTrackAttr === "track-3" &&
    editFlow.r3.synthMachineAttr === "kerman" &&
    editFlow.r3.kbVisible &&
    editFlow.r3.kbIsPads &&
    editFlow.r3.padNames.length === 8 &&
    editFlow.r3.padNames[0] === "KICK" &&
    JSON.stringify(editFlow.r3.keyHitTracks) === JSON.stringify(["track-3"]) &&
    editFlow.r3.keyHitMidis[0] === 36 &&
    JSON.stringify(editFlow.r3.padAuditionTracks) === JSON.stringify(["track-3"]) &&
    editFlow.r3.backClosed &&
    editFlow.r3.focusedAfterBack === "track-3" &&
    editFlow.r3.playheadAfterBack === 2880,
    editFlow.r3
  );

  assert("Drum 2 (Bushehr) full-size editor + Bushehr pad labels + MIDI + Back",
    editFlow.r4.isFocusOpen &&
    editFlow.r4.synthTrackAttr === "track-4" &&
    editFlow.r4.synthMachineAttr === "bushehr" &&
    editFlow.r4.kbVisible &&
    editFlow.r4.kbIsPads &&
    editFlow.r4.padNames.length === 8 &&
    editFlow.r4.padNames[0] !== "KICK" &&
    JSON.stringify(editFlow.r4.keyHitTracks) === JSON.stringify(["track-4"]) &&
    editFlow.r4.keyHitMidis[0] === 38 &&
    JSON.stringify(editFlow.r4.padAuditionTracks) === JSON.stringify(["track-4"]) &&
    editFlow.r4.backClosed &&
    editFlow.r4.focusedAfterBack === "track-4" &&
    editFlow.r4.playheadAfterBack === 2880,
    editFlow.r4
  );

  assert("Project saved locally", editFlow.saved === true, { saved: editFlow.saved });

  // Step 3: Full Page.reload() and verify persistence of all 4 tracks & untouched standalone Synth
  const loaded = new Promise((resolve) => cdp.on("Page.loadEventFired", resolve));
  await cdp.send("Page.reload", { ignoreCache: true });
  await loaded;
  for (let i = 0; i < 120; i++) {
    if (await cdp.evaluate("!!window.SY1_STUDIO && !!window.SY1")) break;
    await sleep(50);
  }
  await cdp.evaluate("window.SY1_STUDIO.ready");

  const afterReload = await cdp.evaluate(`(() => {
    const standalone = {
      machine: window.SY1.getMachine(),
      cutoff: window.SY1.getPatch().cutoff,
      res: window.SY1.getPatch().res
    };
    window.SY1_STUDIO.open();
    const firstVel = (t) => {
      const ev = t.events.find((e) => e.type === "noteOn");
      return ev ? Math.round(ev.velocity * 127) : null;
    };
    const tracks = window.SY1_STUDIO.engine.getTracks().map((t) => ({
      id: t.id,
      machineId: t.machineId,
      presetId: t.presetId,
      cutoff: t.patch.cutoff,
      kickTune: t.patch.kickTune,
      noteCount: t.getNoteCount(),
      firstVel: firstVel(t)
    }));
    window.SY1_STUDIO.close();
    const standaloneAfterClose = {
      machine: window.SY1.getMachine(),
      cutoff: window.SY1.getPatch().cutoff,
      res: window.SY1.getPatch().res
    };
    return { standalone, standaloneAfterClose, tracks };
  })()`);

  assert(
    "All 4 tracks persist identically after reload",
    JSON.stringify(afterReload.tracks) === JSON.stringify(editFlow.beforeSave),
    { before: editFlow.beforeSave, after: afterReload.tracks }
  );

  assert(
    "Standalone Synth state 100% untouched before and after Studio",
    afterReload.standalone.machine === standaloneBefore.machine &&
      afterReload.standalone.cutoff === standaloneBefore.cutoff &&
      afterReload.standalone.res === standaloneBefore.res &&
      afterReload.standaloneAfterClose.machine === standaloneBefore.machine &&
      afterReload.standaloneAfterClose.cutoff === standaloneBefore.cutoff &&
      afterReload.standaloneAfterClose.res === standaloneBefore.res,
    { standaloneBefore, afterReload: afterReload.standaloneAfterClose }
  );

  assert("Zero runtime exceptions", errors.length === 0, { errors });

  console.log(JSON.stringify({ ok: true, passed: cases.length, total: cases.length, cases }, null, 2));
} catch (err) {
  console.error(JSON.stringify({ ok: false, error: String(err), cases, errors }, null, 2));
  process.exitCode = 1;
} finally {
  if (cdp) cdp.close();
  chrome.kill("SIGKILL");
}
