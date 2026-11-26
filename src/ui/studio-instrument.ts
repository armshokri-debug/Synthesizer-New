import { renderDrumStepsHtml } from "./drum-steps-view";
/**
 * SY-1 Studio — Embedded Original Synthesizer & Drum Machine Interface
 *
 * Renders the focused track's authentic SY-1 / Iranian city synthesizer or drum
 * machine faceplate UNCHANGED (exact .synth-panel, .synth-sections, .synth-sec,
 * 3D .sk knobs with radial tick scales, .synth-choice switches, Kashan .fm-lcd,
 * Nishapur .vec-svg XY pad, Konya .eu-svg rings, Kerman/Bushehr/Rasht/Hormoz
 * .drum-voice 8-knob editor, and [data-machine] / [data-skin] tokens), bound
 * exclusively to the focused SY1TrackEngine without touching standalone synth.ts.
 */

import { renderFmAlgorithm, renderEuclideanRings } from "./instrument-special-views";
import { DRUM_NOTES, DRUM_VOICES, DrumVoice, type StepEdit } from "../engine/drums";
import { escapeHtml, SYNTH_PARAMS, synthNorm } from "../engine/params";
import { evalOrbitPoint } from "../engine/vector";
import type { ControlDef, MachineDef, SectionDef } from "../machines/types";
import { getDrumLabelsForTrack, getStudioMachineDef, SY1TrackEngine } from "../studio/track-engine";
import { renderInstrumentKnob, renderInstrumentChoice, renderInstrumentControl } from "./instrument-controls";
import { renderInstrumentFrame, renderInstrumentSection, renderInstrumentTabs, renderInstrumentPresetLabel } from "./instrument-frame";

// Per-track selected drum voice in the Studio drum editor (never touches standalone drums.ts)
const selectedDrumVoiceByTrack = new Map<string, DrumVoice>();
const previewDrumByTrack = new WeakMap<SY1TrackEngine, boolean>();
export function setTrackDrumPreviewView(track: SY1TrackEngine, enabled: boolean): void { previewDrumByTrack.set(track, enabled); }

const liveDrumByTrack = new WeakMap<SY1TrackEngine, boolean>();
export const setTrackDrumLiveView = (track:SY1TrackEngine, enabled:boolean):void => { liveDrumByTrack.set(track,enabled); };
const drumEditByTrack = new WeakMap<SY1TrackEngine, StepEdit>();
export const getTrackDrumEdit = (track:SY1TrackEngine): StepEdit => drumEditByTrack.get(track) ?? "hit";
export const setTrackDrumEdit = (track:SY1TrackEngine, mode:StepEdit): void => { drumEditByTrack.set(track, mode); };

export function getStudioSelectedDrumVoice(trackId: string): DrumVoice {
  return selectedDrumVoiceByTrack.get(trackId) || "kick";
}

export function setStudioSelectedDrumVoice(trackId: string, voice: DrumVoice): void {
  selectedDrumVoiceByTrack.set(trackId, voice);
}

const VEC_PAD_MIN = 12;
const VEC_PAD_SPAN = 176;
const toSvgCoord = (norm: number): number => VEC_PAD_MIN + Math.max(0, Math.min(1, norm)) * VEC_PAD_SPAN;

function renderStudioSynthKnob(track: SY1TrackEngine, key: string, label: string): string {
  return renderInstrumentKnob({ kind: "track", patch: track.patch }, key, label);
}

function renderStudioSynthChoice(track: SY1TrackEngine, key: string, options: [string, string, string?][]): string {
  return renderInstrumentChoice({ kind: "track", patch: track.patch }, key, options);
}

function renderStudioEuclidRings(track: SY1TrackEngine): string {
  return renderEuclideanRings(track.patch);
}

function renderStudioFmAlgo(track: SY1TrackEngine): string {
  return renderFmAlgorithm({kind:"track",patch:track.patch});
}

function buildStudioOrbitPathD(track: SY1TrackEngine): string {
  const p = track.patch;
  const mode = String(p.orbitMode || "off");
  const effSize = Math.min(1, Number(p.orbitSize ?? 0.55) + track.getModWheel());
  if (mode === "off" || effSize <= 0.005) return "";
  const cx = Math.max(0, Math.min(1, Number(p.vecX ?? 0.5)));
  const cy = Math.max(0, Math.min(1, Number(p.vecY ?? 0.5)));
  const steps = 64;
  let d = "";
  for (let i = 0; i <= steps; i++) {
    const [x, y] = evalOrbitPoint(mode, i / steps, cx, cy, effSize);
    d += `${i === 0 ? "M" : "L"}${toSvgCoord(x).toFixed(1)} ${toSvgCoord(y).toFixed(1)} `;
  }
  return d + "Z";
}

function renderStudioVectorPad(track: SY1TrackEngine): string {
  const p = track.patch;
  const cx = Math.max(0, Math.min(1, Number(p.vecX ?? 0.5)));
  const cy = Math.max(0, Math.min(1, Number(p.vecY ?? 0.5)));
  const ax = toSvgCoord(cx);
  const ay = toSvgCoord(cy);
  const orbitD = buildStudioOrbitPathD(track);

  return `<div class="vec-wrap">
    <svg class="vec-svg" data-st-vec-pad="1" viewBox="0 0 200 200" aria-label="Vector XY morph pad (drag to morph A/B/C/D)">
      <g class="vec-grid" aria-hidden="true">
        <circle cx="100" cy="100" r="38" />
        <circle cx="100" cy="100" r="76" />
        <line x1="100" y1="10" x2="100" y2="190" />
        <line x1="10" y1="100" x2="190" y2="100" />
        <line class="vec-diag" x1="16" y1="16" x2="184" y2="184" />
        <line class="vec-diag" x1="184" y1="16" x2="16" y2="184" />
      </g>
      <g class="vec-corner vec-corner-a" aria-hidden="true">
        <text x="12" y="22">A</text>
        <path d="M25 20l4-7v7h4v-7h5v7" />
      </g>
      <g class="vec-corner vec-corner-b" aria-hidden="true">
        <text x="188" y="22" text-anchor="end">B</text>
        <path d="M161 19v-3a4.5 4.5 0 0 1 9 0v3h2h-13zM164.5 21.5h2" />
      </g>
      <g class="vec-corner vec-corner-c" aria-hidden="true">
        <text x="12" y="188">C</text>
        <path d="M25 186c2.5-3.5 4.5-3.5 7 0s4.5 3.5 7 0M25 181c2.5-3.5 4.5-3.5 7 0s4.5 3.5 7 0" />
      </g>
      <g class="vec-corner vec-corner-d" aria-hidden="true">
        <text x="188" y="188" text-anchor="end">D</text>
        <path d="M159 187c1.8-7 3.6-7 5.4 0c1.8-10 3.6-10 5.4 0c1.6-4.5 3.2-4.5 4.8 0" />
      </g>
      <path class="vec-orbit-path" data-st-vec-orbit="1" d="${orbitD}" />
      <circle class="vec-anchor" data-st-vec-anchor="1" cx="${ax.toFixed(1)}" cy="${ay.toFixed(1)}" r="2.8" />
      <g class="vec-cursor" data-st-vec-cursor="1" transform="translate(${ax.toFixed(1)}, ${ay.toFixed(1)})">
        <circle class="vec-cursor-halo" r="13" />
        <circle class="vec-cursor-ring" r="6" />
        <circle class="vec-cursor-dot" r="2.6" />
      </g>
    </svg>
    <div class="vec-xy-hud">
      <span class="vec-axis-pill" data-st-vec-readout="x">X <b>${Math.round(cx * 100)}%</b></span>
      <span class="vec-axis-pill" data-st-vec-readout="y">Y <b>${Math.round(cy * 100)}%</b></span>
    </div>
  </div>`;
}

function renderStudioDrumPadsAndKits(track: SY1TrackEngine, m: MachineDef): string {
  const labels = getDrumLabelsForTrack(m.id, track.patch, track.presetId);
  const activeVoice = getStudioSelectedDrumVoice(track.id);

  const padsHtml = `<div class="drum-voices st-drum-pads" role="group" aria-label="Audition and select drum voices">${DRUM_VOICES.map((v) => {
    const midi = DRUM_NOTES[v];
    return `<button type="button" class="drum-voice-btn st-drum-pad${v === activeVoice ? " active" : ""}" data-st-action="drum-audition" data-st-drum-voice="${v}" data-track-id="${escapeHtml(track.id)}" title="Click to audition & edit ${escapeHtml(labels[v])} (GM MIDI ${midi})">
      <span class="st-drum-pad-name">${escapeHtml(labels[v])}</span>
      <span class="st-drum-pad-midi">M${midi}</span>
    </button>`;
  }).join("")}</div>`;

  const kitsHtml =
    m.kits && m.kits.length > 0
      ? `<div class="st-drum-kits-row">
          <span class="st-drum-kits-lbl">KIT</span>
          <div class="st-drum-kits-list">${m.kits
            .map((k) => {
              const isCur = track.presetId === `kit:${k.id}` || track.presetName === k.name;
              return `<button type="button" class="synth-choice-btn${isCur ? " active" : ""}" data-st-action="drum-pick-kit" data-st-kit="${escapeHtml(k.id)}" data-track-id="${escapeHtml(track.id)}" title="${escapeHtml(k.desc)}">${escapeHtml(k.name)}</button>`;
            })
            .join("")}</div>
        </div>`
      : "";

  const bank = track.getTrackDrumBank(), pat = bank.patterns[bank.selected], mode = getTrackDrumEdit(track);
  return `<div class="drum-transport st-track-pattern-toolbar">
    <div class="drum-slots" role="group" aria-label="Pattern">${Array.from({length:8},(_,i)=>`<button type="button" class="drum-slot${i===bank.selected?" active":""}" data-st-action="track-drum-pattern" data-index="${i}" aria-pressed="${i===bank.selected}">${"ABCDEFGH"[i]}</button>`).join("")}</div>
    <div class="synth-choice drum-len" role="group" aria-label="Pattern length">${[16,12].map(len=>`<button type="button" class="synth-choice-btn${pat.len===len?" active":""}" data-st-action="track-drum-len" data-len="${len}" aria-pressed="${pat.len===len}">${len}</button>`).join("")}</div>
    <button type="button" class="synth-choice-btn drum-acc${mode!=="hit"?" active":""}" data-st-action="track-drum-edit" title="Cycle step edit mode">✎ ${mode.toUpperCase()}</button>
    <button type="button" class="synth-choice-btn" data-st-action="track-drum-clear">Clear</button>
    <button type="button" class="synth-choice-btn${previewDrumByTrack.get(track) ? " active" : ""}" data-st-action="track-drum-preview" aria-pressed="${!!previewDrumByTrack.get(track)}" title="Preview this pattern at project tempo with the transport stopped">${previewDrumByTrack.get(track) ? "Stop Preview" : "Preview"}</button>
    <button type="button" class="synth-choice-btn${liveDrumByTrack.get(track) ? " active" : ""}" data-st-action="track-drum-live" aria-pressed="${!!liveDrumByTrack.get(track)}" title="Enable live pattern; use Studio Play or Record. Requires an empty track.">Live</button>
    <button type="button" class="synth-choice-btn" data-st-action="track-drum-insert" title="Insert pattern at the first free grid position from the playhead">+ MIDI</button>
    </div>${padsHtml}${kitsHtml}`;
}

function renderStudioDrumVoice(track: SY1TrackEngine, m: MachineDef): string {
  const v = getStudioSelectedDrumVoice(track.id);
  const labels = getDrumLabelsForTrack(m.id, track.patch, track.presetId);
  const voicesStrip = `<div class="drum-voices" role="group" aria-label="Select drum voice to edit">${DRUM_VOICES.map(
    (dv) =>
      `<button type="button" class="drum-voice-btn${dv === v ? " active" : ""}" data-st-action="drum-select-voice" data-st-drum-voice="${dv}" data-track-id="${escapeHtml(track.id)}">${escapeHtml(labels[dv])}</button>`
  ).join("")}</div>`;

  return `${voicesStrip}
    <div class="drum-voice-name">${escapeHtml(labels[v])}</div>
    <div class="sk-row">${
      renderStudioSynthKnob(track, v + "Tune", "TUNE") +
      renderStudioSynthKnob(track, v + "Decay", "DECAY") +
      renderStudioSynthKnob(track, v + "Tone", "TONE") +
      renderStudioSynthKnob(track, v + "Level", "LEVEL")
    }</div>
    <div class="sk-row">${
      renderStudioSynthKnob(track, v + "Pan", "PAN") +
      renderStudioSynthKnob(track, v + "Color", "COLOR") +
      renderStudioSynthKnob(track, v + "Drive", "DRIVE") +
      renderStudioSynthKnob(track, v + "Send", "SEND")
    }</div>`;
}

function renderStudioControl(track: SY1TrackEngine, c: ControlDef): string {
  return renderInstrumentControl({ kind: "track", patch: track.patch }, c);
}

function renderStudioSection(track: SY1TrackEngine, m: MachineDef, sec: SectionDef, index: number, activePageId: string): string {

  const isOnPage = activePageId === "all" || sec.page === activePageId;
  let body = "";

  if (sec.custom) {
    if (sec.custom === "euclid-rings") {
      body = `<div class="synth-custom" data-st-custom="euclid-rings">${renderStudioEuclidRings(track)}</div>`;
    } else if (sec.custom === "fm-algo") {
      body = `<div class="synth-custom" data-st-custom="fm-algo">${renderStudioFmAlgo(track)}</div>`;
    } else if (sec.custom === "vector-pad") {
      body = `<div class="synth-custom" data-st-custom="vector-pad">${renderStudioVectorPad(track)}</div>`;
    } else if (sec.custom === "drum-voice") {
      body = `<div class="synth-custom" data-st-custom="drum-voice">${renderStudioDrumVoice(track, m)}</div>`;
    } else if (sec.custom === "drum-steps") {
      const bank = track.getTrackDrumBank(), labels = getDrumLabelsForTrack(m.id, track.patch, track.presetId);
      body = `<div class="synth-custom" data-st-custom="drum-steps">${renderDrumStepsHtml(bank.patterns[bank.selected],getStudioSelectedDrumVoice(track.id),v=>escapeHtml(labels[v]),true)}</div>`;
    } else if (sec.custom === "drum-transport") {
      body = `<div class="synth-custom" data-st-custom="drum-pads">${renderStudioDrumPadsAndKits(track, m)}</div>`;
    }
  } else {
    body = sec.controls.map((c) => renderStudioControl(track, c)).join("");
  }

  return renderInstrumentSection(sec,index,body,isOnPage);
}

export function renderStudioInstrumentHtml(track: SY1TrackEngine, pageFilter: string, focusMode = false, overlay = ""): string {
  const m: MachineDef = getStudioMachineDef(track.machineId);
  const pages = m.pages;
  const validPage = pageFilter === "all" || pages.some((p) => p.id === pageFilter) ? pageFilter : "all";
  const presets = m.presets;
  const curIdx = presets.findIndex((p) => p.id === track.presetId);
  const curPreset = curIdx >= 0 ? presets[curIdx] : null;
  const curKit = m.kind === "drums" && track.presetId.startsWith("kit:")
    ? m.kits?.find((k) => `kit:${k.id}` === track.presetId) || null
    : null;
  const presetLabel = curKit ? curKit.name : curPreset ? curPreset.name : track.presetName || "Custom";
  const presetGroup = curKit ? `${curKit.group} · Kit` : curPreset ? curPreset.group : "Edited sound";
  const frame = renderInstrumentFrame({
    attributes: `class="synth-panel st-embedded-synth" dir="ltr" data-track-id="${escapeHtml(track.id)}" data-machine="${escapeHtml(m.id)}" data-skin="${escapeHtml(m.skin || m.id)}" data-page="${escapeHtml(validPage)}"`,
    top: `<div class="synth-brand"><span class="synth-brand-maker">SY-1 </span><button type="button" class="synth-machine-select" data-st-action="open-browser-for-track" title="Choose instrument for this track">${escapeHtml(m.name)}</button>${focusMode ? '<button type="button" class="synth-midi-btn synth-studio-btn" id="st-inst-back-btn" data-st-action="close-track-instrument" title="Return to Studio arrangement">Studio</button>' : ""}</div>
      <span class="st-embedded-track-tag">${escapeHtml(track.name)}</span>`,
    subbar: `<div class="synth-preset-nav">
      <button type="button" class="synth-midi-btn preset-step-btn" data-st-action="inst-preset-prev" aria-label="Previous preset">◀</button>
      <button type="button" class="preset-display synth-preset-select" data-st-action="open-browser-for-track" title="Choose preset">${renderInstrumentPresetLabel(presetLabel,presetGroup)}</button>
      <button type="button" class="synth-midi-btn preset-step-btn" data-st-action="inst-preset-next" aria-label="Next preset">▶</button>
      </div>
      ${renderInstrumentTabs([{id:"all",label:"ALL"},...pages],validPage,true)}`,
    sections: m.sections.map((sec, idx) => renderStudioSection(track, m, sec, idx, validPage)).join(""),
    sectionClass: validPage !== "all" ? " is-filtered" : "",
    overlay
  });
  return `<div class="st-inst-wrap"><div class="st-embedded-chassis" data-track-id="${escapeHtml(track.id)}" data-machine="${escapeHtml(m.id)}" data-skin="${escapeHtml(m.skin || m.id)}">${frame}</div></div>`;
}

/** Fast DOM-only knob update during Studio Instrument drag (zero innerHTML rebuild). */
export function updateStudioInstrumentKnobDOM(container: HTMLElement, track: SY1TrackEngine, key: string): void {
  const def = SYNTH_PARAMS[key];
  if (!def) return;
  const val = Number(track.patch[key]);
  const n = Math.max(0, Math.min(1, synthNorm(key, val)));
  const fmt = def.fmt ? def.fmt(val) : String(val);
  const root = container.querySelector<HTMLElement>(`.st-embedded-synth[data-track-id="${track.id}"]`);
  if (!root) return;
  const knobs = root.querySelectorAll<HTMLElement>(`.st-inst-knob[data-st-param="${key}"]`);
  knobs.forEach((knob) => {
    const dial = knob.querySelector<HTMLElement>(".sk-dial");
    if (dial) dial.style.setProperty("--n", n.toFixed(4));
    const valEl = knob.querySelector<HTMLElement>(".sk-val");
    if (valEl) valEl.textContent = fmt;
    knob.setAttribute("aria-valuetext", fmt);
  });
}

/** Fast DOM-only Nishapur Vector XY pad update during pointer drag (zero innerHTML rebuild). */
export function updateStudioVectorPadDOM(container: HTMLElement, track: SY1TrackEngine): void {
  const root = container.querySelector<HTMLElement>(`.st-embedded-synth[data-track-id="${track.id}"]`);
  if (!root) return;
  const cx = Math.max(0, Math.min(1, Number(track.patch.vecX ?? 0.5)));
  const cy = Math.max(0, Math.min(1, Number(track.patch.vecY ?? 0.5)));
  const px = toSvgCoord(cx);
  const py = toSvgCoord(cy);
  const cursor = root.querySelector<SVGGElement>("[data-st-vec-cursor]");
  if (cursor) cursor.setAttribute("transform", `translate(${px.toFixed(1)}, ${py.toFixed(1)})`);
  const anchor = root.querySelector<SVGCircleElement>("[data-st-vec-anchor]");
  if (anchor) {
    anchor.setAttribute("cx", px.toFixed(1));
    anchor.setAttribute("cy", py.toFixed(1));
  }
  const orbit = root.querySelector<SVGPathElement>("[data-st-vec-orbit]");
  if (orbit) orbit.setAttribute("d", buildStudioOrbitPathD(track));
  const rx = root.querySelector<HTMLElement>('[data-st-vec-readout="x"] b');
  if (rx) rx.textContent = `${Math.round(cx * 100)}%`;
  const ry = root.querySelector<HTMLElement>('[data-st-vec-readout="y"] b');
  if (ry) ry.textContent = `${Math.round(cy * 100)}%`;
}
