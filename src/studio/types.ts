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

export interface StudioTake {
  wav: Blob;
  sampleRate: number;
  durationSec: number;
  frames: number;
  bpm: number;
  kind: "live" | "bounce";
  createdAt: number;
}

export interface StudioTransportSnapshot {
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
