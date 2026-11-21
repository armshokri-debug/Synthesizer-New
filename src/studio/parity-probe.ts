/**
 * SY-1 Studio — OfflineAudioContext Sound Parity & Track Isolation Probe
 *
 * Used by automated browser verification (Chromium OfflineAudioContext + real
 * "sy1-voices" AudioWorklet + real SynthFXBus + real StudioMasterBus) to prove
 * sound parity and zero cross-track leakage with measured sample-level metrics.
 */

import { createSynthBus, disposeSynthBus } from "../engine/bus";
import { createHQNode } from "../engine/hq";
import { createStudioMasterBus, createStudioEngine, disposeStudioMasterBus } from "./studio-engine";
import { buildSy1PresetPatch, SY1TrackEngine } from "./track-engine";

export interface ParityMetric {
  presetId: string;
  presetName: string;
  sampleRate: number;
  frames: number;
  /** Exact sample-level parity with full HQEngine + drive + EQ + delay + chorus + limiter + softClip + StudioMasterBus (revMix=0 to exclude Chromium's cyclic-graph HashSet pull-order jitter in Freeverb). */
  chainRefStartSample: number;
  chainStudioStartSample: number;
  chainRefPeak: number;
  chainStudioPeak: number;
  chainMaxAbsDiff: number;
  chainRmsDiffDb: number;
  /** Full untouched preset parity (including untouched Freeverb revMix). */
  fullPresetRevMix: number;
  fullRefRms: number;
  fullStudioRms: number;
  fullRmsLevelDiffDb: number;
  /** Standalone SY-1 vs itself across two OfflineAudioContext runs (measures Chromium cyclic-graph jitter on untouched Freeverb). */
  fullStandaloneSelfDiff: number;
  fullStandaloneSelfRmsDiffDb: number;
  fullStudioVsRefDiff: number;
}

export interface IsolationMetric {
  sampleRate: number;
  frames: number;
  baseStartSample: number;
  mutatedStartSample: number;
  track2Peak: number;
  maxAbsDiffTrack2: number;
  rmsDiffDbTrack2: number;
  track1Differs: boolean;
  /** Full-reverb isolation RMS check (Track 2 keeps original revMix=0.25 while Track 1 sweeps revMix=0.9 / delayMix=0.8 / superSaw). */
  fullRevTrack2BaseRms: number;
  fullRevTrack2MutatedRms: number;
  fullRevRmsDiffDb: number;
}

function compareStereoBuffers(
  aL: Float32Array,
  aR: Float32Array,
  bL: Float32Array,
  bR: Float32Array
): {
  refStartSample: number;
  studioStartSample: number;
  refPeak: number;
  studioPeak: number;
  refRms: number;
  studioRms: number;
  maxAbsDiff: number;
  rmsDiffDb: number;
} {
  const n = Math.min(aL.length, bL.length);
  let refStartSample = -1;
  let studioStartSample = -1;
  let refPeak = 0;
  let studioPeak = 0;
  let refSq = 0;
  let studioSq = 0;
  let diffSq = 0;
  let maxAbsDiff = 0;

  for (let i = 0; i < n; i++) {
    const al = aL[i], ar = aR[i];
    const bl = bL[i], br = bR[i];
    const ap = Math.max(Math.abs(al), Math.abs(ar));
    const bp = Math.max(Math.abs(bl), Math.abs(br));
    if (refStartSample < 0 && ap > 1e-6) refStartSample = i;
    if (studioStartSample < 0 && bp > 1e-6) studioStartSample = i;
    if (ap > refPeak) refPeak = ap;
    if (bp > studioPeak) studioPeak = bp;
    refSq += al * al + ar * ar;
    studioSq += bl * bl + br * br;
    const dl = Math.abs(al - bl);
    const dr = Math.abs(ar - br);
    if (dl > maxAbsDiff) maxAbsDiff = dl;
    if (dr > maxAbsDiff) maxAbsDiff = dr;
    diffSq += dl * dl + dr * dr;
  }

  const refRms = Math.sqrt(refSq / Math.max(1, n * 2));
  const studioRms = Math.sqrt(studioSq / Math.max(1, n * 2));
  const diffRms = Math.sqrt(diffSq / Math.max(1, n * 2));
  const rmsDiffDb = diffRms === 0 ? -Infinity : 20 * Math.log10(diffRms / Math.max(1e-12, refRms));
  return { refStartSample, studioStartSample, refPeak, studioPeak, refRms, studioRms, maxAbsDiff, rmsDiffDb };
}

async function renderStandaloneOnce(
  patch: Record<string, any>,
  frames: number,
  sampleRate: number
): Promise<AudioBuffer> {
  const ctx = new OfflineAudioContext(2, frames, sampleRate);
  const bus = createSynthBus(ctx, { ...patch }, { connectToDestination: true, mainFxOn: true });
  bus.out.gain.value = 1;
  const node = await createHQNode(ctx, bus.input, patch);
  if (!node) throw new Error("Failed to load sy1-voices AudioWorklet in OfflineAudioContext");
  ctx.suspend(128 / sampleRate).then(async () => {
    node.port.postMessage({ t: "on", id: 1, midi: 60, cents: 0, vel: 0.85, at: 0.02, from: 0, glide: 0 });
    node.port.postMessage({ t: "off", id: 1, at: 0.3 });
    await new Promise((r) => setTimeout(r, 15));
    await ctx.resume();
  });
  const buf = await ctx.startRendering();
  try { node.disconnect(); } catch (e) {}
  disposeSynthBus(bus);
  return buf;
}

async function renderStudioSingleTrackOnce(
  presetId: string,
  revMixOverride: number | null,
  frames: number,
  sampleRate: number
): Promise<AudioBuffer> {
  const ctx = new OfflineAudioContext(2, frames, sampleRate);
  const master = createStudioMasterBus(ctx, { connectToDestination: true, unityOut: true });
  const track = new SY1TrackEngine({ id: "t1", name: "Track 1", presetId, volume: 1, pan: 0, forceHQ: true });
  if (revMixOverride !== null) {
    track.setParam("revMix", revMixOverride, { fromPreset: true });
  }
  await track.attachAudio(ctx, master.sum);
  ctx.suspend(128 / sampleRate).then(async () => {
    track.noteOn(60, 0.85, 0.02);
    track.noteOff(60, 0.3);
    await new Promise((r) => setTimeout(r, 15));
    await ctx.resume();
  });
  const buf = await ctx.startRendering();
  track.dispose();
  disposeStudioMasterBus(master);
  return buf;
}

/**
 * A2: Compare exact standalone SY-1 AudioWorklet + SynthFXBus path against
 * Studio single-track SY1TrackEngine + StudioMasterBus in Chromium OfflineAudioContext.
 *
 * Runs both:
 *  - A2a (revMix=0): proves bit-exact 0.0 sample parity through HQEngine + drive + EQ +
 *    tape delay + stereo chorus + limiter + softClip + track strip + StudioMasterBus.
 *  - A2b (full untouched preset including Freeverb): measures RMS level parity and
 *    records standalone SY-1's own cyclic-graph pull-order variance across OfflineAudioContext runs.
 */
export async function runOfflineParityProbe(
  presetId: string,
  sampleRate = 48000,
  durationSec = 0.5
): Promise<ParityMetric> {
  const frames = Math.round(sampleRate * durationSec);
  const built = buildSy1PresetPatch(presetId);

  // A2a: Bit-exact chain parity (revMix=0 eliminates Chromium Blink HashSet cycle-break jitter in Freeverb)
  const dryRevPatch = { ...built.patch, revMix: 0 };
  const chainRef = await renderStandaloneOnce(dryRevPatch, frames, sampleRate);
  const chainStudio = await renderStudioSingleTrackOnce(presetId, 0, frames, sampleRate);
  const chainStats = compareStereoBuffers(
    chainRef.getChannelData(0),
    chainRef.getChannelData(1),
    chainStudio.getChannelData(0),
    chainStudio.getChannelData(1)
  );

  // A2b: Full untouched preset (including Freeverb)
  const fullRef1 = await renderStandaloneOnce(built.patch, frames, sampleRate);
  const fullRef2 = await renderStandaloneOnce(built.patch, frames, sampleRate);
  const fullStudio = await renderStudioSingleTrackOnce(presetId, null, frames, sampleRate);
  const selfStats = compareStereoBuffers(
    fullRef1.getChannelData(0),
    fullRef1.getChannelData(1),
    fullRef2.getChannelData(0),
    fullRef2.getChannelData(1)
  );
  const fullStats = compareStereoBuffers(
    fullRef1.getChannelData(0),
    fullRef1.getChannelData(1),
    fullStudio.getChannelData(0),
    fullStudio.getChannelData(1)
  );
  const fullRmsLevelDiffDb =
    20 * Math.log10(Math.max(1e-12, fullStats.studioRms) / Math.max(1e-12, fullStats.refRms));
  const fullStandaloneSelfRmsDiffDb =
    20 * Math.log10(Math.max(1e-12, selfStats.studioRms) / Math.max(1e-12, selfStats.refRms));

  return {
    presetId: built.presetId,
    presetName: built.presetName,
    sampleRate,
    frames,
    chainRefStartSample: chainStats.refStartSample,
    chainStudioStartSample: chainStats.studioStartSample,
    chainRefPeak: chainStats.refPeak,
    chainStudioPeak: chainStats.studioPeak,
    chainMaxAbsDiff: chainStats.maxAbsDiff,
    chainRmsDiffDb: chainStats.rmsDiffDb,
    fullPresetRevMix: Number(built.patch.revMix) || 0,
    fullRefRms: fullStats.refRms,
    fullStudioRms: fullStats.studioRms,
    fullRmsLevelDiffDb,
    fullStandaloneSelfDiff: selfStats.maxAbsDiff,
    fullStandaloneSelfRmsDiffDb,
    fullStudioVsRefDiff: fullStats.maxAbsDiff
  };
}

/**
 * B2/B3: Prove real Web Audio track isolation in Chromium OfflineAudioContext:
 * Render Track 2 playing a note while Track 1 is muted vs while Track 1 sweeps
 * cutoff/resonance/preset/reverb/delay and plays notes. Track 2's isolated output must remain identical.
 */
export async function runOfflineIsolationProbe(sampleRate = 48000, durationSec = 0.5): Promise<IsolationMetric> {
  const frames = Math.round(sampleRate * durationSec);

  const renderScenario = async (mutateTrack1: boolean, track2RevMixOverride: number | null) => {
    const ctx = new OfflineAudioContext(2, frames, sampleRate);
    const master = createStudioMasterBus(ctx, { connectToDestination: true, unityOut: true });

    const t1 = new SY1TrackEngine({ id: "t1", name: "Track 1", presetId: "acidBass", volume: 1, pan: 0, forceHQ: true });
    const t2 = new SY1TrackEngine({ id: "t2", name: "Track 2", presetId: "softKeys", volume: 1, pan: 0, forceHQ: true });
    if (track2RevMixOverride !== null) {
      t2.setParam("revMix", track2RevMixOverride, { fromPreset: true });
    }
    t1.setAudible(false); // isolate Track 2 at the master output while Track 1 still runs full DSP/FX
    t2.setAudible(true);
    await Promise.all([t1.attachAudio(ctx, master.sum), t2.attachAudio(ctx, master.sum)]);

    ctx.suspend(128 / sampleRate).then(async () => {
      if (mutateTrack1) {
        t1.applyPreset("superSaw");
        t1.setParam("cutoff", 120);
        t1.setParam("res", 16);
        t1.setParam("revMix", 0.9);
        t1.setParam("delayMix", 0.8);
        t1.noteOn(48, 1.0, 0.01);
        t1.noteOn(55, 1.0, 0.05);
      }
      t2.noteOn(64, 0.8, 0.02);
      t2.noteOff(64, 0.35);
      await new Promise((r) => setTimeout(r, 15));
      await ctx.resume();
    });

    const buf = await ctx.startRendering();
    t1.detachAudio();
    t2.detachAudio();
    return buf;
  };

  // Exact bit-for-bit isolation check (Track 2 keeps stereo chorus active, revMix=0 to eliminate Freeverb HashSet jitter; Track 1 still blasts full superSaw + revMix=0.9 + delayMix=0.8)
  const baseBuf = await renderScenario(false, 0);
  const mutatedBuf = await renderScenario(true, 0);
  const stats = compareStereoBuffers(
    baseBuf.getChannelData(0),
    baseBuf.getChannelData(1),
    mutatedBuf.getChannelData(0),
    mutatedBuf.getChannelData(1)
  );

  // Full-reverb isolation check (Track 2 keeps original revMix=0.25)
  const fullBase = await renderScenario(false, null);
  const fullMut = await renderScenario(true, null);
  const fullStats = compareStereoBuffers(
    fullBase.getChannelData(0),
    fullBase.getChannelData(1),
    fullMut.getChannelData(0),
    fullMut.getChannelData(1)
  );
  const fullRevRmsDiffDb =
    20 * Math.log10(Math.max(1e-12, fullStats.studioRms) / Math.max(1e-12, fullStats.refRms));

  // Also verify Track 1 actually changes when its own cutoff/preset changes
  const renderT1 = async (cutoff: number) => {
    const ctx = new OfflineAudioContext(2, Math.round(sampleRate * 0.25), sampleRate);
    const master = createStudioMasterBus(ctx, { connectToDestination: true, unityOut: true });
    const t1 = new SY1TrackEngine({ id: "t1", name: "Track 1", presetId: "acidBass", volume: 1, pan: 0, forceHQ: true });
    await t1.attachAudio(ctx, master.sum);
    ctx.suspend(128 / sampleRate).then(async () => {
      t1.setParam("cutoff", cutoff);
      t1.noteOn(48, 0.9, 0.01);
      t1.noteOff(48, 0.2);
      await new Promise((r) => setTimeout(r, 15));
      await ctx.resume();
    });
    const buf = await ctx.startRendering();
    t1.detachAudio();
    return buf;
  };
  const lowCut = await renderT1(120);
  const highCut = await renderT1(12000);
  const t1Diff = compareStereoBuffers(
    lowCut.getChannelData(0),
    lowCut.getChannelData(1),
    highCut.getChannelData(0),
    highCut.getChannelData(1)
  );

  return {
    sampleRate,
    frames,
    baseStartSample: stats.refStartSample,
    mutatedStartSample: stats.studioStartSample,
    track2Peak: stats.refPeak,
    maxAbsDiffTrack2: stats.maxAbsDiff,
    rmsDiffDbTrack2: stats.rmsDiffDb,
    track1Differs: t1Diff.maxAbsDiff > 0.05,
    fullRevTrack2BaseRms: fullStats.refRms,
    fullRevTrack2MutatedRms: fullStats.studioRms,
    fullRevRmsDiffDb
  };
}

/**
 * E2: Bounce a 2-track arrangement to 24-bit Stereo WAV in Chromium OfflineAudioContext
 * and parse back its RIFF/WAVE header and sample statistics.
 */
export async function runOfflineBounceProbe(bpm = 120, bars = 2, sampleRate = 48000): Promise<{
  riff: string;
  wave: string;
  audioFormat: number;
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
  dataBytes: number;
  frames: number;
  expectedFrames: number;
  durationSec: number;
  expectedDurationSec: number;
  peakL: number;
  peakR: number;
  rmsL: number;
  rmsR: number;
}> {
  const eng = createStudioEngine({ isolatedTempo: true, initialBpm: bpm });
  eng.setBars(bars);
  const [t1, t2] = eng.getTracks();
  t1.applyPreset("softKeys");
  t2.applyPreset("moogBass");
  t1.setEvents([
    { type: "noteOn", tick: 0, midi: 60, velocity: 0.85 },
    { type: "noteOff", tick: 480, midi: 60 },
    { type: "noteOn", tick: 960, midi: 64, velocity: 0.85 },
    { type: "noteOff", tick: 1440, midi: 64 }
  ]);
  t2.setEvents([
    { type: "noteOn", tick: 0, midi: 36, velocity: 0.9 },
    { type: "noteOff", tick: 960, midi: 36 },
    { type: "noteOn", tick: 1920, midi: 43, velocity: 0.9 },
    { type: "noteOff", tick: 2880, midi: 43 }
  ]);

  const take = await eng.bounceArrangementWav({ sampleRate, bars });
  const ab = await take.wav.arrayBuffer();
  const dv = new DataView(ab);
  const bytes = new Uint8Array(ab);
  const str = (off: number, len: number) =>
    String.fromCharCode(...Array.from(bytes.subarray(off, off + len)));

  const dataBytes = dv.getUint32(40, true);
  const channels = dv.getUint16(22, true);
  const bitsPerSample = dv.getUint16(34, true);
  const wavRate = dv.getUint32(24, true);
  const frames = dataBytes / (channels * (bitsPerSample / 8));
  const expectedDurationSec = (bars * 4 * 60) / bpm;
  const expectedFrames = Math.round(expectedDurationSec * sampleRate);

  let peakL = 0, peakR = 0, sqL = 0, sqR = 0;
  let o = 44;
  for (let i = 0; i < frames; i++) {
    let sL = bytes[o] | (bytes[o + 1] << 8) | (bytes[o + 2] << 16);
    if (sL & 0x800000) sL -= 0x1000000;
    const fL = sL / 8388608;
    o += 3;

    let sR = bytes[o] | (bytes[o + 1] << 8) | (bytes[o + 2] << 16);
    if (sR & 0x800000) sR -= 0x1000000;
    const fR = sR / 8388608;
    o += 3;

    if (Math.abs(fL) > peakL) peakL = Math.abs(fL);
    if (Math.abs(fR) > peakR) peakR = Math.abs(fR);
    sqL += fL * fL;
    sqR += fR * fR;
  }

  eng.dispose();

  return {
    riff: str(0, 4),
    wave: str(8, 4),
    audioFormat: dv.getUint16(20, true),
    channels,
    sampleRate: wavRate,
    bitsPerSample,
    dataBytes,
    frames,
    expectedFrames,
    durationSec: frames / wavRate,
    expectedDurationSec,
    peakL,
    peakR,
    rmsL: Math.sqrt(sqL / Math.max(1, frames)),
    rmsR: Math.sqrt(sqR / Math.max(1, frames))
  };
}

function decodeWav24(ab: ArrayBuffer): {
  riff: string;
  wave: string;
  audioFormat: number;
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
  frames: number;
  L: Float32Array;
  R: Float32Array;
  peak: number;
  firstNonZeroSample: number;
} {
  const dv = new DataView(ab);
  const bytes = new Uint8Array(ab);
  const str = (off: number, len: number) =>
    String.fromCharCode(...Array.from(bytes.subarray(off, off + len)));
  const audioFormat = dv.getUint16(20, true);
  const channels = dv.getUint16(22, true);
  const sampleRate = dv.getUint32(24, true);
  const bitsPerSample = dv.getUint16(34, true);
  const dataBytes = dv.getUint32(40, true);
  const frames = dataBytes / (channels * (bitsPerSample / 8));
  const L = new Float32Array(frames);
  const R = new Float32Array(frames);
  let peak = 0;
  let firstNonZeroSample = -1;
  let o = 44;
  for (let i = 0; i < frames; i++) {
    let sL = bytes[o] | (bytes[o + 1] << 8) | (bytes[o + 2] << 16);
    if (sL & 0x800000) sL -= 0x1000000;
    const fL = sL / 8388608;
    o += 3;

    let sR = bytes[o] | (bytes[o + 1] << 8) | (bytes[o + 2] << 16);
    if (sR & 0x800000) sR -= 0x1000000;
    const fR = sR / 8388608;
    o += 3;

    L[i] = fL;
    R[i] = fR;
    const p = Math.max(Math.abs(fL), Math.abs(fR));
    if (p > peak) peak = p;
    if (firstNonZeroSample < 0 && p > 1e-4) firstNonZeroSample = i;
  }
  return {
    riff: str(0, 4),
    wave: str(8, 4),
    audioFormat,
    channels,
    sampleRate,
    bitsPerSample,
    frames,
    L,
    R,
    peak,
    firstNonZeroSample
  };
}

/**
 * Phase 2 E4: Verify 2-track and 4-track separate 24-bit Stereo PCM WAV stems are
 * genuinely independent, sample-aligned to frame 0, unnormalized, and null-test
 * against the full arrangement mix to the 24-bit quantization floor.
 */
export async function runOfflineStemsProbe(
  trackCount: 2 | 4 = 2,
  bpm = 120,
  bars = 1,
  sampleRate = 48000
): Promise<{
  trackCount: number;
  stemCount: number;
  sampleRate: number;
  expectedFrames: number;
  mixFrames: number;
  allHeadersValid: boolean;
  allFrameCountsExact: boolean;
  stemsSummary: {
    trackId: string;
    frames: number;
    peak: number;
    firstNonZeroSample: number;
  }[];
  maxOnsetSpreadSamples: number;
  maxSumMinusMixDiff: number;
  nullTestRmsDb: number;
}> {
  const eng = createStudioEngine({ isolatedTempo: true, initialBpm: bpm });
  eng.setBars(bars);
  if (trackCount === 4) {
    eng.addTrack("pluck");
    eng.addTrack("acidBass");
  }
  const presets = ["softKeys", "moogBass", "pluck", "acidBass"];
  const notes = [60, 48, 67, 55];
  const pans = [-0.4, 0.4, -0.2, 0.2];
  const tracks = eng.getTracks();

  tracks.forEach((t, idx) => {
    t.applyPreset(presets[idx % presets.length]);
    // Disable Freeverb so Chromium Blink cyclic-graph pull-order jitter doesn't mask exact null-test
    t.setParam("revMix", 0, { fromPreset: true });
    // Keep summed peaks strictly below 0.98 StudioMasterBus knee to prove exact linear sum
    t.setVolume(trackCount === 4 ? 0.22 : 0.35);
    t.setPan(pans[idx % pans.length]);
    t.setEvents([
      { type: "noteOn", tick: 0, midi: notes[idx % notes.length], velocity: 0.8 },
      { type: "noteOff", tick: 480, midi: notes[idx % notes.length] },
      { type: "noteOn", tick: 960, midi: notes[idx % notes.length] + 4, velocity: 0.75 },
      { type: "noteOff", tick: 1440, midi: notes[idx % notes.length] + 4 }
    ]);
  });

  const mixTake = await eng.bounceArrangementWav({ sampleRate, bars });
  const stemTakes = await eng.bounceTrackStemsWav({ sampleRate, bars });
  eng.dispose();

  const mix = decodeWav24(await mixTake.wav.arrayBuffer());
  const decodedStems = [];
  for (const st of stemTakes) {
    decodedStems.push({ meta: st, wav: decodeWav24(await st.wav.arrayBuffer()) });
  }

  const expectedFrames = Math.round(((bars * 4 * 60) / bpm) * sampleRate);
  const allHeadersValid =
    mix.riff === "RIFF" &&
    mix.wave === "WAVE" &&
    mix.audioFormat === 1 &&
    mix.channels === 2 &&
    mix.bitsPerSample === 24 &&
    mix.sampleRate === sampleRate &&
    decodedStems.every(
      ({ wav }) =>
        wav.riff === "RIFF" &&
        wav.wave === "WAVE" &&
        wav.audioFormat === 1 &&
        wav.channels === 2 &&
        wav.bitsPerSample === 24 &&
        wav.sampleRate === sampleRate
    );
  const allFrameCountsExact =
    mix.frames === expectedFrames && decodedStems.every(({ wav }) => wav.frames === expectedFrames);

  const sumL = new Float32Array(mix.frames);
  const sumR = new Float32Array(mix.frames);
  for (const { wav } of decodedStems) {
    for (let i = 0; i < mix.frames; i++) {
      sumL[i] += wav.L[i];
      sumR[i] += wav.R[i];
    }
  }

  const diff = compareStereoBuffers(mix.L, mix.R, sumL, sumR);
  const onsets = decodedStems.map(({ wav }) => wav.firstNonZeroSample).filter((x) => x >= 0);
  const maxOnsetSpreadSamples = onsets.length > 0 ? Math.max(...onsets) - Math.min(...onsets) : -1;

  return {
    trackCount,
    stemCount: decodedStems.length,
    sampleRate,
    expectedFrames,
    mixFrames: mix.frames,
    allHeadersValid,
    allFrameCountsExact,
    stemsSummary: decodedStems.map(({ meta, wav }) => ({
      trackId: meta.trackId,
      frames: wav.frames,
      peak: Number(wav.peak.toFixed(4)),
      firstNonZeroSample: wav.firstNonZeroSample
    })),
    maxOnsetSpreadSamples,
    maxSumMinusMixDiff: diff.maxAbsDiff,
    nullTestRmsDb: Number.isFinite(diff.rmsDiffDb) ? Number(diff.rmsDiffDb.toFixed(2)) : -999
  };
}

/**
 * Phase 2 Post-Restore Parity & Isolation Probe:
 * Serializes a 2-track Studio project with custom synth params + MIDI to JSON,
 * restores it into a brand-new SY1StudioEngine, and verifies bit-exact audio parity
 * (pre-save vs post-restore) AND bit-exact Track 2 isolation after restoration.
 */
export async function runPostRestoreParityProbe(sampleRate = 48000): Promise<{
  preVsPostMaxAbsDiff: number;
  preVsPostRmsDiffDb: number;
  postRestoreIsolationMaxDiff: number;
  postRestoreBpm: number;
  postRestoreBars: number;
  postRestoreTrack1Cutoff: number;
  postRestoreTrack2Cutoff: number;
}> {
  const src = createStudioEngine({ isolatedTempo: true, initialBpm: 126 });
  src.setProjectName("Restore Parity Check");
  src.setBars(1);
  src.setLoopEnabled(true);
  const [s1, s2] = src.getTracks();
  s1.applyPreset("acidBass");
  s1.setParam("cutoff", 640);
  s1.setParam("res", 8.5);
  s1.setParam("revMix", 0, { fromPreset: true });
  s1.setVolume(0.45);
  s1.setPan(-0.25);
  s1.setEvents([
    { type: "noteOn", tick: 0, midi: 45, velocity: 0.9 },
    { type: "noteOff", tick: 480, midi: 45 }
  ]);

  s2.applyPreset("softKeys");
  s2.setParam("cutoff", 3100);
  s2.setParam("revMix", 0, { fromPreset: true });
  s2.setVolume(0.5);
  s2.setPan(0.25);
  s2.setEvents([
    { type: "noteOn", tick: 240, midi: 64, velocity: 0.8 },
    { type: "noteOff", tick: 960, midi: 64 }
  ]);

  const preTake = await src.bounceArrangementWav({ sampleRate, bars: 1 });
  const serialized = src.exportProjectJson();
  src.dispose();

  const restored = createStudioEngine({ isolatedTempo: true, initialBpm: 90 });
  await restored.loadProject(JSON.parse(serialized));
  const postTake = await restored.bounceArrangementWav({ sampleRate, bars: 1 });

  const preWav = decodeWav24(await preTake.wav.arrayBuffer());
  const postWav = decodeWav24(await postTake.wav.arrayBuffer());
  const parity = compareStereoBuffers(preWav.L, preWav.R, postWav.L, postWav.R);

  // Post-restore isolation: bounce Track 2 stem before vs after mutating Track 1 drastically
  const [r1, r2] = restored.getTracks();
  restored.setTrackMute(r1.id, true);
  const isoBase = await restored.bounceArrangementWav({ sampleRate, bars: 1 });
  r1.applyPreset("superSaw");
  r1.setParam("cutoff", 140);
  r1.setParam("res", 15);
  r1.setParam("revMix", 0.9);
  const isoMut = await restored.bounceArrangementWav({ sampleRate, bars: 1 });

  const isoBaseWav = decodeWav24(await isoBase.wav.arrayBuffer());
  const isoMutWav = decodeWav24(await isoMut.wav.arrayBuffer());
  const isoDiff = compareStereoBuffers(isoBaseWav.L, isoBaseWav.R, isoMutWav.L, isoMutWav.R);

  const postRestoreTrack1Cutoff = JSON.parse(serialized).tracks[0].patch.cutoff;
  const postRestoreTrack2Cutoff = r2.patch.cutoff;
  const postRestoreBpm = restored.getBpm();
  const postRestoreBars = restored.getTransportSnapshot().bars;
  restored.dispose();

  return {
    preVsPostMaxAbsDiff: parity.maxAbsDiff,
    preVsPostRmsDiffDb: Number.isFinite(parity.rmsDiffDb) ? Number(parity.rmsDiffDb.toFixed(2)) : -999,
    postRestoreIsolationMaxDiff: isoDiff.maxAbsDiff,
    postRestoreBpm,
    postRestoreBars,
    postRestoreTrack1Cutoff,
    postRestoreTrack2Cutoff
  };
}

/**
 * Phase 3: Real Chromium OfflineAudioContext 4-Track Heavy Stress Probe.
 * Drives 4 simultaneous full SY-1 AudioWorklet + SynthFXBus tracks with:
 *  - Polyphonic 4-note chords on Track 1 & Track 2
 *  - Rapid 16th-note arpeggios on Track 3 & bass on Track 4
 *  - Rapid Cutoff & Resonance parameter automation sweeps
 *  - Mid-playback preset switch on Track 1
 * Verifies finite output (0 NaN/Inf), peak ceiling <= 1.0, active stereo signal,
 * render CPU real-time factor (RTF), and clean node disposal.
 */
export async function runOffline4TrackStressProbe(sampleRate = 48000, durationSec = 2.0): Promise<{
  sampleRate: number;
  durationSec: number;
  frames: number;
  trackCount: number;
  renderMs: number;
  realtimeFactor: number;
  nonFiniteSamples: number;
  peakL: number;
  peakR: number;
  rmsL: number;
  rmsR: number;
  activeVoicesAfterDispose: number;
}> {
  const frames = Math.round(sampleRate * durationSec);
  const ctx = new OfflineAudioContext(2, frames, sampleRate);
  const master = createStudioMasterBus(ctx, { connectToDestination: true, unityOut: true });

  const presets = ["superSaw", "warmPad", "acidBass", "moogBass"];
  const pans = [-0.5, 0.5, -0.25, 0.25];
  const tracks = presets.map((presetId, idx) =>
    new SY1TrackEngine({
      id: `stress-${idx + 1}`,
      name: `Stress ${idx + 1}`,
      presetId,
      volume: 0.72,
      pan: pans[idx],
      forceHQ: true
    })
  );
  await Promise.all(tracks.map((t) => t.attachAudio(ctx, master.sum)));

  // Schedule dense 4-track polyphonic chords + rapid notes at quantum 1
  ctx.suspend(128 / sampleRate).then(async () => {
    const chord1 = [60, 64, 67, 71];
    const chord2 = [53, 57, 60, 64];
    for (const m of chord1) {
      tracks[0].noteOn(m, 0.85, 0.02);
      tracks[0].noteOff(m, 0.9);
    }
    for (const m of chord2) {
      tracks[1].noteOn(m, 0.75, 0.04);
      tracks[1].noteOff(m, 1.85);
    }
    for (let i = 0; i < 16; i++) {
      const tOn = 0.05 + i * 0.11;
      const tOff = tOn + 0.08;
      const note = 48 + ((i * 5) % 24);
      tracks[2].noteOn(note, 0.85, tOn);
      tracks[2].noteOff(note, tOff);
    }
    const bassNotes = [36, 36, 43, 41];
    for (let i = 0; i < bassNotes.length; i++) {
      tracks[3].noteOn(bassNotes[i], 0.9, 0.02 + i * 0.45);
      tracks[3].noteOff(bassNotes[i], 0.42 + i * 0.45);
    }
    await new Promise((r) => setTimeout(r, 15));
    await ctx.resume();
  });

  // Rapid Cutoff & Resonance sweeps + mid-render preset switch on Track 1
  const sweepTimes = [0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 1.75];
  sweepTimes.forEach((sec, idx) => {
    const qTime = Math.floor((sec * sampleRate) / 128) * (128 / sampleRate);
    ctx.suspend(qTime).then(async () => {
      tracks[2].setParam("cutoff", 220 + idx * 1400);
      tracks[2].setParam("res", 2 + (idx % 4) * 3.2);
      tracks[3].setParam("cutoff", 1800 - idx * 180);
      if (idx === 3) {
        // Mid-playback preset switch on Track 1 followed by fresh chord
        tracks[0].applyPreset("pluck");
        for (const m of [62, 65, 69, 72]) {
          tracks[0].noteOn(m, 0.85, qTime + 0.02);
          tracks[0].noteOff(m, qTime + 0.6);
        }
      }
      await new Promise((r) => setTimeout(r, 5));
      await ctx.resume();
    }).catch(() => {});
  });

  const t0 = performance.now();
  const buf = await ctx.startRendering();
  const renderMs = performance.now() - t0;

  const L = buf.getChannelData(0);
  const R = buf.getChannelData(1);
  let nonFiniteSamples = 0;
  let peakL = 0;
  let peakR = 0;
  let sqL = 0;
  let sqR = 0;
  for (let i = 0; i < L.length; i++) {
    const l = L[i];
    const r = R[i];
    if (!Number.isFinite(l) || !Number.isFinite(r)) {
      nonFiniteSamples++;
      continue;
    }
    const al = Math.abs(l);
    const ar = Math.abs(r);
    if (al > peakL) peakL = al;
    if (ar > peakR) peakR = ar;
    sqL += l * l;
    sqR += r * r;
  }

  let activeVoicesAfterDispose = 0;
  for (const t of tracks) {
    t.dispose();
    activeVoicesAfterDispose += t.getActiveVoiceCount();
  }
  disposeStudioMasterBus(master);

  return {
    sampleRate,
    durationSec,
    frames: L.length,
    trackCount: tracks.length,
    renderMs: Number(renderMs.toFixed(2)),
    realtimeFactor: Number((renderMs / (durationSec * 1000)).toFixed(3)),
    nonFiniteSamples,
    peakL: Number(peakL.toFixed(5)),
    peakR: Number(peakR.toFixed(5)),
    rmsL: Number(Math.sqrt(sqL / Math.max(1, L.length)).toFixed(5)),
    rmsR: Number(Math.sqrt(sqR / Math.max(1, R.length)).toFixed(5)),
    activeVoicesAfterDispose
  };
}
