/** Beat numbers are absolute song beats; negative beats belong to the count-in. */
export function beatsInWindow(now: number, until: number, anchorTime: number, anchorBeat: number, bpm: number) {
  const seconds = 60 / bpm;
  const first = Math.ceil(anchorBeat + (now - anchorTime) / seconds - 1e-7);
  const last = Math.floor(anchorBeat + (until - anchorTime) / seconds + 1e-7);
  const beats: { beat: number; at: number; accent: boolean }[] = [];
  for (let beat = first; beat <= last; beat++) {
    beats.push({ beat, at: anchorTime + (beat - anchorBeat) * seconds, accent: ((beat % 4) + 4) % 4 === 0 });
  }
  return beats;
}

/** Monitor-only output, never connected to a track, Studio tap, or export graph. */
export class StudioMetronome {
  private output: GainNode | null = null;
  private ctx: BaseAudioContext | null = null;
  private voices = new Set<OscillatorNode>();
  private last = -Infinity;
  volume = 0.25;

  schedule(ctx: BaseAudioContext | null, now: number, anchor: number, anchorBeat: number, bpm: number,
    enabled: boolean, countInStart: number | null, countInEnd: number | null) {
    if (!ctx || (!enabled && countInEnd === null)) return;
    if (ctx !== this.ctx) {
      this.dispose(); this.ctx = ctx; this.output = ctx.createGain();
      this.output.gain.value = this.volume;
      this.output.connect(ctx.destination);
    }
    for (const b of beatsInWindow(now, now + 0.1, anchor, anchorBeat, bpm)) {
      if (b.at <= this.last + 1e-6 || (countInStart !== null && b.at < countInStart - 1e-6)) continue;
      if (!enabled && (countInEnd === null || b.at >= countInEnd - 1e-6)) continue;
      this.last = b.at;
      const osc = ctx.createOscillator(), gain = ctx.createGain();
      osc.frequency.value = b.accent ? 1320 : 880;
      const at = Math.max(ctx.currentTime, b.at);
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(b.accent ? 0.7 : 0.45, at + 0.002);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.035);
      osc.connect(gain); gain.connect(this.output!);
      this.voices.add(osc);
      osc.onended = () => { this.voices.delete(osc); osc.disconnect(); gain.disconnect(); };
      osc.start(at); osc.stop(at + 0.04);
    }
  }
  setVolume(value: number) {
    this.volume = Math.max(0, Math.min(1, Number(value) || 0));
    if (this.output) this.output.gain.value = this.volume;
  }
  cancel() {
    for (const v of this.voices) {
      try { v.stop(); } catch {}
      try { v.disconnect(); } catch {}
    }
    this.voices.clear();
    this.last = -Infinity;
  }
  dispose() { this.cancel(); this.output?.disconnect(); this.output = null; this.ctx = null; }
}
