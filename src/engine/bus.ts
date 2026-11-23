/**
 * SY-1 Engine — Audio Context & Shared FX Bus
 */

import { mirrorCall } from "./mirror";

interface ReverbComb {
  delay: DelayNode;
  damp: AudioNode;
  fb: GainNode;
  wob: OscillatorNode;
  delaySec: number;
}

export interface SynthFXBus {
  ctx: BaseAudioContext;
  input: GainNode;
  drive: WaveShaperNode;
  driveComp: GainNode;
  eqLow: BiquadFilterNode;
  eqMid: BiquadFilterNode;
  eqHigh: BiquadFilterNode;
  delay: DelayNode;
  fb: GainNode;
  delayTone: BiquadFilterNode;
  delayHP: BiquadFilterNode;
  delaySat: WaveShaperNode;
  delayWet: GainNode;
  reverbCombs: ReverbComb[];
  revWet: GainNode;
  sum: GainNode;
  master: GainNode;
  limiter: DynamicsCompressorNode;
  /** Soft clipper after the limiter: transparent below 0.9, never above 1.0 (same curve as native fx.hpp). */
  clipIn: GainNode;
  clip: WaveShaperNode;
  /** Final output after the soft clipper (unity): the recorder taps here, before the master volume. */
  tap: GainNode;
  /** App master volume (one knob for every machine). Unity = the sound exactly as designed. */
  out: GainNode;
  analyser: AnalyserNode;
  chorusWet: GainNode;
  chorusLfo: OscillatorNode;
  chorusDepthL: GainNode;
  chorusDepthR: GainNode;
  revSizeApplied: number;
  dampPeakGain: number;
  /** Everything that feeds delay, chorus and reverb (main signal via mainToFx, plus sendIn). */
  fxIn: GainNode;
  /** Main signal into the effects: 1 for synths, 0 on drum machines (voices use per-voice sends). */
  mainToFx: GainNode;
  /** Effects-only input (no dry path): per-voice drum sends. */
  sendIn: GainNode;
  /** Cached last drive value to skip redundant 1024-sample WaveShaper curve allocations. */
  lastDriveApplied?: number;
  /** Lazy FX branch activation flags (keeps zero-mix feedback loops/LFOs dormant until raised > 0, zero sound change). */
  _delayActive?: boolean;
  _chorusActive?: boolean;
  _reverbActive?: boolean;
  _chorusIn?: GainNode;
  _chorusDl?: DelayNode;
  _chorusDr?: DelayNode;
  _chorusMerge?: ChannelMergerNode;
  /** All internal AudioNodes owned by this bus so disposeSynthBus breaks every cyclic feedback loop cleanly. */
  _nodes?: AudioNode[];
}

let audioCtx: AudioContext | null = null;

// ------------------------------------------------- master volume & output ----
const VOL_KEY = "sy1.masterVol";
const SINK_KEY = "sy1.outputDevice";
let masterVol = 1;
let outputDevice = "";
try {
  const v = localStorage.getItem(VOL_KEY);
  if (v !== null && isFinite(Number(v))) masterVol = Math.max(0, Math.min(1, Number(v)));
  outputDevice = localStorage.getItem(SINK_KEY) || "";
} catch (e) {}
const volListeners = new Set<(v: number) => void>();

/** Master volume 0..1 as a knob position; the gain is position squared (0.5 = -12 dB). */
export function getMasterVolume(): number {
  return masterVol;
}
export function masterGainFor(v: number): number {
  return v * v;
}
function setMasterVolume__impl(v: number): void {
  const next = Math.max(0, Math.min(1, v));
  if (next === masterVol) return;
  masterVol = next;
  try { localStorage.setItem(VOL_KEY, String(next)); } catch (e) {}
  const b = audioCtx ? synthBuses.get(audioCtx) : undefined;
  if (b && audioCtx) b.out.gain.setTargetAtTime(masterGainFor(next), audioCtx.currentTime, 0.015);
  volListeners.forEach((cb) => cb(next));
}
export function onMasterVolumeChange(cb: (v: number) => void): () => void {
  volListeners.add(cb);
  return () => volListeners.delete(cb);
}

/** True when this browser can send the sound to a chosen output device (Chrome / Edge 110+). */
export function canChooseOutput(): boolean {
  return typeof AudioContext !== "undefined" && typeof (AudioContext.prototype as any).setSinkId === "function";
}
export function getOutputDevice(): string {
  return outputDevice;
}
/** Send the whole app to an audio output ("" = system default), e.g. BlackHole / Loopback / VB-Cable for a DAW. */
export async function setOutputDevice(id: string): Promise<boolean> {
  outputDevice = id;
  try { localStorage.setItem(SINK_KEY, id); } catch (e) {}
  return applyOutputDevice();
}
async function applyOutputDevice(): Promise<boolean> {
  const ctx = audioCtx as any;
  if (!ctx || typeof ctx.setSinkId !== "function") return false;
  try {
    if ((ctx.sinkId || "") !== outputDevice) await ctx.setSinkId(outputDevice);
    return true;
  } catch (e) {
    return false;
  }
}

const audioStateListeners = new Set<(state: string, ctx: AudioContext) => void>();

/** Subscribe to shared AudioContext state transitions (including iPadOS Safari "interrupted" / "suspended" / "running"). */
export function onAudioContextStateChange(cb: (state: string, ctx: AudioContext) => void): () => void {
  audioStateListeners.add(cb);
  return () => audioStateListeners.delete(cb);
}

let unlockedOnce = false;

export function getAudioCtx(): AudioContext {
  if (!audioCtx) {
    const AC = window.AudioContext || (window as any).webkitAudioContext;
    if (AC) {
      audioCtx = new AC({ latencyHint: "interactive" });
      const ctx = audioCtx;
      if (typeof ctx.addEventListener === "function") {
        ctx.addEventListener("statechange", () => {
          // On iPadOS Safari, app switching / screen lock moves AudioContext to "interrupted" or "suspended".
          // Reset unlockedOnce so the next user gesture re-runs audioSession & silent unlock buffer cleanly.
          if (ctx.state !== "running") {
            unlockedOnce = false;
          }
          audioStateListeners.forEach((cb) => {
            try { cb(ctx.state, ctx); } catch (e) {}
          });
        });
      }
      if (outputDevice) applyOutputDevice();
    }
  }
  return audioCtx!;
}

export function getAudioCtxIfAny(): AudioContext | null {
  return audioCtx;
}

/**
 * Wake the audio context. Browsers only allow this inside a user gesture, so it
 * is called from every touch, click and key press (see installAudioUnlock) and
 * the very first key you play makes sound: no separate "start audio" button.
 */
export function unlockAudio(): void {
  // iOS 17+: play through the speaker even when the ring/silent switch is on silent
  try {
    const nav = navigator as any;
    if (nav.audioSession && nav.audioSession.type !== "playback") nav.audioSession.type = "playback";
  } catch (e) {}
  const ctx = getAudioCtx();
  if (!ctx) return;
  if (ctx.state !== "running") {
    ctx.resume().catch(() => {});
  }
  if (!unlockedOnce) {
    // Older iOS / post-interrupt Safari only unlocks after a sound is started inside the gesture: play one silent sample
    try {
      const src = ctx.createBufferSource();
      src.buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
      src.connect(ctx.destination);
      src.onended = () => {
        try { src.disconnect(); } catch (e) {}
      };
      src.start(0);
      unlockedOnce = true;
    } catch (e) {}
  }
}

/** Resume audio on any gesture anywhere on the page (and again after the OS suspends/interrupts it). */
export function installAudioUnlock(onGesture: () => void): void {
  const handler = () => {
    const ctx = getAudioCtxIfAny();
    if (ctx && ctx.state === "running" && unlockedOnce) return;
    onGesture();
  };
  ["pointerdown", "touchstart", "touchend", "mousedown", "click", "keydown"].forEach((type) => {
    window.addEventListener(type, handler, { capture: true, passive: true });
  });
  const resumeIfVisible = () => {
    if (typeof document !== "undefined" && document.hidden) return;
    try {
      const nav = navigator as any;
      if (nav.audioSession && nav.audioSession.type !== "playback") nav.audioSession.type = "playback";
    } catch (e) {}
    const ctx = getAudioCtxIfAny();
    if (ctx && ctx.state !== "running") ctx.resume().catch(() => {});
  };
  document.addEventListener("visibilitychange", resumeIfVisible);
  window.addEventListener("pageshow", resumeIfVisible);
  window.addEventListener("focus", resumeIfVisible);
}

const synthBuses = new WeakMap<BaseAudioContext, SynthFXBus>();
let synthNoiseBuffer: AudioBuffer | null = null;

export function getSharedNoiseBuffer(ctx: BaseAudioContext): AudioBuffer {
  if (!synthNoiseBuffer || synthNoiseBuffer.sampleRate !== ctx.sampleRate) {
    synthNoiseBuffer = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = synthNoiseBuffer.getChannelData(0);
    for (let i = 0; i < d.length; i++) {
      d[i] = Math.random() * 2 - 1;
    }
  }
  return synthNoiseBuffer;
}

const driveCurveCache = new Map<number, Float32Array>();

export function makeDriveCurve(amount: number): Float32Array {
  const cached = driveCurveCache.get(amount);
  if (cached) return cached;
  const k = amount * 60;
  const n = 1024;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = k === 0 ? x : ((1 + k) * x) / (1 + k * Math.abs(x));
  }
  if (driveCurveCache.size >= 64) {
    const oldest = driveCurveCache.keys().next().value;
    if (oldest !== undefined) driveCurveCache.delete(oldest);
  }
  driveCurveCache.set(amount, curve);
  return curve;
}

/** Gentle fixed tanh soft-clip used in the delay feedback loop so hot repeats warm up instead of distorting harshly. */
export const CLIP_RANGE = 4;
let cachedSoftClipCurve: Float32Array | null = null;
/** soft(x): identity up to 0.9, then 0.9 + 0.1*tanh((|x|-0.9)/0.1): never above 1.0. Over x in +-CLIP_RANGE. */
export function makeSoftClipCurve(): Float32Array {
  if (cachedSoftClipCurve) return cachedSoftClipCurve;
  const n = 8193; // odd: exact 0 in the middle
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = ((i / (n - 1)) * 2 - 1) * CLIP_RANGE;
    const a = Math.abs(x);
    const y = a <= 0.9 ? a : 0.9 + 0.1 * Math.tanh((a - 0.9) / 0.1);
    c[i] = x < 0 ? -y : y;
  }
  cachedSoftClipCurve = c;
  return c;
}

let cachedTanhCurve: Float32Array | null = null;
function makeTanhCurve(): Float32Array {
  if (cachedTanhCurve) return cachedTanhCurve;
  const n = 1024;
  const curve = new Float32Array(n);
  const k = 1.6; // fixed, moderate drive — not user-controllable
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.tanh(x * k) / Math.tanh(k);
  }
  cachedTanhCurve = curve;
  return curve;
}

/** Freeverb-style comb delay lengths (seconds, derived from the classic 44.1kHz sample counts) and allpass delays. */
const REVERB_COMB_DELAYS_SEC = [1557, 1617, 1491, 1422, 1277, 1356, 1188, 1116].map((s) => s / 44100);
const REVERB_ALLPASS_DELAYS_SEC = [556, 441, 341, 225].map((s) => s / 44100);
/**
 * Comb damping: a ONE-POLE low-pass, as in the original Freeverb. Its gain falls
 * monotonically from exactly 1 at DC, so every lower frequency rings at least as
 * long as every higher one. (A biquad here had a passband bump near 2-3 kHz: once
 * the feedback was scaled for that bump, the lows died early and the tail turned
 * into a whistle around 2.5 kHz on every release.)
 */
const REVERB_COMB_DAMP_HZ = 4500;

function makeDamp(ctx: BaseAudioContext): AudioNode {
  const d = Math.exp((-2 * Math.PI * REVERB_COMB_DAMP_HZ) / ctx.sampleRate);
  if (typeof (ctx as any).createIIRFilter === "function") return ctx.createIIRFilter([1 - d], [1, -d]);
  const b = ctx.createBiquadFilter(); // fallback: no resonance
  b.type = "lowpass";
  b.frequency.value = REVERB_COMB_DAMP_HZ;
  b.Q.value = -6;
  return b;
}
const REVERB_ALLPASS_G = 0.5;
const REVERB_FB_MAX = 0.97;

const dampPeakGainCache = new Map<string, number>();

/**
 * Web Audio's biquad lowpass does not stay <=1 near its cutoff at this frequency/sample-rate ratio
 * (bilinear-transform warping) — it has a real passband bump regardless of Q. Rather than guess the
 * size of that bump, measure it once per sample-rate & filter kind with the filter's own getFrequencyResponse,
 * so the comb feedback can be compensated by the EXACT value and the reverb can run as close to its
 * requested decay time as safely possible (not an over-cautious fixed guess).
 */
function measureDampPeakGain(ctx: BaseAudioContext): number {
  const kind = typeof (ctx as any).createIIRFilter === "function" ? "iir" : "bq";
  const cacheKey = `${ctx.sampleRate}:${kind}`;
  const cached = dampPeakGainCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const probe = makeDamp(ctx) as BiquadFilterNode | IIRFilterNode;
  const n = 300;
  const freqs = new Float32Array(n);
  const nyquist = ctx.sampleRate / 2;
  for (let i = 0; i < n; i++) freqs[i] = (i / n) * nyquist;
  const mag = new Float32Array(n);
  const phase = new Float32Array(n);
  probe.getFrequencyResponse(freqs, mag, phase);
  try { probe.disconnect(); } catch (e) {}
  let peak = 1;
  for (let i = 0; i < n; i++) if (Number.isFinite(mag[i]) && mag[i] > peak) peak = mag[i];
  const compensated = peak * 1.01; // the one-pole peaks at exactly 1 (DC); 1% margin
  dampPeakGainCache.set(cacheKey, compensated);
  return compensated;
}

/** Per-comb feedback gain that targets an approximate RT60 (seconds) for that comb's own delay length,
 *  compensated by dampPeakGain so the damping filter's passband bump can never push the loop into runaway. */
function combFeedbackForRT60(delaySec: number, rt60: number, dampPeakGain: number): number {
  const t = Math.max(0.05, rt60);
  const g = Math.pow(10, (-3 * delaySec) / t) / dampPeakGain;
  return Math.min(REVERB_FB_MAX, Math.max(0, g));
}

/** input -> N parallel damped combs (feedback = f(revSize)) -> M series allpass diffusers -> output. No audio files. */
function buildReverb(
  ctx: BaseAudioContext,
  input: AudioNode,
  revSize: number,
  ownedNodes: AudioNode[]
): { combs: ReverbComb[]; output: AudioNode; dampPeakGain: number } {
  const dampPeakGain = measureDampPeakGain(ctx);
  const combInputScale = ctx.createGain();
  combInputScale.gain.value = 0.14; // keeps 8 summed combs from building up too hot (the one-pole damping keeps more low end ringing than the old biquad)
  input.connect(combInputScale);

  const combSum = ctx.createGain();
  ownedNodes.push(combInputScale, combSum);

  const combs: ReverbComb[] = REVERB_COMB_DELAYS_SEC.map((delaySec, idx) => {
    const delay = ctx.createDelay(1);
    delay.delayTime.value = delaySec;
    const damp = makeDamp(ctx);
    // a slow, tiny wobble of each comb's length (different rate per comb) smears its fixed
    // resonances, so long tails stay smooth instead of ringing on single metallic notes
    const wob = ctx.createOscillator();
    wob.frequency.value = 0.13 + 0.11 * (idx % 8);
    const wobAmt = ctx.createGain();
    wobAmt.gain.value = 0.00035; // ±0.35 ms
    wob.connect(wobAmt);
    wobAmt.connect(delay.delayTime);
    wob.start();
    const fb = ctx.createGain();
    fb.gain.value = combFeedbackForRT60(delaySec, revSize, dampPeakGain);

    combInputScale.connect(delay);
    delay.connect(damp);
    damp.connect(fb);
    fb.connect(delay); // feedback loop (sums with combInputScale at the delay's input)
    damp.connect(combSum);

    ownedNodes.push(delay, damp, wob, wobAmt, fb);
    return { delay, damp, fb, wob, delaySec };
  });

  // Series Schroeder allpass diffusers: y = -g*u + z, u = x + g*z, z = delay(u)
  let stage: AudioNode = combSum;
  for (const delaySec of REVERB_ALLPASS_DELAYS_SEC) {
    const u = ctx.createGain();
    const delay = ctx.createDelay(1);
    delay.delayTime.value = delaySec;
    const fbGain = ctx.createGain();
    fbGain.gain.value = REVERB_ALLPASS_G;
    const negGain = ctx.createGain();
    negGain.gain.value = -REVERB_ALLPASS_G;
    const out = ctx.createGain();

    stage.connect(u);
    u.connect(delay);
    delay.connect(fbGain);
    fbGain.connect(u); // feedback: g*z back into u
    u.connect(negGain); // -g*u branch
    negGain.connect(out);
    delay.connect(out); // z branch
    ownedNodes.push(u, delay, fbGain, negGain, out);
    stage = out;
  }

  return { combs, output: stage, dampPeakGain };
}

/** Smoothly re-targets every comb's feedback gain for a new revSize (RT60-ish, seconds). No buffer rebuild, no debounce needed. */
export function setReverbSize(bus: SynthFXBus, revSize: number): void {
  const ctx = bus.ctx;
  const now = ctx.currentTime;
  bus.reverbCombs.forEach((c) => {
    c.fb.gain.setTargetAtTime(combFeedbackForRT60(c.delaySec, revSize, bus.dampPeakGain), now, 0.05);
  });
  bus.revSizeApplied = revSize;
}

// Whether the main signal feeds delay/chorus/reverb (synths) or only per-voice sends do (drum machines).
let mainFxOn = true;

/** Drum machines turn this off so reverb and delay come only from per-voice sends. */
export function setMainToFx(on: boolean): void {
  mainFxOn = on;
  const ctx = audioCtx;
  const b = ctx ? synthBuses.get(ctx) : undefined;
  if (b && ctx) b.mainToFx.gain.setTargetAtTime(on ? 1 : 0, ctx.currentTime, 0.02);
}

export interface CreateSynthBusOptions {
  /** Connect tap -> out -> analyser -> ctx.destination (default true for standalone SY-1). */
  connectToDestination?: boolean;
  /** Initial mainToFx gate (default follows standalone mainFxOn; Studio synth tracks pass true). */
  mainFxOn?: boolean;
}

/**
 * Create an independent SY-1 FX bus with the exact standalone signal chain,
 * gain staging, EQ, tape delay, stereo chorus, Freeverb, limiter and soft clipper.
 */
export function createSynthBus(
  ctx: BaseAudioContext,
  synthPatch: Record<string, any>,
  options: CreateSynthBusOptions = {}
): SynthFXBus {
  const connectToDest = options.connectToDestination !== false;
  const initialMainFx = options.mainFxOn !== undefined ? options.mainFxOn : mainFxOn;
  const p = synthPatch;
  const input = ctx.createGain();
  const drive = ctx.createWaveShaper();
  drive.curve = makeDriveCurve(p.drive) as any;
  drive.oversample = "2x";

  const driveComp = ctx.createGain();
  driveComp.gain.value = 1 / (1 + p.drive * 1.5);

  const eqLow = ctx.createBiquadFilter();
  eqLow.type = "lowshelf";
  eqLow.frequency.value = 220;
  eqLow.gain.value = p.eqLow;

  const eqMid = ctx.createBiquadFilter();
  eqMid.type = "peaking";
  eqMid.frequency.value = 1100;
  eqMid.Q.value = 0.8;
  eqMid.gain.value = p.eqMid;

  const eqHigh = ctx.createBiquadFilter();
  eqHigh.type = "highshelf";
  eqHigh.frequency.value = 4200;
  eqHigh.gain.value = p.eqHigh;

  input.connect(drive);
  drive.connect(driveComp);
  driveComp.connect(eqLow);
  eqLow.connect(eqMid);
  eqMid.connect(eqHigh);

  const sum = ctx.createGain();
  eqHigh.connect(sum); // dry

  // Effects input: the main signal (unless a drum machine turns it off) plus per-voice sends
  const fxIn = ctx.createGain();
  const mainToFx = ctx.createGain();
  mainToFx.gain.value = initialMainFx ? 1 : 0;
  const sendIn = ctx.createGain();
  eqHigh.connect(mainToFx);
  mainToFx.connect(fxIn);
  sendIn.connect(fxIn);

  const delay = ctx.createDelay(2);
  delay.delayTime.value = p.delayTime;
  const fb = ctx.createGain();
  fb.gain.value = Math.min(0.95, p.delayFb);
  const delayTone = ctx.createBiquadFilter();
  delayTone.type = "lowpass";
  delayTone.frequency.value = 4500;
  delayTone.Q.value = Math.SQRT1_2; // flat response — no resonant peak inside the feedback loop
  const delayHP = ctx.createBiquadFilter();
  delayHP.type = "highpass";
  delayHP.frequency.value = 180; // classic tape-delay feedback EQ: trims mud before it recirculates
  delayHP.Q.value = Math.SQRT1_2;
  const delaySat = ctx.createWaveShaper();
  delaySat.curve = makeTanhCurve() as any;
  delaySat.oversample = "2x";
  const delayWet = ctx.createGain();
  const initialDelayMix = Number(p.delayMix) || 0;
  delayWet.gain.value = initialDelayMix * 0.7;

  // Connect the cyclic tape-delay feedback loop only when delayMix > 0 (or lazily on first rise > 0).
  // When delayMix === 0, delayWet gain is 0 so output is mathematically bit-identical (0.0).
  const delayActive = initialDelayMix > 0;
  if (delayActive) {
    fxIn.connect(delay);
    delay.connect(delayTone);
    delayTone.connect(delayHP);
    delayHP.connect(delayWet); // wet tap: filtered, not yet saturated by the feedback-loop drive
    delayWet.connect(sum);
    delayHP.connect(delaySat);
    delaySat.connect(fb);
    fb.connect(delay); // feedback loop
  }

  // Stereo chorus: two short modulated delays, LFO in opposite phase on L and R
  const chorusIn = ctx.createGain();
  const dl = ctx.createDelay(0.05);
  const dr = ctx.createDelay(0.05);
  dl.delayTime.value = 0.012;
  dr.delayTime.value = 0.012;
  const chorusLfo = ctx.createOscillator();
  chorusLfo.type = "triangle";
  chorusLfo.frequency.value = p.chorusRate ?? 0.6;
  const chorusDepthL = ctx.createGain();
  const chorusDepthR = ctx.createGain();
  chorusDepthL.gain.value = 0.004 * (p.chorusDepth ?? 0.5);
  chorusDepthR.gain.value = -0.004 * (p.chorusDepth ?? 0.5);
  const chorusMerge = ctx.createChannelMerger(2);
  const chorusWet = ctx.createGain();
  const initialChorusMix = Number(p.chorusMix ?? 0) || 0;
  chorusWet.gain.value = initialChorusMix * 0.9;

  // Activate stereo chorus modulated delay graph only when chorusMix > 0 (or lazily on first rise > 0).
  // chorusLfo is started once and cleanly stopped in disposeSynthBus to preserve bus oscillator lifecycle parity.
  chorusLfo.start();
  const chorusActive = initialChorusMix > 0;
  if (chorusActive) {
    fxIn.connect(chorusIn);
    chorusIn.connect(dl);
    chorusIn.connect(dr);
    chorusLfo.connect(chorusDepthL);
    chorusLfo.connect(chorusDepthR);
    chorusDepthL.connect(dl.delayTime);
    chorusDepthR.connect(dr.delayTime);
    dl.connect(chorusMerge, 0, 0);
    dr.connect(chorusMerge, 0, 1);
    chorusMerge.connect(chorusWet);
    chorusWet.connect(sum);
  }

  const ownedNodes: AudioNode[] = [];
  const revWet = ctx.createGain();
  const initialRevMix = Number(p.revMix) || 0;
  revWet.gain.value = initialRevMix * 0.9;

  // Build Freeverb 8-comb + 4-allpass graph only when revMix > 0 (or lazily on first rise > 0).
  const reverbActive = initialRevMix > 0;
  let reverbCombs: ReverbComb[] = [];
  let dampPeakGain = 1.01;
  if (reverbActive) {
    const builtRev = buildReverb(ctx, fxIn, p.revSize, ownedNodes);
    reverbCombs = builtRev.combs;
    dampPeakGain = builtRev.dampPeakGain;
    builtRev.output.connect(revWet);
    revWet.connect(sum);
  }

  const master = ctx.createGain();
  master.gain.value = p.volume;

  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -6;
  limiter.ratio.value = 12;
  limiter.attack.value = 0.003;
  limiter.release.value = 0.2;

  const analyser = ctx.createAnalyser();
  analyser.fftSize = connectToDest ? 2048 : 256;

  sum.connect(master);
  master.connect(limiter);
  // Soft clipper: the limiter's 3 ms attack lets the sharpest transients (acoustic drums)
  // slip past; this catches them smoothly instead of hard digital clipping. Input is
  // pre-scaled by 1/4 so the curve covers +-4 (a WaveShaper clamps beyond +-1).
  const clipIn = ctx.createGain();
  clipIn.gain.value = 1 / CLIP_RANGE;
  const clip = ctx.createWaveShaper();
  clip.curve = makeSoftClipCurve() as any;
  clip.oversample = "none"; // oversampling's filters ring ~5% past the curve; "none" keeps the 1.0 ceiling exact
  limiter.connect(clipIn);
  clipIn.connect(clip);
  const tap = ctx.createGain();
  const out = ctx.createGain();
  out.gain.value = masterGainFor(masterVol);
  clip.connect(tap);
  if (connectToDest) {
    tap.connect(out);
    out.connect(analyser);
    analyser.connect(ctx.destination);
  }

  ownedNodes.push(
    input,
    drive,
    driveComp,
    eqLow,
    eqMid,
    eqHigh,
    sum,
    fxIn,
    mainToFx,
    sendIn,
    delay,
    fb,
    delayTone,
    delayHP,
    delaySat,
    delayWet,
    chorusIn,
    dl,
    dr,
    chorusLfo,
    chorusDepthL,
    chorusDepthR,
    chorusMerge,
    chorusWet,
    revWet,
    master,
    limiter,
    clipIn,
    clip,
    tap,
    out,
    analyser
  );

  return {
    ctx,
    input,
    drive,
    driveComp,
    eqLow,
    eqMid,
    eqHigh,
    delay,
    fb,
    delayTone,
    delayHP,
    delaySat,
    delayWet,
    reverbCombs,
    revWet,
    sum,
    master,
    limiter,
    tap,
    out,
    analyser,
    chorusWet,
    chorusLfo,
    chorusDepthL,
    chorusDepthR,
    revSizeApplied: p.revSize,
    dampPeakGain,
    fxIn,
    mainToFx,
    sendIn,
    clipIn,
    clip,
    lastDriveApplied: Number(p.drive),
    _delayActive: delayActive,
    _chorusActive: chorusActive,
    _reverbActive: reverbActive,
    _chorusIn: chorusIn,
    _chorusDl: dl,
    _chorusDr: dr,
    _chorusMerge: chorusMerge,
    _nodes: ownedNodes
  };
}

function ensureDelayBranchActive(bus: SynthFXBus): void {
  if (bus._delayActive) return;
  bus._delayActive = true;
  bus.fxIn.connect(bus.delay);
  bus.delay.connect(bus.delayTone);
  bus.delayTone.connect(bus.delayHP);
  bus.delayHP.connect(bus.delayWet);
  bus.delayWet.connect(bus.sum);
  bus.delayHP.connect(bus.delaySat);
  bus.delaySat.connect(bus.fb);
  bus.fb.connect(bus.delay);
}

function ensureChorusBranchActive(bus: SynthFXBus): void {
  if (bus._chorusActive || !bus._chorusIn || !bus._chorusDl || !bus._chorusDr || !bus._chorusMerge) return;
  bus._chorusActive = true;
  const dl = bus._chorusDl;
  const dr = bus._chorusDr;
  const chorusMerge = bus._chorusMerge;
  bus.fxIn.connect(bus._chorusIn);
  bus._chorusIn.connect(dl);
  bus._chorusIn.connect(dr);
  bus.chorusLfo.connect(bus.chorusDepthL);
  bus.chorusLfo.connect(bus.chorusDepthR);
  bus.chorusDepthL.connect(dl.delayTime);
  bus.chorusDepthR.connect(dr.delayTime);
  dl.connect(chorusMerge, 0, 0);
  dr.connect(chorusMerge, 0, 1);
  chorusMerge.connect(bus.chorusWet);
  bus.chorusWet.connect(bus.sum);
}

function ensureReverbBranchActive(bus: SynthFXBus): void {
  if (bus._reverbActive) return;
  bus._reverbActive = true;
  const owned = bus._nodes || [];
  const builtRev = buildReverb(bus.ctx, bus.fxIn, bus.revSizeApplied, owned);
  bus.reverbCombs = builtRev.combs;
  bus.dampPeakGain = builtRev.dampPeakGain;
  builtRev.output.connect(bus.revWet);
  bus.revWet.connect(bus.sum);
}

/** Apply a single synth patch FX parameter to a SynthFXBus with the exact standalone curves and time constants. */
export function applyBusParam(bus: SynthFXBus, key: string, value: any): void {
  const ctx = bus.ctx;
  const now = ctx.currentTime;
  const v = Number(value);
  if (key === "drive") {
    if (bus.lastDriveApplied !== v) {
      bus.drive.curve = makeDriveCurve(v) as any;
      bus.lastDriveApplied = v;
    }
    bus.driveComp.gain.setTargetAtTime(1 / (1 + v * 1.5), now, 0.02);
  } else if (key === "eqLow") bus.eqLow.gain.setTargetAtTime(v, now, 0.02);
  else if (key === "eqMid") bus.eqMid.gain.setTargetAtTime(v, now, 0.02);
  else if (key === "eqHigh") bus.eqHigh.gain.setTargetAtTime(v, now, 0.02);
  else if (key === "delayTime") bus.delay.delayTime.setTargetAtTime(v, now, 0.05);
  else if (key === "delayFb") bus.fb.gain.setTargetAtTime(Math.min(0.95, v), now, 0.02);
  else if (key === "delayMix") {
    if (v > 0) ensureDelayBranchActive(bus);
    bus.delayWet.gain.setTargetAtTime(v * 0.7, now, 0.02);
  } else if (key === "revMix") {
    if (v > 0) ensureReverbBranchActive(bus);
    bus.revWet.gain.setTargetAtTime(v * 0.9, now, 0.02);
  } else if (key === "chorusMix") {
    if (v > 0) ensureChorusBranchActive(bus);
    bus.chorusWet.gain.setTargetAtTime(v * 0.9, now, 0.03);
  } else if (key === "chorusRate") bus.chorusLfo.frequency.setTargetAtTime(v, now, 0.05);
  else if (key === "chorusDepth") {
    bus.chorusDepthL.gain.setTargetAtTime(0.004 * v, now, 0.05);
    bus.chorusDepthR.gain.setTargetAtTime(-0.004 * v, now, 0.05);
  } else if (key === "volume") bus.master.gain.setTargetAtTime(v, now, 0.02);
  else if (key === "revSize") setReverbSize(bus, v);
}

/** Disconnect every internal node and stop all oscillators of a disposable track FX bus (breaks all 13 feedback cycles). */
export function disposeSynthBus(bus: SynthFXBus): void {
  try { bus.chorusLfo.stop(); } catch (e) {}
  bus.reverbCombs.forEach((c) => {
    try { c.wob.stop(); } catch (e) {}
  });
  if (bus._nodes && bus._nodes.length > 0) {
    for (let i = 0; i < bus._nodes.length; i++) {
      try { bus._nodes[i].disconnect(); } catch (e) {}
    }
    bus._nodes.length = 0;
    return;
  }
  try { bus.input.disconnect(); } catch (e) {}
  try { bus.tap.disconnect(); } catch (e) {}
  try { bus.out.disconnect(); } catch (e) {}
  try { bus.analyser.disconnect(); } catch (e) {}
}

export function getSynthBus(ctx: BaseAudioContext, synthPatch: Record<string, any>): SynthFXBus {
  let bus = synthBuses.get(ctx);
  if (bus) return bus;
  bus = createSynthBus(ctx, synthPatch, { connectToDestination: true });
  synthBuses.set(ctx, bus);
  return bus;
}

/** mirrored for the plugin (see mirror.ts) */
export function setMasterVolume(...args: Parameters<typeof setMasterVolume__impl>): ReturnType<typeof setMasterVolume__impl> {
  return mirrorCall("setMasterVolume", setMasterVolume__impl, args);
}
