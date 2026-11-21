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
  onMasterVolumeChange,
  unlockAudio
} from "../engine/bus";
import { encodeWav, ensureRecorderWorklet, RECORDER_MAX_SECONDS } from "../engine/daw";
import { getTempo, onTempoChange, setTempo } from "../engine/tempo";
import { encodeStudioMidi } from "./midi-io";
import { SY1TrackEngine } from "./track-engine";
import {
  STUDIO_BEATS_PER_BAR,
  STUDIO_MAX_BARS,
  STUDIO_MAX_TRACKS,
  STUDIO_MIN_BARS,
  STUDIO_PPQ,
  STUDIO_TICKS_PER_BAR,
  StudioMidiEvent,
  StudioTake,
  StudioTrackSnapshot,
  StudioTransportSnapshot
} from "./types";

const SCHEDULER_INTERVAL_MS = 25;
const LOOKAHEAD_SEC = 0.1;

/**
 * Transparent Studio master safety soft-clipper:
 * - Exact mathematical identity y = x for |x| <= 0.98 (-0.175 dBFS), so any
 *   single SY-1 track (already soft-clipped by its own SY-1 FX bus) passes
 *   through unaltered.
 * - Smooth tanh knee above 0.98 asymptotically capped at 1.0 when multiple
 *   hot tracks sum together.
 */
export function makeStudioMasterClipCurve(): Float32Array {
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
  analyser.fftSize = 2048;

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

interface LiveRecorderSession {
  ctx: AudioContext;
  node: AudioWorkletNode;
  sink: GainNode;
  chunks: Float32Array[][];
  frames: number;
  bpm: number;
}

export interface ScheduledDispatchRecord {
  trackId: string;
  event: StudioMidiEvent;
  audioTime: number;
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
  private tracks: SY1TrackEngine[] = [];
  private focusedTrackId: string;
  private masterBus: StudioMasterBus | null = null;
  private unsubMasterVol: (() => void) | null = null;
  private unsubTempo: (() => void) | null = null;

  private active = false;
  private playing = false;
  private recording = false;
  private loopEnabled = true;
  private bars = 8;
  private loopStartBar = 1;
  private loopEndBar = 8;

  private bpm: number;
  private playheadTick = 0;
  private anchorAudioTime = 0;
  private anchorTick = 0;
  private anchorBpm: number;

  private schedulerTimer: ReturnType<typeof setInterval> | null = null;
  private cursorAudioTime = 0;
  private cursorTick = 0;
  private playbackOpenNotes = new Map<string, Set<number>>();
  private playbackSustainDown = new Set<string>();
  private liveHeldTracksByMidi = new Map<number, Set<string>>();
  private liveRecordedOpenNotes = new Map<string, Set<number>>();

  private recorder: LiveRecorderSession | null = null;
  private lastLiveTake: StudioTake | null = null;

  private clockNowOverride: (() => number) | null;
  private isolatedTempo: boolean;
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
    if (!on) {
      void this.stop();
      this.allNotesOff();
    }
    this.notify();
  }

  isActive(): boolean {
    return this.active;
  }

  /** Lazily attach StudioMasterBus and all tracks to the single shared AudioContext. */
  async ensureAudio(): Promise<AudioContext | null> {
    if (typeof window === "undefined") return null;
    unlockAudio();
    const ctx = getAudioCtx();
    if (!ctx) return null;

    if (!this.masterBus || this.masterBus.ctx !== ctx) {
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
    this.notify();
    this.notifyKeys();
  }

  addTrack(presetId?: string): SY1TrackEngine | null {
    if (this.tracks.length >= STUDIO_MAX_TRACKS) return null;
    const idx = this.tracks.length + 1;
    const track = this.createTrackInstance(idx, presetId || DEFAULT_TRACK_PRESETS[(idx - 1) % DEFAULT_TRACK_PRESETS.length], false);
    this.tracks.push(track);
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
    t.applyPreset(presetId);
  }

  setTrackParam(id: string, key: string, value: any): void {
    const t = this.getTrack(id);
    if (!t) return;
    t.setParam(key, value);
  }

  clearTrackClip(id: string): void {
    const t = this.getTrack(id);
    if (!t) return;
    t.clearEvents();
    this.notify();
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

  private handleTempoChange(nextBpm: number): void {
    if (!(nextBpm > 0)) return;
    const now = this.nowAudioTime();
    if (this.playing) {
      const curTick = this.getCurrentTick(now);
      this.anchorAudioTime = now;
      this.anchorTick = curTick;
      this.anchorBpm = nextBpm;
      // Re-align scheduler cursor time to the new tempo so future lookahead stays exact
      const deltaTicks = this.cursorTick - curTick;
      if (deltaTicks >= 0) {
        this.cursorAudioTime = now + deltaTicks * this.secondsPerTick(nextBpm);
      } else {
        this.cursorAudioTime = now;
        this.cursorTick = curTick;
      }
    } else {
      this.anchorBpm = nextBpm;
    }
    this.bpm = nextBpm;
    for (const t of this.tracks) t.syncTempo(nextBpm);
    this.notify();
  }

  seekToTick(tick: number): void {
    const clamped = Math.max(0, Math.min(this.getTotalTicks() - 1, Math.round(tick)));
    this.playheadTick = clamped;
    if (this.playing) {
      const now = this.nowAudioTime();
      this.releasePlaybackNotes(now);
      this.anchorAudioTime = now;
      this.anchorTick = clamped;
      this.anchorBpm = this.bpm;
      this.cursorAudioTime = now;
      this.cursorTick = clamped;
    }
    this.notify();
  }

  seekToBar(bar1Indexed: number): void {
    const b = Math.max(1, Math.min(this.bars, Math.round(bar1Indexed)));
    this.seekToTick((b - 1) * STUDIO_TICKS_PER_BAR);
  }

  async play(): Promise<void> {
    if (this.playing) return;
    if (!this.clockNowOverride) {
      await this.ensureAudio();
    }
    if (this.playheadTick >= this.getTotalTicks()) {
      this.playheadTick = 0;
    }
    const now = this.nowAudioTime();
    this.playing = true;
    this.anchorAudioTime = now;
    this.anchorTick = this.playheadTick;
    this.anchorBpm = this.bpm;
    this.cursorAudioTime = now;
    this.cursorTick = this.playheadTick;
    this.playbackOpenNotes.clear();
    this.playbackSustainDown.clear();

    this.stepScheduler(now);
    this.startSchedulerTimer();
    this.notify();
  }

  async record(): Promise<void> {
    if (this.recording) return;
    if (!this.clockNowOverride) {
      await this.ensureAudio();
    }
    // Ensure at least one track is armed; if none armed, arm the focused track
    if (!this.tracks.some((t) => t.armed)) {
      this.getFocusedTrack().armed = true;
    }
    this.recording = true;
    this.liveRecordedOpenNotes.clear();

    // Start live 24-bit WAV recorder on StudioMasterBus.tap if audio context is live
    if (!this.clockNowOverride) {
      await this.startLiveMixRecorder();
    }

    if (!this.playing) {
      await this.play();
    } else {
      this.notify();
    }
  }

  async stop(): Promise<void> {
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
      this.recording = false;
      await this.stopLiveMixRecorder();
    }

    this.playing = false;
    this.playheadTick = 0;
    this.anchorTick = 0;
    this.cursorTick = 0;
    this.releasePlaybackNotes(0);
    this.allNotesOff();

    if (wasPlaying || wasRecording) {
      this.notify();
      this.notifyKeys();
    }
  }

  allNotesOff(): void {
    this.playbackOpenNotes.clear();
    this.playbackSustainDown.clear();
    this.liveHeldTracksByMidi.clear();
    for (const t of this.tracks) t.allNotesOff(0);
    this.notifyKeys();
  }

  // ------------------------------------------------------- lookahead engine ----
  private startSchedulerTimer(): void {
    if (this.schedulerTimer !== null) clearInterval(this.schedulerTimer);
    if (this.clockNowOverride) return; // deterministic test mode drives stepScheduler manually
    this.schedulerTimer = setInterval(() => {
      if (!this.playing) return;
      this.stepScheduler(this.nowAudioTime());
    }, SCHEDULER_INTERVAL_MS);
  }

  /**
   * Advance the audio-clock lookahead scheduler up to `now + LOOKAHEAD_SEC`.
   * Public so deterministic tests can step exact clock timelines without timers.
   */
  stepScheduler(nowAudioTime: number): void {
    if (!this.playing) return;
    const windowEnd = nowAudioTime + LOOKAHEAD_SEC;
    if (this.cursorAudioTime > windowEnd) return;

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
        if (this.recording) {
          this.closeLiveRecordedNotes(loopEnd);
        }

        // Re-anchor cleanly at loopStart to prevent floating-point drift across infinite cycles
        this.anchorAudioTime = loopEndAudio;
        this.anchorTick = loopStart;
        this.cursorAudioTime = loopEndAudio;
        this.cursorTick = loopStart;
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

  private scheduleSegment(startTick: number, endTick: number, segStartAudio: number, secPerTick: number): void {
    if (endTick <= startTick) return;
    for (const track of this.tracks) {
      if (track.events.length === 0) continue;
      // Collect events strictly inside [startTick, endTick)
      const due: StudioMidiEvent[] = [];
      for (let i = 0; i < track.events.length; i++) {
        const ev = track.events[i];
        if (ev.tick >= startTick && ev.tick < endTick) {
          due.push(ev);
        }
      }
      if (due.length === 0) continue;
      due.sort((a, b) => a.tick - b.tick || (a.type === "noteOff" ? -1 : 1) - (b.type === "noteOff" ? -1 : 1));

      let openSet = this.playbackOpenNotes.get(track.id);
      if (!openSet) {
        openSet = new Set<number>();
        this.playbackOpenNotes.set(track.id, openSet);
      }

      for (const ev of due) {
        const at = segStartAudio + (ev.tick - startTick) * secPerTick;
        this.dispatchEventToTrack(track, ev, at, openSet);
        if (this.dispatchObserver) {
          this.dispatchObserver({ trackId: track.id, event: ev, audioTime: at });
        }
      }
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

  private closeLiveRecordedNotes(closeTick: number): void {
    const clampedTick = Math.max(0, Math.round(closeTick));
    this.liveRecordedOpenNotes.forEach((notes, trackId) => {
      const track = this.getTrack(trackId);
      if (!track || notes.size === 0) return;
      notes.forEach((midi) => {
        track.addEvent({ type: "noteOff", tick: clampedTick, midi });
      });
      notes.clear();
    });
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

  liveNoteOn(midi: number, velocity = 0.85, midiChannel = 0): void {
    if (!this.clockNowOverride) this.prepareAudioSync();
    const m = Math.max(0, Math.min(127, Math.round(midi)));
    const vel = Math.max(0.01, Math.min(1, Number(velocity) || 0.85));
    const targets = this.resolveLiveTargets(midiChannel);
    if (targets.length === 0) return;

    let heldSet = this.liveHeldTracksByMidi.get(m);
    if (!heldSet) {
      heldSet = new Set<string>();
      this.liveHeldTracksByMidi.set(m, heldSet);
    }

    const tick = this.recording ? Math.round(this.getCurrentTick()) : 0;

    for (const track of targets) {
      track.noteOn(m, vel, 0);
      heldSet.add(track.id);

      if (this.recording && track.armed) {
        track.addEvent({ type: "noteOn", tick, midi: m, velocity: vel });
        let recOpen = this.liveRecordedOpenNotes.get(track.id);
        if (!recOpen) {
          recOpen = new Set<number>();
          this.liveRecordedOpenNotes.set(track.id, recOpen);
        }
        recOpen.add(m);
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

    const tick = this.recording ? Math.round(this.getCurrentTick()) : 0;

    for (const track of targets) {
      track.noteOff(m, 0);
      heldSet?.delete(track.id);

      if (this.recording && track.armed) {
        const recOpen = this.liveRecordedOpenNotes.get(track.id);
        if (recOpen && recOpen.has(m)) {
          track.addEvent({ type: "noteOff", tick, midi: m });
          recOpen.delete(m);
        }
      }
    }
    if (heldSet && heldSet.size === 0) this.liveHeldTracksByMidi.delete(m);
    this.notifyKeys();
  }

  livePitchBend(norm: number, midiChannel = 0): void {
    const v = Math.max(-1, Math.min(1, Number(norm) || 0));
    const targets = this.resolveLiveTargets(midiChannel);
    const tick = this.recording ? Math.round(this.getCurrentTick()) : 0;
    for (const track of targets) {
      track.setPitchBend(v);
      if (this.recording && track.armed) {
        track.addEvent({ type: "pitchBend", tick, value: v });
      }
    }
  }

  liveCC(cc: number, value: number, midiChannel = 0): void {
    const targets = this.resolveLiveTargets(midiChannel);
    const tick = this.recording ? Math.round(this.getCurrentTick()) : 0;
    const val7 = Math.max(0, Math.min(127, Math.round(value)));
    for (const track of targets) {
      if (cc === 64) {
        track.setSustainPedal(val7 >= 64, 0);
        if (this.recording && track.armed) {
          track.addEvent({ type: "cc", tick, cc: 64, value: val7 });
        }
      } else if (cc === 1) {
        track.setModWheel(val7 / 127);
        if (this.recording && track.armed) {
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
      bpm: this.bpm
    };

    node.port.onmessage = (e) => {
      const d = e.data;
      if (d && d.l) {
        rec.chunks[0].push(d.l);
        rec.chunks[1].push(d.r);
        rec.frames += d.l.length;
        // Strictly preserve the 30-minute safety cap until streaming storage is built
        if (this.recorder === rec && rec.frames / ctx.sampleRate >= RECORDER_MAX_SECONDS) {
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

  private stopLiveMixRecorder(): Promise<void> {
    const rec = this.recorder;
    if (!rec) return Promise.resolve();
    this.recorder = null;

    return new Promise((resolve) => {
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        try { this.masterBus?.tap.disconnect(rec.node); } catch (e) {}
        try { rec.node.disconnect(); rec.sink.disconnect(); } catch (e) {}
        if (rec.frames > 0) {
          const wav = encodeWav(rec.chunks, rec.frames, rec.ctx.sampleRate);
          this.lastLiveTake = {
            wav,
            sampleRate: rec.ctx.sampleRate,
            durationSec: rec.frames / rec.ctx.sampleRate,
            frames: rec.frames,
            bpm: rec.bpm,
            kind: "live",
            createdAt: Date.now()
          };
        }
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

  // --------------------------------------------------- MIDI & WAV exports -----
  exportMidiBytes(projectName = "SY-1 Studio"): Uint8Array {
    return encodeStudioMidi(
      this.tracks.map((t) => ({
        name: `${t.name} (${t.presetName})`,
        midiChannel: t.midiChannel,
        events: t.events
      })),
      this.bpm,
      this.getTotalTicks(),
      projectName
    );
  }

  exportMidiBlob(projectName = "SY-1 Studio"): Blob {
    const bytes = this.exportMidiBytes(projectName);
    return new Blob([bytes.buffer as ArrayBuffer], { type: "audio/midi" });
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
    if (typeof OfflineAudioContext === "undefined") {
      throw new Error("OfflineAudioContext is not available in this environment");
    }
    const sampleRate = options.sampleRate || getAudioCtxIfAny()?.sampleRate || 48000;
    const renderBars = Math.max(1, Math.min(STUDIO_MAX_BARS, Math.round(options.bars ?? this.bars)));
    const endTick = renderBars * STUDIO_TICKS_PER_BAR;
    const tailSec = Math.max(0, options.tailSec ?? 0);
    const secPerTick = this.secondsPerTick(this.bpm);
    const exactDurationSec = endTick * secPerTick + tailSec;
    const totalFrames = Math.max(128, Math.round(exactDurationSec * sampleRate));

    // 2-quantum pre-roll (256 samples): suspend at quantum 1 so Chromium's AudioWorklet
    // thread reliably flushes MessagePort patch + t=0 events before sample 0 of the song renders.
    const preRollFrames = 256;
    const preRollSec = preRollFrames / sampleRate;
    const offline = new OfflineAudioContext(2, totalFrames + preRollFrames, sampleRate);
    const master = createStudioMasterBus(offline, { connectToDestination: true, unityOut: true });

    const anySolo = this.tracks.some((t) => t.solo);
    const clones: { src: SY1TrackEngine; clone: SY1TrackEngine; events: StudioMidiEvent[] }[] = [];

    for (const src of this.tracks) {
      const audible = anySolo ? src.solo : !src.mute;
      if (!audible) continue;

      const clone = new SY1TrackEngine({
        id: src.id,
        name: src.name,
        presetId: src.presetId,
        volume: src.volume,
        pan: src.pan,
        midiChannel: src.midiChannel,
        forceHQ: true
      });
      clone.loadPatchSnapshot({ ...src.patch }, src.presetId, src.presetName);
      clone.syncTempo(this.bpm);
      clone.setAudible(true);
      await clone.attachAudio(offline, master.sum);

      const evs = src.events
        .filter((e) => e.tick >= 0 && e.tick < endTick)
        .map((e) => ({ ...e }))
        .sort((a, b) => a.tick - b.tick || (a.type === "noteOff" ? -1 : 1) - (b.type === "noteOff" ? -1 : 1));
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

    // Deduplicate all suspend points (starting with quantum 1 pre-roll flush barrier)
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
        // Give worklet MessagePort a brief yield while paused so every queued message lands cleanly
        await new Promise((r) => setTimeout(r, 10));
        await offline.resume();
      }).catch(() => {});
    }

    const rendered = await offline.startRendering();
    const rawL = rendered.getChannelData(0);
    const rawR = rendered.numberOfChannels > 1 ? rendered.getChannelData(1) : rawL;
    const L = rawL.subarray(preRollFrames, preRollFrames + totalFrames);
    const R = rawR.subarray(preRollFrames, preRollFrames + totalFrames);
    const wav = encodeWav([[L], [R]], L.length, rendered.sampleRate);

    clones.forEach((c) => c.clone.detachAudio());

    return {
      wav,
      sampleRate: rendered.sampleRate,
      durationSec: L.length / rendered.sampleRate,
      frames: L.length,
      bpm: this.bpm,
      kind: "bounce",
      createdAt: Date.now()
    };
  }

  // ---------------------------------------------------------------- snapshot ---
  getTransportSnapshot(): StudioTransportSnapshot {
    const tick = this.getCurrentTick();
    const clampedTick = Math.max(0, Math.min(this.getTotalTicks(), tick));
    const currentBar = Math.min(this.bars, Math.floor(clampedTick / STUDIO_TICKS_PER_BAR) + 1);
    const tickInBar = clampedTick % STUDIO_TICKS_PER_BAR;
    const currentBeat = Math.min(STUDIO_BEATS_PER_BAR, Math.floor(tickInBar / STUDIO_PPQ) + 1);

    return {
      playing: this.playing,
      recording: this.recording,
      loopEnabled: this.loopEnabled,
      bars: this.bars,
      loopStartBar: this.loopStartBar,
      loopEndBar: this.loopEndBar,
      totalTicks: this.getTotalTicks(),
      bpm: this.bpm,
      currentTick: clampedTick,
      currentBar,
      currentBeat,
      focusedTrackId: this.focusedTrackId,
      maxLiveSeconds: RECORDER_MAX_SECONDS,
      liveRecSeconds: this.recorder ? this.recorder.frames / this.recorder.ctx.sampleRate : 0,
      hasLiveTake: !!this.lastLiveTake,
      liveTakeDurationSec: this.lastLiveTake ? this.lastLiveTake.durationSec : 0
    };
  }

  getTrackSnapshots(): StudioTrackSnapshot[] {
    return this.tracks.map((t) => t.getSnapshot());
  }

  dispose(): void {
    void this.stop();
    if (this.unsubMasterVol) {
      this.unsubMasterVol();
      this.unsubMasterVol = null;
    }
    if (this.unsubTempo) {
      this.unsubTempo();
      this.unsubTempo = null;
    }
    for (const t of this.tracks) t.detachAudio();
    this.masterBus = null;
  }
}

export function createStudioEngine(opts?: StudioEngineOptions): SY1StudioEngine {
  return new SY1StudioEngine(opts);
}

/** Shared singleton for the web Studio UI (never instantiated in AU/VST3 plugin mode). */
export const studioEngine = new SY1StudioEngine();
