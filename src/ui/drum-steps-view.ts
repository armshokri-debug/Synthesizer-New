import { DRUM_VOICES, stepRoll, stepFlam, stepProb, type DrumPattern, type DrumVoice } from "../engine/drums";
export function renderDrumStepsHtml(pat: DrumPattern, drumVoice: DrumVoice, label: (v:DrumVoice)=>string, track = false): string {
  const row = pat.steps[drumVoice];
  const voiceAction = track ? "data-st-action=\"drum-select-voice\" data-st-drum-voice" : "data-action=\"drum-voice\" data-voice";
  const stepAction = track ? "data-st-action=\"track-drum-step\"" : "data-action=\"drum-step\"";
  const voices = `<div class="drum-voices" role="group" aria-label="Drum voice">${DRUM_VOICES.map((v) =>
    `<button type="button" class="drum-voice-btn ${v === drumVoice ? "active" : ""}" ${voiceAction}="${v}">${label(v)}</button>`).join("")}</div>`;
  const steps = `<div class="drum-steps" style="--len:${pat.len}">${Array.from({ length: pat.len }, (_, i) => {
    const s = row[i];
    // marks: roll count, flam, chance (shown small at the bottom of the step)
    const marks: string[] = [];
    if (s) {
      const r = stepRoll(pat, drumVoice, i);
      if (r > 1) marks.push("×" + r);
      if (stepFlam(pat, drumVoice, i)) marks.push("FL");
      const c = stepProb(pat, drumVoice, i);
      if (c < 100) marks.push(c + "%");
    }
    const mark = marks.join(" ");
    return `<button type="button" class="drum-step${s ? " on" : ""}${s === 2 ? " accent" : ""}${s === 3 ? " ghost" : ""}${i % (pat.len === 12 ? 3 : 4) === 0 ? " beat" : ""}"${mark ? ` data-mark="${mark}"` : ""} ${stepAction} data-index="${i}" aria-pressed="${!!s}" aria-label="Step ${i + 1}${s === 2 ? ", accent" : s === 3 ? ", ghost" : ""}${mark ? ", " + mark : ""}"></button>`;
  }).join("")}</div>`;
  return voices + steps;
}

