import { STUDIO_DRUM_BANK_KEY, createTrackDrumBank, normalizeTrackDrumBank, type TrackDrumBank } from "./track-drum-patterns";
import { TrackArpeggiator, type ArpPulse } from "./track-arpeggiator";
import { STUDIO_TUNING_KEY, normalizeStudioTuning } from "./track-tuning";
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
import { createAnalogNode } from "../engine/analog";
import {
  createTrackDrumBus,
  disposeTrackDrumBus,
  DRUM_LABELS,
  DrumVoice,
  drumVoiceForNote,
  TrackDrumBus,
  type ScheduledDrumHit,
  triggerTrackDrum
} from "../engine/drums";
import { createFmNode } from "../engine/fm";
import { createHQNode, getEngine } from "../engine/hq";
import { SYNC_DIVS, SYNTH_PARAMS, SynthPatch, synthDefaults, tuningCents, getCustomTuning } from "../engine/params";
import { createStringsNode } from "../engine/strings";
import { computeOrbitRateHzForBpm, createVectorNode } from "../engine/vector";
import { createSynthVoice, SynthVoice, VoiceRoutingOptions } from "../engine/voice";
import { MACHINES } from "../machines";
import { SY1 } from "../machines/sy1";
import type { MachineDef } from "../machines/types";
import { extractNoteSpans } from "./midi-io";
import { StudioMidiEvent, StudioNoteSpan, StudioRecordingMode, StudioTrackSnapshot, TrackAudioState } from "./types";

import { flattenRegions, regionFromEvents, regionId, type MidiRegion } from "./midi-regions";
import {compileFiniteScore} from "./finite-audio-score";

export type TrackEngineKind = "hq" | "analog" | "strings" | "fm" | "vector" | "drums";

/** All 15 Iranian city synthesizers & drum machines supported natively per Studio track. */
export const STUDIO_MACHINES: readonly MachineDef[] = MACHINES;

/** All 11 synthesizers supported natively per Studio track. */
export const STUDIO_SYNTH_MACHINES: readonly MachineDef[] = MACHINES.filter((m) => m.kind === "synth");

/** All 4 drum machines supported natively per Studio track. */
export const STUDIO_DRUM_MACHINES: readonly MachineDef[] = MACHINES.filter((m) => m.kind === "drums");

export function getStudioMachineDef(machineId?: string): MachineDef {
  return STUDIO_MACHINES.find((m) => m.id === machineId) || SY1;
}

export function engineKindForMachine(m: MachineDef): TrackEngineKind {
  if (m.kind === "drums") return "drums";
  if (m.id === "tabriz") return "analog";
  if (m.id === "shiraz") return "strings";
  if (m.id === "kashan") return "fm";
  if (m.id === "nishapur") return "vector";
  return "hq";
}

export function getDrumLabelsForTrack(
  machineId: string,
  patch: SynthPatch,
  presetId?: string
): Record<DrumVoice, string> {
  const m = getStudioMachineDef(machineId);
  const labels: Record<DrumVoice, string> = { ...DRUM_LABELS, ...(m.drumLabels || {}) };
  if (m.kind === "drums" && m.kits && m.kits.length > 0) {
    let kit = m.kits.find((k) => presetId === `kit:${k.id}` || presetId === k.id);
    if (!kit && m.styles && presetId) {
      const style = m.styles.find((s) => s.id === presetId);
      if (style) kit = m.kits.find((k) => k.id === style.kit);
    }
    if (!kit && typeof patch.kitModel === "string" && patch.kitModel) {
      kit = m.kits.find((k) => k.patch.kitModel === patch.kitModel);
    }
    if (kit && kit.labels) {
      Object.assign(labels, kit.labels);
    }
  }
  return labels;
}

export function buildMachinePresetPatch(
  machineId: string,
  presetId: string
): { machineId: string; presetId: string; presetName: string; patch: SynthPatch } {
  const m = getStudioMachineDef(machineId);
  if (m.kind === "drums" && m.kits && presetId.startsWith("kit:")) {
    const kitId = presetId.slice(4);
    const kit = m.kits.find((k) => k.id === kitId);
    if (kit) {
      const patch: SynthPatch = Object.assign(synthDefaults(), m.base, kit.patch);
      patch.hold = "off";
      return {
        machineId: m.id,
        presetId: `kit:${kit.id}`,
        presetName: kit.name,
        patch
      };
    }
  }
  const preset = m.presets.find((p) => p.id === presetId) || m.presets[0];
  const patch: SynthPatch = Object.assign(synthDefaults(), m.base, preset ? preset.patch : {});
  patch.hold = "off";
  return {
    machineId: m.id,
    presetId: preset ? preset.id : "init",
    presetName: preset ? preset.name : "Init",
    patch
  };
}

export function buildSy1PresetPatch(presetId: string): { presetId: string; presetName: string; patch: SynthPatch } {
  const built = buildMachinePresetPatch("sy1", presetId);
  return {
    presetId: built.presetId,
    presetName: built.presetName,
    patch: built.patch
  };
}

function isOfflineCtx(ctx: BaseAudioContext): boolean {
  return typeof OfflineAudioContext !== "undefined" && ctx instanceof OfflineAudioContext;
}

function studioEventPriority(ev: StudioMidiEvent): number {
  if (ev.type === "noteOff") return 0;
  if (ev.type === "cc") return 1;
  if (ev.type === "pitchBend") return 2;
  return 3;
}

function compareStudioEvents(a: StudioMidiEvent, b: StudioMidiEvent): number {
  return a.tick - b.tick || studioEventPriority(a) - studioEventPriority(b);
}

export interface SY1TrackOptions {
  id: string;
  name: string;
  machineId?: string;
  presetId?: string;
  midiChannel?: number;
  volume?: number;
  pan?: number;
  forceHQ?: boolean;
}

export class SY1TrackEngine {
  readonly id: string;
  name: string;
  machineId: string;
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
  private regions: MidiRegion[] | null = null;
  private lastRecordedRegionId: string | null = null;
  private take: { regions: MidiRegion[]; events: StudioMidiEvent[]; id: string; mode: StudioRecordingMode } | null = null;

  private ctx: BaseAudioContext | null = null;
  private bus: SynthFXBus | null = null;
  private fader: GainNode | null = null;
  private panner: StereoPannerNode | null = null;
  private muteGate: GainNode | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private engineKind: TrackEngineKind = "hq";
  private engineSwapToken = 0;
  private drumBus: TrackDrumBus | null = null;
  private drumOpenHat: { node: GainNode | null } = { node: null };
  private drumTimers = new Set<ReturnType<typeof setTimeout>>();
  private attachPromise: Promise<void> | null = null;
  private audioState: TrackAudioState = "idle";
  private forceHQ: boolean;

  readonly liveArpeggiator = new TrackArpeggiator();
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
  private scoreGeneration = 0;
  private scorePrepared = 0;
  private scoreArmed = false;
  private nextScoreVoiceId = -1;
  private currentBpm = 110;
  private eventsDirty = false;
  private cachedNoteCount: number | null = 0;
  private cachedEventsLen = 0;
  private meterBuf: Float32Array | null = null;

  private listeners = new Set<() => void>();
  private changeRevision = 0;
  getChangeRevision():number {return this.changeRevision;}

  constructor(opts: SY1TrackOptions) {
    this.id = opts.id;
    this.name = opts.name;
    const built = buildMachinePresetPatch(opts.machineId || "sy1", opts.presetId || "init");
    this.machineId = built.machineId;
    this.engineKind = engineKindForMachine(getStudioMachineDef(this.machineId));
    this.presetId = built.presetId;
    this.presetName = built.presetName;
    this.patch = built.patch;
    this.ensureTrackTuning();
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
    this.changeRevision++;
    this.listeners.forEach((cb) => cb());
  }

  private teardownEngineNodes(): void {
    this.cancelFiniteScore();
    this.engineSwapToken++;
    this.drumTimers.forEach((tid) => clearTimeout(tid));
    this.drumTimers.clear();
    if (this.drumBus) {
      disposeTrackDrumBus(this.drumBus);
      this.drumBus = null;
    }
    this.drumOpenHat.node = null;
    if (this.workletNode) {
      try { this.workletNode.port.onmessage = null; } catch (e) {}
      try { this.workletNode.disconnect(); } catch (e) {}
      this.workletNode = null;
    }
    this.classicVoices.forEach((v) => v.kill());
    this.classicVoices.clear();
  }

  private mountActiveEngine(): Promise<void> {
    if (!this.ctx || !this.bus) return Promise.resolve();
    this.teardownEngineNodes();

    const ctx = this.ctx;
    const bus = this.bus;
    const token = this.engineSwapToken;
    const m = getStudioMachineDef(this.machineId);
    const kind = engineKindForMachine(m);
    this.engineKind = kind;

    // Drum machines route dry hits through bus.input and wet effects strictly via per-voice sends to bus.sendIn
    bus.mainToFx.gain.value = kind === "drums" ? 0 : 1;

    if (kind === "drums") {
      const glue = typeof this.patch.drumGlue === "number" ? this.patch.drumGlue : 0.35;
      this.drumBus = createTrackDrumBus(ctx, bus.input, glue);
      this.audioState = "hq";
      this.emitChange();
      return Promise.resolve();
    }

    this.audioState = "classic";
    let factory: Promise<AudioWorkletNode | null>;
    if (kind === "analog") factory = createAnalogNode(ctx, bus.input, this.patch);
    else if (kind === "strings") factory = createStringsNode(ctx, bus.input, this.patch);
    else if (kind === "fm") factory = createFmNode(ctx, bus.input, this.patch);
    else if (kind === "vector") factory = createVectorNode(ctx, bus.input, this.patch, this.currentBpm);
    else factory = createHQNode(ctx, bus.input, this.patch);

    return factory.then((node) => {
      if (this.ctx !== ctx || this.engineSwapToken !== token) {
        if (node) {
          try { node.port.onmessage = null; } catch (e) {}
          try { node.disconnect(); } catch (e) {}
        }
        return;
      }
      if (node) {
        this.workletNode = node;
        this.audioState = "hq";
        // Re-sync any parameter edits made while the worklet was loading
        if (kind === "vector") {
          node.port.postMessage({
            t: "patch",
            patch: { ...this.patch },
            orbitRateHz: computeOrbitRateHzForBpm(this.patch, this.currentBpm)
          });
        } else {
          node.port.postMessage({ t: "patch", patch: { ...this.patch } });
        }
        if (this.pitchBend !== 0) node.port.postMessage({ t: "bend", v: this.pitchBend });
        if (this.modWheel !== 0) node.port.postMessage({ t: "mod", v: this.modWheel });
        this.emitChange();
      }
    });
  }

  /** Attach this track to a shared AudioContext or OfflineAudioContext and connect to destination. */
  attachAudio(ctx: BaseAudioContext, destination: AudioNode): Promise<void> {
    if (this.ctx === ctx && this.bus) {
      return this.attachPromise || Promise.resolve();
    }
    this.detachAudio();
    this.ctx = ctx;

    const kind = engineKindForMachine(getStudioMachineDef(this.machineId));
    const bus = createSynthBus(ctx, this.patch, { connectToDestination: false, mainFxOn: kind !== "drums" });
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

    const p = this.mountActiveEngine();
    this.attachPromise = p;
    return p;
  }

  /** Wait until AudioWorklet / Drum engine initialization settles (if attached). */
  ready(): Promise<void> {
    return this.attachPromise || Promise.resolve();
  }

  isAudioAttached(): boolean {
    return this.ctx !== null && this.bus !== null;
  }

  getAudioState(): TrackAudioState {
    return this.audioState;
  }

  getEngineKind(): TrackEngineKind {
    return engineKindForMachine(getStudioMachineDef(this.machineId));
  }

  isDrumTrack(): boolean {
    return this.getEngineKind() === "drums";
  }

  /** Direct access to this track's FX bus (for diagnostics / testing). */
  getBus(): SynthFXBus | null {
    return this.bus;
  }

  private useWorklet(): boolean {
    if (!this.workletNode) return false;
    return this.forceHQ || getEngine() === "hq" || this.engineKind !== "hq";
  }

  /** Experimental fixed-tempo, finite, polyphonic HQ arrangement path. */
  canUseFiniteScore(): boolean {
    return !!this.workletNode && this.engineKind==="hq" && this.useWorklet() &&
      this.patch.polyMode!=="mono" && this.patch.hold!=="on" && !this.sustainPedal;
  }

  isFiniteScoreArmed(): boolean { return this.scoreArmed; }

  async prepareFiniteScore(startFrame:number,framesPerTick:number,totalTicks:number,repeat=false):Promise<boolean> {
    if(!this.canUseFiniteScore()||this.scorePrepared)return false;
    const node=this.workletNode!;
    this.ensureEventsSorted();
    const compiled=compileFiniteScore(this.events,startFrame,framesPerTick,totalTicks,m=>this.centsFor(m),this.nextScoreVoiceId);
    if(!compiled)return false;
    const gen=++this.scoreGeneration;
    this.nextScoreVoiceId=compiled.nextId;
    this.scorePrepared=gen;
    const accepted=await new Promise<boolean>(resolve=>{
      let timer:ReturnType<typeof setTimeout>;
      const done=(ok:boolean)=>{clearTimeout(timer);node.port.removeEventListener("message",listener);resolve(ok);};
      const listener=(ev:MessageEvent)=>{if(ev.data?.t==="score-ready"&&ev.data.generation===gen)done(!!ev.data.accepted);};
      timer=setTimeout(()=>done(false),120);
      node.port.addEventListener("message",listener);node.port.start();
      try{node.port.postMessage({t:"score-prepare",generation:gen,data:compiled.data,...(repeat?{repeat:{origin:startFrame,period:totalTicks*framesPerTick}}:{})},[compiled.data.buffer]);}
      catch{done(false);}
    });
    if(!accepted||this.workletNode!==node||this.scorePrepared!==gen||!this.canUseFiniteScore()){
      node.port.postMessage({t:"score-cancel",generation:gen});
      if(this.scorePrepared===gen)this.scorePrepared=0;
      return false;
    }
    return true;
  }

  armFiniteScore():boolean {
    if(!this.scorePrepared||!this.canUseFiniteScore())return false;
    this.workletPost({t:"score-arm",generation:this.scorePrepared});
    this.scoreArmed=true;return true;
  }

  cancelFiniteScore():void {
    if(this.scorePrepared)this.workletPost({t:"score-cancel",generation:this.scorePrepared});
    this.scorePrepared=0;this.scoreArmed=false;
  }

  private workletPost(msg: Record<string, unknown>): void {
    if (this.workletNode) this.workletNode.port.postMessage(msg);
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
    if (this.engineKind === "vector" && this.workletNode) {
      this.workletPost({ t: "param", key: "orbitRateHz", value: computeOrbitRateHzForBpm(this.patch, bpm) });
    }
  }

  applyMachinePreset(machineId: string, presetId: string): void {
    const m = getStudioMachineDef(machineId);
    const built = buildMachinePresetPatch(m.id, presetId);
    const prevKind = this.engineKind;
    const nextKind = engineKindForMachine(m);
    const preserveDrumBank = this.machineId === m.id && m.kind === "drums" && presetId.startsWith("kit:") ? this.getTrackDrumBank() : null;

    this.allNotesOff(0);

    const next = built.patch;
    if (preserveDrumBank) { next.drumSwing = this.patch.drumSwing; next.drumAccent = this.patch.drumAccent; }
    Object.keys(next).forEach((k) => {
      this.patch[k] = next[k];
      if (this.bus) applyBusParam(this.bus, k, next[k]);
    });
    const r = this.syncedLfoRate();
    if (r !== null) this.patch.lfoRate = r;

    if (this.machineId !== built.machineId) { delete this.patch[STUDIO_TUNING_KEY]; delete this.patch[STUDIO_DRUM_BANK_KEY]; }
    else if (m.kind === "drums" && !presetId.startsWith("kit:") && built.presetId !== this.presetId) delete this.patch[STUDIO_DRUM_BANK_KEY];
    this.machineId = built.machineId;
    if (preserveDrumBank) this.patch[STUDIO_DRUM_BANK_KEY] = preserveDrumBank;
    this.ensureTrackTuning();
    this.presetId = built.presetId;
    this.presetName = built.presetName;
    this.engineKind = nextKind;

    if (this.ctx && this.bus && prevKind !== nextKind) {
      this.attachPromise = this.mountActiveEngine();
    } else if (this.workletNode) {
      if (nextKind === "vector") {
        this.workletNode.port.postMessage({
          t: "patch",
          patch: { ...this.patch },
          orbitRateHz: computeOrbitRateHzForBpm(this.patch, this.currentBpm)
        });
      } else {
        this.workletNode.port.postMessage({ t: "patch", patch: { ...this.patch } });
      }
    }

    this.classicVoices.forEach((vc) => {
      Object.keys(this.patch).forEach((k) => vc.update(k));
    });
    this.emitChange();
  }

  applyPreset(presetId: string): void {
    const currentMachine = getStudioMachineDef(this.machineId);
    if (
      currentMachine.presets.some((p) => p.id === presetId) ||
      (currentMachine.kind === "drums" && presetId.startsWith("kit:") && currentMachine.kits?.some((k) => `kit:${k.id}` === presetId))
    ) {
      this.applyMachinePreset(currentMachine.id, presetId);
      return;
    }
    if (SY1.presets.some((p) => p.id === presetId)) {
      this.applyMachinePreset("sy1", presetId);
    }
  }

  /** Load an arbitrary patch snapshot (used for offline bounce clones & project restore). */
  loadPatchSnapshot(patch: SynthPatch, presetId: string, presetName: string, machineId?: string): void {
    // Snapshot replacement must release the previous instrument's held notes and
    // sustain latch, just like preset switching, before changing its engine.
    this.allNotesOff(0);
    const prevKind = this.engineKind;
    Object.keys(patch).forEach((k) => {
      this.patch[k] = patch[k];
      if (this.bus) applyBusParam(this.bus, k, patch[k]);
    });
    if (machineId) this.machineId = getStudioMachineDef(machineId).id;
    const savedTuning = normalizeStudioTuning(patch[STUDIO_TUNING_KEY]);
    delete this.patch[STUDIO_TUNING_KEY];
    if (savedTuning) this.patch[STUDIO_TUNING_KEY] = Object.freeze(savedTuning);
    this.ensureTrackTuning();
    const drumBank = normalizeTrackDrumBank(patch[STUDIO_DRUM_BANK_KEY]);
    delete this.patch[STUDIO_DRUM_BANK_KEY];
    if (drumBank && getStudioMachineDef(this.machineId).kind === "drums") this.patch[STUDIO_DRUM_BANK_KEY] = drumBank;
    const nextKind = engineKindForMachine(getStudioMachineDef(this.machineId));
    this.engineKind = nextKind;
    this.presetId = presetId;
    this.presetName = presetName;
    if (this.ctx && this.bus && prevKind !== nextKind) {
      this.attachPromise = this.mountActiveEngine();
    } else if (this.workletNode) {
      if (nextKind === "vector") {
        this.workletNode.port.postMessage({
          t: "patch",
          patch: { ...this.patch },
          orbitRateHz: computeOrbitRateHzForBpm(this.patch, this.currentBpm)
        });
      } else {
        this.workletNode.port.postMessage({ t: "patch", patch: { ...this.patch } });
      }
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
    if (key === "arpOn" && nextVal !== "on") this.liveArpeggiator.stop(true);
    if (key === "arpOn" && nextVal === "on") this.releaseSustained(0);
    if (key === "hold" && nextVal !== "on") this.liveArpeggiator.releaseLatched();
    if (key === "tuning") this.ensureTrackTuning();

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
    this.workletPost({ t: "param", key, value: this.patch[key] });
    if (this.engineKind === "vector" && (key === "orbitRate" || key === "orbitSync")) {
      this.workletPost({ t: "param", key: "orbitRateHz", value: computeOrbitRateHzForBpm(this.patch, this.currentBpm) });
    }

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
    if(this.audible!==audible)this.changeRevision++;
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
    this.workletPost({ t: "bend", v });
    this.classicVoices.forEach((vc) => vc.update("pitchBend"));
  }

  getPitchBend(): number {
    return this.pitchBend;
  }

  setModWheel(norm: number): void {
    const v = Math.max(0, Math.min(1, Number(norm) || 0));
    this.modWheel = v;
    this.workletPost({ t: "mod", v });
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

  private ensureTrackTuning(): void {
    if (this.patch.tuning === "custom" && !normalizeStudioTuning(this.patch[STUDIO_TUNING_KEY])) {
      this.patch[STUDIO_TUNING_KEY] = Object.freeze(getCustomTuning(this.machineId).slice());
    }
  }

  getTrackDrumBank(): TrackDrumBank {
    const m = getStudioMachineDef(this.machineId);
    const saved = normalizeTrackDrumBank(this.patch[STUDIO_DRUM_BANK_KEY]);
    if (saved) return saved;
    const preset = m.presets.find(p => p.id === this.presetId);
    return createTrackDrumBank(preset?.patterns);
  }

  setTrackDrumBank(bank: unknown): boolean {
    if (!this.isDrumTrack()) return false;
    const clean = normalizeTrackDrumBank(bank);
    if (!clean) return false;
    // Replace instead of mutating: history/export snapshots cannot alias edits.
    this.patch[STUDIO_DRUM_BANK_KEY] = clean;
    this.emitChange();
    return true;
  }

  getTrackCustomTuning(): number[] {
    return normalizeStudioTuning(this.patch[STUDIO_TUNING_KEY]) ?? getCustomTuning(this.machineId).slice();
  }

  setTrackCustomTuning(offsets: unknown): boolean {
    const clean = normalizeStudioTuning(offsets);
    if (!clean || this.isDrumTrack()) return false;
    this.patch[STUDIO_TUNING_KEY] = Object.freeze(clean);
    if (this.patch.tuning !== "custom") this.setParam("tuning", "custom");
    else { this.retuneActiveVoices(); this.emitChange(); }
    return true;
  }

  centsFor(midi: number): number {
    if (this.patch.oriental !== "on") return 0;
    if (this.patch.tuning === "custom") {
      const degree = ((midi - (Number(this.patch.tuneRoot) || 0)) % 12 + 12) % 12;
      return (this.patch[STUDIO_TUNING_KEY] ?? getCustomTuning(this.machineId))[degree] ?? 0;
    }
    return tuningCents(
      this.patch.tuning || "shur",
      midi,
      Number(this.patch.tuneRoot) || 0,
      this.machineId,
      Number(this.patch.scaleAlt) || 0,
      this.patch.microTone || "24tet"
    );
  }

  freqFor(midi: number): number {
    return 440 * Math.pow(2, (midi - 69) / 12 + this.centsFor(midi) / 1200);
  }

  private holding(): boolean {
    return this.sustainPedal || (this.patch.hold === "on" && this.patch.arpOn !== "on");
  }

  private createTrackWorkletVoice(midi: number, cents: number, velocity: number, at = 0, fromHz = 0, glide = 0): SynthVoice {
    const id = this.nextVoiceId++;
    this.workletPost({ t: "on", id, midi, cents, vel: velocity, at, from: fromHz, glide });
    let released = false;
    const voice: SynthVoice = {
      freq: 440 * Math.pow(2, (midi - 69) / 12 + cents / 1200),
      isReleased: () => released,
      kill: () => {
        if (released) return;
        released = true;
        this.workletPost({ t: "kill", id });
      },
      release: (t?: number, fastTau?: number) => {
        if (released) return;
        released = true;
        this.workletPost({ t: fastTau ? "kill" : "off", id, at: t || 0 });
      },
      retune: (freqHz: number, glideT: number, t: number) => {
        const m = 69 + 12 * Math.log2(freqHz / 440);
        const base = Math.round(m);
        this.workletPost({ t: "glide", id, midi: base, cents: (m - base) * 100, glide: glideT, at: t });
        voice.freq = freqHz;
      },
      update: () => {}
    };
    return voice;
  }

  private startVoice(midi: number, vel: number, at = 0, fromHz = 0, glide = 0): SynthVoice | null {
    if (!this.ctx || !this.bus) return null;
    if (this.useWorklet()) {
      return this.createTrackWorkletVoice(midi, this.centsFor(midi), vel, at, fromHz, glide);
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

  /** Editor-only audition: independent voice with an audio-clock note-off.
   * Never enters the live/transport pitch maps, mono stack, HOLD or sustain state.
   * A delayed editor release therefore cannot cut a later performance note.
   * Normal preset release envelopes and effects are intentionally preserved. */
  auditionNote(midi: number, velocity = 0.85, durationMs = 220): void {
    const m = Math.max(0, Math.min(127, Math.round(midi)));
    const vel = Math.max(1 / 127, Math.min(1, Number.isFinite(velocity) ? velocity : 0.85));
    if (!Number.isFinite(m) || !this.ctx || !this.bus) return;
    if (this.isDrumTrack()) {
      this.noteOn(m, vel); // percussion is a self-terminating one-shot
      return;
    }
    const start = this.ctx.currentTime + 0.005;
    const duration = Math.max(0.035, Math.min(0.8, (Number.isFinite(durationMs) ? durationMs : 220) / 1000));
    const voice = this.startVoice(m, vel, start);
    // Schedule release on the same voice ID, not on the MIDI pitch.
    voice?.release(start + duration);
  }

  /** Generated live ARP notes use independent gated voices, just like editor audition.
   * They never enter the transport pitch map or inherit the chord's latch/sustain. */
  playArpPulse(pulse: ArpPulse): void {
    if (this.isDrumTrack() || !this.ctx || !this.bus) return;
    this.startVoice(pulse.midi, pulse.velocity, pulse.at)?.release(pulse.off);
  }

  /** Studio-only adapter for cancelable future drum events. */
  scheduleDrumNote(midi: number, velocity: number, at: number): ScheduledDrumHit | undefined {
    let handle: ScheduledDrumHit | undefined;
    this.triggerDrumNote(midi, velocity, at, h => { handle = h; });
    return handle;
  }

  private triggerDrumNote(midi: number, vel: number, at: number, onScheduled?: (hit: ScheduledDrumHit) => void): void {
    const voice = drumVoiceForNote(midi);
    if (!this.isDrumTrack() || !voice || !this.ctx || !this.bus || !this.drumBus) return;
    const machine = getStudioMachineDef(this.machineId);
    triggerTrackDrum({
      ctx: this.ctx, dest: {main: this.bus.input, send: this.bus.sendIn},
      drumBus: this.drumBus, patch: this.patch, fallbackModel: machine.drumModel || "analog",
      openHatRef: this.drumOpenHat, voice, vel, at, timers: this.drumTimers, onScheduled
    });
  }

  noteOn(midi: number, velocity = 0.85, at = 0): void {
    const m = Math.max(0, Math.min(127, Math.round(midi)));
    const vel = Math.max(1 / 127, Math.min(1, Number(velocity) || 0.85));

    if (this.isDrumTrack()) {
      this.triggerDrumNote(m, vel, at);
      return;
    }

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
    if (this.isDrumTrack()) return;
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
    if(at===0)this.cancelFiniteScore();
    this.liveArpeggiator.stop();
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
      this.workletPost({ t: "alloff" });
    }
  }

  isNoteSounding(midi: number): boolean {
    if (this.liveArpeggiator.has(midi)) return true;
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
  cancelRegionPlayback(_destination?: AudioNode): void {
    this.allNotesOff();
    // Disconnect only the lightweight TrackDrumBus & timers (avoids tearing down the full SynthFXBus).
    if (this.isDrumTrack() && this.ctx && this.bus) {
      this.drumTimers.forEach((tid) => clearTimeout(tid));
      this.drumTimers.clear();
      this.drumOpenHat.node = null;
      disposeTrackDrumBus(this.drumBus);
      const glue = typeof this.patch.drumGlue === "number" ? this.patch.drumGlue : 0.35;
      this.drumBus = createTrackDrumBus(this.ctx, this.bus.input, glue);
    }
  }

  getRegions(total: number): MidiRegion[] {
    if (this.take) return this.regionsWithTake(total);
    return this.regions ?? (this.events.length ? [regionFromEvents(this.id, `${this.id}-legacy`, this.events, total)] : []);
  }

  setRegions(regions: MidiRegion[], playback = flattenRegions(regions)): void {
    this.setEvents(playback, true);
    this.regions = regions;
  }

  beginRegionTake(total: number, mode: StudioRecordingMode = "overdub"): void {
    this.take = { regions: this.getRegions(total), events: [], id: regionId(), mode };
  }

  private regionsWithTake(total: number): MidiRegion[] {
    const take = this.take;
    if (!take || !take.events.length) return take?.regions ?? this.regions ?? [];
    const recorded = regionFromEvents(this.id, take.id, take.events, total);
    if (take.mode === "replace") {
      return [recorded];
    }
    if (take.mode === "takes") {
      return [...take.regions, recorded];
    }
    // Overdub: preserve source boundaries of edited, split and looped regions during overdubs.
    const target = take.regions.find(region => !region.loop && region.offset === 0 &&
      region.length === region.sourceLength && recorded.startTick >= region.startTick &&
      recorded.startTick + recorded.length <= region.startTick + region.length);
    if (!target) return [...take.regions, recorded];
    const shift = recorded.startTick - target.startTick;
    return take.regions.map(region => region !== target ? region : {
      ...region, events: [...region.events, ...recorded.events.map(event => ({ ...event, tick: event.tick + shift }))]
    });
  }

  finishRegionTake(total: number): MidiRegion[] | undefined {
    if (!this.take) return;
    const mode = this.take.mode;
    const regions = this.regionsWithTake(total);
    const hasEvents = this.take.events.length > 0;
    const previous = this.take.regions;
    this.take = null;
    if (!hasEvents) return;
    const changed = regions.find(region => !previous.includes(region));
    // Replace rebuilds playback events cleanly from the replacement take; overdub/takes keep the live tick stream.
    if (mode === "replace") {
      this.setRegions(regions);
    } else {
      this.setRegions(regions, this.events);
    }
    this.lastRecordedRegionId = changed?.id ?? null;
    return previous;
  }

  latestRecordedRegion(total: number): MidiRegion | undefined {
    return this.getRegions(total).find(region => region.id === this.lastRecordedRegionId);
  }

  addEvent(ev: StudioMidiEvent): void {
    const n = this.events.length;
    if (n > 0 && compareStudioEvents(this.events[n - 1], ev) > 0) {
      this.eventsDirty = true;
    }
    this.events.push(ev);
    if (this.take) this.take.events.push(ev);
    else if (this.regions) {
      const region = this.regions.find(item => !item.loop && item.offset === 0 && item.sourceLength === item.length &&
        ev.tick >= item.startTick && (ev.tick < item.startTick + item.length ||
        (ev.type === "noteOff" && ev.tick === item.startTick + item.length)));
      this.regions = region
        ? this.regions.map(item => item === region ? { ...item, events: [...item.events, { ...ev, tick: ev.tick - item.startTick }] } : item)
        : [...this.regions, regionFromEvents(this.id, regionId(), [ev], ev.tick + 1)];
    }
    if (this.cachedNoteCount !== null && this.cachedEventsLen === n) {
      if (ev.type === "noteOn") this.cachedNoteCount++;
      this.cachedEventsLen = n + 1;
    } else {
      this.cachedNoteCount = null;
    }
    this.emitChange();
  }

  setEvents(events: StudioMidiEvent[], quiet = false): void {
    this.changeRevision++;
    this.regions = null;
    this.events = events.map((e) => ({ ...e }));
    this.eventsDirty = this.events.length > 1;
    this.cachedNoteCount = null;
    if (!quiet) this.emitChange();
  }

  clearEvents(): void {
    this.regions = null;
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

  /**
   * Replace all noteOn/noteOff pairs on this track from edited Piano Roll note spans
   * while preserving all non-note automation events (CC64 sustain, CC1 mod wheel, pitchBend).
   */
  replaceNoteSpans(spans: StudioNoteSpan[]): void {
    const nonNotes: StudioMidiEvent[] = [];
    for (let i = 0; i < this.events.length; i++) {
      const ev = this.events[i];
      if (ev.type !== "noteOn" && ev.type !== "noteOff") {
        nonNotes.push(ev);
      }
    }
    const next: StudioMidiEvent[] = nonNotes;
    for (let i = 0; i < spans.length; i++) {
      const s = spans[i];
      const midi = Math.max(0, Math.min(127, Math.round(s.midi)));
      const startTick = Math.max(0, Math.round(s.startTick));
      const endTick = Math.max(startTick + 1, Math.round(s.endTick));
      const velocity = Math.max(1 / 127, Math.min(1, Number.isFinite(s.velocity) ? s.velocity : 0.85));
      next.push({ type: "noteOn", tick: startTick, midi, velocity });
      next.push({ type: "noteOff", tick: endTick, midi });
    }
    next.sort(compareStudioEvents);
    this.regions = null;
    this.events = next;
    this.eventsDirty = false;
    this.cachedNoteCount = spans.length;
    this.cachedEventsLen = next.length;
    this.emitChange();
  }

  /** Add a single MIDI note span cleanly. */
  addNote(midi: number, startTick: number, durationTicks: number, velocity = 0.85, totalTicks = 1e9): void {
    const spans = this.getNoteSpans(totalTicks);
    const start = Math.max(0, Math.round(startTick));
    const end = Math.max(start + 1, Math.round(start + Math.max(30, durationTicks)));
    spans.push({
      midi: Math.max(0, Math.min(127, Math.round(midi))),
      startTick: start,
      endTick: end,
      velocity: Math.max(1 / 127, Math.min(1, velocity))
    });
    this.replaceNoteSpans(spans);
  }

  /** Quantize selected (or all) note start ticks to `gridTicks` while preserving durations & CCs. */
  quantizeNotes(gridTicks: number, totalTicks: number, selectedIndices?: Iterable<number>): number {
    const g = Math.max(1, Math.round(gridTicks));
    const spans = this.getNoteSpans(totalTicks);
    if (spans.length === 0) return 0;
    const selSet = selectedIndices ? (selectedIndices instanceof Set ? selectedIndices : new Set(selectedIndices)) : null;
    const useSel = !!selSet && selSet.size > 0;
    let moved = 0;
    const updated = spans.map((s, idx) => {
      if (useSel && !selSet!.has(idx)) return s;
      const dur = Math.max(1, s.endTick - s.startTick);
      const maxStart = Math.max(0, totalTicks - Math.min(g, dur));
      const snapped = Math.max(0, Math.min(maxStart, Math.round(s.startTick / g) * g));
      if (snapped !== s.startTick) moved++;
      return {
        ...s,
        startTick: snapped,
        endTick: Math.min(totalTicks, Math.max(snapped + 1, snapped + dur))
      };
    });
    this.replaceNoteSpans(updated);
    return moved;
  }

  /** Zero-allocation instantaneous output level meter (0..1) from this track's FX bus analyser. */
  readMeterLevel(): number {
    if (!this.bus || !this.audible || this.volume <= 0.001) return 0;
    const an = this.bus.analyser;
    if (!an || typeof an.getFloatTimeDomainData !== "function") return 0;
    const len = an.fftSize || 256;
    if (!this.meterBuf || this.meterBuf.length !== len) {
      this.meterBuf = new Float32Array(len);
    }
    an.getFloatTimeDomainData(this.meterBuf as any);
    let peak = 0;
    for (let i = 0; i < len; i++) {
      const a = Math.abs(this.meterBuf[i]);
      if (a > peak) peak = a;
    }
    return Math.min(1, peak * this.volume);
  }

  getSnapshot(): StudioTrackSnapshot {
    return {
      id: this.id,
      name: this.name,
      machineId: this.machineId,
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
    this.teardownEngineNodes();
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
