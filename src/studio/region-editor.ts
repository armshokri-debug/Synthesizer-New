import {
  cloneRegion, flattenRegions, regionFromEvents, MAX_REGIONS_PER_TRACK, MAX_REGION_EVENTS, regionEditorLength, regionEditorNotes,
  regionId, replaceRegionNotes, snapRegionTick, type MidiRegion
} from "./midi-regions";
import type { SY1TrackEngine } from "./track-engine";
import { STUDIO_TICKS_PER_BAR, type StudioNoteSpan, type StudioMidiEvent } from "./types";

type Tracks = Map<string, MidiRegion[]>;
type History = { before: Tracks; after: Tracks; beforeSelection: string[]; afterSelection: string[] };

interface TimelineHost {
  tracks(): SY1TrackEngine[];
  length(): number;
  focus(trackId: string): void;
  commit(trackIds: readonly string[]): void;
  recording(): boolean;
}

function clampGridStart(tick: number, grid: number, totalLength: number): number {
  const maxStart = grid > 0
    ? Math.max(0, Math.floor(Math.max(0, totalLength - 1) / grid) * grid)
    : Math.max(0, totalLength - 1);
  return Math.max(0, Math.min(maxStart, snapRegionTick(tick, grid)));
}

export function previewMoveRegions(
  regions: readonly Pick<MidiRegion, "startTick" | "length">[],
  delta: number,
  grid: number,
  totalLength: number
): { shift: number; guideTick: number } | null {
  if (!regions.length) return null;
  const first = Math.min(...regions.map(region => region.startTick));
  const last = Math.max(...regions.map(region => region.startTick + region.length));
  const targetFirst = clampGridStart(first + delta, grid, Math.max(1, totalLength - (last - first) + 1));
  const shift = Math.max(-first, Math.min(Math.max(0, totalLength - last), targetFirst - first));
  return { shift, guideTick: first + shift };
}

export function previewResizeRegion(
  region: Pick<MidiRegion, "startTick" | "length" | "offset" | "loop">,
  edge: "left" | "right" | "loop",
  tick: number,
  grid: number,
  totalLength: number
): { startTick: number; length: number; offset: number; loop: boolean; guideTick: number } {
  const end = region.startTick + region.length;
  const snapped = snapRegionTick(tick, grid);
  if (edge === "left") {
    const startTick = Math.max(0, region.startTick - region.offset, Math.min(end - 1, snapped));
    return {
      startTick,
      length: end - startTick,
      offset: region.offset + startTick - region.startTick,
      loop: region.loop,
      guideTick: startTick
    };
  }
  const snappedEnd = Math.max(region.startTick + 1, Math.min(totalLength, snapped));
  return {
    startTick: region.startTick,
    length: snappedEnd - region.startTick,
    offset: region.offset,
    loop: edge === "loop" || region.loop,
    guideTick: snappedEnd
  };
}

export class RegionEditor {
  private selected = new Set<string>();
  private history: History[] = [];
  private future: History[] = [];
  private clipboard: MidiRegion[] = [];
  grid = 120;

  constructor(private host: TimelineHost) {}

  private track(id: string): SY1TrackEngine {
    const track = this.host.tracks().find(item => item.id === id);
    if (!track) throw new Error("Track is unavailable.");
    return track;
  }

  regions(trackId: string): MidiRegion[] { return this.track(trackId).getRegions(this.host.length()); }
  selection(): string[] { return [...this.selected]; }
  has(id: string): boolean { return this.selected.has(id); }
  private all() { return this.host.tracks().flatMap(track => this.regions(track.id)); }
  selectedRegions() { return this.all().filter(region => this.selected.has(region.id)); }

  select(id: string, additive = false): void {
    const region = this.all().find(item => item.id === id);
    if (!region) return;
    if (!additive) this.selected.clear();
    if (additive && this.selected.has(id)) this.selected.delete(id);
    else this.selected.add(id);
    this.host.focus(region.trackId);
  }

  selectMany(ids: readonly string[], additive = false): void {
    const all = this.all(), valid = new Map(all.map(region => [region.id, region]));
    const selected = additive ? new Set(this.selected) : new Set<string>();
    for (const id of ids) if (valid.has(id)) selected.add(id);
    this.selected = selected;
    const primary = ids.at(-1);
    if (primary && valid.has(primary)) this.host.focus(valid.get(primary)!.trackId);
  }
  selectAll(trackId?: string): void {
    this.selectMany((trackId ? this.regions(trackId) : this.all()).map(r => r.id));
  }

  clearSelection(): void { this.selected.clear(); }
  reset(): void { this.clearSelection(); this.history = []; this.future = []; }
  registerTake(before: Tracks): void {
    if (!before.size) return;
    const after = new Map([...before.keys()].map(id => [id, this.regions(id)]));
    const selection = this.selection();
    this.remember({ before, after, beforeSelection: selection, afterSelection: selection });
  }

  private remember(entry: History): void {
    this.history.push(entry);
    if (this.history.length > 50) this.history.shift();
    this.future = [];
  }

  private assertEditable() {
    if (this.host.recording()) throw new Error("Stop recording before editing regions.");
  }

  private apply(tracks: Tracks, selection: string[]): void {
    this.assertEditable();
    const playback = [...tracks].map(([trackId, regions]) => {
      if (regions.length > MAX_REGIONS_PER_TRACK || regions.some(region => region.events.length > MAX_REGION_EVENTS) ||
          regions.reduce((n, region) => n + region.events.length, 0) > MAX_REGION_EVENTS) {
        throw new Error("Track exceeds the region or source event limit.");
      }
      return { track: this.track(trackId), regions, events: flattenRegions(regions) };
    });
    for (const {track, regions, events} of playback) track.setRegions(regions, events);
    this.selected = new Set(selection);
    this.host.commit(playback.map(({track}) => track.id));
  }

  private edit(after: Tracks, afterSelection = this.selection()): void {
    if (!after.size) return;
    const before = new Map([...after.keys()].map(id => [id, this.regions(id)]));
    const beforeSelection = this.selection();
    this.apply(after, afterSelection);
    this.remember({ before, after, beforeSelection, afterSelection });
  }

  undo(): void {
    const entry = this.history.at(-1);
    if (!entry) return;
    this.apply(entry.before, entry.beforeSelection);
    this.history.pop();
    this.future.push(entry);
  }

  redo(): void {
    const entry = this.future.at(-1);
    if (!entry) return;
    this.apply(entry.after, entry.afterSelection);
    this.future.pop();
    this.history.push(entry);
  }

  canUndo() { return this.history.length > 0; }
  canRedo() { return this.future.length > 0; }
  canPaste() { return this.clipboard.length > 0; }

  private change(regions: MidiRegion[]) {
    const tracks: Tracks = new Map();
    for (const region of regions) {
      const list = tracks.get(region.trackId) ?? this.regions(region.trackId);
      tracks.set(region.trackId, list.map(item => item.id === region.id ? region : item));
    }
    this.edit(tracks);
  }

  /** Move/copy a whole selection while retaining relative track and time offsets. */
  move(delta: number, trackDelta = 0, copy = false): void {
    this.assertEditable();
    const regions = this.selectedRegions();
    const preview = previewMoveRegions(regions, delta, delta===0?0:this.grid, this.host.length());
    if (!preview || (!preview.shift && !trackDelta && !copy)) return;
    const trackIds = this.host.tracks().map(track => track.id);
    const destinations = regions.map(region => trackIds[trackIds.indexOf(region.trackId) + trackDelta]);
    if (destinations.some(id => !id)) throw new Error("Selection cannot move outside the track list.");
    const affected = new Set([...regions.map(region => region.trackId), ...destinations]);
    const after: Tracks = new Map([...affected].map(id => [id, this.regions(id).filter(region => copy || !this.selected.has(region.id))]));
    const next = regions.map((region, i) => ({
      ...cloneRegion(region), id: copy ? regionId() : region.id,
      startTick: region.startTick + preview.shift, trackId: destinations[i]
    }));
    for (const region of next) after.get(region.trackId)!.push(region);
    this.edit(after, next.map(region => region.id));
    this.host.focus(next.at(-1)!.trackId);
  }

  resize(id: string, edge: "left" | "right" | "loop", tick: number): void {
    const region = this.all().find(item => item.id === id);
    if (!region) return;
    const next = previewResizeRegion(region, edge, tick, this.grid, this.host.length());
    if (next.startTick === region.startTick && next.length === region.length && next.loop === region.loop) return;
    this.change([{ ...region, startTick: next.startTick, length: next.length, offset: next.offset, loop: next.loop }]);
  }

  repeatToEnd(): void {
    this.change(this.selectedRegions().map(region => ({ ...region, loop: true, length: this.host.length() - region.startTick }))
      .filter(region => region.length > 0));
  }

  split(tick: number): void {
    const tracks: Tracks = new Map();
    const nextSelection = this.selection();
    for (const region of this.selectedRegions()) {
      const left = Math.round(tick) - region.startTick;
      if (left <= 0 || left >= region.length) continue;
      const right = { ...cloneRegion(region), id: regionId(), startTick: region.startTick + left,
        offset: region.offset + left, length: region.length - left };
      const list = tracks.get(region.trackId) ?? this.regions(region.trackId);
      tracks.set(region.trackId, list.flatMap(item => item.id === region.id ? [{ ...region, length: left }, right] : [item]));
      nextSelection.push(right.id);
    }
    this.edit(tracks, nextSelection);
  }

  merge(): void {
    const chosen = this.selectedRegions().sort((a, b) => a.startTick - b.startTick);
    if (chosen.length < 2 || chosen.some(region => region.trackId !== chosen[0].trackId)) throw new Error("Select two or more regions on one track.");
    const first = chosen[0];
    const last = chosen.at(-1)!;
    const sameSource = chosen.every((region, i) => region.loop === first.loop &&
      region.sourceLength === first.sourceLength && JSON.stringify(region.events) === JSON.stringify(first.events) &&
      region.offset - first.offset === region.startTick - first.startTick &&
      (!i || chosen[i - 1].startTick + chosen[i - 1].length === region.startTick));
    const length = last.startTick + last.length - first.startTick;
    let merged: MidiRegion;
    if (sameSource) merged = { ...first, length };
    else {
      const compatible = chosen.every((region, i) => !region.loop && region.offset === 0 && region.length >= region.sourceLength &&
        (!i || chosen[i - 1].startTick + chosen[i - 1].length <= region.startTick));
      if (!compatible) throw new Error("Merge needs non-overlapping complete regions or consecutive slices of the same source.");
      merged = { ...first, length, sourceLength: length, events: chosen.flatMap(region =>
        region.events.map(event => ({ ...event, tick: event.tick + region.startTick - first.startTick }))) };
    }
    this.edit(new Map([[first.trackId, [...this.regions(first.trackId).filter(region => !this.selected.has(region.id)), merged]]]), [merged.id]);
  }

  create(trackId: string, tick: number): void {
    const startTick = clampGridStart(tick, this.grid, this.host.length());
    const length = Math.min(STUDIO_TICKS_PER_BAR, this.host.length() - startTick);
    const region: MidiRegion = {
      id: regionId(), trackId, startTick, length, sourceLength: length, offset: 0, loop: false, events: []
    };
    this.edit(new Map([[trackId, [...this.regions(trackId), region]]]), [region.id]);
    this.host.focus(trackId);
  }

  insertPattern(trackId: string, tick: number, length: number, events: StudioMidiEvent[], nextFree = false): number {
    this.assertEditable();
    if (!Number.isInteger(length) || length < 1 || !events.length) throw new Error("Pattern contains no hits.");
    if (!Number.isFinite(tick) || events.some(e => !Number.isInteger(e.tick) || e.tick < 0 || e.tick > length || (e.type === "noteOn" && e.tick === length))) throw new Error("Invalid pattern timing.");
    let startTick = Math.max(0, snapRegionTick(tick, this.grid));
    const existing = this.regions(trackId);
    if (nextFree) {
      const grid = Math.max(1, this.grid);
      for (const region of [...existing].sort((a, b) => a.startTick - b.startTick)) {
        if (startTick + length <= region.startTick) break;
        const end = region.startTick + region.length;
        if (startTick < end) startTick = Math.ceil(end / grid) * grid;
      }
    }
    if (startTick + length > this.host.length()) throw new Error("Extend the arrangement before inserting this pattern.");
    if (existing.some(r => r.startTick < startTick + length && startTick < r.startTick + r.length)) throw new Error("Choose an empty position on this track before inserting the pattern.");
    const region: MidiRegion = {id:regionId(),trackId,startTick,length,sourceLength:length,offset:0,loop:false,events:events.map(e=>({...e}))};
    this.edit(new Map([[trackId,[...existing,region]]]),[region.id]);
    this.host.focus(trackId);
    return startTick;
  }

  copy(): void {
    const regions = this.selectedRegions();
    if (regions.length) this.clipboard = regions.map(cloneRegion);
  }

  remove(): void {
    const tracks: Tracks = new Map();
    for (const region of this.selectedRegions()) {
      if (!tracks.has(region.trackId)) tracks.set(region.trackId, this.regions(region.trackId).filter(item => !this.selected.has(item.id)));
    }
    this.edit(tracks, []);
  }

  clearTrack(trackId: string): void {
    const existing = this.regions(trackId);
    const track = this.track(trackId);
    if (existing.length === 0 && track.events.length === 0) return;
    const clearedIds = new Set(existing.map(region => region.id));
    const nextSelection = this.selection().filter(id => !clearedIds.has(id));
    this.edit(new Map([[trackId, []]]), nextSelection);
  }

  cut(): void { this.assertEditable(); this.copy(); this.remove(); }

  pasteInPlace(trackId: string): void {
    if (!this.clipboard.length) return;
    this.paste(trackId, Math.min(...this.clipboard.map(region => region.startTick)), true);
  }

  paste(trackId: string, tick: number, exact = false): void {
    if (!this.clipboard.length) return;
    // MIDI is instrument-independent; preserve pitch, velocity, controllers and source offsets.
    this.track(trackId);
    const first = Math.min(...this.clipboard.map(region => region.startTick));
    const maxEnd = Math.max(...this.clipboard.map(region => region.startTick + region.length));
    const span = Math.max(1, maxEnd - first);
    const targetStart = exact ? Math.max(0, Math.round(tick)) : clampGridStart(tick, this.grid, Math.max(1, this.host.length() - span + 1));
    this.insert(this.clipboard.map(region => ({ ...region, trackId })), targetStart);
    this.host.focus(trackId);
  }

  duplicate(): void {
    const regions = this.selectedRegions();
    if (regions.length) this.insert(regions, Math.max(...regions.map(region => region.startTick + region.length)));
  }

  private insert(regions: MidiRegion[], start: number): void {
    const first = Math.min(...regions.map(region => region.startTick));
    const tracks: Tracks = new Map();
    const ids: string[] = [];
    for (const source of regions) {
      const region = { ...cloneRegion(source), id: regionId(), startTick: Math.max(0, start) + source.startTick - first };
      if (region.startTick + region.length > this.host.length()) throw new Error("Extend the arrangement before inserting this region.");
      ids.push(region.id);
      const list = tracks.get(region.trackId) ?? this.regions(region.trackId);
      tracks.set(region.trackId, [...list, region]);
    }
    this.edit(tracks, ids);
  }

  current(trackId: string): MidiRegion | undefined {
    const regions = this.regions(trackId);
    for (const id of this.selection().reverse()) {
      const region = regions.find(item => item.id === id);
      if (region) return region;
    }
    return undefined;
  }

  editorLength(trackId: string): number {
    const region = this.current(trackId);
    return region ? regionEditorLength(region) : this.host.length();
  }

  editorNotes(trackId: string): StudioNoteSpan[] {
    const region = this.current(trackId);
    return region ? regionEditorNotes(region) : this.track(trackId).getNoteSpans(this.host.length());
  }

  editNotes(trackId: string, spans: StudioNoteSpan[]): void {
    const region = this.current(trackId);
    if (region) this.change([replaceRegionNotes(region, regionEditorNotes(region), spans)]);
    else if (this.regions(trackId).length > 1) throw new Error("Select a region before editing its notes.");
    else {
      const existing = this.regions(trackId)[0];
      // The legacy editor uses arrangement coordinates until the user opens a region.
      const controllers = this.track(trackId).events.filter(event => event.type === "cc" || event.type === "pitchBend");
      const events = [...controllers, ...spans.flatMap<import("./types").StudioMidiEvent>(note => [
        { type: "noteOn", tick: note.startTick, midi: note.midi, velocity: note.velocity },
        { type: "noteOff", tick: note.endTick, midi: note.midi }
      ])];
      if (existing && (existing.offset || existing.loop || existing.length < existing.sourceLength))
        throw new Error("Select the trimmed or looped region to edit its notes.");
      const next = events.length ? [regionFromEvents(trackId, existing?.id ?? regionId(), events, this.host.length())] : [];
      this.edit(new Map([[trackId, next]]));
    }
  }
}
