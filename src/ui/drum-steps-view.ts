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


// BUSHEHR web faceplate only. Every button uses the existing engine action,
// with its explicit voice rather than the currently selected lane.
const BUSHEHR_ICONS: Record<DrumVoice,string> = {
  kick:'<ellipse cx="24" cy="13" rx="16" ry="7"/><path d="M8 13v17c0 4 7 7 16 7s16-3 16-7V13M14 19v13m10-12v16m10-17v13M8 25l32 7M8 32l32-7"/>',
  snare:'<ellipse cx="24" cy="12" rx="16" ry="6"/><path d="M8 12l10 18-4 10h20l-4-10 10-18M18 30h12M10 15l14 9 14-9"/>',
  clap:'<circle cx="24" cy="24" r="17"/><circle cx="24" cy="24" r="13"/><path d="M24 5v5m0 28v5M5 24h5m28 0h5M11 11l4 4m18 18 4 4M11 37l4-4m18-18 4-4"/>',
  ch:'<path d="M8 29h32M12 27c3-9 21-9 24 0M22 17v-5h4v5M24 29v12M17 41h14"/>',
  oh:'<circle cx="24" cy="24" r="17"/><circle cx="24" cy="24" r="12"/><path d="M24 5v7m0 24v7M5 24h7m24 0h7M11 11l5 5m16 16 5 5"/>',
  tom:'<ellipse cx="24" cy="11" rx="16" ry="6"/><path d="M8 11c0 12 9 18 11 22l-5 8h20l-5-8c2-4 11-10 11-22M19 33h10M14 16c7 4 13 4 20 0"/>',
  rim:'<ellipse cx="24" cy="26" rx="16" ry="8"/><path d="M8 26v5c0 5 7 8 16 8s16-3 16-8v-5M12 12l23 15M36 8L18 26"/>',
  bell:'<ellipse cx="24" cy="24" rx="17" ry="12"/><ellipse cx="24" cy="24" rx="7" ry="5"/><path d="M24 19v-6m-4 0h8M7 24l34 0M24 36v4"/>'
};
function bushehrIcon(v:DrumVoice):string {
  return '<svg class="bushehr-voice-icon" viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'+BUSHEHR_ICONS[v]+'</svg>';
}
export function renderBushehrPads(selected:DrumVoice,label:(v:DrumVoice)=>string,track=false):string {
  const attrs=track?'data-st-action="drum-audition" data-st-drum-voice':'data-action="drum-voice" data-voice';
  return '<div class="bushehr-pads" role="group" aria-label="Percussion audition pads">'+DRUM_VOICES.map(v=>'<button type="button" class="drum-voice-btn bushehr-pad '+(v===selected?'active':'')+'" '+attrs+'="'+v+'" aria-pressed="'+(v===selected)+'">'+bushehrIcon(v)+'<span>'+label(v)+'</span><i aria-hidden="true"></i></button>').join('')+'</div>';
}
export function renderBushehrMatrix(pat:DrumPattern,selected:DrumVoice,label:(v:DrumVoice)=>string,track=false):string {
  const voiceAction=track?'data-st-action="drum-select-voice" data-st-drum-voice':'data-action="drum-voice" data-voice';
  const stepAction=track?'data-st-action="track-drum-step"':'data-action="drum-step"';
  const numbers=Array.from({length:pat.len},(_,i)=>'<span class="bushehr-step-num">'+(i+1)+'</span>').join('');
  return '<div class="bushehr-matrix-scroll"><div class="bushehr-matrix" style="--len:'+pat.len+'"><div class="bushehr-lane-head"><span>VOICE</span>'+numbers+'</div>'+DRUM_VOICES.map(v=>{
    const cells=Array.from({length:pat.len},(_,i)=>{
      const s=pat.steps[v][i];const marks:string[]=[];
      if(s){const r=stepRoll(pat,v,i);if(r>1)marks.push("×"+r);if(stepFlam(pat,v,i))marks.push("FL");const c=stepProb(pat,v,i);if(c<100)marks.push(c+"%");}
      const mark=marks.join(" ");
      return '<button type="button" class="drum-step'+(s?' on':'')+(s===2?' accent':'')+(s===3?' ghost':'')+(i%(pat.len===12?3:4)===0?' beat':'')+'" '+stepAction+' data-grid-voice="'+v+'" data-index="'+i+'" aria-pressed="'+!!s+'" aria-label="'+label(v)+' step '+(i+1)+(s===2?', accent':s===3?', ghost':'')+(mark?', '+mark:'')+'"'+(mark?' data-mark="'+mark+'"':'')+'></button>';
    }).join('');
    return '<div class="bushehr-lane'+(v===selected?' is-selected':'')+'"><button type="button" class="drum-voice-btn bushehr-lane-label'+(v===selected?' active':'')+'" '+voiceAction+'="'+v+'" aria-pressed="'+(v===selected)+'">'+bushehrIcon(v)+'<span>'+label(v)+'</span></button>'+cells+'</div>';
  }).join('')+'</div></div>';
}
