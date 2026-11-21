/**
 * SY-1 Studio — OfflineAudioContext Sound Parity & Track Isolation Probe
 *
 * Used by automated browser verification (Chromium OfflineAudioContext + real
 * "sy1-voices" AudioWorklet + real SynthFXBus + real StudioMasterBus) to prove
 * sound parity and zero cross-track leakage with measured sample-level metrics.
 */

import { createSynthBus } from "../engine/bus";
import { createHQNode } from "../engine/hq";
import { createStudioMasterBus, createStudioEngine } from "./studio-engine";
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
  return await ctx.startRendering();
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
  track.detachAudio();
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
