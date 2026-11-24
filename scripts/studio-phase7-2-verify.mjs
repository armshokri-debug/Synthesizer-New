/**
 * SY-1 Studio — Phase 7.2 Short Chromium Audio Verification
 *
 * Verifies in real headless Chromium on a single Kerman drum track:
 * 1. Original vs duplicated & pasted region MIDI + patch equivalence.
 * 2. Live AudioContext playback scheduling: Bar 1 Beat 1 has positive lookahead lead
 *    (no negative clamping, 0 ms Kick/Hat flam) matching Bar 2 and Bar 3, with exact 2.000 s bar spacing.
 * 3. Deterministic offline bounce (dry Kerman + default FX Kerman): Bar 1 Beat 1 matches Bar 2 Beat 1
 *    without cold-start DynamicsCompressor attenuation.
 * 4. Overlapping Copy+Paste at tick 0 does NOT double-trigger audio (peak/RMS & dispatch count unchanged).
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import { CdpClient, sleep, waitForCdp } from "./studio-cdp.mjs";

const CHROME_BIN =
  process.env.SY1_CHROME_BIN ||
  "/ms-playwright/chrome-headless-shell-linux64/chrome-headless-shell";
const BASE_URL = process.env.SY1_URL || "http://127.0.0.1:3000/";
const PORT = Number(process.env.SY1_CDP_PORT || 9236);

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
  cdp.on("Runtime.exceptionThrown", (ev) => {
    errors.push(ev.exceptionDetails.exception?.description || ev.exceptionDetails.text);
  });

  await cdp.send("Page.navigate", { url: BASE_URL });
  for (let i = 0; i < 120; i++) {
    if (await cdp.evaluate("!!window.SY1_STUDIO")) break;
    await sleep(50);
  }
  await cdp.evaluate("window.SY1_STUDIO.ready");

  const result = await cdp.evaluate(`(async () => {
    const api = window.SY1_STUDIO;
    const engine = api.engine;
    api.open();
    await engine.ensureAudio();

    // Configure single Kerman drum track at 120 BPM (1 bar = 2.000 s)
    engine.setBpm(120);
    engine.setBars(4);
    engine.setLoopEnabled(false);
    const tracks = engine.getTracks();
    const drum = tracks[0];
    for (let i = 1; i < tracks.length; i++) {
      engine.setTrackMute(tracks[i].id, true);
      engine.clearTrackClip(tracks[i].id);
    }
    engine.setTrackMute(drum.id, false);
    engine.setTrackMachinePreset(drum.id, "kerman", "init");

    // 1-bar drum groove: Kick(36)+Hat(42) on Beat 1, Snare(38)+Hat(42) on Beat 2,
    // Kick(36)+Hat(42) on Beat 3, Snare(38)+Clap(39) on Beat 4, Open Hat(46) on Beat 4.5
    engine.replaceTrackNotes(drum.id, [
      { midi: 36, startTick: 0, endTick: 120, velocity: 118 / 127 },
      { midi: 42, startTick: 0, endTick: 120, velocity: 84 / 127 },
      { midi: 38, startTick: 480, endTick: 600, velocity: 106 / 127 },
      { midi: 42, startTick: 480, endTick: 600, velocity: 78 / 127 },
      { midi: 36, startTick: 960, endTick: 1080, velocity: 114 / 127 },
      { midi: 42, startTick: 960, endTick: 1080, velocity: 82 / 127 },
      { midi: 38, startTick: 1440, endTick: 1560, velocity: 108 / 127 },
      { midi: 39, startTick: 1440, endTick: 1560, velocity: 92 / 127 },
      { midi: 46, startTick: 1680, endTick: 1860, velocity: 90 / 127 }
    ]);

    const patchBefore = JSON.stringify(drum.patch);
    const [r1] = engine.regions.regions(drum.id);
    engine.regions.select(r1.id);
    engine.regions.duplicate(); // Bar 2
    engine.regions.select(r1.id);
    engine.regions.copy();
    engine.regions.paste(drum.id, 3840); // Bar 3

    const regs = engine.regions.regions(drum.id).sort((a, b) => a.startTick - b.startTick);
    const midiEquiv =
      regs.length === 3 &&
      JSON.stringify(regs[0].events) === JSON.stringify(regs[1].events) &&
      JSON.stringify(regs[0].events) === JSON.stringify(regs[2].events) &&
      JSON.stringify(drum.patch) === patchBefore;

    // --- TEST 1: Live AudioContext scheduling timing (Bar 1 vs Bar 2 vs Bar 3) ---
    const liveEvents = [];
    engine.setDispatchObserver((rec) => {
      if (rec.trackId !== drum.id || rec.event.type !== "noteOn") return;
      const now = engine.nowAudioTime();
      liveEvents.push({
        tick: rec.event.tick,
        midi: rec.event.midi,
        vel: Math.round(rec.event.velocity * 127),
        at: rec.audioTime,
        leadMs: Math.round((rec.audioTime - now) * 1000 * 100) / 100
      });
    });

    engine.seekToTick(0);
    await engine.play();
    await new Promise((r) => setTimeout(r, 4600));
    await engine.stop();
    engine.setDispatchObserver(null);

    const b1Kick = liveEvents.find((e) => e.tick === 0 && e.midi === 36);
    const b1Hat = liveEvents.find((e) => e.tick === 0 && e.midi === 42);
    const b2Kick = liveEvents.find((e) => e.tick === 1920 && e.midi === 36);
    const b2Hat = liveEvents.find((e) => e.tick === 1920 && e.midi === 42);
    const b3Kick = liveEvents.find((e) => e.tick === 3840 && e.midi === 36);

    const b1FlamMs = b1Kick && b1Hat ? Math.abs(b1Kick.at - b1Hat.at) * 1000 : 999;
    const b2FlamMs = b2Kick && b2Hat ? Math.abs(b2Kick.at - b2Hat.at) * 1000 : 999;
    const bar1To2Sec = b1Kick && b2Kick ? b2Kick.at - b1Kick.at : 0;
    const bar2To3Sec = b2Kick && b3Kick ? b3Kick.at - b2Kick.at : 0;

    // --- Helper: decode 24-bit stereo WAV stem and measure window peak & RMS ---
    async function measureWavBars(barsToRender) {
      const [stem] = await engine.bounceTrackStemsWav({ bars: barsToRender, sampleRate: 48000 });
      const buf = new Uint8Array(await stem.wav.arrayBuffer());
      const sr = stem.sampleRate;
      const frames = stem.frames;
      const L = new Float32Array(frames);
      let off = 44;
      for (let i = 0; i < frames; i++) {
        const b0 = buf[off], b1 = buf[off + 1], b2 = buf[off + 2];
        let v = b0 | (b1 << 8) | (b2 << 16);
        if (v & 0x800000) v |= ~0xffffff;
        L[i] = v / 8388608;
        off += 6; // stereo 24-bit
      }
      const winStats = (startSec, durSec) => {
        const s0 = Math.floor(startSec * sr);
        const s1 = Math.min(frames, s0 + Math.floor(durSec * sr));
        let peak = 0, peakIdx = 0, sumSq = 0;
        for (let i = s0; i < s1; i++) {
          const a = Math.abs(L[i]);
          if (a > peak) { peak = a; peakIdx = i - s0; }
          sumSq += L[i] * L[i];
        }
        return {
          peak: Math.round(peak * 100000) / 100000,
          rms: Math.round(Math.sqrt(sumSq / Math.max(1, s1 - s0)) * 100000) / 100000,
          peakIdx
        };
      };
      return {
        bar1Beat1: winStats(0.0, 0.2),
        bar2Beat1: winStats(2.0, 0.2),
        bar3Beat1: winStats(4.0, 0.2),
        bar1Full: winStats(0.0, 2.0),
        bar2Full: winStats(2.0, 2.0),
        bar3Full: winStats(4.0, 2.0)
      };
    }

    // --- TEST 2: Offline bounce with default Kerman FX + drumGlue (checks cold-start compressor fix) ---
    // Note: Keep kick-only or full groove to compare Bar 1 Beat 1 vs Bar 2 Beat 1
    const defaultFxStats = await measureWavBars(3);

    // --- TEST 3: Offline bounce DRY (revMix=0, delayMix=0, chorusMix=0, drumGlue=0) on pure Kick+Snare ---
    // Isolates pure DSP + Studio scheduling parity without reverb/open-hat cross-bar tail
    drum.setParam("revMix", 0);
    drum.setParam("delayMix", 0);
    drum.setParam("chorusMix", 0);
    drum.setParam("drumGlue", 0);
    // Replace with clean 4-on-the-floor kick (zero open hat bleed at bar seam) and duplicate to Bar 2 & 3
    engine.clearTrackClip(drum.id);
    engine.replaceTrackNotes(drum.id, [
      { midi: 36, startTick: 0, endTick: 120, velocity: 118 / 127 },
      { midi: 36, startTick: 960, endTick: 1080, velocity: 118 / 127 }
    ]);
    const [dryR1] = engine.regions.regions(drum.id);
    engine.regions.select(dryR1.id);
    engine.regions.duplicate(); // Bar 2 (tick 1920)
    engine.regions.duplicate(); // Bar 3 (tick 3840)
    const drySingleStats = await measureWavBars(3);

    // --- TEST 4: Overlapping Copy + Paste directly at tick 0 (must NOT double-trigger audio) ---
    const singleNoteOnCount = drum.events.filter((e) => e.type === "noteOn").length;
    engine.regions.select(dryR1.id);
    engine.regions.copy();
    engine.regions.paste(drum.id, 0);
    const stackedNoteOnCount = drum.events.filter((e) => e.type === "noteOn").length;
    const stackedStats = await measureWavBars(3);

    return {
      midiEquiv,
      live: {
        b1Kick,
        b1Hat,
        b2Kick,
        b2Hat,
        b3Kick,
        b1FlamMs: Math.round(b1FlamMs * 1000) / 1000,
        b2FlamMs: Math.round(b2FlamMs * 1000) / 1000,
        bar1To2Sec: Math.round(bar1To2Sec * 100000) / 100000,
        bar2To3Sec: Math.round(bar2To3Sec * 100000) / 100000
      },
      defaultFxStats,
      drySingleStats,
      overlapCheck: {
        singleNoteOnCount,
        stackedNoteOnCount,
        singleBar1Peak: drySingleStats.bar1Beat1.peak,
        stackedBar1Peak: stackedStats.bar1Beat1.peak,
        singleBar1Rms: drySingleStats.bar1Beat1.rms,
        stackedBar1Rms: stackedStats.bar1Beat1.rms
      }
    };
  })()`);

  assert("Original, duplicated, and pasted Kerman regions have identical MIDI & patch", result.midiEquiv, result.midiEquiv);

  assert(
    "Live playback Bar 1 Beat 1 schedules with strictly positive lookahead lead (no negative clamp)",
    result.live.b1Kick && result.live.b1Hat && result.live.b1Kick.leadMs > 0 && result.live.b1Hat.leadMs > 0,
    result.live
  );

  assert(
    "Live playback Bar 1 Kick+Hat has zero inter-voice flam (matching Bar 2)",
    result.live.b1FlamMs < 0.01 && result.live.b2FlamMs < 0.01,
    { b1FlamMs: result.live.b1FlamMs, b2FlamMs: result.live.b2FlamMs }
  );

  assert(
    "Live playback bar-to-bar interval is exact 2.000 s at 120 BPM",
    Math.abs(result.live.bar1To2Sec - 2.0) < 0.001 && Math.abs(result.live.bar2To3Sec - 2.0) < 0.001,
    { bar1To2Sec: result.live.bar1To2Sec, bar2To3Sec: result.live.bar2To3Sec }
  );

  // Offline dry kick Bar 1 Beat 1 vs Bar 2 Beat 1 vs Bar 3 Beat 1:
  // (With deterministic offline drums + settled 8192-sample compressor pre-roll, peaks match within < 1%)
  const dryPeakDiff12 = Math.abs(result.drySingleStats.bar1Beat1.peak - result.drySingleStats.bar2Beat1.peak);
  const dryRmsDiff12 = Math.abs(result.drySingleStats.bar1Beat1.rms - result.drySingleStats.bar2Beat1.rms);
  const dryPeakDiff23 = Math.abs(result.drySingleStats.bar2Beat1.peak - result.drySingleStats.bar3Beat1.peak);
  assert(
    "Offline dry Kerman bounce matches original (Bar 1) vs copied (Bar 2 & Bar 3) peak and RMS",
    dryPeakDiff12 < 0.01 && dryPeakDiff23 < 0.01 && dryRmsDiff12 < 0.01 && result.drySingleStats.bar1Beat1.peak > 0.3,
    { drySingleStats: result.drySingleStats, dryPeakDiff12, dryPeakDiff23, dryRmsDiff12 }
  );

  // Default FX Kerman bounce: cold-start compressor drop is gone (previously 0.593 vs 0.705 -> 16% drop!)
  const fxPeakRatio =
    result.defaultFxStats.bar1Beat1.peak / Math.max(1e-6, result.defaultFxStats.bar2Beat1.peak);
  assert(
    "Offline default-FX Kerman bounce eliminates cold-start Bar 1 Beat 1 compressor drop",
    fxPeakRatio > 0.92 && fxPeakRatio < 1.08,
    { defaultFxStats: result.defaultFxStats, fxPeakRatio: Math.round(fxPeakRatio * 10000) / 10000 }
  );

  // Overlapping Copy + Paste at tick 0 must NOT double-trigger
  const overlapPeakDiff = Math.abs(
    result.overlapCheck.singleBar1Peak - result.overlapCheck.stackedBar1Peak
  );
  const overlapRmsDiff = Math.abs(
    result.overlapCheck.singleBar1Rms - result.overlapCheck.stackedBar1Rms
  );
  assert(
    "Overlapping Copy+Paste at tick 0 does not double-trigger notes or boost audio level",
    result.overlapCheck.singleNoteOnCount === result.overlapCheck.stackedNoteOnCount &&
      overlapPeakDiff < 0.005 &&
      overlapRmsDiff < 0.005,
    result.overlapCheck
  );

  assert("Zero uncaught browser errors", errors.length === 0, errors);

  console.log(
    JSON.stringify(
      {
        ok: true,
        passed: cases.filter((c) => c.pass).length,
        total: cases.length,
        summary: {
          live: result.live,
          defaultFxStats: result.defaultFxStats,
          drySingleStats: result.drySingleStats,
          overlapCheck: result.overlapCheck
        },
        errors
      },
      null,
      2
    )
  );
} finally {
  cdp?.close();
  chrome.kill("SIGKILL");
}
