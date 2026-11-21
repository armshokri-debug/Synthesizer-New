/**
 * SY-1 Studio — Versioned Project Serialization, Export & Strict Validation (.sy1studio)
 *
 * Guarantees that corrupted, truncated, unsupported-version, or maliciously malformed
 * project files are rejected completely BEFORE any live engine state is touched.
 */

import { PARAM_CHOICES, SYNTH_PARAMS, SynthPatch, synthDefaults } from "../engine/params";
import { SY1 } from "../machines/sy1";
import {
  STUDIO_MAX_BARS,
  STUDIO_MAX_TRACKS,
  STUDIO_MIN_BARS,
  STUDIO_PROJECT_EXTENSION,
  STUDIO_PROJECT_FORMAT,
  STUDIO_PROJECT_VERSION,
  StudioMidiEvent,
  StudioProjectData,
  StudioProjectTrackData,
  StudioSavedProjectMeta
} from "./types";

export const STUDIO_MAX_EVENTS_PER_TRACK = 100_000;
export const STUDIO_MAX_IMPORT_BYTES = 16 * 1024 * 1024; // 16 MB safety limit

export type ProjectValidationResult =
  | { ok: true; project: StudioProjectData; warnings: string[] }
  | { ok: false; error: string };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function sanitizeProjectName(name: unknown): string {
  const s = typeof name === "string" ? name.trim().replace(/[\r\n\t]+/g, " ") : "";
  return (s || "Untitled Project").slice(0, 80);
}

export function slugifyFilename(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || "sy1-studio-project";
}

function validateAndSanitizePatch(rawPatch: unknown, warnings: string[], trackLabel: string): SynthPatch | null {
  if (!isPlainObject(rawPatch)) return null;
  const base: SynthPatch = Object.assign(synthDefaults(), SY1.base);
  const out: SynthPatch = { ...base };

  for (const key of Object.keys(SYNTH_PARAMS)) {
    if (!(key in rawPatch)) continue;
    const def = SYNTH_PARAMS[key];
    const val = rawPatch[key];

    if (def.type) {
      const choices = PARAM_CHOICES[def.type];
      if (typeof val === "string" && choices && choices.includes(val)) {
        out[key] = val;
      } else {
        warnings.push(`${trackLabel}: reset invalid enum "${key}" to default`);
      }
    } else {
      const num = Number(val);
      if (!Number.isFinite(num)) {
        warnings.push(`${trackLabel}: reset non-numeric "${key}" to default`);
        continue;
      }
      let clamped = Math.max(def.min!, Math.min(def.max!, num));
      if (def.step) clamped = Math.round(clamped / def.step) * def.step;
      out[key] = clamped;
    }
  }

  // Never restore latched keyboard hold from a saved project
  out.hold = "off";
  return out;
}

function validateMidiEvent(raw: unknown, idx: number, trackLabel: string): StudioMidiEvent | string {
  if (!isPlainObject(raw)) {
    return `${trackLabel}: event #${idx} is not an object`;
  }
  const type = raw.type;
  const tick = Number(raw.tick);
  if (!Number.isFinite(tick) || tick < 0 || tick > 1e9) {
    return `${trackLabel}: event #${idx} has invalid tick`;
  }
  const safeTick = Math.round(tick);

  if (type === "noteOn") {
    const midi = Number(raw.midi);
    const vel = Number(raw.velocity);
    if (!Number.isInteger(midi) || midi < 0 || midi > 127) {
      return `${trackLabel}: event #${idx} noteOn has invalid midi pitch`;
    }
    if (!Number.isFinite(vel) || vel < 0 || vel > 1) {
      return `${trackLabel}: event #${idx} noteOn has invalid velocity`;
    }
    return {
      type: "noteOn",
      tick: safeTick,
      midi,
      velocity: Math.max(0.01, Math.min(1, vel))
    };
  }

  if (type === "noteOff") {
    const midi = Number(raw.midi);
    if (!Number.isInteger(midi) || midi < 0 || midi > 127) {
      return `${trackLabel}: event #${idx} noteOff has invalid midi pitch`;
    }
    return { type: "noteOff", tick: safeTick, midi };
  }

  if (type === "cc") {
    const cc = Number(raw.cc);
    const value = Number(raw.value);
    if (!Number.isInteger(cc) || cc < 0 || cc > 127) {
      return `${trackLabel}: event #${idx} cc has invalid controller number`;
    }
    if (!Number.isFinite(value) || value < 0 || value > 127) {
      return `${trackLabel}: event #${idx} cc has invalid value`;
    }
    return { type: "cc", tick: safeTick, cc, value: Math.round(value) };
  }

  if (type === "pitchBend") {
    const value = Number(raw.value);
    if (!Number.isFinite(value) || value < -1.01 || value > 1.01) {
      return `${trackLabel}: event #${idx} pitchBend has invalid value`;
    }
    return { type: "pitchBend", tick: safeTick, value: Math.max(-1, Math.min(1, value)) };
  }

  return `${trackLabel}: event #${idx} has unknown type "${String(type)}"`;
}

/**
 * Strictly validate an untrusted project object before applying it to SY1StudioEngine.
 */
export function validateStudioProject(raw: unknown): ProjectValidationResult {
  if (!isPlainObject(raw)) {
    return { ok: false, error: "Invalid project file: root must be a JSON object." };
  }

  if (raw.format !== STUDIO_PROJECT_FORMAT) {
    return {
      ok: false,
      error: `Unrecognized project format "${String(raw.format ?? "")}". Expected "${STUDIO_PROJECT_FORMAT}".`
    };
  }

  const version = Number(raw.version);
  if (!Number.isInteger(version) || version < 1) {
    return { ok: false, error: "Invalid project version." };
  }
  if (version > STUDIO_PROJECT_VERSION) {
    return {
      ok: false,
      error: `Project version ${version} is newer than supported version ${STUDIO_PROJECT_VERSION}.`
    };
  }

  const bpm = Number(raw.bpm);
  if (!Number.isFinite(bpm) || bpm < 40 || bpm > 240) {
    return { ok: false, error: "Invalid BPM: must be between 40 and 240." };
  }

  const bars = Number(raw.bars);
  if (!Number.isInteger(bars) || bars < STUDIO_MIN_BARS || bars > STUDIO_MAX_BARS) {
    return {
      ok: false,
      error: `Invalid bar length: must be an integer between ${STUDIO_MIN_BARS} and ${STUDIO_MAX_BARS}.`
    };
  }

  if (!Array.isArray(raw.tracks)) {
    return { ok: false, error: "Invalid project file: tracks must be an array." };
  }
  if (raw.tracks.length < 1 || raw.tracks.length > STUDIO_MAX_TRACKS) {
    return {
      ok: false,
      error: `Invalid track count (${raw.tracks.length}): must be between 1 and ${STUDIO_MAX_TRACKS}.`
    };
  }

  const warnings: string[] = [];
  const seenIds = new Set<string>();
  const tracks: StudioProjectTrackData[] = [];

  for (let i = 0; i < raw.tracks.length; i++) {
    const rt = raw.tracks[i];
    const label = `Track ${i + 1}`;
    if (!isPlainObject(rt)) {
      return { ok: false, error: `${label} is malformed.` };
    }

    const id = typeof rt.id === "string" && rt.id.trim() ? rt.id.trim().slice(0, 64) : "";
    if (!id) {
      return { ok: false, error: `${label} is missing a valid track id.` };
    }
    if (seenIds.has(id)) {
      return { ok: false, error: `Duplicate track id "${id}".` };
    }
    seenIds.add(id);

    const name = typeof rt.name === "string" && rt.name.trim() ? rt.name.trim().slice(0, 64) : `SY-1 Track ${i + 1}`;
    const presetId = typeof rt.presetId === "string" && rt.presetId.trim() ? rt.presetId.trim().slice(0, 64) : "custom";
    const matchedPreset = SY1.presets.find((p) => p.id === presetId);
    const presetName =
      typeof rt.presetName === "string" && rt.presetName.trim()
        ? rt.presetName.trim().slice(0, 64)
        : matchedPreset
          ? matchedPreset.name
          : "Custom";

    const patch = validateAndSanitizePatch(rt.patch, warnings, label);
    if (!patch) {
      return { ok: false, error: `${label} is missing a valid patch object.` };
    }

    const volume = Number(rt.volume);
    const pan = Number(rt.pan);
    const midiChannel = Number(rt.midiChannel ?? 0);
    if (!Number.isFinite(volume) || volume < 0 || volume > 1) {
      return { ok: false, error: `${label} has invalid volume.` };
    }
    if (!Number.isFinite(pan) || pan < -1 || pan > 1) {
      return { ok: false, error: `${label} has invalid pan.` };
    }
    if (!Number.isInteger(midiChannel) || midiChannel < 0 || midiChannel > 16) {
      return { ok: false, error: `${label} has invalid MIDI channel.` };
    }

    if (!Array.isArray(rt.events)) {
      return { ok: false, error: `${label} is missing a valid events array.` };
    }
    if (rt.events.length > STUDIO_MAX_EVENTS_PER_TRACK) {
      return {
        ok: false,
        error: `${label} exceeds maximum event count (${STUDIO_MAX_EVENTS_PER_TRACK}).`
      };
    }

    const events: StudioMidiEvent[] = [];
    for (let j = 0; j < rt.events.length; j++) {
      const ev = validateMidiEvent(rt.events[j], j, label);
      if (typeof ev === "string") {
        return { ok: false, error: ev };
      }
      events.push(ev);
    }

    tracks.push({
      id,
      name,
      presetId,
      presetName,
      patch,
      volume,
      pan,
      mute: Boolean(rt.mute),
      solo: Boolean(rt.solo),
      armed: Boolean(rt.armed),
      midiChannel,
      events
    });
  }

  const loopEnabled = raw.loopEnabled !== undefined ? Boolean(raw.loopEnabled) : true;
  const rawLoopStart = Number(raw.loopStartBar ?? 1);
  const rawLoopEnd = Number(raw.loopEndBar ?? bars);
  const loopStartBar = Number.isInteger(rawLoopStart)
    ? Math.max(1, Math.min(bars, rawLoopStart))
    : 1;
  const loopEndBar = Number.isInteger(rawLoopEnd)
    ? Math.max(loopStartBar, Math.min(bars, rawLoopEnd))
    : bars;

  const focusedTrackId =
    typeof raw.focusedTrackId === "string" && seenIds.has(raw.focusedTrackId)
      ? raw.focusedTrackId
      : tracks[0].id;

  const id =
    typeof raw.id === "string" && raw.id.trim()
      ? raw.id.trim().slice(0, 64)
      : `proj-${Date.now().toString(36)}`;
  const savedAt =
    Number.isFinite(Number(raw.savedAt)) && Number(raw.savedAt) > 0
      ? Number(raw.savedAt)
      : Date.now();

  return {
    ok: true,
    project: {
      format: STUDIO_PROJECT_FORMAT,
      version: STUDIO_PROJECT_VERSION,
      id,
      name: sanitizeProjectName(raw.name),
      savedAt,
      bpm: Math.round(bpm),
      bars,
      loopEnabled,
      loopStartBar,
      loopEndBar,
      focusedTrackId,
      tracks
    },
    warnings
  };
}

export function serializeStudioProject(project: StudioProjectData): string {
  return JSON.stringify(project, null, 2);
}

export function parseStudioProjectJson(text: string): ProjectValidationResult {
  if (typeof text !== "string" || text.trim().length === 0) {
    return { ok: false, error: "Project file is empty." };
  }
  if (text.length > STUDIO_MAX_IMPORT_BYTES) {
    return {
      ok: false,
      error: `Project file exceeds maximum size (${Math.round(STUDIO_MAX_IMPORT_BYTES / (1024 * 1024))} MB).`
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { ok: false, error: "Corrupted project file: invalid JSON syntax." };
  }
  return validateStudioProject(parsed);
}

export function createProjectBlob(project: StudioProjectData): Blob {
  return new Blob([serializeStudioProject(project)], { type: "application/json" });
}

export function projectFilename(project: StudioProjectData): string {
  return `${slugifyFilename(project.name)}${STUDIO_PROJECT_EXTENSION}`;
}

export function summarizeProjectMeta(project: StudioProjectData): StudioSavedProjectMeta {
  let noteCount = 0;
  for (const t of project.tracks) {
    for (const ev of t.events) {
      if (ev.type === "noteOn") noteCount++;
    }
  }
  return {
    id: project.id,
    name: project.name,
    savedAt: project.savedAt,
    bpm: project.bpm,
    bars: project.bars,
    trackCount: project.tracks.length,
    noteCount
  };
}
