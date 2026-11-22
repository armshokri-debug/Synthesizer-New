import {
  cloneRegion, flattenRegions, regionFromEvents, MAX_REGIONS_PER_TRACK, MAX_REGION_EVENTS, regionEditorLength, regionEditorNotes,
  regionId, replaceRegionNotes, snapRegionTick, type MidiRegion
} from "./midi-regions";
import type { SY1TrackEngine } from "./track-engine";
import { STUDIO_TICKS_PER_BAR, type StudioNoteSpan } from "./types";

type Tracks = Map<string, MidiRegion[]>;
type History = { before: Tracks; after: Tracks; beforeSelection: string[]; afterSelection: string[] };

interface TimelineHost {
  tracks(): SY1TrackEngine[];
  length(): number;
  focus(trackId: string): void;
  commit(): void;
  recording(): boolean;
}

export class RegionEditor {
  private selected = new Set<string>();
  private history: History[] = [];
  private future: History[] = [];
  private clipboard: { region: MidiRegion; machineId: string }[] = [];
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
    this.host.commit();
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

  move(delta: number): void {
    const regions = this.selectedRegions();
    if (!regions.length) return;
    const first = Math.min(...regions.map(region => region.startTick));
    const last = Math.max(...regions.map(region => region.startTick + region.length));
    const shift = Math.max(-first, Math.min(Math.max(0, this.host.length() - last), snapRegionTick(first + delta, this.grid) - first));
    if (!shift) return;
    this.change(regions.map(region => ({ ...region, startTick: region.startTick + shift })));
  }

  resize(id: string, edge: "left" | "right" | "loop", tick: number): void {
    const region = this.all().find(item => item.id === id);
    if (!region) return;
    const end = region.startTick + region.length;
    const snapped = snapRegionTick(tick, this.grid);
    if (edge === "left") {
      const startTick = Math.max(0, region.startTick - region.offset, Math.min(end - 1, snapped));
      if (startTick === region.startTick) return;
      this.change([{ ...region, startTick, length: end - startTick, offset: region.offset + startTick - region.startTick }]);
    } else {
      const length = Math.max(1, Math.min(this.host.length(), snapped) - region.startTick);
      const loop = edge === "loop" || region.loop;
      if (length === region.length && loop === region.loop) return;
      this.change([{ ...region, length, loop }]);
    }
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
    const startTick = Math.max(0, Math.min(this.host.length() - 1, snapRegionTick(tick, this.grid)));
    const length = Math.min(STUDIO_TICKS_PER_BAR, this.host.length() - startTick);
    const region: MidiRegion = {
      id: regionId(), trackId, startTick, length, sourceLength: length, offset: 0, loop: false, events: []
    };
    this.edit(new Map([[trackId, [...this.regions(trackId), region]]]), [region.id]);
    this.host.focus(trackId);
  }

  copy(): void {
    const regions = this.selectedRegions();
    if (regions.length) this.clipboard = regions.map(region => ({ region: cloneRegion(region), machineId: this.track(region.trackId).machineId }));
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

  paste(trackId: string, tick: number): void {
    if (!this.clipboard.length) return;
    const machine = this.track(trackId).machineId;
    if (this.clipboard.some(item => item.machineId !== machine)) throw new Error("Paste onto a track with the same instrument.");
    this.insert(this.clipboard.map(item => ({ ...item.region, trackId })), snapRegionTick(tick, this.grid));
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
