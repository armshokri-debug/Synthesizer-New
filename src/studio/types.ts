/**
 * SY-1 Studio — Core Domain Types & Constants
 */

import type { SynthPatch } from "../engine/params";

export const STUDIO_PPQ = 480;
export const STUDIO_BEATS_PER_BAR = 4;
export const STUDIO_TICKS_PER_BAR = STUDIO_PPQ * STUDIO_BEATS_PER_BAR; // 1920
export const STUDIO_INITIAL_TRACKS = 2;
export const STUDIO_MAX_TRACKS = 4;
export const STUDIO_BAR_PRESETS = [8, 12, 64, 128] as const;
export const STUDIO_MIN_BARS = 1;
export const STUDIO_MAX_BARS = 512;

export const STUDIO_SNAP_OPTIONS = [
  { id: "off", label: "Off", ticks: 0 },
  { id: "1/4", label: "1/4", ticks: STUDIO_PPQ },
  { id: "1/8", label: "1/8", ticks: STUDIO_PPQ / 2 },
  { id: "1/16", label: "1/16", ticks: STUDIO_PPQ / 4 },
  { id: "1/32", label: "1/32", ticks: STUDIO_PPQ / 8 }
] as const;

export type StudioMidiEvent =
  | { type: "noteOn"; tick: number; midi: number; velocity: number }
  | { type: "noteOff"; tick: number; midi: number }
  | { type: "cc"; tick: number; cc: number; value: number }
  | { type: "pitchBend"; tick: number; value: number };

export interface StudioNoteSpan {
  midi: number;
  startTick: number;
  endTick: number;
  velocity: number;
}

export type TrackAudioState = "idle" | "hq" | "classic";

export interface StudioTrackSnapshot {
  id: string;
  name: string;
  machineId?: string;
  presetId: string;
  presetName: string;
  volume: number;
  pan: number;
  mute: boolean;
  solo: boolean;
  audible: boolean;
  armed: boolean;
  midiChannel: number; // 0 = All, 1..16
  noteCount: number;
  eventCount: number;
  audioState: TrackAudioState;
  patch: SynthPatch;
}

export const STUDIO_PROJECT_FORMAT = "sy1-studio-project" as const;
export const STUDIO_PROJECT_VERSION = 1 as const;
export const STUDIO_PROJECT_EXTENSION = ".sy1studio";

export interface StudioTake {
  wav: Blob;
  sampleRate: number;
  durationSec: number;
  frames: number;
  bpm: number;
  kind: "live" | "bounce" | "stem";
  createdAt: number;
}

export interface StudioStemTake extends StudioTake {
  kind: "stem";
  trackId: string;
  trackName: string;
  presetName: string;
  filename: string;
}

export interface StudioProjectTrackData {
  id: string;
  name: string;
  machineId?: string;
  presetId: string;
  presetName: string;
  patch: SynthPatch;
  volume: number;
  pan: number;
  mute: boolean;
  solo: boolean;
  armed: boolean;
  midiChannel: number;
  events: StudioMidiEvent[];
}

export interface StudioProjectData {
  format: typeof STUDIO_PROJECT_FORMAT;
  version: typeof STUDIO_PROJECT_VERSION;
  id: string;
  name: string;
  savedAt: number;
  bpm: number;
  bars: number;
  loopEnabled: boolean;
  loopStartBar: number;
  loopEndBar: number;
  focusedTrackId: string;
  recordingSettings?: { metronome: boolean; countIn: boolean; clickVolume: number };
  tracks: StudioProjectTrackData[];
}

export interface StudioSavedProjectMeta {
  id: string;
  name: string;
  savedAt: number;
  bpm: number;
  bars: number;
  trackCount: number;
  noteCount: number;
}

export type StorageErrorKind = "unavailable" | "quota" | "corrupt" | "io";

export interface StudioTransportSnapshot {
  projectId: string;
  projectName: string;
  playing: boolean;
  recording: boolean;
  loopEnabled: boolean;
  bars: number;
  loopStartBar: number; // 1-indexed inclusive
  loopEndBar: number;   // 1-indexed inclusive
  totalTicks: number;
  bpm: number;
  currentTick: number;
  currentBar: number;   // 1-indexed
  currentBeat: number;  // 1-indexed (1..4)
  focusedTrackId: string;
  maxLiveSeconds: number;
  liveRecSeconds: number;
  liveRecBytes: number;
  maxLiveBytes: number;
  liveRecWarning: string;
  hasLiveTake: boolean;
  liveTakeDurationSec: number;
}

export interface ParsedMidiTrack {
  name: string;
  channel: number;
  events: StudioMidiEvent[];
}

export interface ParsedMidiFile {
  format: number;
  trackCount: number;
  ppq: number;
  bpm: number;
  tracks: ParsedMidiTrack[];
}
