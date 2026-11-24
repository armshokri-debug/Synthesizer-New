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

function playbackSortPriority(event: StudioMidiEvent): number {
  if (event.type === "noteOff") return 0;
  if (event.type === "cc") return 1;
  if (event.type === "pitchBend") return 2;
  return 3;
}

/** Materialize one visible region; its immutable source coordinates survive trims and splits. */
export function regionPlayback(region: MidiRegion): StudioMidiEvent[] {
  if (!region.loop && region.offset === 0 && region.length >= region.sourceLength) {
    const out = region.events.map(event => ({ ...event }));
    if (!out.length) return out;
    // Close any genuinely dangling note or sustain pedal at the region boundary so it cannot bleed into a copied/following region.
    const openDepth = new Map<number, number>();
    let sustained = false;
    const ordered = out
      .map((event, order) => ({ event, order }))
      .sort((a, b) => a.event.tick - b.event.tick || playbackSortPriority(a.event) - playbackSortPriority(b.event) || a.order - b.order);
    for (const { event } of ordered) {
      if (event.type === "noteOn") {
        openDepth.set(event.midi, (openDepth.get(event.midi) ?? 0) + 1);
      } else if (event.type === "noteOff") {
        const d = openDepth.get(event.midi) ?? 0;
        if (d <= 1) openDepth.delete(event.midi);
        else openDepth.set(event.midi, d - 1);
      } else if (event.type === "cc" && event.cc === 64) {
        sustained = event.value >= 64;
      }
    }
    for (const midi of openDepth.keys()) {
      out.push({ type: "noteOff", tick: region.length, midi });
    }
    if (sustained) {
      out.push({ type: "cc", cc: 64, value: 0, tick: region.length });
    }
    return out;
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
  const raw: { event: StudioMidiEvent; order: number }[] = [];
  let order = 0;
  for (const region of [...regions].sort((a, b) => a.startTick - b.startTick)) {
    for (const event of regionPlayback(region)) {
      raw.push({ event: { ...event, tick: event.tick + region.startTick }, order: order++ });
      if (raw.length > MAX_REGION_EVENTS) throw new Error("Track exceeds the playback event limit.");
    }
  }
  if (raw.length <= 1) return raw.map(item => item.event);

  raw.sort(
    (a, b) =>
      a.event.tick - b.event.tick ||
      playbackSortPriority(a.event) - playbackSortPriority(b.event) ||
      a.order - b.order
  );

  // Normalize same-pitch overlaps and exact same-tick duplicate triggers across regions:
  // - Two identical (tick, midi) noteOns never double-fire a drum or synth voice.
  // - Overlapping same-pitch notes emit a clean noteOff at retrigger and suppress the superseded earlier noteOff.
  // - Duplicate identical controller events at the exact same tick are collapsed.
  const output: StudioMidiEvent[] = [];
  const openDepth = new Map<number, number>();
  const lastNoteOnTick = new Map<number, number>();
  const lastNoteOnOutIndex = new Map<number, number>();
  let lastCtrlTick = -1;
  const seenCtrlAtTick = new Set<string>();

  for (const { event } of raw) {
    if (event.tick !== lastCtrlTick) {
      lastCtrlTick = event.tick;
      seenCtrlAtTick.clear();
    }
    if (event.type === "noteOn") {
      const depth = openDepth.get(event.midi) ?? 0;
      if (depth > 0 && lastNoteOnTick.get(event.midi) === event.tick) {
        // Same-tick duplicate noteOn for the same pitch: keep one trigger so copied/overlapped regions never double-hit.
        const idx = lastNoteOnOutIndex.get(event.midi);
        if (idx !== undefined) {
          const prev = output[idx];
          if (prev && prev.type === "noteOn") {
            output[idx] = { ...prev, velocity: event.velocity };
          }
        }
        openDepth.set(event.midi, depth + 1);
        continue;
      }
      if (depth > 0) {
        // Cleanly release the still-sounding earlier note of the same pitch right before retriggering.
        output.push({ type: "noteOff", tick: event.tick, midi: event.midi });
      }
      openDepth.set(event.midi, depth + 1);
      lastNoteOnTick.set(event.midi, event.tick);
      lastNoteOnOutIndex.set(event.midi, output.length);
      output.push(event);
    } else if (event.type === "noteOff") {
      const depth = openDepth.get(event.midi) ?? 0;
      if (depth <= 0) continue;
      if (depth > 1) {
        // Earlier superseded note's noteOff: do not cut off the newer overlapping note early.
        openDepth.set(event.midi, depth - 1);
        continue;
      }
      openDepth.delete(event.midi);
      lastNoteOnTick.delete(event.midi);
      lastNoteOnOutIndex.delete(event.midi);
      output.push(event);
    } else {
      const key = event.type === "cc" ? `cc:${event.cc}:${event.value}` : `pb:${event.value}`;
      if (seenCtrlAtTick.has(key)) continue;
      seenCtrlAtTick.add(key);
      output.push(event);
    }
    if (output.length > MAX_REGION_EVENTS) throw new Error("Track exceeds the playback event limit.");
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
