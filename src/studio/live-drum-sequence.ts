import { drumPatternMidi } from "./track-drum-patterns";
import { STUDIO_PPQ } from "./types";
import type { SY1TrackEngine } from "./track-engine";

type Hit = { tick: number; midi: number; velocity: number; duration: number };
/** Transport-owned live pattern cursor. Each cycle is compiled exactly once;
 * segments use musical ticks, so tempo changes do not reset the pattern. */
export class LiveDrumSequence {
  private cycleStart: number | null = null;
  private length = 0;
  private hits: Hit[] = [];
  private index = 0;
  constructor(private readonly random: () => number = Math.random) {}
  reset(): void { this.cycleStart = null; this.length = 0; this.index = 0; this.hits = []; }
  private cycle(track: SY1TrackEngine, start: number, bpm: number): void {
    const bank = track.getTrackDrumBank();
    const result = drumPatternMidi(bank.patterns[bank.selected], track.patch, bpm, this.random);
    this.cycleStart = start; this.length = result.length; this.index = 0;
    const open = new Map<number, Hit>();
    this.hits = [];
    for (const e of result.events) {
      if (e.type === "noteOn") {
        const h = {tick:e.tick,midi:e.midi,velocity:e.velocity,duration:1};
        this.hits.push(h); open.set(e.midi,h);
      } else if (e.type === "noteOff") {
        const h = open.get(e.midi); if (h) h.duration = Math.max(1,e.tick-h.tick);
        open.delete(e.midi);
      }
    }
  }
  /** Start step 1 on the next sixteenth subdivision of the transport. */
  drain(track: SY1TrackEngine, start: number, end: number, bpm: number, emit: (hit: Hit) => void): void {
    if (!(end > start)) return;
    if (this.cycleStart === null) {
      const step = STUDIO_PPQ / 4;
      this.cycle(track, Math.ceil((start - 1e-7)/step)*step, bpm);
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
