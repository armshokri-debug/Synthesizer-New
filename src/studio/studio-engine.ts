import { drumPatternMidi } from "./track-drum-patterns";
import { LiveDrumSequence } from "./live-drum-sequence";
import { arpStepBeats } from "./track-arpeggiator";
/**
 * SY-1 Studio — Multi-Track Studio Engine, Shared Audio-Clock Transport,
 * Lookahead MIDI Scheduler, Live Mix Recorder & Deterministic 24-bit WAV Bounce.
 */

import {
  CLIP_RANGE,
  getAudioCtx,
  getAudioCtxIfAny,
  getMasterVolume,
  masterGainFor,
  onAudioContextStateChange,
  onMasterVolumeChange,
  unlockAudio
} from "../engine/bus";
import { encodeWav, ensureRecorderWorklet, RECORDER_MAX_SECONDS } from "../engine/daw";
import { trimCaptureWindow } from "./recording-window";
import { getTempo, onTempoChange, setTempo } from "../engine/tempo";
import { encodeStudioMidi } from "./midi-io";
import {
  createProjectBlob,
  createProjectId,
  sanitizeProjectName,
  serializeStudioProject,
  slugifyFilename,
  validateStudioProject
} from "./project-io";
import { getStudioMachineDef, SY1TrackEngine } from "./track-engine";
import { RegionEditor } from "./region-editor";
import { cloneRegion, flattenRegions, type MidiRegion } from "./midi-regions";
import { StudioMetronome } from "./metronome";
import {
  STUDIO_BEATS_PER_BAR,
  STUDIO_MAX_BARS,
  STUDIO_MAX_TRACKS,
  STUDIO_MIN_BARS,
  STUDIO_PPQ,
  STUDIO_PROJECT_FORMAT,
  STUDIO_PROJECT_VERSION,
  STUDIO_TICKS_PER_BAR,
  StudioMidiEvent,
  StudioNoteSpan,
  StudioProjectData,
  StudioRecordingMode,
  StudioStemTake,
  StudioTake,
  StudioTrackSnapshot,
  StudioTransportSnapshot
} from "./types";

/**
 * Estimated peak RAM per stereo frame during live capture + 24-bit WAV encode:
 * 2 channels * 4 bytes (Float32 chunks) + 2 channels * 3 bytes (24-bit PCM buffer) = 14 bytes/frame.
 */
export const STUDIO_LIVE_BYTES_PER_FRAME = 14;
export const STUDIO_LIVE_RAM_BUDGET_DESKTOP = 256 * 1024 * 1024; // 256 MB
export const STUDIO_LIVE_RAM_BUDGET_MOBILE = 128 * 1024 * 1024;  // 128 MB (iPad / low-RAM safety)

export function getLiveRecordingRamBudgetBytes(): number {
  if (typeof navigator === "undefined") return STUDIO_LIVE_RAM_BUDGET_DESKTOP;
  const nav = navigator as Navigator & { deviceMemory?: number };
  const ua = nav.userAgent || "";
  const isTouchMobile =
    /iPad|iPhone|iPod/i.test(ua) ||
    (nav.maxTouchPoints > 1 && /Macintosh/i.test(ua));
  if (isTouchMobile || (typeof nav.deviceMemory === "number" && nav.deviceMemory <= 4)) {
    return STUDIO_LIVE_RAM_BUDGET_MOBILE;
  }
  return STUDIO_LIVE_RAM_BUDGET_DESKTOP;
}

const SCHEDULER_INTERVAL_MS = 25;
const LOOKAHEAD_SEC = 0.1;
/** Small live-AudioContext start headroom so beat 1 (tick 0) schedules cleanly ahead of ctx.currentTime without late clamping or inter-voice flam. */
const PLAY_START_LEAD_SEC = 0.05;
const SEEK_PLAY_LEAD_SEC = 0.025;
/** If the audio clock jumps further ahead than this (main-thread stall or iPad background sleep), re-anchor cleanly instead of burst-firing stale backlog. */
const SCHEDULER_STALL_THRESHOLD_SEC = 0.35;

let cachedStudioMasterClipCurve: Float32Array | null = null;

/**
 * Transparent Studio master safety soft-clipper:
 * - Exact mathematical identity y = x for |x| <= 0.98 (-0.175 dBFS), so any
 *   single SY-1 track (already soft-clipped by its own SY-1 FX bus) passes
 *   through unaltered.
 * - Smooth tanh knee above 0.98 asymptotically capped at 1.0 when multiple
 *   hot tracks sum together.
 */
export function makeStudioMasterClipCurve(): Float32Array {
  if (cachedStudioMasterClipCurve) return cachedStudioMasterClipCurve;
  const n = 8193;
  const c = new Float32Array(n);
  const knee = 0.98;
  const head = 1 - knee;
  for (let i = 0; i < n; i++) {
    const x = ((i / (n - 1)) * 2 - 1) * CLIP_RANGE;
    const a = Math.abs(x);
    const y = a <= knee ? a : knee + head * Math.tanh((a - knee) / head);
    c[i] = x < 0 ? -y : y;
  }
  cachedStudioMasterClipCurve = c;
  return c;
}

export interface StudioMasterBus {
  ctx: BaseAudioContext;
  sum: GainNode;
  clipIn: GainNode;
  clip: WaveShaperNode;
  tap: GainNode;
  out: GainNode;
  analyser: AnalyserNode;
}

export function createStudioMasterBus(
  ctx: BaseAudioContext,
  options: { connectToDestination?: boolean; unityOut?: boolean } = {}
): StudioMasterBus {
  const connectToDest = options.connectToDestination !== false;
  const sum = ctx.createGain();
  sum.gain.value = 1;

  const clipIn = ctx.createGain();
  clipIn.gain.value = 1 / CLIP_RANGE;

  const clip = ctx.createWaveShaper();
  clip.curve = makeStudioMasterClipCurve() as any;
  clip.oversample = "none";

  const tap = ctx.createGain();
  tap.gain.value = 1;

  const out = ctx.createGain();
  out.gain.value = options.unityOut ? 1 : masterGainFor(getMasterVolume());

  const analyser = ctx.createAnalyser();
  analyser.fftSize = connectToDest ? 2048 : 256;

  sum.connect(clipIn);
  clipIn.connect(clip);
  clip.connect(tap);

  if (connectToDest) {
    tap.connect(out);
    out.connect(analyser);
    analyser.connect(ctx.destination);
  }

  return { ctx, sum, clipIn, clip, tap, out, analyser };
}

/** Disconnect all nodes of a StudioMasterBus cleanly. */
export function disposeStudioMasterBus(bus: StudioMasterBus | null): void {
  if (!bus) return;
  try { bus.sum.disconnect(); } catch (e) {}
  try { bus.clipIn.disconnect(); } catch (e) {}
  try { bus.clip.disconnect(); } catch (e) {}
  try { bus.tap.disconnect(); } catch (e) {}
  try { bus.out.disconnect(); } catch (e) {}
  try { bus.analyser.disconnect(); } catch (e) {}
}

interface LiveRecorderSession {
  ctx: AudioContext;
  node: AudioWorkletNode;
  sink: GainNode;
  chunks: Float32Array[][];
  frames: number;
  bpm: number;
  firstFrame: number | null;
  startAt: number | null;
}

export interface ScheduledDispatchRecord {
  trackId: string;
  event: StudioMidiEvent;
  audioTime: number;
  source?: "drum-preview";
}

export interface StudioEngineOptions {
  /** Custom clock source (for deterministic non-browser testing). */
  clockNow?: () => number;
  /** Disable binding to global tempo listener (for isolated unit tests). */
  isolatedTempo?: boolean;
  /** Initial BPM when isolatedTempo is true. */
  initialBpm?: number;
}

const DEFAULT_TRACK_PRESETS = ["softKeys", "moogBass", "warmPad", "lead"];

export class SY1StudioEngine {
  readonly regions = new RegionEditor({
    tracks: () => this.tracks,
    length: () => this.getTotalTicks(),
    focus: id => this.setFocusedTrack(id),
    recording: () => this.recording || this.preparingRecord,
    commit: () => this.refreshRegionPlayback()
  });

  private refreshRegionPlayback(): void {
    if (this.playing) {
      const tick = this.getCurrentTick();
      this.playbackOpenNotes.clear();
      this.playbackSustainDown.clear();
      this.liveHeldTracksByMidi.clear();
      for (const track of this.tracks) track.cancelRegionPlayback(this.masterBus?.sum);
      this.seekToTick(tick);
      this.stepScheduler(this.nowAudioTime());
      this.notifyKeys();
    } else this.notify();
  }

  private tracks: SY1TrackEngine[] = [];
  private focusedTrackId: string;
  private projectId = createProjectId();
  private projectName = "Untitled Project";
  private hasRestoredBpmPending = false;
  private masterBus: StudioMasterBus | null = null;
  private unsubMasterVol: (() => void) | null = null;
  private unsubTempo: (() => void) | null = null;
  private unsubAudioState: (() => void) | null = null;

  private active = false;
  private playing = false;
  private recording = false;
  private transportEpoch = 0;
  private preparingRecord = false;
  private finalizingRecord = false;
  private countInStart: number | null = null;
  private countInEnd: number | null = null;
  // The capture boundary is not the moving transport anchor (which changes at loops).
  private recordingStartAt: number | null = null;
  private pendingRecordingStart: ((at: number) => void) | null = null;
  // Standalone generated notes are heard directly. Avoid monitoring them a second
  // time through the MIDI lookahead on the same pass; later loop passes replay them.
  private performanceCaptureTimes = new WeakMap<StudioMidiEvent, number>();
  private metronome = new StudioMetronome();
  private clickEnabled = false;
  private countInEnabled = false;
  private recordingMode: StudioRecordingMode = "overdub";
  private loopEnabled = true;
  private bars = 8;
  private loopStartBar = 1;
  private loopEndBar = 8;

  private bpm: number;
  private tapTimes: number[] = [];
  private playheadTick = 0;
  private anchorAudioTime = 0;
  private anchorTick = 0;
  private anchorBpm: number;

  private schedulerTimer: ReturnType<typeof setInterval> | null = null;
  private drumPreview: {
    track: SY1TrackEngine;
    voice: SY1TrackEngine;
    sequence: LiveDrumSequence;
    scheduled: {tick:number;midi:number;velocity:number;at:number;handle?: ReturnType<SY1TrackEngine['scheduleDrumNote']>}[];
    anchorTime: number;
    anchorTick: number;
    cursorTick: number;
    unsubscribe: () => void;
  } | null = null;
  private liveDrums = new Map<string, LiveDrumSequence>();
  // Explicit instrument recording may overdub on an occupied track. Original
  // arrangement hits remain the playback source at colliding tick/note pairs.
  private patternOverdub = new Map<string, Set<string>>();
  private patternCapturedEvents = new WeakSet<StudioMidiEvent>();
  private pendingDrumCapture: {track: SY1TrackEngine; tick: number; midi: number; velocity: number; duration: number; at: number}[] = [];
  // Future transport-owned percussion events retain their audio cancellation
  // handle and the corresponding capture record. Never re-trigger a sounding hit.
  private scheduledTransportDrums: {track:SY1TrackEngine;tick:number;midi:number;velocity:number;at:number;handle?:ReturnType<SY1TrackEngine['scheduleDrumNote']>;capture?:SY1StudioEngine['pendingDrumCapture'][number]}[]=[];
  private recordedDrumHits = new Set<string>();
  private liveArpTimer: ReturnType<typeof setInterval> | null = null;
  // Per-session transport telemetry; bounded scalar counters, no per-tick logs.
  private schedulerStats = { calls: 0, underruns: 0, severeStalls: 0, maxLateMs: 0, maxWorkMs: 0, skippedNoteOns: 0, seamRecoveries: 0 };
  getSchedulerDiagnostics() { return { ...this.schedulerStats }; }
  resetSchedulerDiagnostics(): void {
    this.schedulerStats = { calls: 0, underruns: 0, severeStalls: 0, maxLateMs: 0, maxWorkMs: 0, skippedNoteOns: 0, seamRecoveries: 0 };
  }
  private cursorAudioTime = 0;
  private cursorTick = 0;
  private playbackOpenNotes = new Map<string, Set<number>>();
  private playbackSustainDown = new Set<string>();
  private liveHeldTracksByMidi = new Map<number, Set<string>>();
  private liveRecordedOpenNotes = new Map<string, Map<number, { tick: number; velocity: number }>>();
  private pendingLoopWrap: { at: number; end: number; start: number } | null = null;

  private recorder: LiveRecorderSession | null = null;
  private lastLiveTake: StudioTake | null = null;
  private liveRecWarning = "";
  private maxLiveRamBytes: number = getLiveRecordingRamBudgetBytes();

  private clockNowOverride: (() => number) | null;
  private isolatedTempo: boolean;
  private masterMeterBuf: Float32Array | null = null;
  private stateListeners = new Set<() => void>();
  private keyHighlightListener: (() => void) | null = null;
  private dispatchObserver: ((rec: ScheduledDispatchRecord) => void) | null = null;

  constructor(opts: StudioEngineOptions = {}) {
    this.clockNowOverride = opts.clockNow || null;
    this.isolatedTempo = !!opts.isolatedTempo;
    this.bpm = opts.initialBpm ?? getTempo();
    this.anchorBpm = this.bpm;

    // Phase 1 initializes with two truly independent SY-1 tracks (expandable to 4)
    const t1 = this.createTrackInstance(1, DEFAULT_TRACK_PRESETS[0], true);
    const t2 = this.createTrackInstance(2, DEFAULT_TRACK_PRESETS[1], false);
    this.tracks.push(t1, t2);
    this.focusedTrackId = t1.id;
    this.recomputeAudibility();

    if (!this.isolatedTempo) {
      this.unsubTempo = onTempoChange((nextBpm) => this.handleTempoChange(nextBpm));
    }
    this.unsubAudioState = onAudioContextStateChange((state, ctx) => {
      this.handleAudioContextStateChange(state, ctx.currentTime);
    });
  }

  private createTrackInstance(index: number, presetId: string, armed: boolean): SY1TrackEngine {
    const track = new SY1TrackEngine({
      id: `track-${index}`,
      name: `SY-1 Track ${index}`,
      presetId,
      volume: 1,
      pan: 0,
      midiChannel: 0
    });
    track.armed = armed;
    track.syncTempo(this.bpm);
    track.onChange(() => this.notify());
    return track;
  }

  // -------------------------------------------------------------- listeners ----
  onChange(cb: () => void): () => void {
    this.stateListeners.add(cb);
    return () => this.stateListeners.delete(cb);
  }

  setKeyHighlightListener(cb: (() => void) | null): void {
    this.keyHighlightListener = cb;
  }

  /** Optional observer for automated scheduler timing & loop verification. */
  setDispatchObserver(cb: ((rec: ScheduledDispatchRecord) => void) | null): void {
    this.dispatchObserver = cb;
  }

  private notify(): void {
    this.stateListeners.forEach((cb) => cb());
  }

  private notifyKeys(): void {
    if (this.keyHighlightListener) this.keyHighlightListener();
  }

  // ------------------------------------------------------------- lifecycle ----
  setActive(on: boolean): void {
    if (this.active === on) return;
    this.active = on;
    if (on) {
      // If a saved project was hydrated while Studio was closed, sync its BPM to central tempo now
      if (this.hasRestoredBpmPending && !this.isolatedTempo) {
        this.hasRestoredBpmPending = false;
        setTempo(this.bpm);
      }
    } else {
      void this.stop();
      this.allNotesOff();
    }
    this.notify();
  }

  isActive(): boolean {
    return this.active;
  }

  isPlaying(): boolean {
    return this.playing;
  }

  getRecordingMode(): StudioRecordingMode {
    return this.recordingMode;
  }

  getRecordingSettings() {
    const base: { metronome: boolean; countIn: boolean; clickVolume: number; mode?: StudioRecordingMode } = {
      metronome: this.clickEnabled,
      countIn: this.countInEnabled,
      clickVolume: this.metronome.volume
    };
    if (this.recordingMode !== "overdub") {
      base.mode = this.recordingMode;
    }
    return base;
  }
  setRecordingSettings(settings: {
    metronome?: boolean;
    countIn?: boolean;
    clickVolume?: number;
    mode?: StudioRecordingMode;
  }) {
    if (settings.metronome !== undefined) { this.clickEnabled = settings.metronome; this.metronome.cancel(); }
    if (settings.countIn !== undefined) this.countInEnabled = settings.countIn;
    if (settings.clickVolume !== undefined) this.metronome.setVolume(settings.clickVolume);
    if (settings.mode === "overdub" || settings.mode === "takes" || settings.mode === "replace") {
      this.recordingMode = settings.mode;
    }
    this.notify();
  }
  getCountInBeat(): number {
    const now = this.nowAudioTime();
    return this.countInStart !== null && this.countInEnd !== null && now < this.countInEnd
      ? Math.max(1, Math.min(4, Math.floor((now - this.countInStart) * this.bpm / 60) + 1)) : 0;
  }

  /** Audio-clock gate shared by live input and the standalone performance recorder. */
  canCapturePerformanceAt(at: number): boolean {
    return this.recording && this.playing && this.recordingStartAt !== null &&
      Number.isFinite(at) && at >= this.recordingStartAt - 1e-6;
  }

  /** Notify a one-shot producer only when its start falls within the audio lookahead.
   * The callback must schedule against `at`, not a wall-clock timer. */
  private dispatchRecordingStart(now: number): void {
    const callback = this.pendingRecordingStart;
    const at = this.recordingStartAt;
    if (!callback || !this.recording || !this.playing || at === null || at > now + LOOKAHEAD_SEC) return;
    this.pendingRecordingStart = null;
    callback(Math.max(now, at));
  }

  /** Capture the original synth's sounding MIDI; never trigger a second voice. */
  capturePerformanceMidi(trackId: string, bytes: readonly number[], at: number): void {
    if (!this.canCapturePerformanceAt(at)) return;
    const track = this.getTrack(trackId);
    if (!track) return;
    this.finishRecordingLoopBoundary(this.nowAudioTime());
    const tick = Math.round(this.getCurrentTick(at));
    const cmd = bytes[0] & 0xf0, midi = bytes[1] & 127, value = bytes[2] & 127;
    if (cmd === 0x90 && value > 0) {
      this.recordNoteOn(track, midi, value / 127, tick, at);
    } else if (cmd === 0x80 || (cmd === 0x90 && value === 0)) {
      this.recordNoteOff(track, midi, tick, at);
    } else if (cmd === 0xe0) {
      this.addRecordedEvent(track, {type:"pitchBend",tick,value:((value<<7|midi)-8192)/8192}, at);
    } else if (cmd === 0xb0 && (midi === 1 || midi === 64)) {
      this.addRecordedEvent(track, {type:"cc",tick,cc:midi,value}, at);
    }
  }

  /**
   * Handle AudioContext state transitions (especially iPadOS Safari "interrupted" / "suspended" -> "running").
   * Releases active voices cleanly on interrupt and re-anchors the scheduler clock cleanly on resume so no
   * stuck notes or burst-fire backlog clicks occur.
   */
  handleAudioContextStateChange(state: string, nowAudioTime = this.nowAudioTime()): void {
    if (state === "interrupted" || state === "suspended") {
      this.stopDrumPreview();
      this.flushDrumCapture(nowAudioTime, true);
      this.cancelTransportDrums();
      this.pendingDrumCapture = [];
      this.metronome.cancel();
      if (this.playing || this.active) {
        this.releasePlaybackNotes(0);
        this.stopLiveArpTimer();
        for (const t of this.tracks) t.allNotesOff(0);
        this.liveHeldTracksByMidi.clear();
        this.notifyKeys();
      }
      return;
    }
    if (state === "running" && this.playing) {
      if (this.getCountInBeat()) { this.stepScheduler(nowAudioTime); return; }
      const resyncTick = this.getCurrentTick(nowAudioTime);
      for (const sequence of this.liveDrums.values()) sequence.reset();
      this.anchorAudioTime = nowAudioTime;
      this.anchorTick = resyncTick;
      this.anchorBpm = this.bpm;
      this.cursorAudioTime = nowAudioTime;
      this.cursorTick = resyncTick;
      this.stepScheduler(nowAudioTime);
    }
  }

  /** Lazily attach StudioMasterBus and all tracks to the single shared AudioContext. */
  async ensureAudio(): Promise<AudioContext | null> {
    if (typeof window === "undefined") return null;
    unlockAudio();
    const ctx = getAudioCtx();
    if (!ctx) return null;

    if (!this.masterBus || this.masterBus.ctx !== ctx) {
      disposeStudioMasterBus(this.masterBus);
      this.masterBus = createStudioMasterBus(ctx, { connectToDestination: true });
      if (this.unsubMasterVol) this.unsubMasterVol();
      this.unsubMasterVol = onMasterVolumeChange((v) => {
        if (this.masterBus && this.masterBus.ctx === ctx) {
          this.masterBus.out.gain.setTargetAtTime(masterGainFor(v), ctx.currentTime, 0.015);
        }
      });
    }

    await Promise.all(this.tracks.map((t) => t.attachAudio(ctx, this.masterBus!.sum)));
    return ctx;
  }

  /** Synchronous kick for immediate audio unlock + bus attachment inside a user gesture. */
  prepareAudioSync(): AudioContext | null {
    if (typeof window === "undefined") return null;
    unlockAudio();
    const ctx = getAudioCtx();
    if (!ctx) return null;
    if (!this.masterBus || this.masterBus.ctx !== ctx) {
      disposeStudioMasterBus(this.masterBus);
      this.masterBus = createStudioMasterBus(ctx, { connectToDestination: true });
      if (this.unsubMasterVol) this.unsubMasterVol();
      this.unsubMasterVol = onMasterVolumeChange((v) => {
        if (this.masterBus && this.masterBus.ctx === ctx) {
          this.masterBus.out.gain.setTargetAtTime(masterGainFor(v), ctx.currentTime, 0.015);
        }
      });
    }
    for (const t of this.tracks) {
      if (!t.isAudioAttached()) {
        void t.attachAudio(ctx, this.masterBus.sum);
      }
    }
    return ctx;
  }

  getMasterBus(): StudioMasterBus | null {
    return this.masterBus;
  }

  /** Zero-allocation instantaneous master output level (0..1) for the Mixer master meter. */
  readMasterMeterLevel(): number {
    if (!this.masterBus) return 0;
    const an = this.masterBus.analyser;
    if (!an || typeof an.getFloatTimeDomainData !== "function") return 0;
    const len = an.fftSize || 2048;
    if (!this.masterMeterBuf || this.masterMeterBuf.length !== len) {
      this.masterMeterBuf = new Float32Array(len);
    }
    an.getFloatTimeDomainData(this.masterMeterBuf as any);
    let peak = 0;
    for (let i = 0; i < len; i++) {
      const a = Math.abs(this.masterMeterBuf[i]);
      if (a > peak) peak = a;
    }
    return Math.min(1, peak);
  }

  // ----------------------------------------------------------------- clock ----
  nowAudioTime(): number {
    if (this.clockNowOverride) return this.clockNowOverride();
    const ctx = getAudioCtxIfAny();
    if (ctx) return ctx.currentTime;
    return typeof performance !== "undefined" ? performance.now() / 1000 : Date.now() / 1000;
  }

  getTotalTicks(): number {
    return this.bars * STUDIO_TICKS_PER_BAR;
  }

  getLoopStartTick(): number {
    return (this.loopStartBar - 1) * STUDIO_TICKS_PER_BAR;
  }

  getLoopEndTick(): number {
    return this.loopEndBar * STUDIO_TICKS_PER_BAR;
  }

  ticksPerSecond(bpm = this.bpm): number {
    return (bpm / 60) * STUDIO_PPQ;
  }

  secondsPerTick(bpm = this.bpm): number {
    return 60 / (bpm * STUDIO_PPQ);
  }

  getCurrentTick(atAudioTime = this.nowAudioTime()): number {
    if (!this.playing) return this.playheadTick;
    const wrap = this.pendingLoopWrap;
    if (wrap && atAudioTime < wrap.at) {
      return Math.max(0, wrap.end - (wrap.at - atAudioTime) * this.ticksPerSecond(this.anchorBpm));
    }
    const elapsedSec = Math.max(0, atAudioTime - this.anchorAudioTime);
    const rawTick = this.anchorTick + elapsedSec * this.ticksPerSecond(this.anchorBpm);
    if (this.loopEnabled) {
      const start = this.getLoopStartTick();
      const end = this.getLoopEndTick();
      const span = Math.max(STUDIO_TICKS_PER_BAR, end - start);
      if (rawTick >= end) {
        return start + ((rawTick - start) % span);
      }
      return Math.max(0, rawTick);
    }
    return Math.min(this.getTotalTicks(), Math.max(0, rawTick));
  }

  // ---------------------------------------------------------------- tracks ----
  getTracks(): SY1TrackEngine[] {
    return this.tracks;
  }

  getTrack(id: string): SY1TrackEngine | undefined {
    return this.tracks.find((t) => t.id === id);
  }

  getFocusedTrack(): SY1TrackEngine {
    return this.tracks.find((t) => t.id === this.focusedTrackId) || this.tracks[0];
  }

  setFocusedTrack(id: string): void {
    if (!this.tracks.some((t) => t.id === id)) return;
    if (this.focusedTrackId === id) return;
    this.focusedTrackId = id;
    if (this.drumPreview?.track.id !== id) this.stopDrumPreview();
    this.notify();
    this.notifyKeys();
  }

  addTrack(presetId?: string): SY1TrackEngine | null {
    if (this.tracks.length >= STUDIO_MAX_TRACKS) return null;
    const idx = this.tracks.length + 1;
    const track = this.createTrackInstance(idx, presetId || DEFAULT_TRACK_PRESETS[(idx - 1) % DEFAULT_TRACK_PRESETS.length], false);
    this.tracks.push(track);
    if (this.recording) track.beginRegionTake(this.getTotalTicks());
    this.recomputeAudibility();
    const ctx = getAudioCtxIfAny();
    if (ctx && this.masterBus && this.masterBus.ctx === ctx) {
      void track.attachAudio(ctx, this.masterBus.sum);
    }
    this.notify();
    return track;
  }

  private recomputeAudibility(): void {
    const anySolo = this.tracks.some((t) => t.solo);
    for (const t of this.tracks) {
      const audible = anySolo ? t.solo : !t.mute;
      t.setAudible(audible);
    }
  }

  setTrackMute(id: string, mute: boolean): void {
    const t = this.getTrack(id);
    if (!t) return;
    t.mute = !!mute;
    this.recomputeAudibility();
    this.notify();
  }

  setTrackSolo(id: string, solo: boolean): void {
    const t = this.getTrack(id);
    if (!t) return;
    t.solo = !!solo;
    this.recomputeAudibility();
    this.notify();
  }

  setTrackArmed(id: string, armed: boolean): void {
    const t = this.getTrack(id);
    if (!t) return;
    t.armed = !!armed;
    this.notify();
  }

  setTrackVolume(id: string, vol: number): void {
    const t = this.getTrack(id);
    if (!t) return;
    t.setVolume(vol);
  }

  setTrackPan(id: string, pan: number): void {
    const t = this.getTrack(id);
    if (!t) return;
    t.setPan(pan);
  }

  setTrackMidiChannel(id: string, channel: number): void {
    const t = this.getTrack(id);
    if (!t) return;
    t.midiChannel = Math.max(0, Math.min(16, Math.round(channel)));
    this.notify();
  }

  setTrackPreset(id: string, presetId: string): void {
    const t = this.getTrack(id);
    if (!t) return;
    this.playbackOpenNotes.get(id)?.clear();
    this.playbackSustainDown.delete(id);
    t.applyPreset(presetId);
  }

  setTrackMachinePreset(id: string, machineId: string, presetId: string): void {
    const t = this.getTrack(id);
    if (!t) return;
    if (this.liveDrums.has(id) && t.machineId !== machineId) this.liveDrums.delete(id);
    this.playbackOpenNotes.get(id)?.clear();
    this.playbackSustainDown.delete(id);
    t.applyMachinePreset(machineId, presetId);
  }

  setTrackMachine(id: string, machineId: string): void {
    const t = this.getTrack(id);
    if (!t) return;
    const m = getStudioMachineDef(machineId);
    const defaultPreset = m.presets[0]?.id || "init";
    this.setTrackMachinePreset(id, m.id, defaultPreset);
  }

  setTrackParam(id: string, key: string, value: any): void {
    const t = this.getTrack(id);
    if (!t) return;
    t.setParam(key, value);
  }

  replaceTrackNotes(id: string, spans: StudioNoteSpan[]): void {
    const t = this.getTrack(id);
    if (!t) return;
    this.regions.editNotes(id, spans);
  }

  quantizeTrackNotes(id: string, gridTicks: number, selectedIndices?: Iterable<number>): number {
    const t = this.getTrack(id);
    if (!t) return 0;
    const selected = selectedIndices ? new Set(selectedIndices) : null;
    const limit = Math.max(1, this.regions.editorLength(id));
    const spans = this.regions.editorNotes(id);
    const grid = Math.max(1, Math.round(gridTicks));
    const maxStart = Math.max(0, Math.floor((limit - 1) / grid) * grid);
    let changed = 0;
    const next = spans.map((span, index) => {
      if (selected !== null && !selected.has(index)) return span;
      const startTick = Math.max(0, Math.min(maxStart, Math.round(span.startTick / grid) * grid));
      const dur = Math.max(1, span.endTick - span.startTick);
      const endTick = Math.min(limit, startTick + dur);
      if (startTick !== span.startTick || endTick !== span.endTick) changed++;
      return { ...span, startTick, endTick };
    });
    if (changed) this.regions.editNotes(id, next);
    return changed;
  }

  clearTrackClip(id: string): void {
    if (!this.getTrack(id)) return;
    this.regions.clearTrack(id);
  }

  // ------------------------------------------------------------- transport ----
  setBars(bars: number): void {
    const next = Math.max(STUDIO_MIN_BARS, Math.min(STUDIO_MAX_BARS, Math.round(Number(bars) || 8)));
    if (next === this.bars) return;
    const prevLoopWasFull = this.loopStartBar === 1 && this.loopEndBar === this.bars;
    this.bars = next;
    if (prevLoopWasFull || this.loopEndBar > next) {
      this.loopEndBar = next;
    }
    if (this.loopStartBar > this.loopEndBar) {
      this.loopStartBar = 1;
    }
    if (this.playheadTick >= this.getTotalTicks()) {
      this.playheadTick = 0;
    }
    this.notify();
  }

  setLoopEnabled(on: boolean): void {
    this.loopEnabled = !!on;
    this.notify();
  }

  setLoopRange(startBar: number, endBar: number): void {
    const s = Math.max(1, Math.min(this.bars, Math.round(startBar)));
    const e = Math.max(s, Math.min(this.bars, Math.round(endBar)));
    this.loopStartBar = s;
    this.loopEndBar = e;
    this.notify();
  }

  setBpm(nextBpm: number): void {
    const clamped = Math.max(40, Math.min(240, Math.round(nextBpm)));
    if (this.isolatedTempo) {
      this.handleTempoChange(clamped);
    } else {
      setTempo(clamped);
      // Ensure local state updates even if tempo.ts already held the same number
      if (this.bpm !== getTempo()) this.handleTempoChange(getTempo());
    }
  }

  getBpm(): number {
    return this.bpm;
  }

  /** Project-local tap tempo (never alters standalone SY-1 tempo in localStorage). */
  tapBpm(nowMs: number = performance.now()): void {
    this.tapTimes = this.tapTimes.filter((t) => nowMs - t < 2000);
    this.tapTimes.push(nowMs);
    if (this.tapTimes.length >= 2) {
      let sum = 0;
      for (let i = 1; i < this.tapTimes.length; i++) {
        sum += this.tapTimes[i] - this.tapTimes[i - 1];
      }
      const avg = sum / (this.tapTimes.length - 1);
      if (avg > 0) this.setBpm(60000 / avg);
    }
    if (this.tapTimes.length > 6) this.tapTimes.shift();
  }

  private handleTempoChange(nextBpm: number): void {
    if (!(nextBpm > 0)) return;
    const now = this.nowAudioTime();
    const preview = this.drumPreview;
    if (preview) {
      const tick=this.getDrumPreviewTick(now);
      // Invalidate only future hits, retaining sounding tails and musical phase.
      // Cancel reverse dispatch order for reversible hi-hat choke scheduling.
      const redo: typeof preview.scheduled=[];
      for(let i=preview.scheduled.length-1;i>=0;i--){
        const hit=preview.scheduled[i];
        if(hit.at>now && (hit.handle?.cancel() ?? !!this.clockNowOverride))redo.push(hit);
      }
      preview.scheduled=[];
      preview.anchorTick=tick;
      preview.anchorTime=Math.max(now,preview.anchorTime);
      preview.voice.syncTempo(nextBpm);
      for(const hit of redo.reverse()){
        const at=preview.anchorTime+(hit.tick-tick)*this.secondsPerTick(nextBpm);
        this.dispatchPreviewHit(preview,hit,at);
      }
    }
    this.metronome.cancel();
    // Rescale the future audio-time offsets against the old/new tempo ratio.
    // Tick identities stay unchanged even when the lookahead crosses a loop.
    if(this.playing){
      const anchor = this.countInEnd!==null && now<this.countInEnd
        ? now : this.pendingLoopWrap ? now : Math.max(now,this.anchorAudioTime);
      this.retimeTransportDrums(now, anchor, this.bpm/nextBpm);
    }
    if (this.countInEnd !== null && this.countInStart !== null && now < this.countInEnd) {
      const remaining = (this.countInEnd - now) * this.bpm / 60;
      this.countInEnd = now + remaining * 60 / nextBpm;
      this.countInStart = this.countInEnd - 4 * 60 / nextBpm;
      this.anchorAudioTime = this.countInEnd;
      for (const track of this.tracks) track.liveArpeggiator.realignUnstarted(this.anchorAudioTime);
      if (this.recording && this.recordingStartAt !== null && now < this.recordingStartAt) {
        this.recordingStartAt = this.countInEnd;
        if(this.recorder)this.recorder.startAt=this.recordingStartAt;
      }
      this.cursorAudioTime = this.countInEnd;
      this.anchorBpm = nextBpm;
      this.bpm = nextBpm;
      for (const t of this.tracks) t.syncTempo(nextBpm);
      this.notify(); return;
    }
    if (this.playing) {
      const curTick = this.getCurrentTick(now);
      const wrap = this.pendingLoopWrap;
      const secPerTick = this.secondsPerTick(nextBpm);
      this.anchorBpm = nextBpm;
      if (wrap && now < wrap.at) {
        // The scheduler has already visited the next loop, but the listener
        // is still on the previous pass. Preserve both sides of the seam.
        const seamAt = now + (wrap.end - curTick) * secPerTick;
        this.pendingLoopWrap = { ...wrap, at: seamAt };
        this.anchorAudioTime = seamAt;
        this.anchorTick = wrap.start;
        this.cursorAudioTime = seamAt + (this.cursorTick - wrap.start) * secPerTick;
      } else {
        this.finishRecordingLoopBoundary(now);
        const anchor = Math.max(now, this.anchorAudioTime);
        this.anchorAudioTime = anchor;
        this.anchorTick = curTick;
        const deltaTicks = this.cursorTick - curTick;
        if (deltaTicks >= 0) {
          this.cursorAudioTime = anchor + deltaTicks * secPerTick;
        } else {
          this.cursorAudioTime = anchor;
          this.cursorTick = curTick;
        }
      }
    } else {
      this.anchorBpm = nextBpm;
    }
    this.bpm = nextBpm;
    for (const t of this.tracks) t.syncTempo(nextBpm);
    this.notify();
  }

  seekToTick(tick: number): void {
    if (this.recording) return;
    this.cancelTransportDrums();
    this.pendingDrumCapture = [];
    this.pendingLoopWrap = null;
    this.metronome.cancel();
    this.countInStart = this.countInEnd = null;
    for (const sequence of this.liveDrums.values()) sequence.reset();
    const clamped = Math.max(0, Math.min(this.getTotalTicks() - 1, Math.round(tick)));
    this.playheadTick = clamped;
    if (this.playing) {
      const now = this.nowAudioTime();
      const seekLead = !this.clockNowOverride ? SEEK_PLAY_LEAD_SEC : 0;
      const startAt = now + seekLead;
      this.releasePlaybackNotes(now);
      this.anchorAudioTime = startAt;
      this.anchorTick = clamped;
      this.anchorBpm = this.bpm;
      this.cursorAudioTime = startAt;
      this.cursorTick = clamped;
    }
    this.notify();
  }

  seekToBar(bar1Indexed: number): void {
    const b = Math.max(1, Math.min(this.bars, Math.round(bar1Indexed)));
    this.seekToTick((b - 1) * STUDIO_TICKS_PER_BAR);
  }

  async play(countInSeconds = 0): Promise<void> {
    if (this.playing || this.finalizingRecord) return;
    this.stopDrumPreview();
    const epoch = this.transportEpoch;
    if (!this.clockNowOverride) {
      await this.ensureAudio();
    }
    if (epoch !== this.transportEpoch || this.playing) return;
    this.stopDrumPreview();
    if (this.playheadTick >= this.getTotalTicks()) {
      this.playheadTick = 0;
    }
    const now = this.nowAudioTime();
    const startLead = countInSeconds > 0 ? countInSeconds : (!this.clockNowOverride ? PLAY_START_LEAD_SEC : 0);
    this.playing = true;
    this.anchorAudioTime = now + startLead;
    if (this.recording) {
      this.recordingStartAt = this.anchorAudioTime;
      if (this.recorder) this.recorder.startAt = this.recordingStartAt;
    }
    this.anchorTick = this.playheadTick;
    this.anchorBpm = this.bpm;
    this.cursorAudioTime = now + startLead;
    this.countInStart = countInSeconds > 0 ? now : null;
    this.countInEnd = countInSeconds > 0 ? now + countInSeconds : null;
    this.cursorTick = this.playheadTick;
    this.playbackOpenNotes.clear();
    this.playbackSustainDown.clear();

    this.stepScheduler(now);
    this.startSchedulerTimer();
    this.notify();
  }

  async record(options: { midiOnly?: boolean; patternTrackId?: string; onStart?: (at: number) => void } = {}): Promise<void> {
    if (this.recording || this.preparingRecord || this.finalizingRecord) return;
    this.recordedDrumHits.clear();
    this.patternOverdub.clear();
    this.patternCapturedEvents = new WeakSet();
    // Keep already scheduled live hits so punch-in captures those that sound
    // after the recording boundary, not just hits scheduled after Record.
    this.preparingRecord = true;
    const patternTrackId = options.patternTrackId ?? this.drumPreview?.track.id;
    this.stopDrumPreview();
    const epoch = this.transportEpoch;
    try {
      if (!this.clockNowOverride) {
        await this.ensureAudio();
      }
      if (epoch !== this.transportEpoch) return;
      // Prepare the PCM recorder before establishing the MIDI capture boundary.
      if (!this.clockNowOverride && !options.midiOnly) {
        await this.startLiveMixRecorder();
        if(epoch!==this.transportEpoch){await this.stopLiveMixRecorder();return;}
      }
      // Ensure at least one track is armed; if none armed, arm the focused track
      const instrumentTarget = patternTrackId ? this.getTrack(patternTrackId) : undefined;
      if (instrumentTarget?.isDrumTrack() && !options.onStart) instrumentTarget.armed = true;
      if (!this.tracks.some((t) => t.armed)) {
        this.getFocusedTrack().armed = true;
      }
      const total = this.getTotalTicks();
      // Explicit instrument Record plays the selected pattern even when the
      // track already has regions. Overdub keeps old notes and avoids collisions;
      // explicit Replace retains its existing replacement semantics.
      const focused = patternTrackId ? this.getTrack(patternTrackId) : undefined;
      if (!options.onStart && focused?.armed && focused.isDrumTrack()) {
        const existing = new Set<string>();
        if (this.recordingMode !== "replace") {
          for (const event of focused.events) {
            if(event.type==="noteOn") existing.add(event.tick+":"+event.midi);
          }
        }
        this.patternOverdub.set(focused.id,existing);
        if (!this.liveDrums.has(focused.id)) this.liveDrums.set(focused.id,new LiveDrumSequence());
      }
      for (const track of this.tracks) {
        track.beginRegionTake(total, track.armed ? this.recordingMode : "overdub");
      }
      this.recording = true;
      this.recordingStartAt = this.playing
        ? Math.max(this.nowAudioTime(), this.pendingLoopWrap ? -Infinity : this.anchorAudioTime) : null;
      if(this.recorder)this.recorder.startAt=this.recordingStartAt;
      this.performanceCaptureTimes = new WeakMap();
      this.pendingRecordingStart = options.onStart ?? null;
      this.liveRecordedOpenNotes.clear();

      if (!this.playing) {
        await this.play(this.countInEnabled ? 4 * 60 / this.bpm : 0);
      } else {
        this.dispatchRecordingStart(this.nowAudioTime());
        this.notify();
      }
    } finally { this.preparingRecord = false; }
  }

  /** Pause retains the current musical position; explicit Stop keeps its rewind behavior. */
  async pause(): Promise<void> { await this.stop(true); }

  async stop(preservePosition = false): Promise<void> {
    const stopAt=this.nowAudioTime();
    this.stopDrumPreview();
    this.flushDrumCapture(this.nowAudioTime(), true);
    this.cancelTransportDrums();
    if (!preservePosition || this.recording) this.liveDrums.clear();
    else for (const sequence of this.liveDrums.values()) sequence.reset();
    this.pendingDrumCapture = []; this.recordedDrumHits.clear();
    this.patternOverdub.clear();
    this.patternCapturedEvents = new WeakSet();
    this.stopLiveArpTimer();
    for (const track of this.tracks) track.liveArpeggiator.stop();
    this.transportEpoch++;
    this.pendingRecordingStart = null;
    this.recordingStartAt = null;
    this.performanceCaptureTimes = new WeakMap();
    this.finishRecordingLoopBoundary(this.nowAudioTime());
    this.metronome.cancel();
    this.countInStart = this.countInEnd = null;
    const wasPlaying = this.playing;
    const wasRecording = this.recording;

    if (this.schedulerTimer !== null) {
      clearInterval(this.schedulerTimer);
      this.schedulerTimer = null;
    }

    const now = this.nowAudioTime();
    const stopTick = wasPlaying ? Math.round(this.getCurrentTick(now)) : this.playheadTick;

    if (wasRecording) {
      this.closeLiveRecordedNotes(stopTick);
      const previous = new Map<string, MidiRegion[]>();
      for (const track of this.tracks) {
        const regions = track.finishRegionTake(this.getTotalTicks());
        if (regions) previous.set(track.id, regions);
      }
      this.regions.registerTake(previous);
      this.recording = false;
      this.finalizingRecord = true;
    }

    this.playing = false;
    this.pendingLoopWrap = null;
    this.playheadTick = preservePosition ? stopTick : 0;
    this.anchorTick = this.playheadTick;
    this.cursorTick = this.playheadTick;
    this.releasePlaybackNotes(0);
    this.allNotesOff();

    if (wasPlaying || wasRecording) {
      this.notify();
      this.notifyKeys();
    }
    if (wasRecording) {
      try { await this.stopLiveMixRecorder(stopAt); }
      finally { this.finalizingRecord = false; this.notify(); }
    }
  }

  allNotesOff(): void {
    this.playbackOpenNotes.clear();
    this.playbackSustainDown.clear();
    this.liveHeldTracksByMidi.clear();
    this.stopLiveArpTimer();
    for (const t of this.tracks) t.allNotesOff(0);
    this.notifyKeys();
  }

  // ------------------------------------------------------- lookahead engine ----
  private startSchedulerTimer(): void {
    if (this.schedulerTimer !== null || this.clockNowOverride) return;
    // Preview and arrangement are mutually exclusive modes of this one scheduler.
    this.schedulerTimer = setInterval(() => {
      if (!this.playing && !this.drumPreview) return;
      const started = performance.now();
      this.stepScheduler(this.nowAudioTime());
      this.schedulerStats.maxWorkMs = Math.max(this.schedulerStats.maxWorkMs, performance.now() - started);
    }, SCHEDULER_INTERVAL_MS);
  }

  /**
   * Advance the audio-clock lookahead scheduler up to `now + LOOKAHEAD_SEC`.
   * Public so deterministic tests can step exact clock timelines without timers.
   */
  stepScheduler(nowAudioTime: number): void {
    if (!this.playing) { this.stepDrumPreview(nowAudioTime); return; }
    this.scheduledTransportDrums=this.scheduledTransportDrums.filter(h=>h.at>nowAudioTime);
    this.flushDrumCapture(nowAudioTime);
    this.finishRecordingLoopBoundary(nowAudioTime);
    this.metronome.schedule(this.masterBus?.ctx || null, nowAudioTime, this.anchorAudioTime, this.anchorTick / STUDIO_PPQ,
      this.bpm, this.clickEnabled, this.countInStart, this.countInEnd !== null && nowAudioTime < this.countInEnd ? this.countInEnd : null);
    this.dispatchRecordingStart(nowAudioTime);
    const windowEnd = nowAudioTime + LOOKAHEAD_SEC;
    if (this.cursorAudioTime > windowEnd) return;

    this.schedulerStats.calls++;
    const late = Math.max(0, nowAudioTime - this.cursorAudioTime);
    if (late > 0.005) {
      this.schedulerStats.underruns++;
      this.schedulerStats.maxLateMs = Math.max(this.schedulerStats.maxLateMs, late * 1000);
    }
    if (late > SCHEDULER_STALL_THRESHOLD_SEC) {
      this.schedulerStats.severeStalls++;
      const resyncTick = this.getCurrentTick(nowAudioTime);
      const elapsedTicks = late * this.ticksPerSecond(this.anchorBpm);
      const samePass = !this.pendingLoopWrap &&
        resyncTick >= this.cursorTick &&
        this.cursorTick + elapsedTicks < (this.loopEnabled ? this.getLoopEndTick() : this.getTotalTicks());
      if (samePass) {
        // Events already scheduled on the audio clock remain intact. Only
        // reconcile missed releases/controllers; never replay stale attacks.
        for (const track of this.tracks) {
          let open = this.playbackOpenNotes.get(track.id);
          if (!open) this.playbackOpenNotes.set(track.id, open = new Set<number>());
          const held = open;
          track.forEachEventInRange(this.cursorTick, resyncTick, ev => {
            if (ev.type === "noteOn") { this.schedulerStats.skippedNoteOns++; return; }
            if (ev.type === "noteOff" && !held.has(ev.midi)) return;
            this.dispatchEventToTrack(track, ev, nowAudioTime, held);
          });
        }
      } else {
        // An uncertain loop seam or arrangement end retains safe release.
        this.schedulerStats.seamRecoveries++;
        this.releasePlaybackNotes(nowAudioTime);
      }
      for (const sequence of this.liveDrums.values()) sequence.reset();
      this.anchorAudioTime = nowAudioTime;
      this.anchorTick = resyncTick;
      this.cursorAudioTime = nowAudioTime;
      this.cursorTick = resyncTick;
    }

    const secPerTick = this.secondsPerTick(this.anchorBpm);
    const ticksPerSec = this.ticksPerSecond(this.anchorBpm);
    const totalTicks = this.getTotalTicks();
    const loopStart = this.getLoopStartTick();
    const loopEnd = this.getLoopEndTick();

    let safety = 0;
    while (this.cursorAudioTime < windowEnd && safety++ < 32) {
      const remainingSec = windowEnd - this.cursorAudioTime;
      const segStartTick = this.cursorTick;
      const segStartAudio = this.cursorAudioTime;
      const segEndTickRaw = segStartTick + remainingSec * ticksPerSec;

      if (this.loopEnabled && segStartTick < loopEnd && segEndTickRaw >= loopEnd) {
        // Dispatch up to loopEnd (exclusive)
        this.scheduleSegment(segStartTick, loopEnd, segStartAudio, secPerTick);
        const loopEndAudio = segStartAudio + (loopEnd - segStartTick) * secPerTick;

        // Close any playback-held notes cleanly at the exact loop boundary
        this.releasePlaybackNotes(loopEndAudio);
        this.pendingLoopWrap = { at: loopEndAudio, end: loopEnd, start: loopStart };
        this.finishRecordingLoopBoundary(nowAudioTime);

        // Re-anchor cleanly at loopStart to prevent floating-point drift across infinite cycles
        this.anchorAudioTime = loopEndAudio;
        this.anchorTick = loopStart;
        this.cursorAudioTime = loopEndAudio;
        this.cursorTick = loopStart;
        for (const sequence of this.liveDrums.values()) sequence.reset();
        continue;
      }

      if (!this.loopEnabled && segEndTickRaw >= totalTicks) {
        this.scheduleSegment(segStartTick, totalTicks, segStartAudio, secPerTick);
        const endAudio = segStartAudio + (totalTicks - segStartTick) * secPerTick;
        this.releasePlaybackNotes(endAudio);
        this.cursorAudioTime = endAudio;
        this.cursorTick = totalTicks;
        if (nowAudioTime >= endAudio) {
          void this.stop();
        }
        break;
      }

      this.scheduleSegment(segStartTick, segEndTickRaw, segStartAudio, secPerTick);
      this.cursorAudioTime = windowEnd;
      this.cursorTick = segEndTickRaw;
    }
  }

  isDrumPreviewEnabled(id: string): boolean {
    return this.drumPreview?.track.id === id;
  }

  /** Preview has its own disposable voice graph, with no arrangement or recording dispatch. */
  startDrumPreview(id: string): void {
    if (this.playing || this.recording || this.preparingRecord) throw new Error("Stop the transport before previewing a pattern.");
    const track = this.getTrack(id);
    if (!track?.isDrumTrack()) throw new Error("Choose a drum track.");
    this.stopDrumPreview();
    const context = this.clockNowOverride ? null : this.prepareAudioSync();
    if (!this.clockNowOverride && (!context || !this.masterBus)) throw new Error("Audio is unavailable.");
    const voice = new SY1TrackEngine({ id: "drum-preview", name: "Drum Preview", machineId: track.machineId,
      volume: track.volume, pan: track.pan });
    const copySound = () => {
      if (voice.machineId !== track.machineId) { this.stopDrumPreview(); return; }
      voice.loadPatchSnapshot(track.patch, track.presetId, track.presetName);
      voice.setVolume(track.volume);
      voice.setPan(track.pan);
    };
    copySound();
    voice.syncTempo(this.bpm);
    if (context && this.masterBus) void voice.attachAudio(context, this.masterBus.sum);
    const now = this.nowAudioTime();
    const preview = {
      track, voice, sequence: new LiveDrumSequence(), scheduled: [] as NonNullable<SY1StudioEngine['drumPreview']>['scheduled'],
      anchorTime: now + (context ? PLAY_START_LEAD_SEC : 0), anchorTick: 0, cursorTick: 0,
      unsubscribe: track.onChange(copySound)
    };
    this.drumPreview = preview;
    this.stepScheduler(now);
    this.startSchedulerTimer();
    this.notify();
  }

  stopDrumPreview(): void {
    const preview = this.drumPreview;
    if (!preview) return;
    this.drumPreview = null;
    if (!this.playing && this.schedulerTimer !== null) {
      clearInterval(this.schedulerTimer);
      this.schedulerTimer = null;
    }
    for(let i=preview.scheduled.length-1;i>=0;i--)preview.scheduled[i].handle?.cancel();
    preview.scheduled=[];
    preview.unsubscribe();
    preview.voice.dispose();
    this.notify();
  }

  private getDrumPreviewTick(now: number): number {
    const preview = this.drumPreview!;
    return preview.anchorTick + Math.max(0, now - preview.anchorTime) * this.ticksPerSecond(this.bpm);
  }

  private dispatchPreviewHit(preview: NonNullable<SY1StudioEngine['drumPreview']>, hit: {tick:number;midi:number;velocity:number}, at:number): void {
    const handle=preview.voice.scheduleDrumNote(hit.midi,hit.velocity,at);
    const actualAt=handle?.at??at;
    preview.scheduled.push({tick:hit.tick,midi:hit.midi,velocity:hit.velocity,at:actualAt,handle});
    this.dispatchObserver?.({trackId:preview.track.id,source:"drum-preview",
      event:{type:"noteOn",tick:hit.tick,midi:hit.midi,velocity:hit.velocity},audioTime:actualAt});
  }

  private stepDrumPreview(now: number): void {
    const preview = this.drumPreview;
    if (!preview) return;
    preview.scheduled=preview.scheduled.filter(h=>h.at>now);
    const tick = this.getDrumPreviewTick(now);
    if ((tick - preview.cursorTick) * this.secondsPerTick(this.bpm) > SCHEDULER_STALL_THRESHOLD_SEC) {
      preview.sequence.reset();
    }
    const start = Math.max(tick, preview.cursorTick);
    const end = tick + LOOKAHEAD_SEC * this.ticksPerSecond(this.bpm);
    if (end <= start) return;
    const anchor = Math.max(now, preview.anchorTime);
    preview.sequence.drain(preview.track, start, end, this.bpm, hit => {
      const at = anchor + (hit.tick - tick) * this.secondsPerTick(this.bpm);
      this.dispatchPreviewHit(preview,hit,at);
    });
    preview.cursorTick = end;
  }

  insertDrumPattern(id: string, tick = this.getCurrentTick()): number {
    const track = this.getTrack(id);
    if (!track?.isDrumTrack()) throw new Error("Choose a drum track.");
    const bank = track.getTrackDrumBank();
    const pattern = drumPatternMidi(bank.patterns[bank.selected], track.patch, this.bpm);
    const start = this.regions.insertPattern(id, tick, pattern.length, pattern.events, true);
    this.liveDrums.delete(id);
    if (this.isDrumPreviewEnabled(id)) this.stopDrumPreview();
    this.notify();
    return start;
  }

  isLiveDrumEnabled(id: string): boolean { return this.liveDrums.has(id); }

  /** Enable an explicit live pattern source; never overwrite or mask an existing clip. */
  setLiveDrumEnabled(id: string, enabled: boolean): void {
    if (this.recording || this.preparingRecord) throw new Error("Stop recording before changing Live Pattern.");
    const track = this.getTrack(id);
    if (!track?.isDrumTrack()) throw new Error("Choose a drum track.");
    if (enabled) {
      if (track.events.length || track.getRegions(this.getTotalTicks()).length) throw new Error("Use an empty drum track for Live Pattern, or insert the pattern as MIDI.");
      if (!this.liveDrums.has(id)) this.liveDrums.set(id,new LiveDrumSequence());
    } else this.liveDrums.delete(id);
    this.notify();
  }

  private dispatchTransportDrum(track:SY1TrackEngine,hit:{tick:number;midi:number;velocity:number},at:number,capture?:SY1StudioEngine['pendingDrumCapture'][number]):void {
    const handle=track.audible?track.scheduleDrumNote(hit.midi,hit.velocity,at):undefined;
    const actualAt=handle?.at??at;
    if(capture)capture.at=actualAt;
    this.scheduledTransportDrums.push({track,tick:hit.tick,midi:hit.midi,velocity:hit.velocity,at:actualAt,handle,capture});
    this.dispatchObserver?.({trackId:track.id,event:{type:"noteOn",tick:hit.tick,midi:hit.midi,velocity:hit.velocity},audioTime:actualAt});
  }
  private cancelTransportDrums():void {
    for(let i=this.scheduledTransportDrums.length-1;i>=0;i--)this.scheduledTransportDrums[i].handle?.cancel();
    this.scheduledTransportDrums=[];
  }
  private retimeTransportDrums(now:number,anchor:number,ratio:number):void {
    const redo:typeof this.scheduledTransportDrums=[];
    for(let i=this.scheduledTransportDrums.length-1;i>=0;i--){
      const h=this.scheduledTransportDrums[i];
      if(h.at>now && (h.handle?h.handle.cancel():true))redo.push(h);
    }
    this.scheduledTransportDrums=[];
    for(const h of redo.reverse())this.dispatchTransportDrum(h.track,h,anchor+(h.at-anchor)*ratio,h.capture);
  }

  private flushDrumCapture(now: number, stopping = false): void {
    if (!this.pendingDrumCapture.length) return;
    const remaining: typeof this.pendingDrumCapture = [];
    for (const h of this.pendingDrumCapture) {
      if (h.at > now + 1e-7) { if (!stopping) remaining.push(h); continue; }
      if (!this.canCapturePerformanceAt(h.at) || !h.track.armed || this.getTrack(h.track.id) !== h.track) continue;
      const key = `${h.track.id}:${h.tick}:${h.midi}`;
      if (this.recordedDrumHits.has(key)) continue;
      this.recordedDrumHits.add(key);
      const limit = this.loopEnabled && h.tick < this.getLoopEndTick() ? this.getLoopEndTick() : this.getTotalTicks();
      const duration = stopping ? Math.min(h.duration, Math.max(1,Math.round((now-h.at)*this.ticksPerSecond()))) : h.duration;
      const on:StudioMidiEvent={type:"noteOn",tick:h.tick,midi:h.midi,velocity:h.velocity};
      const off:StudioMidiEvent={type:"noteOff",tick:Math.min(limit,h.tick+duration),midi:h.midi};
      if(this.patternOverdub.has(h.track.id)){this.patternCapturedEvents.add(on);this.patternCapturedEvents.add(off);}
      this.addRecordedEvent(h.track,on,h.at);
      this.addRecordedEvent(h.track,off,h.at);
    }
    this.pendingDrumCapture = remaining;
  }

  private scheduleSegment(startTick: number, endTick: number, segStartAudio: number, secPerTick: number): void {
    if (endTick <= startTick) return;
    const observer = this.dispatchObserver;
    const replacingArmed = this.recording && this.recordingMode === "replace";
    for (let ti = 0; ti < this.tracks.length; ti++) {
      const track = this.tracks[ti];
      const sequence = this.liveDrums.get(track.id);
      const overdub = this.recording ? this.patternOverdub.get(track.id) : undefined;
      if (sequence && track.isDrumTrack()) {
        // Live is an explicit source on an empty track. If a clip was added
        // during preview, restore normal arrangement playback instead of doubling.
        if (!this.recording && (track.events.length || track.getRegions(this.getTotalTicks()).length)) this.liveDrums.delete(track.id);
        else {
          sequence.drain(track, startTick, endTick, this.bpm, hit => {
            if(overdub?.has(hit.tick+":"+hit.midi))return;
            const at = segStartAudio + (hit.tick - startTick) * secPerTick;
            const capture={track,...hit,at};
            this.dispatchTransportDrum(track,hit,at,capture);
            this.pendingDrumCapture.push(capture);
          });
          if(!overdub || replacingArmed)continue;
        }
      }
      if (track.events.length === 0) continue;
      // In explicit Replace recording mode, suppress playback of the armed track's old clip while hearing all other tracks.
      if (replacingArmed && track.armed) continue;

      let openSet: Set<number> | undefined;
      const skipMutedNoteOn = !track.audible && !observer;
      track.forEachEventInRange(startTick, endTick, (ev) => {
        if(overdub && this.patternCapturedEvents.has(ev))return;
        if (skipMutedNoteOn && ev.type === "noteOn") return;
        const at = segStartAudio + (ev.tick - startTick) * secPerTick;
        const capturedAt = this.performanceCaptureTimes.get(ev);
        // A loop is at least one full bar. 250 ms covers lookahead/rounding, without
        // suppressing the same MIDI event when the song visits it on the next pass.
        if (capturedAt !== undefined && at <= capturedAt + 0.25) return;
        if (!openSet) {
          openSet = this.playbackOpenNotes.get(track.id);
          if (!openSet) {
            openSet = new Set<number>();
            this.playbackOpenNotes.set(track.id, openSet);
          }
        }
        if (skipMutedNoteOn && ev.type === "noteOff" && !openSet.has(ev.midi)) return;
        if(track.isDrumTrack() && ev.type==="noteOn"){
          this.dispatchTransportDrum(track,ev,at);
          return;
        }
        this.dispatchEventToTrack(track, ev, at, openSet);
        if (observer) {
          observer({ trackId: track.id, event: ev, audioTime: at });
        }
      });
    }
  }

  private dispatchEventToTrack(
    track: SY1TrackEngine,
    ev: StudioMidiEvent,
    at: number,
    openSet: Set<number>
  ): void {
    if (ev.type === "noteOn") {
      track.noteOn(ev.midi, ev.velocity, at);
      openSet.add(ev.midi);
    } else if (ev.type === "noteOff") {
      track.noteOff(ev.midi, at);
      openSet.delete(ev.midi);
    } else if (ev.type === "cc") {
      if (ev.cc === 64) {
        const down = ev.value >= 64;
        track.setSustainPedal(down, at);
        if (down) this.playbackSustainDown.add(track.id);
        else this.playbackSustainDown.delete(track.id);
      } else if (ev.cc === 1) {
        track.setModWheel(ev.value / 127);
      }
    } else if (ev.type === "pitchBend") {
      track.setPitchBend(ev.value);
    }
  }

  private releasePlaybackNotes(at: number): void {
    for (const track of this.tracks) {
      if (this.playbackSustainDown.has(track.id)) {
        track.setSustainPedal(false, at);
        this.playbackSustainDown.delete(track.id);
      }
      const open = this.playbackOpenNotes.get(track.id);
      if (open && open.size > 0) {
        open.forEach((midi) => {
          track.noteOff(midi, at);
        });
        open.clear();
      }
    }
  }

  private addRecordedEvent(track: SY1TrackEngine, event: StudioMidiEvent, captureAt?: number): void {
    if (captureAt !== undefined) this.performanceCaptureTimes.set(event, captureAt);
    track.addEvent(event);
  }

  private recordNoteOn(track: SY1TrackEngine, midi: number, velocity: number, tick: number, captureAt?: number): void {
    let notes = this.liveRecordedOpenNotes.get(track.id);
    if (!notes) {
      notes = new Map();
      this.liveRecordedOpenNotes.set(track.id, notes);
    }
    if (notes.has(midi)) this.recordNoteOff(track, midi, tick, captureAt);
    this.addRecordedEvent(track, { type: "noteOn", tick, midi, velocity }, captureAt);
    notes.set(midi, { tick, velocity });
  }

  private recordNoteOff(track: SY1TrackEngine, midi: number, tick: number, captureAt?: number): void {
    const notes = this.liveRecordedOpenNotes.get(track.id);
    const note = notes?.get(midi);
    if (!notes || !note) return;
    // Generated MIDI can report a scheduled release across the loop seam in advance.
    const end = this.loopEnabled && tick < note.tick ? this.getLoopEndTick() : tick;
    this.addRecordedEvent(track, { type: "noteOff", tick: Math.max(note.tick + 1, end), midi }, captureAt);
    notes.delete(midi);
  }

  private finishRecordingLoopBoundary(now: number): void {
    const wrap = this.pendingLoopWrap;
    if (!wrap || now < wrap.at) return;
    this.pendingLoopWrap = null;
    if (this.recording) this.closeLiveRecordedNotes(wrap.end, wrap.start);
  }

  private closeLiveRecordedNotes(closeTick: number, reopenAt?: number): void {
    for (const [trackId, notes] of this.liveRecordedOpenNotes) {
      const track = this.getTrack(trackId);
      if (!track) continue;
      for (const [midi, note] of notes) {
        track.addEvent({ type: "noteOff", tick: Math.max(note.tick + 1, Math.round(closeTick)), midi });
        if (reopenAt !== undefined) {
          track.addEvent({ type: "noteOn", tick: reopenAt, midi, velocity: note.velocity });
          notes.set(midi, { ...note, tick: reopenAt });
        }
      }
      if (reopenAt === undefined) notes.clear();
    }
  }

  // ------------------------------------------------------------- live input ----
  private resolveLiveTargets(midiChannel: number): SY1TrackEngine[] {
    if (this.recording) {
      const armed = this.tracks.filter((t) => {
        if (!t.armed) return false;
        if (midiChannel === 0 || t.midiChannel === 0) return true;
        return t.midiChannel === midiChannel;
      });
      if (armed.length > 0) return armed;
      if (midiChannel > 0) return [];
      return [this.getFocusedTrack()];
    }

    if (midiChannel > 0) {
      const matched = this.tracks.filter((t) => t.midiChannel === midiChannel);
      if (matched.length > 0) return matched;
    }
    return [this.getFocusedTrack()];
  }

  private stopLiveArpTimer(): void {
    if (this.liveArpTimer !== null) clearInterval(this.liveArpTimer);
    this.liveArpTimer = null;
  }

  private liveArpStart(track: SY1TrackEngine, now: number): number {
    if (!this.playing) return now + 0.005;
    if (now < this.anchorAudioTime) return this.anchorAudioTime;
    const tick = this.getCurrentTick(now);
    const division = arpStepBeats(track.patch) * STUDIO_PPQ;
    // Align to the transport subdivision without scheduling into the past.
    const nextTick = Math.ceil((tick + 0.005 * this.ticksPerSecond()) / division) * division;
    return now + (nextTick - tick) * this.secondsPerTick();
  }

  /** Independent live ARP clock also works while transport is stopped.
   * Recorded regions contain the generated sounding notes; region playback is unchanged. */
  stepLiveArpeggiators(now = this.nowAudioTime()): void {
    if (!Number.isFinite(now)) return;
    let running = false;
    for (const track of this.tracks) {
      for (const pulse of track.liveArpeggiator.drain(track.patch, this.bpm, now)) {
        track.playArpPulse(pulse);
        if (track.armed && this.canCapturePerformanceAt(pulse.at)) {
          this.capturePerformanceMidi(track.id, [0x90, pulse.midi, Math.max(1, Math.round(pulse.velocity * 127))], pulse.at);
          this.capturePerformanceMidi(track.id, [0x80, pulse.midi, 0], pulse.off);
        }
      }
      running ||= track.liveArpeggiator.running;
    }
    if (!running) this.stopLiveArpTimer();
  }

  liveNoteOn(midi: number, velocity = 0.85, midiChannel = 0): void {
    if (!this.clockNowOverride) this.prepareAudioSync();
    const m = Math.max(0, Math.min(127, Math.round(midi)));
    const vel = Math.max(1 / 127, Math.min(1, Number(velocity) || 0.85));
    const targets = this.resolveLiveTargets(midiChannel);
    if (targets.length === 0) return;

    let heldSet = this.liveHeldTracksByMidi.get(m);
    if (!heldSet) {
      heldSet = new Set<string>();
      this.liveHeldTracksByMidi.set(m, heldSet);
    }

    const now = this.nowAudioTime();
    this.finishRecordingLoopBoundary(now);
    const tick = this.recording ? Math.round(this.getCurrentTick(now)) : 0;

    for (const track of targets) {
      heldSet.add(track.id);
      if (!track.isDrumTrack() && track.patch.arpOn === "on") {
        track.liveArpeggiator.noteOn(m, vel, track.patch, this.liveArpStart(track, now));
        if (!this.clockNowOverride && this.liveArpTimer === null) {
          this.liveArpTimer = setInterval(() => this.stepLiveArpeggiators(), SCHEDULER_INTERVAL_MS);
        }
        continue;
      }
      track.noteOn(m, vel, 0);

      if (this.canCapturePerformanceAt(now) && track.armed) {
        this.recordNoteOn(track, m, vel, tick);
      }
    }
    this.notifyKeys();
  }

  liveNoteOff(midi: number, midiChannel = 0): void {
    const m = Math.max(0, Math.min(127, Math.round(midi)));
    const heldSet = this.liveHeldTracksByMidi.get(m);
    const targets =
      heldSet && heldSet.size > 0
        ? this.tracks.filter((t) => heldSet.has(t.id) && (midiChannel === 0 || t.midiChannel === 0 || t.midiChannel === midiChannel))
        : this.resolveLiveTargets(midiChannel);

    const now = this.nowAudioTime();
    this.finishRecordingLoopBoundary(now);
    const tick = this.recording ? Math.round(this.getCurrentTick(now)) : 0;

    for (const track of targets) {
      heldSet?.delete(track.id);
      if (track.liveArpeggiator.noteOff(m, track.patch)) continue;
      track.noteOff(m, 0);

      if (this.canCapturePerformanceAt(now) && track.armed) {
        this.recordNoteOff(track, m, tick);
      }
    }
    if (heldSet && heldSet.size === 0) this.liveHeldTracksByMidi.delete(m);
    this.notifyKeys();
  }

  livePitchBend(norm: number, midiChannel = 0): void {
    const v = Math.max(-1, Math.min(1, Number(norm) || 0));
    const targets = this.resolveLiveTargets(midiChannel);
    const now = this.nowAudioTime();
    this.finishRecordingLoopBoundary(now);
    const tick = this.recording ? Math.round(this.getCurrentTick(now)) : 0;
    for (const track of targets) {
      track.setPitchBend(v);
      if (this.canCapturePerformanceAt(now) && track.armed) {
        track.addEvent({ type: "pitchBend", tick, value: v });
      }
    }
  }

  liveCC(cc: number, value: number, midiChannel = 0): void {
    const targets = this.resolveLiveTargets(midiChannel);
    const now = this.nowAudioTime();
    this.finishRecordingLoopBoundary(now);
    const tick = this.recording ? Math.round(this.getCurrentTick(now)) : 0;
    const val7 = Math.max(0, Math.min(127, Math.round(value)));
    for (const track of targets) {
      if (cc === 64) {
        track.setSustainPedal(val7 >= 64, 0);
        if (this.canCapturePerformanceAt(now) && track.armed) {
          track.addEvent({ type: "cc", tick, cc: 64, value: val7 });
        }
      } else if (cc === 1) {
        track.setModWheel(val7 / 127);
        if (this.canCapturePerformanceAt(now) && track.armed) {
          track.addEvent({ type: "cc", tick, cc: 1, value: val7 });
        }
      }
    }
  }

  liveModWheel(norm: number, midiChannel = 0): void {
    const val7 = Math.max(0, Math.min(127, Math.round(Math.max(0, Math.min(1, norm)) * 127)));
    this.liveCC(1, val7, midiChannel);
  }

  isFocusedNoteSounding(midi: number): boolean {
    return this.getFocusedTrack().isNoteSounding(midi);
  }

  // ------------------------------------------------------- live WAV recorder ---
  private async startLiveMixRecorder(): Promise<boolean> {
    if (this.recorder || !this.masterBus) return false;
    const ctx = getAudioCtxIfAny();
    if (!ctx || this.masterBus.ctx !== ctx) return false;
    const ok = await ensureRecorderWorklet(ctx);
    if (!ok) return false;

    const node = new AudioWorkletNode(ctx, "sy1-recorder", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      channelCount: 2,
      channelCountMode: "explicit",
      channelInterpretation: "speakers"
    });
    const sink = ctx.createGain();
    sink.gain.value = 0;

    const rec: LiveRecorderSession = {
      ctx,
      node,
      sink,
      chunks: [[], []],
      frames: 0,
      bpm: this.bpm,
      firstFrame:null,
      startAt:null
    };

    this.liveRecWarning = "";
    node.port.onmessage = (e) => {
      const d = e.data;
      if(d && Number.isFinite(d.start))rec.firstFrame=Math.round(d.start*ctx.sampleRate);
      if (d && d.l) {
        rec.chunks[0].push(d.l);
        rec.chunks[1].push(d.r);
        rec.frames += d.l.length;

        const sec = rec.frames / ctx.sampleRate;
        const estBytes = rec.frames * STUDIO_LIVE_BYTES_PER_FRAME;
        const hitTimeCap = sec >= RECORDER_MAX_SECONDS;
        const hitRamCap = estBytes >= this.maxLiveRamBytes;

        if (!hitTimeCap && !hitRamCap && (sec >= RECORDER_MAX_SECONDS * 0.85 || estBytes >= this.maxLiveRamBytes * 0.85)) {
          if (!this.liveRecWarning) {
            this.liveRecWarning = "Approaching recording memory/time limit";
            this.notify();
          }
        }

        // Strictly preserve the 30-minute safety cap AND prevent browser OOM
        if (this.recorder === rec && (hitTimeCap || hitRamCap)) {
          this.liveRecWarning = hitTimeCap
            ? "Stopped at 30-minute live recording safety limit"
            : "Stopped safely at browser memory limit";
          void this.stop();
        }
      }
    };

    this.masterBus.tap.connect(node);
    node.connect(sink);
    sink.connect(ctx.destination);
    this.recorder = rec;
    return true;
  }

  private stopLiveMixRecorder(endAt = this.nowAudioTime()): Promise<void> {
    const rec = this.recorder;
    if (!rec) return Promise.resolve();
    this.recorder = null;

    return new Promise((resolve) => {
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        try { rec.node.port.onmessage = null; } catch (e) {}
        try { this.masterBus?.tap.disconnect(rec.node); } catch (e) {}
        try { rec.node.disconnect(); rec.sink.disconnect(); } catch (e) {}
        const rate=rec.ctx.sampleRate;
        const trimmed=rec.firstFrame!==null&&rec.startAt!==null&&endAt>rec.startAt
          ? trimCaptureWindow(rec.chunks,rec.firstFrame,Math.round(rec.startAt*rate),Math.round(endAt*rate))
          : {chunks:[[],[]],frames:0,missingFrames:0};
        if(trimmed.missingFrames>0)this.liveRecWarning='Recording audio was incomplete; missing '+trimmed.missingFrames+' frames';
        if (trimmed.frames > 0) {
          const wav = encodeWav(trimmed.chunks, trimmed.frames, rate);
          this.lastLiveTake = {
            wav,
            sampleRate: rec.ctx.sampleRate,
            durationSec: trimmed.frames / rate,
            frames: trimmed.frames,
            bpm: rec.bpm,
            kind: "live",
            createdAt: Date.now()
          };
        }
        // Release raw Float32 capture chunks immediately so multi-megabyte buffers can be GC'd
        rec.chunks[0].length = 0;
        rec.chunks[1].length = 0;
        resolve();
      };
      const prev = rec.node.port.onmessage;
      const timer = setTimeout(finish, 400);
      rec.node.port.onmessage = (e) => {
        if (prev) (prev as any).call(rec.node.port, e);
        if (e.data && e.data.done) {
          clearTimeout(timer);
          finish();
        }
      };
      rec.node.port.postMessage("stop");
    });
  }

  getLastLiveTake(): StudioTake | null {
    return this.lastLiveTake;
  }

  // ---------------------------------------------- project save / load ---------
  getProjectId(): string {
    return this.projectId;
  }

  getProjectName(): string {
    return this.projectName;
  }

  setProjectName(name: string): void {
    const clean = sanitizeProjectName(name);
    if (clean === this.projectName) return;
    this.projectName = clean;
    this.notify();
  }

  setMaxLiveRamBytesForTesting(bytes: number): void {
    this.maxLiveRamBytes = Math.max(1024, Math.round(bytes));
  }

  /** Capture a complete, serializable snapshot of the Studio project. */
  exportProject(): StudioProjectData {
    return {
      format: STUDIO_PROJECT_FORMAT,
      version: STUDIO_PROJECT_VERSION,
      id: this.projectId,
      name: this.projectName,
      savedAt: Date.now(),
      bpm: this.bpm,
      bars: this.bars,
      loopEnabled: this.loopEnabled,
      loopStartBar: this.loopStartBar,
      loopEndBar: this.loopEndBar,
      focusedTrackId: this.focusedTrackId,
      recordingSettings: this.getRecordingSettings(),
      tracks: this.tracks.map((t) => {
        t.ensureEventsSorted();
        const regions = t.getRegions(this.getTotalTicks());
        return {
          id: t.id,
          name: t.name,
          machineId: t.machineId,
          presetId: t.presetId,
          presetName: t.presetName,
          patch: { ...t.patch },
          volume: t.volume,
          pan: t.pan,
          mute: t.mute,
          solo: t.solo,
          armed: t.armed,
          midiChannel: t.midiChannel,
          events: regions.length ? flattenRegions(regions) : [],
          regions: regions.map(cloneRegion)
        };
      })
    };
  }

  exportProjectJson(): string {
    return serializeStudioProject(this.exportProject());
  }

  exportProjectBlob(): Blob {
    return createProjectBlob(this.exportProject());
  }

  /**
   * Create a fresh, independent project with a brand-new unique stable project ID.
   * Never overwrites any previously saved project in storage. Blocked during recording.
   */
  async createNewProject(opts: {
    name?: string;
    bpm?: number;
    bars?: number;
    machineId?: string;
    presetId?: string;
  } = {}): Promise<StudioProjectData> {
    if (this.recording || this.preparingRecord) {
      throw new Error("Stop recording before creating a new project.");
    }
    await this.stop();
    for (const old of this.tracks) {
      old.dispose();
    }
    this.playbackOpenNotes.clear();
    this.playbackSustainDown.clear();
    this.liveHeldTracksByMidi.clear();
    this.liveRecordedOpenNotes.clear();
    this.lastLiveTake = null;
    this.liveRecWarning = "";

    let nextId = createProjectId();
    while (nextId === this.projectId) nextId = createProjectId();
    this.projectId = nextId;
    this.projectName = sanitizeProjectName(opts.name ?? "Untitled Project");
    const nextBpm = Math.max(40, Math.min(240, Math.round(opts.bpm ?? 110)));
    const nextBars = Math.max(STUDIO_MIN_BARS, Math.min(STUDIO_MAX_BARS, Math.round(opts.bars ?? 8)));
    this.bpm = nextBpm;
    this.anchorBpm = nextBpm;
    this.bars = nextBars;
    this.loopEnabled = true;
    this.loopStartBar = 1;
    this.loopEndBar = nextBars;
    this.playheadTick = 0;
    this.anchorTick = 0;
    this.cursorTick = 0;

    if (!this.isolatedTempo) {
      if (this.active) {
        this.hasRestoredBpmPending = false;
        setTempo(nextBpm);
      } else {
        this.hasRestoredBpmPending = true;
      }
    }

    const t1 = this.createTrackInstance(1, opts.presetId || DEFAULT_TRACK_PRESETS[0], true);
    if (opts.machineId && opts.machineId !== "sy1") {
      t1.applyMachinePreset(opts.machineId, opts.presetId || "");
    }
    const t2 = this.createTrackInstance(2, DEFAULT_TRACK_PRESETS[1], false);
    this.tracks = [t1, t2];
    this.focusedTrackId = t1.id;
    this.regions.reset();
    this.recomputeAudibility();

    const ctx = getAudioCtxIfAny();
    if (ctx && this.masterBus && this.masterBus.ctx === ctx) {
      await Promise.all(this.tracks.map((t) => t.attachAudio(ctx, this.masterBus!.sum)));
    }

    this.notify();
    this.notifyKeys();
    return this.exportProject();
  }

  /**
   * Duplicate / Save As the current project under a brand-new unique project ID
   * while preserving all tracks, instruments, patches, MIDI regions, and settings.
   * Never alters or overwrites the original project ID in storage.
   */
  duplicateCurrentProject(newName?: string): StudioProjectData {
    if (this.recording || this.preparingRecord) {
      throw new Error("Stop recording before duplicating the project.");
    }
    let nextId = createProjectId();
    while (nextId === this.projectId) nextId = createProjectId();
    this.projectId = nextId;
    this.projectName = sanitizeProjectName(newName || `${this.projectName} Copy`);
    this.notify();
    return this.exportProject();
  }

  /**
   * Atomically validate and restore a Studio project.
   * Throws an Error without altering live engine state if recording is active or validation fails.
   */
  async loadProject(raw: unknown): Promise<StudioProjectData> {
    if (this.recording || this.preparingRecord) {
      throw new Error("Stop recording before switching projects.");
    }
    const check = validateStudioProject(raw);
    if (!check.ok) {
      throw new Error(check.error);
    }
    const proj = check.project;

    await this.stop();
    for (const old of this.tracks) {
      old.dispose();
    }
    this.playbackOpenNotes.clear();
    this.playbackSustainDown.clear();
    this.liveHeldTracksByMidi.clear();
    this.liveRecordedOpenNotes.clear();
    this.lastLiveTake = null;
    this.liveRecWarning = "";

    this.projectId = proj.id;
    this.projectName = proj.name;
    this.bars = proj.bars;
    this.loopEnabled = proj.loopEnabled;
    this.loopStartBar = proj.loopStartBar;
    this.loopEndBar = proj.loopEndBar;
    this.playheadTick = 0;
    this.anchorTick = 0;
    this.cursorTick = 0;

    // Preserve standalone SY-1 tempo until Studio is actually opened
    this.bpm = proj.bpm;
    this.anchorBpm = proj.bpm;
    if (!this.isolatedTempo) {
      if (this.active) {
        this.hasRestoredBpmPending = false;
        setTempo(proj.bpm);
      } else {
        this.hasRestoredBpmPending = true;
      }
    }

    const rebuilt: SY1TrackEngine[] = [];
    for (const td of proj.tracks) {
      const track = new SY1TrackEngine({
        id: td.id,
        name: td.name,
        machineId: td.machineId || "sy1",
        presetId: td.presetId,
        volume: td.volume,
        pan: td.pan,
        midiChannel: td.midiChannel
      });
      track.loadPatchSnapshot({ ...td.patch }, td.presetId, td.presetName, td.machineId || "sy1");
      track.mute = td.mute;
      track.solo = td.solo;
      track.armed = td.armed;
      if (td.regions) track.setRegions(td.regions, td.events);
      else track.setEvents(td.events);
      track.syncTempo(proj.bpm);
      track.onChange(() => this.notify());
      rebuilt.push(track);
    }

    this.tracks = rebuilt;
    this.regions.reset();
    this.setRecordingSettings(
      proj.recordingSettings || { metronome: false, countIn: false, clickVolume: 0.25, mode: "overdub" }
    );
    this.focusedTrackId = rebuilt.some((t) => t.id === proj.focusedTrackId)
      ? proj.focusedTrackId
      : rebuilt[0].id;
    this.recomputeAudibility();

    // If audio is already live on a shared AudioContext, re-attach restored tracks immediately
    const ctx = getAudioCtxIfAny();
    if (ctx && this.masterBus && this.masterBus.ctx === ctx) {
      await Promise.all(this.tracks.map((t) => t.attachAudio(ctx, this.masterBus!.sum)));
    }

    this.notify();
    this.notifyKeys();
    return proj;
  }

  // --------------------------------------------------- MIDI & WAV exports -----
  exportMidiBytes(projectName?: string): Uint8Array {
    const title = projectName || this.projectName || "SY-1 Studio";
    return encodeStudioMidi(
      this.tracks.map((t) => {
        const m = getStudioMachineDef(t.machineId);
        // GM drum channel 10 (1-indexed) when a drum track is on "All" (0)
        const ch = t.isDrumTrack() && t.midiChannel === 0 ? 10 : t.midiChannel;
        return {
          name: `${t.name} [${m.name}: ${t.presetName}]`,
          midiChannel: ch,
          events: t.events
        };
      }),
      this.bpm,
      this.getTotalTicks(),
      title
    );
  }

  exportMidiBlob(projectName?: string): Blob {
    const bytes = this.exportMidiBytes(projectName);
    return new Blob([bytes.buffer as ArrayBuffer], { type: "audio/midi" });
  }

  /**
   * Shared deterministic OfflineAudioContext renderer used by both Full Mix bounce
   * and per-track 24-bit Stereo PCM Stem bounce so every stem is guaranteed to be
   * sample-aligned with the mix (identical pre-roll, frame count, and event timing).
   */
  private async renderTracksOffline(
    selectedTracks: SY1TrackEngine[],
    options: {
      sampleRate: number;
      bars: number;
      tailSec: number;
      useMasterBus: boolean;
    }
  ): Promise<{ L: Float32Array; R: Float32Array; sampleRate: number }> {
    if (typeof OfflineAudioContext === "undefined") {
      throw new Error("OfflineAudioContext is not available in this environment");
    }
    const { sampleRate, bars: renderBars, tailSec, useMasterBus } = options;
    const endTick = renderBars * STUDIO_TICKS_PER_BAR;
    const secPerTick = this.secondsPerTick(this.bpm);
    const exactDurationSec = endTick * secPerTick + tailSec;
    const totalFrames = Math.max(128, Math.round(exactDurationSec * sampleRate));

    // 64-quantum silent pre-roll (8192 samples, ~170.7 ms at 48 kHz; sliced off before frame 0):
    // flushes AudioWorklet MessagePort patch + t=0 events AND lets WebAudio DynamicsCompressorNode
    // internal detector settle before beat 1 so Bar 1 matches copied/subsequent bars identically.
    const preRollFrames = 8192;
    const preRollSec = preRollFrames / sampleRate;
    const offline = new OfflineAudioContext(2, totalFrames + preRollFrames, sampleRate);
    const offlineMaster = useMasterBus
      ? createStudioMasterBus(offline, { connectToDestination: true, unityOut: true })
      : null;
    const destination: AudioNode = offlineMaster ? offlineMaster.sum : offline.destination;

    const clones: { src: SY1TrackEngine; clone: SY1TrackEngine; events: StudioMidiEvent[] }[] = [];

    const offlinePriority = (e: StudioMidiEvent) =>
      e.type === "noteOff" ? 0 : e.type === "cc" ? 1 : e.type === "pitchBend" ? 2 : 3;

    for (const src of selectedTracks) {
      const clone = new SY1TrackEngine({
        id: src.id,
        name: src.name,
        machineId: src.machineId,
        presetId: src.presetId,
        volume: src.volume,
        pan: src.pan,
        midiChannel: src.midiChannel,
        forceHQ: true
      });
      clone.loadPatchSnapshot({ ...src.patch }, src.presetId, src.presetName, src.machineId);
      clone.syncTempo(this.bpm);
      clone.setAudible(true);
      await clone.attachAudio(offline, destination);

      const evs = src.events
        .filter((e) => e.tick >= 0 && e.tick < endTick)
        .map((e) => ({ ...e }))
        .sort((a, b) => a.tick - b.tick || offlinePriority(a) - offlinePriority(b));
      clones.push({ src, clone, events: evs });
    }

    interface TimelineBatch {
      suspendAt: number;
      actions: (() => void)[];
    }
    const batches: TimelineBatch[] = [{ suspendAt: 128 / sampleRate, actions: [] }];

    const immediateChanges = new Map<number, (() => void)[]>();
    for (const item of clones) {
      const openNotes = new Set<number>();
      let batchStartSec = preRollSec;
      let countInWindow = 0;

      for (const ev of item.events) {
        const at = preRollSec + ev.tick * secPerTick;
        if (ev.type === "pitchBend" || (ev.type === "cc" && ev.cc === 1)) {
          const key = Math.max(128 / sampleRate, Math.floor((at * sampleRate) / 128) * (128 / sampleRate));
          let list = immediateChanges.get(key);
          if (!list) {
            list = [];
            immediateChanges.set(key, list);
          }
          if (ev.type === "pitchBend") {
            list.push(() => item.clone.setPitchBend(ev.value));
          } else {
            list.push(() => item.clone.setModWheel(ev.value / 127));
          }
          continue;
        }

        const runEv = () => {
          if (ev.type === "noteOn") {
            item.clone.noteOn(ev.midi, ev.velocity, at);
            openNotes.add(ev.midi);
          } else if (ev.type === "noteOff") {
            item.clone.noteOff(ev.midi, at);
            openNotes.delete(ev.midi);
          } else if (ev.type === "cc" && ev.cc === 64) {
            item.clone.setSustainPedal(ev.value >= 64, at);
          }
        };

        if (countInWindow >= 180 && at > batchStartSec + 0.05) {
          batchStartSec = Math.max(preRollSec, at - 0.01);
          countInWindow = 0;
          batches.push({ suspendAt: batchStartSec, actions: [] });
        }
        batches[batches.length - 1].actions.push(runEv);
        countInWindow++;
      }

      // Close any notes left open at endTick
      const endAt = preRollSec + endTick * secPerTick;
      batches[batches.length - 1].actions.push(() => {
        if (item.clone.getSustainPedal()) item.clone.setSustainPedal(false, endAt);
        openNotes.forEach((m) => item.clone.noteOff(m, endAt));
        openNotes.clear();
      });
    }

    immediateChanges.forEach((actions, time) => {
      if (time <= preRollSec) {
        batches[0].actions.unshift(...actions);
      } else {
        batches.push({ suspendAt: time, actions });
      }
    });

    const maxSuspend = (totalFrames + preRollFrames - 128) / sampleRate;
    const sortedBatches = batches
      .filter((b) => b.suspendAt > 0 && b.suspendAt <= maxSuspend)
      .sort((a, b) => a.suspendAt - b.suspendAt);

    const deduped: TimelineBatch[] = [];
    for (const b of sortedBatches) {
      const qTime = Math.max(128 / sampleRate, Math.floor((b.suspendAt * sampleRate) / 128) * (128 / sampleRate));
      const last = deduped[deduped.length - 1];
      if (last && Math.abs(last.suspendAt - qTime) < 1e-6) {
        last.actions.push(...b.actions);
      } else {
        deduped.push({ suspendAt: qTime, actions: [...b.actions] });
      }
    }

    for (const b of deduped) {
      offline.suspend(b.suspendAt).then(async () => {
        for (const fn of b.actions) fn();
        await new Promise((r) => setTimeout(r, 25));
        await offline.resume();
      }).catch(() => {});
    }

    const rendered = await offline.startRendering();
    const rawL = rendered.getChannelData(0);
    const rawR = rendered.numberOfChannels > 1 ? rendered.getChannelData(1) : rawL;
    const L = rawL.slice(preRollFrames, preRollFrames + totalFrames);
    const R = rawR.slice(preRollFrames, preRollFrames + totalFrames);

    clones.forEach((c) => c.clone.dispose());
    disposeStudioMasterBus(offlineMaster);
    return { L, R, sampleRate: rendered.sampleRate };
  }

  /**
   * Deterministically bounce the arrangement (default: full bar length) to an
   * uncompressed 24-bit stereo PCM WAV using OfflineAudioContext with real
   * isolated SY-1 AudioWorklet tracks and identical FX + StudioMasterBus.
   */
  async bounceArrangementWav(options: {
    sampleRate?: number;
    bars?: number;
    tailSec?: number;
  } = {}): Promise<StudioTake> {
    const sampleRate = options.sampleRate || getAudioCtxIfAny()?.sampleRate || 48000;
    const renderBars = Math.max(1, Math.min(STUDIO_MAX_BARS, Math.round(options.bars ?? this.bars)));
    const tailSec = Math.max(0, options.tailSec ?? 0);

    const anySolo = this.tracks.some((t) => t.solo);
    const audibleTracks = this.tracks.filter((t) => (anySolo ? t.solo : !t.mute));

    const { L, R, sampleRate: outRate } = await this.renderTracksOffline(audibleTracks, {
      sampleRate,
      bars: renderBars,
      tailSec,
      useMasterBus: true
    });
    const wav = encodeWav([[L], [R]], L.length, outRate);

    return {
      wav,
      sampleRate: outRate,
      durationSec: L.length / outRate,
      frames: L.length,
      bpm: this.bpm,
      kind: "bounce",
      createdAt: Date.now()
    };
  }

  /**
   * Render each track independently (sequentially, for low peak RAM) as genuine
   * uncompressed 24-bit Stereo PCM WAV stems, sample-aligned to frame 0 of the
   * arrangement with zero normalization or extra master compression.
   */
  async bounceTrackStemsWav(options: {
    sampleRate?: number;
    bars?: number;
    tailSec?: number;
    includeMuted?: boolean;
    onProgress?: (done: number, total: number, trackName: string) => void;
  } = {}): Promise<StudioStemTake[]> {
    const sampleRate = options.sampleRate || getAudioCtxIfAny()?.sampleRate || 48000;
    const renderBars = Math.max(1, Math.min(STUDIO_MAX_BARS, Math.round(options.bars ?? this.bars)));
    const tailSec = Math.max(0, options.tailSec ?? 0);

    const anySolo = this.tracks.some((t) => t.solo);
    const targets = options.includeMuted
      ? [...this.tracks]
      : this.tracks.filter((t) => (anySolo ? t.solo : !t.mute));

    if (targets.length === 0) {
      throw new Error("No audible tracks to export as stems.");
    }

    const stems: StudioStemTake[] = [];
    const projSlug = slugifyFilename(this.projectName);
    const bpmTag = Math.round(this.bpm);

    for (let i = 0; i < targets.length; i++) {
      const track = targets[i];
      if (options.onProgress) options.onProgress(i, targets.length, track.name);

      const { L, R, sampleRate: outRate } = await this.renderTracksOffline([track], {
        sampleRate,
        bars: renderBars,
        tailSec,
        useMasterBus: false
      });
      const wav = encodeWav([[L], [R]], L.length, outRate);
      const trackSlug = slugifyFilename(track.name);
      const presetSlug = slugifyFilename(track.presetName);

      stems.push({
        wav,
        sampleRate: outRate,
        durationSec: L.length / outRate,
        frames: L.length,
        bpm: this.bpm,
        kind: "stem",
        createdAt: Date.now(),
        trackId: track.id,
        trackName: track.name,
        presetName: track.presetName,
        filename: `${projSlug}-${String(i + 1).padStart(2, "0")}-${trackSlug}-${presetSlug}-${bpmTag}bpm-24bit.wav`
      });
    }

    if (options.onProgress) options.onProgress(targets.length, targets.length, "Done");
    return stems;
  }

  /** Lightweight playhead position readout for 60 Hz rAF without allocating a full StudioTransportSnapshot. */
  getPlayheadPosition(): { currentTick: number; totalTicks: number; currentBar: number; currentBeat: number } {
    const totalTicks = this.getTotalTicks();
    const tick = this.getCurrentTick();
    const clampedTick = Math.max(0, Math.min(totalTicks, tick));
    const currentBar = Math.min(this.bars, Math.floor(clampedTick / STUDIO_TICKS_PER_BAR) + 1);
    const tickInBar = clampedTick % STUDIO_TICKS_PER_BAR;
    const currentBeat = Math.min(STUDIO_BEATS_PER_BAR, Math.floor(tickInBar / STUDIO_PPQ) + 1);
    return { currentTick: clampedTick, totalTicks, currentBar, currentBeat };
  }

  // ---------------------------------------------------------------- snapshot ---
  getTransportSnapshot(): StudioTransportSnapshot {
    const pos = this.getPlayheadPosition();
    const liveFrames = this.recorder ? this.recorder.frames : 0;

    return {
      projectId: this.projectId,
      projectName: this.projectName,
      playing: this.playing,
      recording: this.recording,
      loopEnabled: this.loopEnabled,
      bars: this.bars,
      loopStartBar: this.loopStartBar,
      loopEndBar: this.loopEndBar,
      totalTicks: pos.totalTicks,
      bpm: this.bpm,
      currentTick: pos.currentTick,
      currentBar: pos.currentBar,
      currentBeat: pos.currentBeat,
      focusedTrackId: this.focusedTrackId,
      maxLiveSeconds: RECORDER_MAX_SECONDS,
      liveRecSeconds: this.recorder ? liveFrames / this.recorder.ctx.sampleRate : 0,
      liveRecBytes: liveFrames * STUDIO_LIVE_BYTES_PER_FRAME,
      maxLiveBytes: this.maxLiveRamBytes,
      liveRecWarning: this.liveRecWarning,
      hasLiveTake: !!this.lastLiveTake,
      liveTakeDurationSec: this.lastLiveTake ? this.lastLiveTake.durationSec : 0,
      recordingMode: this.recordingMode
    };
  }

  getTrackSnapshots(): StudioTrackSnapshot[] {
    return this.tracks.map((t) => t.getSnapshot());
  }

  dispose(): void {
    this.metronome.dispose();
    void this.stop();
    if (this.unsubMasterVol) {
      this.unsubMasterVol();
      this.unsubMasterVol = null;
    }
    if (this.unsubTempo) {
      this.unsubTempo();
      this.unsubTempo = null;
    }
    if (this.unsubAudioState) {
      this.unsubAudioState();
      this.unsubAudioState = null;
    }
    for (const t of this.tracks) t.dispose();
    disposeStudioMasterBus(this.masterBus);
    this.masterBus = null;
    this.stateListeners.clear();
    this.keyHighlightListener = null;
    this.dispatchObserver = null;
  }
}

export function createStudioEngine(opts?: StudioEngineOptions): SY1StudioEngine {
  return new SY1StudioEngine(opts);
}

/** Shared singleton for the web Studio UI (isolated from standalone SY-1 tempo/localStorage; never instantiated in AU/VST3 plugin mode). */
export const studioEngine = new SY1StudioEngine({ isolatedTempo: true });
