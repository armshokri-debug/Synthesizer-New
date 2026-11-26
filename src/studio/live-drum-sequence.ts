import { drumPatternMidi } from "./track-drum-patterns";
import { STUDIO_PPQ } from "./types";
import type { SY1TrackEngine } from "./track-engine";
import type { DrumVoice } from "../engine/drums";

type Hit = { tick: number; midi: number; velocity: number; duration: number };
/** A musical cycle retains its origin and chance draws. Edits to the current
 * pattern affect only its undispatched portion; length/selection changes latch
 * at the next cycle boundary. No hit already dispatched is emitted twice. */
export class LiveDrumSequence {
  private cycleStart: number | null = null;
  private length = 0;
  private selected = -1;
  private signature = "";
  private hits: Hit[] = [];
  private index = 0;
  private chance = new Map<string,number>();
  constructor(private readonly random: () => number = Math.random) {}
  reset(): void {
    this.cycleStart = null; this.length = 0; this.index = 0;
    this.hits = []; this.signature = ""; this.chance.clear(); this.selected = -1;
  }
  private draw = (voice: DrumVoice, step: number): number => {
    const key=voice+":"+step;
    if(!this.chance.has(key)) this.chance.set(key,this.random());
    return this.chance.get(key)!;
  };
  private compile(track: SY1TrackEngine, bpm: number, from: number, fresh: boolean): void {
    const bank = track.getTrackDrumBank();
    const pattern = bank.patterns[bank.selected];
    if (!fresh && (bank.selected !== this.selected || pattern.len * STUDIO_PPQ / 4 !== this.length)) return;
    const signature = JSON.stringify([pattern,track.patch.drumSwing,track.patch.drumAccent,bpm]);
    if (!fresh && signature === this.signature) return;
    const result = drumPatternMidi(pattern, track.patch, bpm, this.draw);
    this.signature=signature; this.selected=bank.selected; this.length=result.length;
    const open = new Map<number, Hit>();
    const hits: Hit[] = [];
    for (const e of result.events) {
      if (e.type === "noteOn") {
        const h = {tick:e.tick,midi:e.midi,velocity:e.velocity,duration:1};
        hits.push(h); open.set(e.midi,h);
      } else if (e.type === "noteOff") {
        const h = open.get(e.midi); if (h) h.duration = Math.max(1,e.tick-h.tick);
        open.delete(e.midi);
      }
    }
    this.hits=hits;
    const local=from-this.cycleStart!;
    this.index=hits.findIndex(h=>h.tick>=local-1e-7);
    if(this.index<0)this.index=hits.length;
  }
  private cycle(track: SY1TrackEngine, start: number, bpm: number): void {
    this.cycleStart=start; this.chance.clear();
    this.compile(track,bpm,start,true);
  }
  drain(track: SY1TrackEngine, start: number, end: number, bpm: number, emit: (hit: Hit) => void): void {
    if (!(end > start)) return;
    if (this.cycleStart === null) {
      const step = STUDIO_PPQ / 4;
      this.cycle(track, Math.ceil((start - 1e-7)/step)*step, bpm);
    } else {
      this.compile(track,bpm,start,false);
    }
    for (let i=0; i<32 && this.cycleStart! < end; i++) {
      const origin = this.cycleStart!;
      while (this.index < this.hits.length) {
        const h = this.hits[this.index], tick = origin + h.tick;
        if (tick >= end) break;
        this.index++;
        if (tick >= start - 1e-7) emit({...h,tick});
      }
      if (origin + this.length >= end) break;
      this.cycle(track, origin + this.length, bpm);
    }
  }
}
