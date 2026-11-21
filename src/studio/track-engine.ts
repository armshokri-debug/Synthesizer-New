/**
 * SY-1 Studio — Isolated Per-Track SY-1 Synthesizer Engine
 *
 * Each track owns:
 * - Its own SynthPatch object (never shared with standalone synth.ts or localStorage)
 * - Its own SY-1 AudioWorkletNode ("sy1-voices" -> independent HQEngine DSP instance)
 * - Its own isolated SynthFXBus (drive, 3-band EQ, tape delay, chorus, Freeverb, limiter, soft clip)
 * - Its own Classic fallback voice pool (isolated VoiceRoutingOptions)
 * - Its own channel strip (fader, stereo pan, mute/solo gate)
 * - Its own poly/mono/legato/sustain/bend/mod performance state and MIDI clip events
 */

import { applyBusParam, createSynthBus, disposeSynthBus, SynthFXBus } from "../engine/bus";
import { createHQNode, getEngine } from "../engine/hq";
import { SYNC_DIVS, SYNTH_PARAMS, SynthPatch, synthDefaults, tuningCents } from "../engine/params";
import { createSynthVoice, SynthVoice, VoiceRoutingOptions } from "../engine/voice";
import { SY1 } from "../machines/sy1";
import { extractNoteSpans } from "./midi-io";
import { StudioMidiEvent, StudioNoteSpan, StudioTrackSnapshot, TrackAudioState } from "./types";

export function buildSy1PresetPatch(presetId: string): { presetId: string; presetName: string; patch: SynthPatch } {
  const preset = SY1.presets.find((p) => p.id === presetId) || SY1.presets[0];
  const patch: SynthPatch = Object.assign(synthDefaults(), SY1.base, preset ? preset.patch : {});
  patch.hold = "off";
  return {
    presetId: preset ? preset.id : "init",
    presetName: preset ? preset.name : "Init",
    patch
  };
}

function isOfflineCtx(ctx: BaseAudioContext): boolean {
  return typeof OfflineAudioContext !== "undefined" && ctx instanceof OfflineAudioContext;
}

function compareStudioEvents(a: StudioMidiEvent, b: StudioMidiEvent): number {
  return a.tick - b.tick || (a.type === "noteOff" ? -1 : 1) - (b.type === "noteOff" ? -1 : 1);
}

export interface SY1TrackOptions {
  id: string;
  name: string;
  presetId?: string;
  midiChannel?: number;
  volume?: number;
  pan?: number;
  forceHQ?: boolean;
}

export class SY1TrackEngine {
  readonly id: string;
  name: string;
  presetId: string;
  presetName: string;
  readonly patch: SynthPatch;

  volume: number;
  pan: number;
  mute = false;
  solo = false;
  audible = true;
  armed = false;
  midiChannel: number; // 0 = All, 1..16
  events: StudioMidiEvent[] = [];

  private ctx: BaseAudioContext | null = null;
  private bus: SynthFXBus | null = null;
  private fader: GainNode | null = null;
  private panner: StereoPannerNode | null = null;
  private muteGate: GainNode | null = null;
  private hqNode: AudioWorkletNode | null = null;
  private attachPromise: Promise<void> | null = null;
  private audioState: TrackAudioState = "idle";
  private forceHQ: boolean;

  private classicVoices = new Set<SynthVoice>();
  private heldVoices = new Map<number, SynthVoice>();
  private heldVelocities = new Map<number, number>();
  private physicallyHeld = new Set<number>();
  private sustainedNotes = new Set<number>();
  private sustainPedal = false;
  private monoStack: number[] = [];
  private monoVoice: SynthVoice | null = null;
  private monoMidi = -1;
  private lastMonoHz = 0;
  private pitchBend = 0;
  private modWheel = 0;
  private nextVoiceId = 1;
  private currentBpm = 110;
  private eventsDirty = false;
  private cachedNoteCount: number | null = 0;
  private cachedEventsLen = 0;

  private listeners = new Set<() => void>();

  constructor(opts: SY1TrackOptions) {
    this.id = opts.id;
    this.name = opts.name;
    const built = buildSy1PresetPatch(opts.presetId || "init");
    this.presetId = built.presetId;
    this.presetName = built.presetName;
    this.patch = built.patch;
    this.volume = opts.volume !== undefined ? Math.max(0, Math.min(1, opts.volume)) : 1;
    this.pan = opts.pan !== undefined ? Math.max(-1, Math.min(1, opts.pan)) : 0;
    this.midiChannel = opts.midiChannel ?? 0;
    this.forceHQ = !!opts.forceHQ;
  }

  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private emitChange(): void {
    this.listeners.forEach((cb) => cb());
  }

  /** Attach this track to a shared AudioContext or OfflineAudioContext and connect to destination. */
  attachAudio(ctx: BaseAudioContext, destination: AudioNode): Promise<void> {
    if (this.ctx === ctx && this.bus) {
      return this.attachPromise || Promise.resolve();
    }
    this.detachAudio();
    this.ctx = ctx;

    const bus = createSynthBus(ctx, this.patch, { connectToDestination: false, mainFxOn: true });
    const fader = ctx.createGain();
    fader.gain.value = this.volume;

    const muteGate = ctx.createGain();
    muteGate.gain.value = this.audible ? 1 : 0;

    let panner: StereoPannerNode | null = null;
    if (typeof ctx.createStereoPanner === "function") {
      panner = ctx.createStereoPanner();
      panner.pan.value = this.pan;
      bus.tap.connect(fader);
      fader.connect(panner);
      panner.connect(muteGate);
    } else {
      bus.tap.connect(fader);
      fader.connect(muteGate);
    }
    muteGate.connect(destination);

    this.bus = bus;
    this.fader = fader;
    this.panner = panner;
    this.muteGate = muteGate;
    this.audioState = "classic";

    const p = createHQNode(ctx, bus.input, this.patch).then((node) => {
      if (this.ctx !== ctx) {
        if (node) {
          try { node.disconnect(); } catch (e) {}
        }
        return;
      }
      if (node) {
        this.hqNode = node;
        this.audioState = "hq";
        // Re-sync any parameter edits made while the worklet was loading
        node.port.postMessage({ t: "patch", patch: { ...this.patch } });
        if (this.pitchBend !== 0) node.port.postMessage({ t: "bend", v: this.pitchBend });
        if (this.modWheel !== 0) node.port.postMessage({ t: "mod", v: this.modWheel });
        this.emitChange();
      }
    });

    this.attachPromise = p;
    return p;
  }

  /** Wait until HQ AudioWorklet initialization settles (if attached). */
  ready(): Promise<void> {
    return this.attachPromise || Promise.resolve();
  }

  isAudioAttached(): boolean {
    return this.ctx !== null && this.bus !== null;
  }

  getAudioState(): TrackAudioState {
    return this.audioState;
  }

  /** Direct access to this track's FX bus (for diagnostics / testing). */
  getBus(): SynthFXBus | null {
    return this.bus;
  }

  private useHQ(): boolean {
    if (!this.hqNode) return false;
    return this.forceHQ || getEngine() === "hq";
  }

  private hqPost(msg: Record<string, unknown>): void {
    if (this.hqNode) this.hqNode.port.postMessage(msg);
  }

  private syncedLfoRate(): number | null {
    const s = Math.round(this.patch.lfoSync || 0);
    if (s <= 0) return null;
    const div = SYNC_DIVS[Math.min(SYNC_DIVS.length, s) - 1];
    return this.currentBpm / 60 / div.beats;
  }

  syncTempo(bpm: number): void {
    this.currentBpm = bpm;
    const r = this.syncedLfoRate();
    if (r !== null) this.setParam("lfoRate", r, { internal: true });
  }

  applyPreset(presetId: string): void {
    const preset = SY1.presets.find((p) => p.id === presetId);
    if (!preset) return;
    this.allNotesOff();
    const next: SynthPatch = Object.assign(synthDefaults(), SY1.base, preset.patch);
    next.hold = "off";
    Object.keys(next).forEach((k) => {
      this.patch[k] = next[k];
      if (this.bus) applyBusParam(this.bus, k, next[k]);
    });
    const r = this.syncedLfoRate();
    if (r !== null) this.patch.lfoRate = r;

    this.presetId = preset.id;
    this.presetName = preset.name;

    if (this.hqNode) {
      this.hqNode.port.postMessage({ t: "patch", patch: { ...this.patch } });
    }
    this.classicVoices.forEach((vc) => {
      Object.keys(this.patch).forEach((k) => vc.update(k));
    });
    this.emitChange();
  }

  /** Load an arbitrary patch snapshot (used for offline bounce clones). */
  loadPatchSnapshot(patch: SynthPatch, presetId: string, presetName: string): void {
    Object.keys(patch).forEach((k) => {
      this.patch[k] = patch[k];
      if (this.bus) applyBusParam(this.bus, k, patch[k]);
    });
    this.presetId = presetId;
    this.presetName = presetName;
    if (this.hqNode) {
      this.hqNode.port.postMessage({ t: "patch", patch: { ...this.patch } });
    }
  }

  setParam(
    key: string,
    value: any,
    { fromPreset = false, internal = false }: { fromPreset?: boolean; internal?: boolean } = {}
  ): void {
    const def = SYNTH_PARAMS[key];
    if (!def) return;
    if (key === "hold" && fromPreset) value = "off";

    const before = this.patch[key];
    let nextVal: any;
    if (def.type) {
      nextVal = value;
    } else {
      let v = Math.max(def.min!, Math.min(def.max!, Number(value)));
      if (def.step) v = Math.round(v / def.step) * def.step;
      nextVal = v;
    }

    // Short-circuit identical parameter writes during rapid UI/MIDI scrubbing to avoid redundant worklet & UI churn
    if (!fromPreset && !internal && nextVal === before && key !== "lfoSync") {
      return;
    }
    this.patch[key] = nextVal;

    if (!fromPreset && !internal && key !== "hold" && key !== "oriental") {
      this.presetId = "custom";
      this.presetName = "Custom";
    }

    if (key === "hold" && this.patch.hold !== "on" && before === "on") {
      this.releaseSustained(0);
    }

    if (!internal) {
      if (key === "lfoRate" && !fromPreset && (this.patch.lfoSync || 0) > 0) {
        this.patch.lfoSync = 0;
      }
      if (key === "lfoSync") {
        const r = this.syncedLfoRate();
        if (r !== null) this.setParam("lfoRate", r, { internal: true });
      }
      if (key === "polyMode" && this.patch[key] !== before) {
        this.allNotesOff();
      }
    }

    if (this.bus) {
      applyBusParam(this.bus, key, this.patch[key]);
    }
    this.classicVoices.forEach((vc) => vc.update(key));
    this.hqPost({ t: "param", key, value: this.patch[key] });

    if (!fromPreset && (key === "oriental" || key === "tuning" || key === "tuneRoot" || key === "scaleAlt" || key === "microTone")) {
      this.retuneActiveVoices();
    }

    this.emitChange();
  }

  setVolume(v: number): void {
    const next = Math.max(0, Math.min(1, Number(v)));
    if (!Number.isFinite(next)) return;
    this.volume = next;
    if (this.fader && this.ctx) {
      if (isOfflineCtx(this.ctx)) this.fader.gain.value = next;
      else this.fader.gain.setTargetAtTime(next, this.ctx.currentTime, 0.012);
    }
    this.emitChange();
  }

  setPan(v: number): void {
    const next = Math.max(-1, Math.min(1, Number(v)));
    if (!Number.isFinite(next)) return;
    this.pan = next;
    if (this.panner && this.ctx) {
      if (isOfflineCtx(this.ctx)) this.panner.pan.value = next;
      else this.panner.pan.setTargetAtTime(next, this.ctx.currentTime, 0.012);
    }
    this.emitChange();
  }

  setAudible(audible: boolean): void {
    this.audible = audible;
    if (this.muteGate && this.ctx) {
      const g = audible ? 1 : 0;
      if (isOfflineCtx(this.ctx)) this.muteGate.gain.value = g;
      else this.muteGate.gain.setTargetAtTime(g, this.ctx.currentTime, 0.012);
    }
  }

  setPitchBend(norm: number): void {
    const v = Math.max(-1, Math.min(1, Number(norm) || 0));
    this.pitchBend = v;
    this.hqPost({ t: "bend", v });
    this.classicVoices.forEach((vc) => vc.update("pitchBend"));
  }

  getPitchBend(): number {
    return this.pitchBend;
  }

  setModWheel(norm: number): void {
    const v = Math.max(0, Math.min(1, Number(norm) || 0));
    this.modWheel = v;
    this.hqPost({ t: "mod", v });
    this.classicVoices.forEach((vc) => vc.update("modWheel"));
  }

  getModWheel(): number {
    return this.modWheel;
  }

  setSustainPedal(down: boolean, at = 0): void {
    const next = !!down;
    if (next === this.sustainPedal) return;
    this.sustainPedal = next;
    if (!next) this.releaseSustained(at);
  }

  getSustainPedal(): boolean {
    return this.sustainPedal;
  }

  centsFor(midi: number): number {
    if (this.patch.oriental !== "on") return 0;
    return tuningCents(
      this.patch.tuning || "shur",
      midi,
      Number(this.patch.tuneRoot) || 0,
      "sy1",
      Number(this.patch.scaleAlt) || 0,
      this.patch.microTone || "24tet"
    );
  }

  freqFor(midi: number): number {
    return 440 * Math.pow(2, (midi - 69) / 12 + this.centsFor(midi) / 1200);
  }

  private holding(): boolean {
    return this.sustainPedal || this.patch.hold === "on";
  }

  private createTrackHQVoice(midi: number, cents: number, velocity: number, at = 0, fromHz = 0, glide = 0): SynthVoice {
    const id = this.nextVoiceId++;
    this.hqPost({ t: "on", id, midi, cents, vel: velocity, at, from: fromHz, glide });
    let released = false;
    const voice: SynthVoice = {
      freq: 440 * Math.pow(2, (midi - 69) / 12 + cents / 1200),
      isReleased: () => released,
      kill: () => {
        if (released) return;
        released = true;
        this.hqPost({ t: "kill", id });
      },
      release: (t?: number, fastTau?: number) => {
        if (released) return;
        released = true;
        this.hqPost({ t: fastTau ? "kill" : "off", id, at: t || 0 });
      },
      retune: (freqHz: number, glideT: number, t: number) => {
        const m = 69 + 12 * Math.log2(freqHz / 440);
        const base = Math.round(m);
        this.hqPost({ t: "glide", id, midi: base, cents: (m - base) * 100, glide: glideT, at: t });
        voice.freq = freqHz;
      },
      update: () => {}
    };
    return voice;
  }

  private startVoice(midi: number, vel: number, at = 0, fromHz = 0, glide = 0): SynthVoice | null {
    if (!this.ctx || !this.bus) return null;
    if (this.useHQ()) {
      return this.createTrackHQVoice(midi, this.centsFor(midi), vel, at, fromHz, glide);
    }
    const routing: VoiceRoutingOptions = {
      busInput: this.bus.input,
      voicePool: this.classicVoices,
      getPitchBend: () => this.pitchBend,
      getModWheel: () => this.modWheel
    };
    const startAt = at > 0 ? Math.max(at, this.ctx.currentTime) : this.ctx.currentTime;
    return createSynthVoice(this.ctx, this.freqFor(midi), startAt, this.patch, vel, fromHz, glide, routing);
  }

  private retuneActiveVoices(): void {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    this.heldVoices.forEach((v, m) => {
      if (!v.isReleased() && v.retune) v.retune(this.freqFor(m), 0.005, now);
    });
    if (this.monoVoice && !this.monoVoice.isReleased() && this.monoMidi >= 0 && this.monoVoice.retune) {
      const hz = this.freqFor(this.monoMidi);
      this.monoVoice.retune(hz, 0.005, now);
      this.lastMonoHz = hz;
    }
  }

  noteOn(midi: number, velocity = 0.85, at = 0): void {
    const m = Math.max(0, Math.min(127, Math.round(midi)));
    const vel = Math.max(0.01, Math.min(1, Number(velocity) || 0.85));
    const releaseAt = at > 0 ? at : this.ctx ? this.ctx.currentTime : 0;

    this.physicallyHeld.add(m);
    this.sustainedNotes.delete(m);
    this.heldVelocities.set(m, vel);

    if (this.patch.polyMode === "mono") {
      const idx = this.monoStack.indexOf(m);
      if (idx >= 0) this.monoStack.splice(idx, 1);
      this.monoStack.push(m);

      const hz = this.freqFor(m);
      const glide = Number(this.patch.glide) || 0;
      const wasSounding = this.monoVoice !== null && !this.monoVoice.isReleased();

      if (wasSounding && this.patch.legato === "on" && this.monoVoice!.retune) {
        this.monoVoice!.retune(hz, Math.max(0.003, glide), releaseAt);
      } else {
        if (this.monoVoice && !this.monoVoice.isReleased()) {
          this.monoVoice.release(releaseAt, 0.01);
        }
        const fromHz = glide > 0.004 && this.lastMonoHz > 0 ? this.lastMonoHz : 0;
        this.monoVoice = this.startVoice(m, vel, at, fromHz, glide);
      }
      this.monoMidi = m;
      this.lastMonoHz = hz;
      return;
    }

    const old = this.heldVoices.get(m);
    if (old && !old.isReleased()) {
      old.release(releaseAt, 0.01);
    }
    const v = this.startVoice(m, vel, at);
    if (v) this.heldVoices.set(m, v);
  }

  noteOff(midi: number, at = 0): void {
    const m = Math.max(0, Math.min(127, Math.round(midi)));
    const releaseAt = at > 0 ? at : this.ctx ? this.ctx.currentTime : 0;
    this.physicallyHeld.delete(m);

    if (this.patch.polyMode === "mono") {
      const idx = this.monoStack.indexOf(m);
      if (idx >= 0) this.monoStack.splice(idx, 1);

      if (this.holding()) {
        this.sustainedNotes.add(m);
        return;
      }

      if (this.monoStack.length === 0) {
        if (this.monoVoice && !this.monoVoice.isReleased()) {
          this.monoVoice.release(releaseAt);
        }
        this.monoVoice = null;
        this.monoMidi = -1;
      } else if (this.monoMidi === m) {
        const top = this.monoStack[this.monoStack.length - 1];
        const hz = this.freqFor(top);
        const glide = Number(this.patch.glide) || 0;
        if (this.monoVoice && !this.monoVoice.isReleased() && this.patch.legato === "on" && this.monoVoice.retune) {
          this.monoVoice.retune(hz, Math.max(0.003, glide), releaseAt);
        } else {
          if (this.monoVoice && !this.monoVoice.isReleased()) {
            this.monoVoice.release(releaseAt, 0.01);
          }
          const topVel = this.heldVelocities.get(top) ?? 0.85;
          this.monoVoice = this.startVoice(top, topVel, at, glide > 0.004 ? this.lastMonoHz : 0, glide);
        }
        this.monoMidi = top;
        this.lastMonoHz = hz;
      }
      this.heldVelocities.delete(m);
      return;
    }

    if (this.holding()) {
      if (this.heldVoices.has(m)) this.sustainedNotes.add(m);
      return;
    }

    const v = this.heldVoices.get(m);
    if (v) {
      this.heldVoices.delete(m);
      if (!v.isReleased()) v.release(releaseAt);
    }
    this.heldVelocities.delete(m);
  }

  private releaseSustained(at = 0): void {
    if (this.holding()) return;
    const releaseAt = at > 0 ? at : this.ctx ? this.ctx.currentTime : 0;

    this.sustainedNotes.forEach((m) => {
      if (!this.physicallyHeld.has(m)) {
        this.heldVelocities.delete(m);
        if (this.patch.polyMode !== "mono") {
          const v = this.heldVoices.get(m);
          if (v) {
            this.heldVoices.delete(m);
            if (!v.isReleased()) v.release(releaseAt);
          }
        }
      }
    });
    this.sustainedNotes.clear();

    if (this.patch.polyMode === "mono") {
      if (this.monoStack.length === 0) {
        if (this.monoVoice && !this.monoVoice.isReleased()) this.monoVoice.release(releaseAt);
        this.monoVoice = null;
        this.monoMidi = -1;
      } else {
        const top = this.monoStack[this.monoStack.length - 1];
        if (this.monoMidi !== top) {
          const hz = this.freqFor(top);
          const glide = Number(this.patch.glide) || 0;
          if (this.monoVoice && !this.monoVoice.isReleased() && this.patch.legato === "on" && this.monoVoice.retune) {
            this.monoVoice.retune(hz, Math.max(0.003, glide), releaseAt);
          } else {
            if (this.monoVoice && !this.monoVoice.isReleased()) this.monoVoice.release(releaseAt, 0.01);
            this.monoVoice = this.startVoice(top, this.heldVelocities.get(top) ?? 0.85, at, glide > 0.004 ? this.lastMonoHz : 0, glide);
          }
          this.monoMidi = top;
          this.lastMonoHz = hz;
        }
      }
    }
  }

  /** Cleanly release all active notes on this track (e.g. Stop, Panic, preset switch). */
  allNotesOff(at = 0): void {
    const releaseAt = at > 0 ? at : this.ctx ? this.ctx.currentTime : 0;
    this.sustainPedal = false;
    this.physicallyHeld.clear();
    this.sustainedNotes.clear();
    this.heldVelocities.clear();
    this.monoStack.length = 0;

    this.heldVoices.forEach((v) => {
      if (!v.isReleased()) v.release(releaseAt);
    });
    this.heldVoices.clear();

    if (this.monoVoice && !this.monoVoice.isReleased()) {
      this.monoVoice.release(releaseAt);
    }
    this.monoVoice = null;
    this.monoMidi = -1;

    if (at === 0) {
      this.classicVoices.forEach((v) => v.kill());
      this.hqPost({ t: "alloff" });
    }
  }

  isNoteSounding(midi: number): boolean {
    if (this.patch.polyMode === "mono") {
      if (this.holding() && (this.sustainedNotes.has(midi) || this.physicallyHeld.has(midi))) return true;
      return this.monoVoice !== null && !this.monoVoice.isReleased() && this.monoMidi === midi;
    }
    const v = this.heldVoices.get(midi);
    return !!v && !v.isReleased();
  }

  getActiveVoiceCount(): number {
    if (this.patch.polyMode === "mono") {
      return this.monoVoice && !this.monoVoice.isReleased() ? 1 : 0;
    }
    let c = 0;
    this.heldVoices.forEach((v) => {
      if (!v.isReleased()) c++;
    });
    return c;
  }

  // ------------------------------------------------------------------ clip ----
  addEvent(ev: StudioMidiEvent): void {
    const n = this.events.length;
    if (n > 0 && compareStudioEvents(this.events[n - 1], ev) > 0) {
      this.eventsDirty = true;
    }
    this.events.push(ev);
    if (this.cachedNoteCount !== null && this.cachedEventsLen === n) {
      if (ev.type === "noteOn") this.cachedNoteCount++;
      this.cachedEventsLen = n + 1;
    } else {
      this.cachedNoteCount = null;
    }
    this.emitChange();
  }

  setEvents(events: StudioMidiEvent[]): void {
    this.events = events.map((e) => ({ ...e }));
    this.eventsDirty = this.events.length > 1;
    this.cachedNoteCount = null;
    this.emitChange();
  }

  clearEvents(): void {
    this.events = [];
    this.eventsDirty = false;
    this.cachedNoteCount = 0;
    this.cachedEventsLen = 0;
    this.emitChange();
  }

  ensureEventsSorted(): void {
    if (!this.eventsDirty) return;
    this.events.sort(compareStudioEvents);
    this.eventsDirty = false;
  }

  /**
   * Zero-allocation O(log N + K) range query for events strictly inside [startTick, endTick).
   * Eliminates per-tick linear scans, array allocations and re-sorts in the 25 ms scheduler.
   */
  forEachEventInRange(startTick: number, endTick: number, cb: (ev: StudioMidiEvent) => void): void {
    const evs = this.events;
    const len = evs.length;
    if (len === 0 || endTick <= startTick) return;
    if (this.eventsDirty) {
      evs.sort(compareStudioEvents);
      this.eventsDirty = false;
    }
    // Lower bound: first index with evs[i].tick >= startTick
    let lo = 0;
    let hi = len;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (evs[mid].tick < startTick) lo = mid + 1;
      else hi = mid;
    }
    for (let i = lo; i < len; i++) {
      const ev = evs[i];
      if (ev.tick >= endTick) break;
      cb(ev);
    }
  }

  getNoteCount(): number {
    if (this.cachedNoteCount !== null && this.cachedEventsLen === this.events.length) {
      return this.cachedNoteCount;
    }
    let n = 0;
    for (let i = 0; i < this.events.length; i++) {
      if (this.events[i].type === "noteOn") n++;
    }
    this.cachedNoteCount = n;
    this.cachedEventsLen = this.events.length;
    return n;
  }

  getNoteSpans(fallbackEndTick: number): StudioNoteSpan[] {
    return extractNoteSpans(this.events, fallbackEndTick);
  }

  getSnapshot(): StudioTrackSnapshot {
    return {
      id: this.id,
      name: this.name,
      presetId: this.presetId,
      presetName: this.presetName,
      volume: this.volume,
      pan: this.pan,
      mute: this.mute,
      solo: this.solo,
      audible: this.audible,
      armed: this.armed,
      midiChannel: this.midiChannel,
      noteCount: this.getNoteCount(),
      eventCount: this.events.length,
      audioState: this.audioState,
      patch: { ...this.patch }
    };
  }

  detachAudio(): void {
    this.allNotesOff(0);
    if (this.hqNode) {
      try { this.hqNode.port.onmessage = null; } catch (e) {}
      try { this.hqNode.disconnect(); } catch (e) {}
      this.hqNode = null;
    }
    this.classicVoices.clear();
    if (this.bus) {
      disposeSynthBus(this.bus);
      this.bus = null;
    }
    try { this.fader?.disconnect(); } catch (e) {}
    try { this.panner?.disconnect(); } catch (e) {}
    try { this.muteGate?.disconnect(); } catch (e) {}
    this.fader = null;
    this.panner = null;
    this.muteGate = null;
    this.ctx = null;
    this.attachPromise = null;
    this.audioState = "idle";
  }

  /** Fully dispose audio graph, state listeners, and retained clip buffers. */
  dispose(): void {
    this.detachAudio();
    this.listeners.clear();
    this.events.length = 0;
    this.eventsDirty = false;
    this.cachedNoteCount = 0;
    this.cachedEventsLen = 0;
  }
}
