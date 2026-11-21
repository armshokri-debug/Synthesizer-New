/**
 * SY-1 Studio — Real Headless Chromium Web Audio & UI Verification Script
 *
 * Drives the installed /ms-playwright/chrome-headless-shell-linux64 directly over
 * Chrome DevTools Protocol (CDP) using Node's built-in HTTP + WebSocket APIs.
 *
 * Executes real browser tests:
 *  - Standalone SY-1 regression smoke test
 *  - A2: Real Chromium OfflineAudioContext + AudioWorklet ("sy1-voices") + SynthFXBus sound parity
 *  - B2/B3: Real Chromium OfflineAudioContext track isolation under preset/cutoff/FX sweeps
 *  - E2: Real Chromium OfflineAudioContext 24-bit Stereo PCM WAV arrangement bounce
 *  - Studio UI end-to-end interaction test (open/close, 2 tracks, preset/cutoff isolation,
 *    bars 8/12/64/128/custom, transport play/stop/record, standalone state preservation)
 */

import { spawn } from "node:child_process";
import fs from "node:fs";

const CHROME_BIN = "/ms-playwright/chrome-headless-shell-linux64/chrome-headless-shell";
const TARGET_URL = process.env.SY1_URL || "http://127.0.0.1:3000";
const CDP_PORT = 9223;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForCdp(port, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      if (res.ok) {
        const list = await res.json();
        const page = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
        if (page) return page.webSocketDebuggerUrl;
      }
    } catch {}
    await sleep(150);
  }
  throw new Error(`Timed out waiting for CDP on port ${port}`);
}

class CdpClient {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.id = 0;
    this.pending = new Map();
    this.listeners = new Map();
  }

  async connect() {
    this.ws = new WebSocket(this.wsUrl);
    await new Promise((resolve, reject) => {
      this.ws.addEventListener("open", () => resolve());
      this.ws.addEventListener("error", (e) => reject(e));
    });
    this.ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        else resolve(msg.result);
      } else if (msg.method) {
        const list = this.listeners.get(msg.method);
        if (list) list.forEach((fn) => fn(msg.params));
      }
    });
  }

  on(method, fn) {
    let list = this.listeners.get(method);
    if (!list) {
      list = [];
      this.listeners.set(method, list);
    }
    list.push(fn);
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const res = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true
    });
    if (res.exceptionDetails) {
      const desc = res.exceptionDetails.exception?.description || res.exceptionDetails.text;
      throw new Error(`Browser eval exception: ${desc}`);
    }
    return res.result?.value;
  }

  close() {
    try { this.ws?.close(); } catch {}
  }
}

async function main() {
  if (!fs.existsSync(CHROME_BIN)) {
    throw new Error(`Chromium headless shell not found at ${CHROME_BIN}`);
  }

  const chrome = spawn(
    CHROME_BIN,
    [
      "--headless",
      "--no-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--autoplay-policy=no-user-gesture-required",
      "--enable-precise-memory-info",
      `--remote-debugging-port=${CDP_PORT}`,
      "--window-size=1280,840",
      "about:blank"
    ],
    { stdio: ["ignore", "pipe", "pipe"] }
  );

  const pageErrors = [];
  const consoleErrors = [];
  let cdp = null;

  try {
    const wsUrl = await waitForCdp(CDP_PORT);
    cdp = new CdpClient(wsUrl);
    await cdp.connect();

    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Log.enable");

    cdp.on("Runtime.exceptionThrown", (p) => {
      const desc = p.exceptionDetails?.exception?.description || p.exceptionDetails?.text || "unknown";
      pageErrors.push(desc);
    });
    cdp.on("Runtime.consoleAPICalled", (p) => {
      if (p.type === "error") {
        const text = (p.args || []).map((a) => a.value ?? a.description ?? "").join(" ");
        // Ignore expected Vite HMR WebSocket error in this environment
        if (!text.includes("WebSocket") && !text.includes("ws://")) {
          consoleErrors.push(text);
        }
      }
    });

    const loadDone = new Promise((resolve) => cdp.on("Page.loadEventFired", resolve));
    await cdp.send("Page.navigate", { url: TARGET_URL });
    await loadDone;
    await sleep(400);

    // 1. Standalone SY-1 regression check
    const standalone = await cdp.evaluate(`(() => {
      const panelVisible = !document.getElementById("sy1-panel").hidden;
      const studioHidden = document.getElementById("sy1-studio").hidden;
      const studioBtn = !!document.getElementById("open-studio-btn");
      const hasSy1 = !!window.SY1 && !!window.SY1_STUDIO;
      window.SY1.setMachine("sy1");
      window.SY1.applyPreset("warmPad");
      const warmCutoff = window.SY1.getPatch().cutoff;
      window.SY1.setParam("cutoff", 1950);
      const editedCutoff = window.SY1.getPatch().cutoff;
      return { panelVisible, studioHidden, studioBtn, hasSy1, warmCutoff, editedCutoff };
    })()`);

    // 2. A2: Real Chromium OfflineAudioContext + AudioWorklet Sound Parity across 6 presets
    const parityResults = await cdp.evaluate(`(async () => {
      const presets = ["init", "warmPad", "acidBass", "moogBass", "superSaw", "pluck"];
      const out = [];
      for (const id of presets) {
        const m = await window.SY1_STUDIO.diagnostics.runOfflineParityProbe(id, 48000, 0.5);
        out.push({
          ...m,
          chainRmsDiffDb: Number.isFinite(m.chainRmsDiffDb) ? Number(m.chainRmsDiffDb.toFixed(2)) : -999,
          fullRmsLevelDiffDb: Number(m.fullRmsLevelDiffDb.toFixed(3)),
          fullStandaloneSelfRmsDiffDb: Number(m.fullStandaloneSelfRmsDiffDb.toFixed(3))
        });
      }
      return out;
    })()`);

    // 3. B2/B3: Real Chromium OfflineAudioContext Track Isolation
    const isolation = await cdp.evaluate(`(async () => {
      const m = await window.SY1_STUDIO.diagnostics.runOfflineIsolationProbe(48000, 0.5);
      return {
        ...m,
        rmsDiffDbTrack2: Number.isFinite(m.rmsDiffDbTrack2) ? Number(m.rmsDiffDbTrack2.toFixed(2)) : -999,
        fullRevRmsDiffDb: Number(m.fullRevRmsDiffDb.toFixed(3))
      };
    })()`);

    // 4. E2: Real Chromium OfflineAudioContext 24-bit Stereo WAV Bounce
    const bounce = await cdp.evaluate(`(async () => {
      return await window.SY1_STUDIO.diagnostics.runOfflineBounceProbe(120, 2, 48000);
    })()`);

    // 5. Studio UI & Interactive E2E Smoke Test (plus standalone preservation)
    const uiCheck = await cdp.evaluate(`(async () => {
      const standaloneBefore = { ...window.SY1.getPatch() };
      document.getElementById("open-studio-btn").click();
      await new Promise((r) => setTimeout(r, 80));

      const studioOpen = window.SY1_STUDIO.isOpen();
      const studioVisible = !document.getElementById("sy1-studio").hidden;
      const synthHidden = document.getElementById("sy1-panel").hidden;
      const trackEls = document.querySelectorAll("#sy1-studio .st-track");
      const trackCount = trackEls.length;

      const eng = window.SY1_STUDIO.engine;
      const [t1, t2] = eng.getTracks();
      const t2BeforeCutoff = t2.patch.cutoff;
      const t2BeforePreset = t2.presetId;

      // Change Track 1 preset via DOM select and cutoff via engine
      const sel1 = document.querySelector('select[data-st-select="preset"][data-track-id="track-1"]');
      sel1.value = "acidBass";
      sel1.dispatchEvent(new Event("change", { bubbles: true }));
      t1.setParam("cutoff", 240);

      // Test bar length presets & custom input
      for (const b of [8, 12, 64, 128]) {
        const btn = document.querySelector('button[data-st-action="set-bars"][data-st-bars="' + b + '"]');
        btn.click();
      }
      const customBars = document.getElementById("st-bars-custom");
      customBars.value = "16";
      customBars.dispatchEvent(new Event("change", { bubbles: true }));
      const barsAfterCustom = eng.getTransportSnapshot().bars;

      // Test MIDI export bytes
      const midiBytes = eng.exportMidiBytes("Chromium Test");
      const midiHeader = String.fromCharCode(midiBytes[0], midiBytes[1], midiBytes[2], midiBytes[3]);

      // Test live recording into Track 1 + stop
      await eng.record();
      eng.liveNoteOn(60, 0.85);
      await new Promise((r) => setTimeout(r, 120));
      eng.liveNoteOff(60);
      await eng.stop();
      const t1NotesAfterRec = t1.getNoteCount();
      const t2NotesAfterRec = t2.getNoteCount();
      const hasLiveTake = eng.getTransportSnapshot().hasLiveTake;
      const liveTakeDur = eng.getTransportSnapshot().liveTakeDurationSec;

      // Return to Synth view and verify standalone state was never altered
      document.getElementById("st-back-btn").click();
      await new Promise((r) => setTimeout(r, 80));
      const backToSynth = !document.getElementById("sy1-panel").hidden && document.getElementById("sy1-studio").hidden;
      const standaloneAfter = window.SY1.getPatch();
      const standaloneIntact = standaloneAfter.cutoff === standaloneBefore.cutoff && standaloneAfter.osc1Wave === standaloneBefore.osc1Wave;

      const mem = performance.memory ? {
        usedMB: Number((performance.memory.usedJSHeapSize / 1048576).toFixed(2)),
        totalMB: Number((performance.memory.totalJSHeapSize / 1048576).toFixed(2))
      } : null;

      return {
        studioOpen,
        studioVisible,
        synthHidden,
        trackCount,
        t1Cutoff: t1.patch.cutoff,
        t2CutoffUnchanged: t2.patch.cutoff === t2BeforeCutoff,
        t2PresetUnchanged: t2.presetId === t2BeforePreset,
        barsAfterCustom,
        midiHeader,
        t1NotesAfterRec,
        t2NotesAfterRec,
        hasLiveTake,
        liveTakeDur: Number(liveTakeDur.toFixed(3)),
        backToSynth,
        standaloneIntact,
        mem
      };
    })()`);

    const report = {
      standalone,
      parityResults,
      isolation,
      bounce,
      uiCheck,
      pageErrors,
      consoleErrors
    };

    console.log(JSON.stringify(report, null, 2));

    // Strict assertions
    const failures = [];
    if (pageErrors.length) failures.push(`Page errors: ${pageErrors.join("; ")}`);
    if (consoleErrors.length) failures.push(`Console errors: ${consoleErrors.join("; ")}`);
    if (!standalone.panelVisible || !standalone.studioHidden || !standalone.studioBtn || !standalone.hasSy1) {
      failures.push("Standalone regression check failed");
    }
    for (const p of parityResults) {
      if (!(p.chainRefPeak > 0.01)) failures.push(`Parity preset ${p.presetId} silent`);
      // A2a: Strict bit-exact chain parity (HQEngine + drive + EQ + delay + chorus + limiter + softClip + track strip + StudioMasterBus)
      if (!(p.chainMaxAbsDiff <= 1e-6)) failures.push(`Parity preset ${p.presetId} chainMaxAbsDiff=${p.chainMaxAbsDiff}`);
      // A2b: Full untouched preset including Freeverb (within Chromium cyclic-graph HashSet pull-order bucket spread)
      if (!(p.fullStudioRms > 0.005) || !(Math.abs(p.fullRmsLevelDiffDb) <= 2.5)) {
        failures.push(`Parity preset ${p.presetId} fullRmsLevelDiffDb=${p.fullRmsLevelDiffDb}`);
      }
    }
    if (!(isolation.track2Peak > 0.01)) failures.push("Isolation Track 2 silent");
    if (!(isolation.maxAbsDiffTrack2 <= 1e-6)) failures.push(`Isolation Track 2 leaked: ${isolation.maxAbsDiffTrack2}`);
    if (!(Math.abs(isolation.fullRevRmsDiffDb) <= 2.5)) {
      failures.push(`Isolation full-reverb RMS shifted: ${isolation.fullRevRmsDiffDb} dB`);
    }
    if (!isolation.track1Differs) failures.push("Isolation Track 1 cutoff sweep had no effect");
    if (bounce.riff !== "RIFF" || bounce.wave !== "WAVE" || bounce.audioFormat !== 1 || bounce.channels !== 2 || bounce.bitsPerSample !== 24 || bounce.sampleRate !== 48000) {
      failures.push("Bounce WAV header mismatch");
    }
    if (bounce.frames !== bounce.expectedFrames) {
      failures.push(`Bounce WAV frame count mismatch: ${bounce.frames} vs ${bounce.expectedFrames}`);
    }
    if (!(bounce.peakL > 0.02 && bounce.peakR > 0.02)) {
      failures.push(`Bounce WAV signal too quiet: L=${bounce.peakL}, R=${bounce.peakR}`);
    }
    if (!uiCheck.studioOpen || !uiCheck.studioVisible || !uiCheck.synthHidden || uiCheck.trackCount !== 2) {
      failures.push("Studio UI mount/track count check failed");
    }
    if (!uiCheck.t2CutoffUnchanged || !uiCheck.t2PresetUnchanged || !uiCheck.standaloneIntact) {
      failures.push("UI isolation or standalone preservation failed");
    }
    if (uiCheck.barsAfterCustom !== 16 || uiCheck.midiHeader !== "MThd" || uiCheck.t1NotesAfterRec < 1 || uiCheck.t2NotesAfterRec !== 0) {
      failures.push("UI bars/MIDI/recording check failed");
    }
    if (!uiCheck.backToSynth) failures.push("Returning to Synth view failed");

    if (failures.length > 0) {
      console.error("VERIFICATION FAILURES:\n - " + failures.join("\n - "));
      process.exitCode = 1;
    } else {
      console.log("ALL REAL CHROMIUM WEB AUDIO & UI VERIFICATION CHECKS PASSED!");
    }
  } finally {
    cdp?.close();
    try { chrome.kill("SIGKILL"); } catch {}
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
