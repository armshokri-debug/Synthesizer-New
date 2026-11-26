import { SYNC_DIVS, type SynthPatch } from "../engine/params";
import { euclidHit } from "../engine/arp";

export interface ArpPulse { midi: number; velocity: number; at: number; off: number }
export function arpStepBeats(p: SynthPatch): number {
  const rate = Number(p.arpMode === "euclid" ? p.eucRate : p.arpRate) || 6;
  return SYNC_DIVS[Math.max(0, Math.min(SYNC_DIVS.length - 1, Math.round(rate) - 1))].beats;
}
/** One clock and held chord per track. No globals, audio nodes or transport mutation. */
export class TrackArpeggiator {
  private held = new Map<number, number>();
  private physical = new Set<number>();
  private routed = new Set<number>();
  private nextAt = 0;
  private step = 0;
  private position = -1;
  private direction = 1;
  private priorDuration = 0;
  get running(): boolean { return this.held.size > 0; }
  has(midi: number): boolean { return this.held.has(midi); }
  noteOn(midi: number, velocity: number, p: SynthPatch, startAt: number): void {
    const wasRunning = this.running;
    this.routed.add(midi);
    if (p.hold === "on" && !this.physical.has(midi) && this.held.has(midi)) {
      this.held.delete(midi); return;
    }
    this.physical.add(midi);
    this.held.set(midi, velocity);
    if (!wasRunning) { this.nextAt = startAt; this.step = 0; this.position = -1; this.direction = 1; this.priorDuration = 0; }
  }
  noteOff(midi: number, p: SynthPatch): boolean {
    if (!this.routed.delete(midi)) return false;
    this.physical.delete(midi);
    if (p.hold !== "on") this.held.delete(midi);
    return true;
  }
  realignUnstarted(at: number): void { if (this.running && this.step === 0) { this.nextAt = at; this.priorDuration = 0; } }
  releaseLatched(): void { for (const m of this.held.keys()) if (!this.physical.has(m)) this.held.delete(m); }
  stop(preserveRouting = false): void {
    this.held.clear(); this.physical.clear();
    if (!preserveRouting) this.routed.clear();
    this.step = 0; this.position = -1; this.direction = 1; this.priorDuration = 0;
  }
  drain(p: SynthPatch, bpm: number, now: number, lookahead = 0.06): ArpPulse[] {
    if (p.arpOn !== "on") { this.stop(true); return []; }
    if (!this.running || !Number.isFinite(now) || !(bpm > 0)) return [];
    const duration = 60 / bpm * arpStepBeats(p);
    if (this.priorDuration && duration !== this.priorDuration && this.nextAt > now) {
      this.nextAt = now + Math.min(1, (this.nextAt - now) / this.priorDuration) * duration;
    }
    this.priorDuration = duration;
    const gate = Math.max(0.05, Math.min(1, Number(p.arpGate ?? 0.6)));
    const swing = Math.max(0, Math.min(0.6, Number(p.arpSwing) || 0));
    // Compare the actual swung step, not the unswung grid timestamp.
    const pendingSwing = this.step % 2 ? swing * duration : 0;
    if (this.nextAt + pendingSwing < now - 0.025) this.nextAt = now + 0.005 - pendingSwing;
    const sorted = [...this.held.entries()].sort((a,b) => a[0]-b[0]);
    const base = p.arpMode === "played" ? [...this.held.entries()] : sorted;
    const sequence: [number, number][] = [];
    for (let o = 0; o < Math.max(1, Math.min(4, Math.round(Number(p.arpOct) || 1))); o++) {
      for (const [m, v] of base) if (m + o * 12 <= 127) sequence.push([m + o * 12, v]);
    }
    const result: ArpPulse[] = [];
    for (let i = 0; i < 32 && this.nextAt <= now + lookahead; i++) {
      const at = Math.max(now, this.nextAt + (this.step % 2 ? swing * duration : 0));
      // The swung step must also fit within the lookahead. Keep it pending otherwise.
      if (at > now + lookahead) break;
      const emit = (midi: number, velocity: number) => {
        if (midi >= 0 && midi <= 127) result.push({midi, velocity, at, off: at + duration * gate * 0.98});
      };
      if (p.arpMode === "euclid") {
        for (let r=1; r<=3; r++) {
          if (p[`euc${r}On`] === "off") continue;
          const steps = Math.max(1, Math.round(Number(p[`euc${r}Steps`]) || 16));
          const pulses = Number(p[`euc${r}Pulses`] ?? 4), rot = Number(p[`euc${r}Rot`] ?? 0);
          const local = this.step % steps;
          if (!euclidHit(steps,pulses,rot,local)) continue;
          const [m,v] = sorted[(r-1)%sorted.length];
          let first = 0; while(first<local && !euclidHit(steps,pulses,rot,first)) first++;
          emit(m+12*Math.round(Number(p[`euc${r}Oct`])||0), v*(first===local?1:0.78));
        }
      } else if(sequence.length) {
        const n = sequence.length;
        if(p.arpMode === "random") this.position = Math.floor(Math.random()*n);
        else if(p.arpMode === "down") this.position = this.position <= 0 || this.position >= n ? n-1 : this.position-1;
        else if(p.arpMode === "updown") {
          if(n===1) this.position=0;
          else { this.position+=this.direction; if(this.position>=n){this.direction=-1;this.position=n-2;} if(this.position<0){this.direction=1;this.position=1;} }
        } else this.position=(this.position+1)%n;
        const [m,v]=sequence[this.position]; emit(m,v);
      }
      this.step++; this.nextAt+=duration;
    }
    return result;
  }
}
