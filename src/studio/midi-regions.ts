import { extractNoteSpans } from "./midi-io";
import { STUDIO_TICKS_PER_BAR, type StudioMidiEvent, type StudioNoteSpan } from "./types";

export const MAX_REGION_EVENTS = 100_000;
export const MAX_REGIONS_PER_TRACK = 512;

export interface MidiRegion {
  id: string;
  trackId: string;
  startTick: number;
  length: number;
  sourceLength: number;
  offset: number;
  loop: boolean;
  events: StudioMidiEvent[];
}

export function cloneRegion(region: MidiRegion): MidiRegion {
  return { ...region, events: region.events.map(event => ({ ...event })) };
}

export function regionId(): string {
  if (globalThis.crypto.randomUUID) return globalThis.crypto.randomUUID();
  return Array.from(globalThis.crypto.getRandomValues(new Uint32Array(4)), n => n.toString(16).padStart(8, "0")).join("-");
}

export function snapRegionTick(tick: number, grid: number): number {
  return grid > 0 ? Math.round(tick / grid) * grid : Math.round(tick);
}

export function regionFromEvents(trackId: string, id: string, events: StudioMidiEvent[], total: number): MidiRegion {
  let first = total, last = 0;
  for (const event of events) {
    first = Math.min(first, event.tick);
    last = Math.max(last, event.tick + (event.type === "noteOff" ? 0 : 1));
  }
  const startTick = events.length ? Math.floor(first / STUDIO_TICKS_PER_BAR) * STUDIO_TICKS_PER_BAR : 0;
  const length = Math.max(STUDIO_TICKS_PER_BAR, Math.ceil((last - startTick) / STUDIO_TICKS_PER_BAR) * STUDIO_TICKS_PER_BAR);
  return { id, trackId, startTick, length, sourceLength: length, offset: 0, loop: false,
    events: events.map(event => ({ ...event, tick: event.tick - startTick })) };
}

export function noteEvents(spans: readonly StudioNoteSpan[]): StudioMidiEvent[] {
  return spans.flatMap(note => [
    { type: "noteOn", tick: note.startTick, midi: note.midi, velocity: note.velocity },
    { type: "noteOff", tick: note.endTick, midi: note.midi }
  ]);
}

function isController(event: StudioMidiEvent): event is Exclude<StudioMidiEvent, {type: "noteOn" | "noteOff"}> {
  return event.type === "cc" || event.type === "pitchBend";
}

/** Materialize one visible region; its immutable source coordinates survive trims and splits. */
export function regionPlayback(region: MidiRegion): StudioMidiEvent[] {
  if (!region.loop && region.offset === 0 && region.length >= region.sourceLength) {
    return region.events.map(event => ({ ...event }));
  }
  if (!region.events.length) return [];
  const spans = extractNoteSpans(region.events, region.sourceLength);
  const controllers = region.events.filter(isController).sort((a, b) => a.tick - b.tick);
  const output: StudioMidiEvent[] = [];
  const end = region.offset + region.length;
  const period = region.sourceLength;
  const firstCycle = region.loop ? Math.floor(region.offset / period) : 0;
  const lastCycle = region.loop ? Math.floor((end - 1) / period) : 0;
  if (lastCycle - firstCycle + 1 > MAX_REGION_EVENTS) throw new Error("Region loop is too short.");
  for (let cycle = firstCycle; cycle <= lastCycle; cycle++) {
    const base = cycle * period;
    const first = Math.max(0, region.offset - base);
    const last = Math.min(period, end - base);
    if (last <= first) continue;
    const shift = base - region.offset;
    for (const note of spans) {
      const startTick = Math.max(first, note.startTick);
      const endTick = Math.min(last, note.endTick);
      if (endTick <= startTick) continue;
      output.push(...noteEvents([{ ...note, startTick: startTick + shift, endTick: endTick + shift }]));
      if (output.length > MAX_REGION_EVENTS) throw new Error("Region exceeds the playback event limit.");
    }
    const carried = new Map<number, StudioMidiEvent>();
    let sustained = false;
    const inWindow: StudioMidiEvent[] = [];
    for (const event of controllers) {
      if (event.tick >= last) break;
      if (event.type === "cc" && event.cc === 64) sustained = event.value >= 64;
      if (event.tick < first) carried.set(event.type === "cc" ? event.cc : -1, event);
      else inWindow.push({ ...event, tick: event.tick + shift });
    }
    // Chase the source controller state at the audible left edge.
    for (const event of carried.values()) output.push({ ...event, tick: first + shift });
    for (const event of inWindow) output.push(event);
    if (sustained) output.push({ type: "cc", cc: 64, value: 0, tick: last + shift });
    if (output.length > MAX_REGION_EVENTS) throw new Error("Region exceeds the playback event limit.");
  }
  return output;
}

export function flattenRegions(regions: readonly MidiRegion[]): StudioMidiEvent[] {
  const output: StudioMidiEvent[] = [];
  for (const region of [...regions].sort((a, b) => a.startTick - b.startTick)) {
    for (const event of regionPlayback(region)) {
      output.push({ ...event, tick: event.tick + region.startTick });
      if (output.length > MAX_REGION_EVENTS) throw new Error("Track exceeds the playback event limit.");
    }
  }
  return output;
}

/** Replace visible note edits, retaining hidden notes and original controller data. */
export function replaceRegionNotes(region: MidiRegion, before: StudioNoteSpan[], after: StudioNoteSpan[]): MidiRegion {
  const original = extractNoteSpans(region.events, region.sourceLength);
  const signature = (span: StudioNoteSpan) => [span.midi, span.startTick, span.endTick, span.velocity].join(":");
  const unchanged = new Map<string, number>();
  for (const span of after) unchanged.set(signature(span), (unchanged.get(signature(span)) ?? 0) + 1);
  const removed = new Map<string, number>();
  for (const span of before) {
    const key = signature(span);
    const remaining = unchanged.get(key) ?? 0;
    if (remaining) unchanged.set(key, remaining - 1);
    else removed.set(key, (removed.get(key) ?? 0) + 1);
  }
  const visibleLength = region.loop ? Math.min(region.length, region.sourceLength - region.offset % region.sourceLength) : region.length;
  const offset = region.loop ? region.offset % region.sourceLength : region.offset;
  const kept = original.filter(span => {
    if (span.endTick <= offset || span.startTick >= offset + visibleLength) return true;
    const key = signature({ midi: span.midi, startTick: Math.max(span.startTick - offset, 0),
      endTick: Math.min(span.endTick - offset, visibleLength), velocity: span.velocity });
    const count = removed.get(key) ?? 0;
    if (!count) return true;
    removed.set(key, count - 1);
    return false;
  });
  for (const span of after) {
    const key = signature(span);
    const count = unchanged.get(key) ?? 0;
    if (!count) continue;
    unchanged.set(key, count - 1);
    kept.push({ ...span, startTick: span.startTick + offset, endTick: span.endTick + offset });
  }
  return { ...region, sourceLength: Math.max(region.sourceLength, offset + visibleLength),
    events: [...region.events.filter(isController), ...noteEvents(kept)] };
}

export function regionEditorLength(region: MidiRegion): number {
  return region.loop ? Math.min(region.length, region.sourceLength - region.offset % region.sourceLength) : region.length;
}

export function regionEditorNotes(region: MidiRegion): StudioNoteSpan[] {
  const length = regionEditorLength(region);
  return extractNoteSpans(regionPlayback({ ...region, length }), length);
}
