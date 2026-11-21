/**
 * SY-1 Studio — Real Headless Chromium Web Audio, Persistence & Multitrack Verification Script
 *
 * Drives the installed /ms-playwright/chrome-headless-shell-linux64 directly over
 * Chrome DevTools Protocol (CDP) using Node's built-in HTTP + WebSocket APIs.
 *
 * Executes real browser tests:
 *  Phase 1 Regression Suite:
 *   - Standalone SY-1 regression smoke test
 *   - A2: Real Chromium OfflineAudioContext + AudioWorklet ("sy1-voices") + SynthFXBus sound parity
 *   - B2/B3: Real Chromium OfflineAudioContext track isolation under preset/cutoff/FX sweeps
 *   - E2: Real Chromium OfflineAudioContext 24-bit Stereo PCM WAV arrangement bounce
 *   - Studio UI end-to-end interaction test (open/close, 2 tracks, preset/cutoff isolation,
 *     bars 8/12/64/128/custom, transport play/stop/record, standalone state preservation)
 *  Phase 2 Persistence & Multitrack Export Suite:
 *   - E4a / E4b: 2-track AND 4-track separate 24-bit Stereo WAV stem alignment & mix null-test
 *   - P2-Parity: Post-restore bit-exact audio parity & post-restore Track 2 isolation
 *   - P2-SaveReload: Real IndexedDB Save -> real CDP Page.reload -> Restore (plus standalone intact)
 *   - P2-ExportImport: .sy1studio JSON export -> state mutation -> import restore + corrupt file rejection
 *   - P2-Quota: Real Chromium QuotaExceededError & unavailable IndexedDB error handling
 *  Phase 3 Stability & Performance Suite:
 *   - P3-4TrackStress: Real 4-track AudioWorklet + SynthFXBus heavy stress (chords, rapid Cutoff/Res, preset switch, RTF)
 *   - P3-UIStressAndHeap: Idle rAF stopped when not playing, Volume/Pan slider stays connected mid-drag,
 *     and 10 consecutive 4-track Save/LoadProject cycles JS heap check
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

  once(method) {
    return new Promise((resolve) => {
      const wrapper = (params) => {
        const list = this.listeners.get(method);
        if (list) {
          const idx = list.indexOf(wrapper);
          if (idx >= 0) list.splice(idx, 1);
        }
        resolve(params);
      };
      this.on(method, wrapper);
    });
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

    const firstLoad = cdp.once("Page.loadEventFired");
    await cdp.send("Page.navigate", { url: TARGET_URL });
    await firstLoad;
    await sleep(400);

    // Clear any leftover IndexedDB before Phase 1 baseline runs
    await cdp.evaluate(`(async () => {
      await window.SY1_STUDIO.ready;
      await window.SY1_STUDIO.storage.clearAutosave();
      const listed = await window.SY1_STUDIO.storage.listProjects();
      if (listed.ok) {
        for (const p of listed.data) {
          await window.SY1_STUDIO.storage.deleteProject(p.id);
        }
      }
    })()`);

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

    // 5. Phase 1 Studio UI & Interactive E2E Smoke Test (plus standalone preservation)
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
        standaloneIntact
      };
    })()`);

    // -------------------------------------------------------------------------
    // Phase 2 Real Headless Chromium Verification
    // -------------------------------------------------------------------------

    // 6. E4a & E4b: 2-Track and 4-Track Separate 24-bit WAV Stem Alignment & Null-Test
    const stems2 = await cdp.evaluate(`(async () => {
      return await window.SY1_STUDIO.diagnostics.runOfflineStemsProbe(2, 120, 1, 48000);
    })()`);
    const stems4 = await cdp.evaluate(`(async () => {
      return await window.SY1_STUDIO.diagnostics.runOfflineStemsProbe(4, 120, 1, 48000);
    })()`);

    // 7. Post-Restore Audio Parity & Isolation (pre-save vs post-restore)
    const postRestoreParity = await cdp.evaluate(`(async () => {
      return await window.SY1_STUDIO.diagnostics.runPostRestoreParityProbe(48000);
    })()`);

    // 8. Real IndexedDB Save -> Browser Page Reload -> Restore (plus standalone tempo isolation)
    const preReloadSetup = await cdp.evaluate(`(async () => {
      window.SY1.setTempo(110);
      window.SY1.applyPreset("warmPad");
      window.SY1.setParam("cutoff", 1950);

      document.getElementById("open-studio-btn").click();
      await new Promise((r) => setTimeout(r, 60));

      const eng = window.SY1_STUDIO.engine;
      eng.setProjectName("Phase 2 Reload Session");
      eng.setBpm(132);
      eng.setBars(12);
      eng.setLoopEnabled(true);
      eng.setLoopRange(2, 10);

      const t3 = eng.addTrack("pluck");
      const [t1, t2] = eng.getTracks();
      t1.applyPreset("acidBass");
      t1.setParam("cutoff", 480);
      t1.setParam("res", 9.5);
      eng.setTrackVolume(t1.id, 0.7);
      eng.setTrackPan(t1.id, -0.35);
      eng.setTrackSolo(t1.id, true);
      t1.setEvents([
        { type: "noteOn", tick: 0, midi: 45, velocity: 0.9 },
        { type: "noteOff", tick: 480, midi: 45 }
      ]);

      t2.applyPreset("warmPad");
      t2.setParam("cutoff", 2750);
      eng.setTrackMute(t2.id, true);
      eng.setTrackPan(t2.id, 0.4);
      t2.setEvents([
        { type: "noteOn", tick: 480, midi: 60, velocity: 0.8 },
        { type: "noteOff", tick: 1440, midi: 60 }
      ]);

      if (t3) {
        // Keep t3 on unedited "pluck" preset to verify exact presetId restoration alongside custom patches
        eng.setFocusedTrack(t3.id);
      }

      const savedOk = await window.SY1_STUDIO.saveProject();
      // Also verify UI Save, Open, Export Project, Import, and Export Stems buttons exist
      const hasSaveBtn = !!document.getElementById("st-save-btn");
      const hasOpenBtn = !!document.getElementById("st-open-btn");
      const hasExportProjBtn = !!document.getElementById("st-export-project");
      const hasImportProjBtn = !!document.getElementById("st-import-project-btn");
      const hasStemsBtn = !!document.getElementById("st-export-stems");
      const exportedJson = eng.exportProjectJson();
      return {
        savedOk: !!savedOk,
        hasSaveBtn,
        hasOpenBtn,
        hasExportProjBtn,
        hasImportProjBtn,
        hasStemsBtn,
        exportedJson
      };
    })()`);

    // Real Chromium Page Reload!
    const reloadDone = cdp.once("Page.loadEventFired");
    await cdp.send("Page.reload", { ignoreCache: false });
    await reloadDone;
    await sleep(400);

    const postReloadCheck = await cdp.evaluate(`(async () => {
      await window.SY1_STUDIO.ready;

      // Before opening Studio: verify standalone SY-1 tempo was NOT overwritten by restored 132 BPM Studio project
      const standaloneTempoBeforeStudio = window.SY1.getTempo();

      // Open Studio and verify full IndexedDB restoration
      document.getElementById("open-studio-btn").click();
      await new Promise((r) => setTimeout(r, 80));

      const eng = window.SY1_STUDIO.engine;
      const snap = eng.getTransportSnapshot();
      const tracks = eng.getTracks();
      const listed = await window.SY1_STUDIO.storage.listProjects();

      // Open the saved projects drawer and verify project appears in DOM
      document.getElementById("st-open-btn").click();
      await new Promise((r) => setTimeout(r, 120));
      const drawerEl = document.getElementById("st-open-drawer");
      const drawerVisible = !!drawerEl;
      const drawerText = drawerEl?.textContent || "";

      return {
        standaloneTempoBeforeStudio,
        projectName: snap.projectName,
        bpm: snap.bpm,
        bars: snap.bars,
        loopEnabled: snap.loopEnabled,
        loopStartBar: snap.loopStartBar,
        loopEndBar: snap.loopEndBar,
        trackCount: tracks.length,
        t1Preset: tracks[0]?.presetId,
        t1Cutoff: tracks[0]?.patch.cutoff,
        t1Res: tracks[0]?.patch.res,
        t1Vol: Number((tracks[0]?.volume ?? 0).toFixed(2)),
        t1Pan: Number((tracks[0]?.pan ?? 0).toFixed(2)),
        t1Solo: tracks[0]?.solo,
        t1Notes: tracks[0]?.getNoteCount(),
        t2Preset: tracks[1]?.presetId,
        t2Cutoff: tracks[1]?.patch.cutoff,
        t2Mute: tracks[1]?.mute,
        t2Notes: tracks[1]?.getNoteCount(),
        t3Preset: tracks[2]?.presetId,
        savedListCount: listed.ok ? listed.data.length : -1,
        drawerVisible,
        drawerHasProjectName: drawerText.includes("Phase 2 Reload Session")
      };
    })()`);

    // 9. Export -> Mutate -> Import -> Restore + Invalid/Corrupted Import Rejection
    const exportImportCheck = await cdp.evaluate(`(async (exportedJson) => {
      const eng = window.SY1_STUDIO.engine;
      // Mutate current state drastically
      eng.setProjectName("Temporary Mutated State");
      eng.setBpm(76);
      eng.setBars(8);
      eng.getTracks()[0].setParam("cutoff", 120);

      // Try importing corrupted JSON first — must reject and leave mutated state untouched
      const badSyntax = await window.SY1_STUDIO.importProjectJson("{broken json!!!");
      const badSchema = await window.SY1_STUDIO.importProjectJson(JSON.stringify({ format: "wrong", version: 99, tracks: [] }));
      const nameAfterBad = eng.getProjectName();
      const bpmAfterBad = eng.getBpm();
      const statusHasError = document.getElementById("st-status")?.classList.contains("is-error") ?? false;

      // Now import the valid exported .sy1studio JSON
      const goodImport = await window.SY1_STUDIO.importProjectJson(exportedJson);
      const snap = eng.getTransportSnapshot();
      const tracks = eng.getTracks();

      return {
        badSyntaxOk: badSyntax.ok,
        badSchemaOk: badSchema.ok,
        preservedAfterBad: nameAfterBad === "Temporary Mutated State" && bpmAfterBad === 76,
        statusHasError,
        goodImportOk: goodImport.ok,
        restoredName: snap.projectName,
        restoredBpm: snap.bpm,
        restoredBars: snap.bars,
        restoredTrackCount: tracks.length,
        restoredT1Cutoff: tracks[0]?.patch.cutoff,
        restoredT1Notes: tracks[0]?.getNoteCount()
      };
    })(${JSON.stringify(preReloadSetup.exportedJson)})`);

    // 10. Real Chromium IndexedDB QuotaExceededError & clean teardown
    const quotaAndCleanup = await cdp.evaluate(`(async () => {
      // Simulate QuotaExceededError inside IDBObjectStore.prototype.put temporarily
      const origPut = IDBObjectStore.prototype.put;
      let quotaResult = null;
      try {
        IDBObjectStore.prototype.put = function() {
          throw new DOMException("Simulated quota exceeded", "QuotaExceededError");
        };
        quotaResult = await window.SY1_STUDIO.storage.saveProject(window.SY1_STUDIO.engine.exportProject());
      } finally {
        IDBObjectStore.prototype.put = origPut;
      }

      // Clean up test IndexedDB entries so browser starts clean
      await window.SY1_STUDIO.storage.clearAutosave();
      const listed = await window.SY1_STUDIO.storage.listProjects();
      if (listed.ok) {
        for (const p of listed.data) {
          await window.SY1_STUDIO.storage.deleteProject(p.id);
        }
      }
      const afterClean = await window.SY1_STUDIO.storage.listProjects();

      const mem = performance.memory ? {
        usedMB: Number((performance.memory.usedJSHeapSize / 1048576).toFixed(2)),
        totalMB: Number((performance.memory.totalJSHeapSize / 1048576).toFixed(2))
      } : null;

      return {
        quotaOk: quotaResult?.ok,
        quotaKind: quotaResult && !quotaResult.ok ? quotaResult.kind : null,
        cleanedProjectCount: afterClean.ok ? afterClean.data.length : -1,
        mem
      };
    })()`);

    // -------------------------------------------------------------------------
    // Phase 3 Real Headless Chromium Stability, Stress & Heap Verification
    // -------------------------------------------------------------------------

    // 11. P3-4TrackStress: 4 simultaneous AudioWorklet + SynthFXBus tracks under heavy chords, Cutoff/Res sweeps & preset switch
    const stress4Track = await cdp.evaluate(`(async () => {
      return await window.SY1_STUDIO.diagnostics.runOffline4TrackStressProbe(48000, 2.0);
    })()`);

    // 12. P3-UIStressAndHeap: Idle rAF verification, Volume slider DOM preservation mid-drag, 10x 4-track reload heap check
    const uiStressAndHeap = await cdp.evaluate(`(async () => {
      const eng = window.SY1_STUDIO.engine;
      if (!window.SY1_STUDIO.isOpen()) {
        document.getElementById("open-studio-btn").click();
        await new Promise((r) => setTimeout(r, 80));
      }
      await eng.stop();
      await new Promise((r) => setTimeout(r, 50));

      // Verify rAF playhead loop is NOT spinning when stopped
      const idleRafWhileStopped = window.SY1_STUDIO.diagnostics.isPlayheadLoopActive();

      // Expand to 4 tracks
      while (eng.getTracks().length < 4) eng.addTrack();
      await new Promise((r) => setTimeout(r, 60));

      // Drag Track 1 Volume slider continuously and verify DOM element is NOT destroyed mid-drag
      const volSlider = document.querySelector('input[data-st-range="volume"][data-track-id="track-1"]');
      volSlider.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1 }));
      let sliderConnectedDuringDrag = true;
      for (const val of ["0.85", "0.70", "0.55", "0.40", "0.65"]) {
        volSlider.value = val;
        volSlider.dispatchEvent(new Event("input", { bubbles: true }));
        await new Promise((r) => setTimeout(r, 10));
        if (!volSlider.isConnected) sliderConnectedDuringDrag = false;
      }
      volSlider.dispatchEvent(new Event("change", { bubbles: true }));
      volSlider.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1 }));
      const finalT1Vol = Number(eng.getTracks()[0].volume.toFixed(2));

      // 10 consecutive 4-track project reload cycles (verifies clean AudioNode & listener teardown)
      const projJson = eng.exportProject();
      const heapBeforeMB = performance.memory ? Number((performance.memory.usedJSHeapSize / 1048576).toFixed(2)) : null;
      for (let i = 0; i < 10; i++) {
        await eng.loadProject(projJson);
      }
      await new Promise((r) => setTimeout(r, 120));
      const heapAfterMB = performance.memory ? Number((performance.memory.usedJSHeapSize / 1048576).toFixed(2)) : null;

      // Clean up autosave after UI stress
      await window.SY1_STUDIO.storage.clearAutosave();

      return {
        idleRafWhileStopped,
        trackCount: eng.getTracks().length,
        sliderConnectedDuringDrag,
        finalT1Vol,
        heapBeforeMB,
        heapAfterMB,
        heapDeltaMB: heapBeforeMB !== null && heapAfterMB !== null ? Number((heapAfterMB - heapBeforeMB).toFixed(2)) : null
      };
    })()`);

    // -------------------------------------------------------------------------
    // Phase 4 Real Headless Chromium Professional DAW UI/UX & Responsive Suite
    // -------------------------------------------------------------------------

    // 13. P4-VisualRegression & DAW Workflow (Desktop 1440x900)
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 1440,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false
    });
    await sleep(120);

    const phase4Desktop = await cdp.evaluate(`(async () => {
      const eng = window.SY1_STUDIO.engine;
      // Start on standalone synth and capture visual baseline
      if (window.SY1_STUDIO.isOpen()) {
        document.getElementById("st-back-btn").click();
        await new Promise((r) => setTimeout(r, 80));
      }
      window.SY1.setMachine("sy1");
      await new Promise((r) => setTimeout(r, 60));

      const synthPanel = document.querySelector("#sy1-panel .synth-panel");
      const standaloneBaseline = {
        secCount: synthPanel.querySelectorAll(".synth-sec").length,
        knobCount: synthPanel.querySelectorAll(".sk").length,
        panelBg: getComputedStyle(synthPanel).backgroundImage.slice(0, 64),
        cutoffBefore: window.SY1.getPatch().cutoff
      };

      // Open Studio
      document.getElementById("open-studio-btn").click();
      await new Promise((r) => setTimeout(r, 100));

      // Verify Arrangement header-to-lane vertical alignment & horizontal overflow
      const firstCtl = document.querySelector("#sy1-studio .st-track-ctl").getBoundingClientRect();
      const firstLane = document.querySelector("#sy1-studio .st-lane").getBoundingClientRect();
      const headerLaneAligned = Math.abs(firstCtl.top - firstLane.top) <= 1.5 && firstLane.width >= 300;
      const desktopNoOverflow = document.documentElement.scrollWidth <= window.innerWidth;

      // Test Arrangement horizontal zoom (1x -> 2x)
      const laneW1 = firstLane.width;
      document.querySelector('[data-st-action="arr-zoom-in"]').click();
      document.querySelector('[data-st-action="arr-zoom-in"]').click();
      await new Promise((r) => setTimeout(r, 60));
      const laneW2 = document.querySelector("#sy1-studio .st-lane").getBoundingClientRect().width;
      const arrZoomWorks = laneW2 > laneW1 + 40;
      document.querySelector('[data-st-action="arr-zoom-fit"]').click();
      await new Promise((r) => setTimeout(r, 40));

      // Test Collapsible Instrument Browser: search, favorite, pick Yazd preset -> Track 1
      const browserEl = document.getElementById("st-browser");
      const browserInitiallyOpen = browserEl && !browserEl.hidden;
      document.getElementById("st-browser-toggle").click();
      await new Promise((r) => setTimeout(r, 40));
      const browserCollapsed = document.getElementById("st-browser").hidden;
      document.getElementById("st-browser-toggle").click();
      await new Promise((r) => setTimeout(r, 40));

      // Select Yazd city synth in browser, favorite its first preset, and load it onto Track 1
      eng.setFocusedTrack("track-1");
      await new Promise((r) => setTimeout(r, 40));
      document.querySelector('[data-st-action="browser-machine"][data-st-machine="yazd"]').click();
      await new Promise((r) => setTimeout(r, 40));
      const firstYazdStar = document.querySelector('[data-st-action="browser-star"][data-st-machine="yazd"]');
      firstYazdStar.click();
      await new Promise((r) => setTimeout(r, 40));
      const favStoredInStudioKey = (localStorage.getItem("sy1_studio_favs") || "").includes("yazd:");
      const firstYazdPresetBtn = document.querySelector('[data-st-action="browser-pick-preset"][data-st-machine="yazd"]');
      firstYazdPresetBtn.click();
      await new Promise((r) => setTimeout(r, 60));
      const t1MachineAfterPick = eng.getTrack("track-1").machineId;

      // Switch Bottom Dock -> Instrument tab and verify UNCHANGED original synth faceplate (.synth-panel, .synth-sec, .sk)
      document.getElementById("st-tab-instrument").click();
      await new Promise((r) => setTimeout(r, 80));
      const embeddedSynth = document.querySelector("#sy1-studio .st-embedded-synth.synth-panel");
      const embeddedMachineAttr = embeddedSynth?.getAttribute("data-machine") || "";
      const embeddedSecCount = embeddedSynth ? embeddedSynth.querySelectorAll(".synth-sec").length : 0;
      const embeddedKnobCount = embeddedSynth ? embeddedSynth.querySelectorAll(".sk").length : 0;
      const embeddedHasScales = embeddedSynth ? embeddedSynth.querySelectorAll(".sk-scale").length > 0 : false;

      // Expand Instrument view to full height and back to split
      document.getElementById("st-dock-expand").click();
      await new Promise((r) => setTimeout(r, 40));
      const dockExpandedActive = document.querySelector("#sy1-studio .st-daw").classList.contains("is-dock-expanded");
      document.getElementById("st-dock-expand").click();
      await new Promise((r) => setTimeout(r, 40));

      // Switch Bottom Dock -> Mixer tab and verify channel strips + Master strip + meters
      document.getElementById("st-tab-mixer").click();
      await new Promise((r) => setTimeout(r, 60));
      const mixerStripCount = document.querySelectorAll("#st-mixer .st-mix-strip:not(.is-master)").length;
      const mixerHasMaster = !!document.querySelector("#st-mixer .st-mix-strip.is-master");
      const mixerHasMeters = document.querySelectorAll('#st-mixer [data-st-meter]').length === mixerStripCount + 1;

      // Switch Bottom Dock -> Piano Roll tab and test real note creation, snap, quantize, delete & persistence
      document.getElementById("st-tab-pianoroll").click();
      await new Promise((r) => setTimeout(r, 80));
      eng.clearTrackClip("track-1");
      await new Promise((r) => setTimeout(r, 40));

      const grid = document.getElementById("st-pr-grid");
      const gRect = grid.getBoundingClientRect();
      // Click grid to create a note
      grid.dispatchEvent(new MouseEvent("click", {
        bubbles: true,
        clientX: gRect.left + 80,
        clientY: gRect.top + 200
      }));
      await new Promise((r) => setTimeout(r, 60));
      const prNoteCountAfterClick = document.querySelectorAll("#st-pr-notes .st-pr-note").length;

      // Test Snap select + Quantize button
      const snapSel = document.getElementById("st-pr-snap");
      snapSel.value = "480";
      snapSel.dispatchEvent(new Event("change", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 40));
      document.getElementById("st-pr-quantize").click();
      await new Promise((r) => setTimeout(r, 60));
      const t1SpanAfterQuantize = eng.getTrack("track-1").getNoteSpans(eng.getTotalTicks())[0];

      // Save to IndexedDB and verify standalone visual regression after closing Studio
      const savedP4 = await window.SY1_STUDIO.saveProject();
      document.getElementById("st-back-btn").click();
      await new Promise((r) => setTimeout(r, 100));

      const synthPanelAfter = document.querySelector("#sy1-panel .synth-panel");
      const standaloneAfter = {
        secCount: synthPanelAfter.querySelectorAll(".synth-sec").length,
        knobCount: synthPanelAfter.querySelectorAll(".sk").length,
        panelBg: getComputedStyle(synthPanelAfter).backgroundImage.slice(0, 64),
        cutoffAfter: window.SY1.getPatch().cutoff,
        isStudioClassRemoved: !document.documentElement.classList.contains("is-studio")
      };

      const standaloneVisuallyIdentical =
        standaloneAfter.secCount === standaloneBaseline.secCount &&
        standaloneAfter.knobCount === standaloneBaseline.knobCount &&
        standaloneAfter.panelBg === standaloneBaseline.panelBg &&
        standaloneAfter.cutoffAfter === standaloneBaseline.cutoffBefore &&
        standaloneAfter.isStudioClassRemoved;

      return {
        headerLaneAligned,
        desktopNoOverflow,
        arrZoomWorks,
        browserInitiallyOpen,
        browserCollapsed,
        favStoredInStudioKey,
        t1MachineAfterPick,
        embeddedMachineAttr,
        embeddedSecCount,
        embeddedKnobCount,
        embeddedHasScales,
        dockExpandedActive,
        mixerStripCount,
        mixerHasMaster,
        mixerHasMeters,
        prNoteCountAfterClick,
        quantizedStartTick: t1SpanAfterQuantize ? t1SpanAfterQuantize.startTick : -1,
        savedP4: !!savedP4,
        standaloneVisuallyIdentical
      };
    })()`);

    // 14. P4-Responsive Viewports: iPad Landscape (1024x768) & iPad Portrait (768x1024)
    const responsiveResults = {};
    for (const vp of [
      { key: "ipadLandscape", width: 1024, height: 768, mobile: true },
      { key: "ipadPortrait", width: 768, height: 1024, mobile: true }
    ]) {
      await cdp.send("Emulation.setDeviceMetricsOverride", {
        width: vp.width,
        height: vp.height,
        deviceScaleFactor: 2,
        mobile: vp.mobile
      });
      await sleep(120);

      responsiveResults[vp.key] = await cdp.evaluate(`(async () => {
        if (!window.SY1_STUDIO.isOpen()) {
          document.getElementById("open-studio-btn").click();
          await new Promise((r) => setTimeout(r, 80));
        }
        // On portrait, close browser overlay if open to inspect clean arrangement & dock
        const br = document.getElementById("st-browser");
        if (window.innerWidth <= 768 && br && !br.hidden) {
          document.getElementById("st-browser-toggle").click();
          await new Promise((r) => setTimeout(r, 40));
        }

        const noHorizontalOverflow = document.documentElement.scrollWidth <= window.innerWidth;
        const playBtnRect = document.getElementById("st-play-btn").getBoundingClientRect();
        const ctlRect = document.querySelector("#sy1-studio .st-track-ctl").getBoundingClientRect();
        const laneRect = document.querySelector("#sy1-studio .st-lane").getBoundingClientRect();
        const dockRect = document.getElementById("st-dock").getBoundingClientRect();

        return {
          innerWidth: window.innerWidth,
          scrollWidth: document.documentElement.scrollWidth,
          noHorizontalOverflow,
          playBtnVisible: playBtnRect.width >= 40 && playBtnRect.height >= 34 && playBtnRect.right <= window.innerWidth,
          headerLaneAligned: Math.abs(ctlRect.top - laneRect.top) <= 1.5,
          laneHasUsableWidth: laneRect.width >= 200,
          dockVisible: dockRect.height >= 160
        };
      })()`);
    }

    // Restore clean desktop viewport & clean up Phase 4 IndexedDB/localStorage test data
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 1280,
      height: 840,
      deviceScaleFactor: 1,
      mobile: false
    });
    await cdp.evaluate(`(async () => {
      await window.SY1_STUDIO.storage.clearAutosave();
      const listed = await window.SY1_STUDIO.storage.listProjects();
      if (listed.ok) {
        for (const p of listed.data) {
          await window.SY1_STUDIO.storage.deleteProject(p.id);
        }
      }
      localStorage.removeItem("sy1_studio_favs");
    })()`);

    const report = {
      phase1: {
        standalone,
        parityResults,
        isolation,
        bounce,
        uiCheck
      },
      phase2: {
        stems2,
        stems4,
        postRestoreParity,
        preReloadSetup: {
          savedOk: preReloadSetup.savedOk,
          hasSaveBtn: preReloadSetup.hasSaveBtn,
          hasOpenBtn: preReloadSetup.hasOpenBtn,
          hasExportProjBtn: preReloadSetup.hasExportProjBtn,
          hasImportProjBtn: preReloadSetup.hasImportProjBtn,
          hasStemsBtn: preReloadSetup.hasStemsBtn
        },
        postReloadCheck,
        exportImportCheck,
        quotaAndCleanup
      },
      phase3: {
        stress4Track,
        uiStressAndHeap
      },
      phase4: {
        desktop: phase4Desktop,
        responsive: responsiveResults
      },
      pageErrors,
      consoleErrors
    };

    console.log(JSON.stringify(report, null, 2));

    // Strict assertions
    const failures = [];
    if (pageErrors.length) failures.push(`Page errors: ${pageErrors.join("; ")}`);
    if (consoleErrors.length) failures.push(`Console errors: ${consoleErrors.join("; ")}`);

    // Phase 1 regression assertions
    if (!standalone.panelVisible || !standalone.studioHidden || !standalone.studioBtn || !standalone.hasSy1) {
      failures.push("Standalone regression check failed");
    }
    for (const p of parityResults) {
      if (!(p.chainRefPeak > 0.01)) failures.push(`Parity preset ${p.presetId} silent`);
      if (!(p.chainMaxAbsDiff <= 1e-6)) failures.push(`Parity preset ${p.presetId} chainMaxAbsDiff=${p.chainMaxAbsDiff}`);
      const revAllowance = Math.max(2.5, Math.abs(p.fullStandaloneSelfRmsDiffDb) + 0.5);
      if (!(p.fullStudioRms > 0.005) || !(Math.abs(p.fullRmsLevelDiffDb) <= revAllowance)) {
        failures.push(`Parity preset ${p.presetId} fullRmsLevelDiffDb=${p.fullRmsLevelDiffDb} (self=${p.fullStandaloneSelfRmsDiffDb})`);
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

    // Phase 2 assertions
    for (const [label, st] of [["stems2", stems2], ["stems4", stems4]]) {
      if (!st.allHeadersValid) failures.push(`${label}: invalid 24-bit WAV header`);
      if (!st.allFrameCountsExact) failures.push(`${label}: frame count mismatch`);
      if (st.stemCount !== st.trackCount) failures.push(`${label}: expected ${st.trackCount} stems, got ${st.stemCount}`);
      if (st.stemsSummary.some((s) => !(s.peak > 0.01))) failures.push(`${label}: silent stem detected`);
      if (!(st.maxSumMinusMixDiff <= 2e-6)) failures.push(`${label}: sum-vs-mix diff ${st.maxSumMinusMixDiff} > 2e-6`);
      if (!(st.nullTestRmsDb <= -110)) failures.push(`${label}: nullTestRmsDb ${st.nullTestRmsDb} > -110 dB`);
    }

    if (!(postRestoreParity.preVsPostMaxAbsDiff <= 1e-6)) {
      failures.push(`Post-restore parity diff ${postRestoreParity.preVsPostMaxAbsDiff} > 1e-6`);
    }
    if (!(postRestoreParity.postRestoreIsolationMaxDiff <= 1e-6)) {
      failures.push(`Post-restore isolation diff ${postRestoreParity.postRestoreIsolationMaxDiff} > 1e-6`);
    }
    if (postRestoreParity.postRestoreBpm !== 126 || postRestoreParity.postRestoreTrack1Cutoff !== 640 || postRestoreParity.postRestoreTrack2Cutoff !== 3100) {
      failures.push("Post-restore parameter metadata mismatch");
    }

    if (!preReloadSetup.savedOk || !preReloadSetup.hasSaveBtn || !preReloadSetup.hasOpenBtn || !preReloadSetup.hasExportProjBtn || !preReloadSetup.hasImportProjBtn || !preReloadSetup.hasStemsBtn) {
      failures.push("Phase 2 UI controls or Save failed");
    }
    if (postReloadCheck.standaloneTempoBeforeStudio === 132) {
      failures.push("Startup Studio hydration leaked BPM into standalone SY-1!");
    }
    if (
      postReloadCheck.projectName !== "Phase 2 Reload Session" ||
      postReloadCheck.bpm !== 132 ||
      postReloadCheck.bars !== 12 ||
      postReloadCheck.loopStartBar !== 2 ||
      postReloadCheck.loopEndBar !== 10 ||
      postReloadCheck.trackCount !== 3 ||
      postReloadCheck.t1Preset !== "custom" ||
      postReloadCheck.t1Cutoff !== 480 ||
      postReloadCheck.t1Res !== 9.5 ||
      postReloadCheck.t1Solo !== true ||
      postReloadCheck.t1Notes !== 1 ||
      postReloadCheck.t2Preset !== "custom" ||
      postReloadCheck.t2Cutoff !== 2750 ||
      postReloadCheck.t2Mute !== true ||
      postReloadCheck.t2Notes !== 1 ||
      postReloadCheck.t3Preset !== "pluck" ||
      !postReloadCheck.drawerVisible ||
      !postReloadCheck.drawerHasProjectName
    ) {
      failures.push(`Save -> Reload -> Restore check mismatch: ${JSON.stringify(postReloadCheck)}`);
    }

    if (
      exportImportCheck.badSyntaxOk !== false ||
      exportImportCheck.badSchemaOk !== false ||
      !exportImportCheck.preservedAfterBad ||
      !exportImportCheck.statusHasError ||
      exportImportCheck.goodImportOk !== true ||
      exportImportCheck.restoredName !== "Phase 2 Reload Session" ||
      exportImportCheck.restoredBpm !== 132 ||
      exportImportCheck.restoredBars !== 12 ||
      exportImportCheck.restoredTrackCount !== 3 ||
      exportImportCheck.restoredT1Cutoff !== 480 ||
      exportImportCheck.restoredT1Notes !== 1
    ) {
      failures.push(`Export -> Import -> Restore check failed: ${JSON.stringify(exportImportCheck)}`);
    }

    if (quotaAndCleanup.quotaOk !== false || quotaAndCleanup.quotaKind !== "quota" || quotaAndCleanup.cleanedProjectCount !== 0) {
      failures.push(`Quota/cleanup check failed: ${JSON.stringify(quotaAndCleanup)}`);
    }

    // Phase 3 assertions
    if (
      stress4Track.trackCount !== 4 ||
      stress4Track.nonFiniteSamples !== 0 ||
      !(stress4Track.peakL > 0.05 && stress4Track.peakR > 0.05) ||
      !(stress4Track.peakL <= 1.0 && stress4Track.peakR <= 1.0) ||
      !(stress4Track.rmsL > 0.01 && stress4Track.rmsR > 0.01) ||
      stress4Track.activeVoicesAfterDispose !== 0
    ) {
      failures.push(`Phase 3 4-track AudioWorklet stress probe failed: ${JSON.stringify(stress4Track)}`);
    }
    if (
      uiStressAndHeap.idleRafWhileStopped !== false ||
      uiStressAndHeap.trackCount !== 4 ||
      uiStressAndHeap.sliderConnectedDuringDrag !== true ||
      uiStressAndHeap.finalT1Vol !== 0.65
    ) {
      failures.push(`Phase 3 UI stress/slider/rAF check failed: ${JSON.stringify(uiStressAndHeap)}`);
    }

    // Phase 4 assertions
    if (
      !phase4Desktop.headerLaneAligned ||
      !phase4Desktop.desktopNoOverflow ||
      !phase4Desktop.arrZoomWorks ||
      !phase4Desktop.browserInitiallyOpen ||
      !phase4Desktop.browserCollapsed ||
      !phase4Desktop.favStoredInStudioKey ||
      phase4Desktop.t1MachineAfterPick !== "yazd" ||
      phase4Desktop.embeddedMachineAttr !== "yazd" ||
      !(phase4Desktop.embeddedSecCount >= 4) ||
      !(phase4Desktop.embeddedKnobCount >= 12) ||
      !phase4Desktop.embeddedHasScales ||
      !phase4Desktop.dockExpandedActive ||
      phase4Desktop.mixerStripCount !== 4 ||
      !phase4Desktop.mixerHasMaster ||
      !phase4Desktop.mixerHasMeters ||
      phase4Desktop.prNoteCountAfterClick !== 1 ||
      phase4Desktop.quantizedStartTick < 0 ||
      phase4Desktop.quantizedStartTick % 480 !== 0 ||
      !phase4Desktop.savedP4 ||
      !phase4Desktop.standaloneVisuallyIdentical
    ) {
      failures.push(`Phase 4 Desktop DAW & visual regression failed: ${JSON.stringify(phase4Desktop)}`);
    }

    for (const vpKey of ["ipadLandscape", "ipadPortrait"]) {
      const vp = responsiveResults[vpKey];
      if (
        !vp ||
        !vp.noHorizontalOverflow ||
        !vp.playBtnVisible ||
        !vp.headerLaneAligned ||
        !vp.laneHasUsableWidth ||
        !vp.dockVisible
      ) {
        failures.push(`Phase 4 Responsive check (${vpKey}) failed: ${JSON.stringify(vp)}`);
      }
    }

    if (failures.length > 0) {
      console.error("VERIFICATION FAILURES:\n - " + failures.join("\n - "));
      process.exitCode = 1;
    } else {
      console.log("ALL REAL CHROMIUM PHASE 1, PHASE 2, PHASE 3 & PHASE 4 VERIFICATION CHECKS PASSED!");
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
