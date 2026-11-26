import { renderDrumStepsHtml } from "./drum-steps-view";
import { renderFmAlgorithm, renderEuclideanRings } from "./instrument-special-views";
/**
 * SY-1 UI — Panel: rendered from the active machine's definition.
 *
 * Top bar: machine menu, scope, preset browser, tempo (when the machine uses
 * it), engine/MIDI controls. Then page tabs (small screens) and the machine's
 * sections. The drum machine adds custom sections (pattern, steps, sound).
 */

import {
  getLearnTargetParam,
  getMidiInputs,
  getMidiStatusMessage,
  getSelectedMidiChannel,
  getSelectedMidiDevice,
  isLearnMode,
  isMidiEnabled,
  isLearnUnavailable,
  isMidiUnavailable,
  isParamMapped,
  onMidiStateChange,
  requestMidi,
  setMidiActivityCallback,
  setSelectedMidiChannel,
  setSelectedMidiDevice,
  selectLearnParam,
  toggleLearnMode
} from "../engine/midi";
import { renderMasterKnob, renderRecButton } from "./daw-panel";
import { escapeHtml } from "../engine/params";
import {
  allNotesOff,
  applySynthPreset,
  getDrumKitDef,
  getMachine,
  getMachines,
  getModWheel,
  getSynthPatch,
  getSynthPresetId,
  noteOff,
  noteOn,
  isDrumKitEdited,
  onDrumKitChange,
  onMachineChange,
  onParamChange,
  onPresetChange,
  prepareAudio,
  setMachine,
  setSynthParam,
  stepPreset,
  switchEngine
} from "../engine/synth";
import { evalOrbitPoint, getVectorLiveXY, setVectorDrawnPath } from "../engine/vector";
import { getEngine, getHQState, onEngineChange } from "../engine/hq";
import { getMidiPickup, getMidiMode, HOST_MIDI, MIDI_MODES, MidiMode, setMidiMode, setMidiPickup } from "../engine/cc-map";
import { getPluginMidiOut, onDawChange, setPluginMidiOut } from "../engine/daw";
import { exportDrumMidi } from "./drum-export";
import { fmtBpm, getSync, getTempo, isHostSynced, onSyncChange, onTempoChange, setSync, setTempo, tapTempo } from "../engine/tempo";
import {
  clearPattern,
  drumLabel,
  DRUM_NOTES,
  DRUM_VOICES,
  DrumVoice,
  getPattern,
  getPatternIndex,
  isDrumPlaying,
  onDrumChange,
  onDrumStep,
  selectPattern,
  setPatternLength,
  startDrums,
  stopDrums,
  editStep,
  STEP_EDITS,
  StepEdit,
  playDrum
} from "../engine/drums";
import type { ControlDef, SectionDef } from "../machines/types";
import { onArpStep } from "../engine/arp";
import { getBaseMidi, renderKeyboard } from "./keyboard";
import { renderSynthKnob, standaloneControlContext, updateMidiLearnDOM, updateSynthControlDOM } from "./knob";
import { renderInstrumentChoice, renderInstrumentControl } from "./instrument-controls";
import { renderOriginalFaceplate, renderInstrumentSection, renderInstrumentTabs, renderInstrumentPresetLabel } from "./instrument-frame";
import { onPluginVisualFrame, queueVisualUpdate } from "./plugin-visuals";

// ------------------------------------------------------------ controls ----
export function renderSynthChoice(key: string, options: [string, string, string?][]): string {
  return renderInstrumentChoice(standaloneControlContext(), key, options);
}

export function renderControl(c: ControlDef): string {
  return renderInstrumentControl(standaloneControlContext(), c);
}

// --------------------------------------------------------- drum sections ----
let drumVoice: DrumVoice = "kick";
let stepEdit: StepEdit = "hit";
const EDIT_LABEL: Record<StepEdit, string> = { hit: "HIT", accent: "ACCENT", ghost: "GHOST", roll: "ROLL", flam: "FLAM", chance: "CHANCE" };
const EDIT_HELP: Record<StepEdit, string> = {
  hit: "Tap steps to add or remove hits",
  accent: "Tap steps to make them accents (louder, brighter)",
  ghost: "Tap steps to make them ghost notes (very soft)",
  roll: "Tap steps to cycle a roll / riz: 2, 3 or 4 fast hits in one step",
  flam: "Tap steps to add a flam (a soft grace note just before)",
  chance: "Tap steps to cycle the chance they play: 75%, 50%, 25%"
};

function renderDrumTransport(): string {
  const pat = getPattern();
  const idx = getPatternIndex();
  const playing = isDrumPlaying();
  return `<div class="drum-transport">
      <button type="button" class="drum-play ${playing ? "active" : ""}" data-action="drum-play" aria-pressed="${playing}">${playing ? "■ Stop" : "▶ Play"}</button>
      <div class="drum-slots" role="group" aria-label="Pattern">${Array.from({ length: 8 }, (_, i) =>
        `<button type="button" class="drum-slot ${i === idx ? "active" : ""}" data-action="drum-pattern" data-index="${i}" title="Pattern ${"ABCDEFGH"[i]}">${"ABCDEFGH"[i]}</button>`).join("")}</div>
    </div>
    <div class="drum-transport drum-transport-2">
      <div class="synth-choice drum-len">
        <button type="button" class="synth-choice-btn ${pat.len === 16 ? "active" : ""}" data-action="drum-len" data-len="16" title="16 steps (4/4)">16</button>
        <button type="button" class="synth-choice-btn ${pat.len === 12 ? "active" : ""}" data-action="drum-len" data-len="12" title="12 steps (6/8)">12</button>
      </div>
      <button type="button" class="synth-choice-btn drum-acc ${stepEdit !== "hit" ? "active" : ""}" data-action="drum-edit" title="EDIT mode: ${EDIT_HELP[stepEdit]} (tap to change mode)">✎ ${EDIT_LABEL[stepEdit]}</button>
      <button type="button" class="synth-choice-btn" data-action="drum-clear" title="Clear this pattern">CLEAR</button>
      <button type="button" class="synth-choice-btn drum-export" data-action="drum-export" draggable="true" title="${HOST_MIDI ? "Save this pattern as a MIDI file in Music/SY-1 and show it, to drag into the DAW (Shift: patterns A–H)" : "Save this pattern as a MIDI file, or drag it into your DAW (Shift: patterns A–H)"}">⤓ MIDI</button>
    </div>`;
}

function renderDrumSteps(): string {
  return renderDrumStepsHtml(getPattern(), drumVoice, drumLabel);
}

function renderDrumVoice(): string {
  const v = drumVoice;
  return `<div class="drum-voice-name">${drumLabel(v)}</div><div class="sk-row">${
    renderSynthKnob(v + "Tune", "TUNE") + renderSynthKnob(v + "Decay", "DECAY") +
    renderSynthKnob(v + "Tone", "TONE") + renderSynthKnob(v + "Level", "LEVEL")}</div><div class="sk-row">${
    renderSynthKnob(v + "Pan", "PAN") + renderSynthKnob(v + "Color", "COLOR") +
    renderSynthKnob(v + "Drive", "DRIVE") + renderSynthKnob(v + "Send", "SEND")}</div>`;
}

// ------------------------------------------------- Kashan: algorithm LCD ----
// Operator positions (x, y) per algorithm in a 200 x 120 box; edges are [from, to].
function renderFmAlgo(): string { return renderFmAlgorithm(standaloneControlContext()); }

// ----------------------------------------------------- Konya: the rings ----
function renderEuclidRings(): string { return renderEuclideanRings(getSynthPatch()); }

let euStepUnsub: (() => void) | null = null;
function bindEuclidPlayhead(): void {
  if (euStepUnsub) return;
  euStepUnsub = onArpStep((step) => {
    if (document.getElementById("sy1-panel")?.dataset.studioInstrument) return;
    document.querySelectorAll(".eu-dot.now").forEach((el) => el.classList.remove("now"));
    if (step < 0) return;
    const p = getSynthPatch();
    for (let r = 1; r <= 3; r++) {
      const steps = Math.max(1, Math.round(p[`euc${r}Steps`] ?? 16));
      const el = document.querySelector(`.eu-dot[data-ring="${r}"][data-i="${step % steps}"]`);
      if (el) el.classList.add("now");
    }
  });
}

// -------------------------------------------- Nishapur: Vector XY pad ----
const VEC_PAD_MIN = 12;
const VEC_PAD_SPAN = 176;
const toSvgCoord = (norm: number): number => VEC_PAD_MIN + Math.max(0, Math.min(1, norm)) * VEC_PAD_SPAN;

let vecTrail: [number, number][] = [];
let vecRecPoints: [number, number][] | null = null;
let vecRafId = 0;

function buildOrbitPathD(): string {
  if (vecRecPoints && vecRecPoints.length >= 2) {
    return vecRecPoints
      .map(([x, y], i) => `${i === 0 ? "M" : "L"}${toSvgCoord(x).toFixed(1)} ${toSvgCoord(y).toFixed(1)}`)
      .join(" ");
  }
  const p = getSynthPatch();
  const mode = String(p.orbitMode || "off");
  const effSize = Math.min(1, (Number(p.orbitSize) ?? 0.55) + getModWheel());
  if (mode === "off" || effSize <= 0.005) return "";
  const cx = Math.max(0, Math.min(1, Number(p.vecX) ?? 0.5));
  const cy = Math.max(0, Math.min(1, Number(p.vecY) ?? 0.5));
  const steps = 72;
  let d = "";
  for (let i = 0; i <= steps; i++) {
    const [x, y] = evalOrbitPoint(mode, i / steps, cx, cy, effSize);
    d += `${i === 0 ? "M" : "L"}${toSvgCoord(x).toFixed(1)} ${toSvgCoord(y).toFixed(1)} `;
  }
  return d + "Z";
}

function renderVectorPad(): string {
  const p = getSynthPatch();
  const cx = Math.max(0, Math.min(1, Number(p.vecX) ?? 0.5));
  const cy = Math.max(0, Math.min(1, Number(p.vecY) ?? 0.5));
  const live = getVectorLiveXY(p);
  const px = toSvgCoord(live.x);
  const py = toSvgCoord(live.y);
  const ax = toSvgCoord(cx);
  const ay = toSvgCoord(cy);
  const orbitD = buildOrbitPathD();
  const recOn = p.orbitRec === "on";
  const xMapped = isParamMapped("vecX");
  const yMapped = isParamMapped("vecY");
  const learnTarget = isLearnMode() ? getLearnTargetParam() : null;

  return `<div class="vec-wrap">
    <svg class="vec-svg${recOn ? " is-recording" : ""}" id="vec-pad-svg" viewBox="0 0 200 200" aria-label="Vector XY morph pad">
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
      <path class="vec-orbit-path${recOn ? " is-rec" : ""}" id="vec-orbit-path" d="${orbitD}" />
      <polyline class="vec-trail" id="vec-trail" points="" />
      <circle class="vec-anchor" id="vec-anchor" cx="${ax.toFixed(1)}" cy="${ay.toFixed(1)}" r="2.8" />
      <g class="vec-cursor" id="vec-cursor" transform="translate(${px.toFixed(1)}, ${py.toFixed(1)})">
        <circle class="vec-cursor-halo" r="13" />
        <circle class="vec-cursor-ring" r="6" />
        <circle class="vec-cursor-dot" r="2.6" />
      </g>
    </svg>
    <div class="vec-xy-hud">
      <button type="button" class="vec-axis-pill${xMapped ? " is-mapped" : ""}${learnTarget === "vecX" ? " is-learning" : ""}" data-param="vecX">X <b>${Math.round(cx * 100)}%</b><span class="sk-dot"></span></button>
      <button type="button" class="vec-axis-pill${yMapped ? " is-mapped" : ""}${learnTarget === "vecY" ? " is-learning" : ""}" data-param="vecY">Y <b>${Math.round(cy * 100)}%</b><span class="sk-dot"></span></button>
    </div>
  </div>`;
}

function updateVectorPadDOM(rebuildOrbit = false): void {
  const svg = document.getElementById("vec-pad-svg");
  if (!svg) return;
  const p = getSynthPatch();
  const cx = Math.max(0, Math.min(1, Number(p.vecX) ?? 0.5));
  const cy = Math.max(0, Math.min(1, Number(p.vecY) ?? 0.5));
  const live = vecRecPoints && vecRecPoints.length
    ? { x: vecRecPoints[vecRecPoints.length - 1][0], y: vecRecPoints[vecRecPoints.length - 1][1] }
    : getVectorLiveXY(p);

  const px = toSvgCoord(live.x);
  const py = toSvgCoord(live.y);

  const last = vecTrail[vecTrail.length - 1];
  if (!last || Math.hypot(px - last[0], py - last[1]) > 1.2) {
    vecTrail.push([px, py]);
    if (vecTrail.length > 22) vecTrail.shift();
  }

  const cursor = document.getElementById("vec-cursor");
  if (cursor) cursor.setAttribute("transform", `translate(${px.toFixed(1)}, ${py.toFixed(1)})`);
  const anchor = document.getElementById("vec-anchor");
  if (anchor) {
    anchor.setAttribute("cx", toSvgCoord(cx).toFixed(1));
    anchor.setAttribute("cy", toSvgCoord(cy).toFixed(1));
  }
  const trail = document.getElementById("vec-trail");
  if (trail) {
    trail.setAttribute("points", vecTrail.map(([tx, ty]) => `${tx.toFixed(1)},${ty.toFixed(1)}`).join(" "));
  }
  if (rebuildOrbit) {
    const orbitEl = document.getElementById("vec-orbit-path");
    if (orbitEl) {
      orbitEl.setAttribute("d", buildOrbitPathD());
      orbitEl.classList.toggle("is-rec", p.orbitRec === "on");
    }
    svg.classList.toggle("is-recording", p.orbitRec === "on");
  }
}

function startVectorPadLoop(): void {
  if (vecRafId) cancelAnimationFrame(vecRafId);
  if ((globalThis as any).__SY1_PLUGIN__) return; // driven once per native visual frame
  const tick = () => {
    if (getMachine().id !== "nishapur") {
      vecRafId = 0;
      return;
    }
    updateVectorPadDOM(false);
    vecRafId = requestAnimationFrame(tick);
  };
  vecRafId = requestAnimationFrame(tick);
}

function bindVectorPad(): void {
  const svg = document.getElementById("vec-pad-svg") as SVGSVGElement | null;
  if (!svg) return;
  let pointerId: number | null = null;

  const setFromEvent = (e: PointerEvent, isStart: boolean) => {
    const r = svg.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return;
    const x = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    const y = Math.max(0, Math.min(1, (e.clientY - r.top) / r.height));
    const p = getSynthPatch();
    if (p.orbitRec === "on") {
      if (isStart || !vecRecPoints) {
        vecRecPoints = [[x, y]];
      } else {
        const prev = vecRecPoints[vecRecPoints.length - 1];
        if (!prev || Math.hypot(x - prev[0], y - prev[1]) >= 0.008) {
          vecRecPoints.push([x, y]);
          if (vecRecPoints.length > 512) {
            // Keep memory bounded during long drags; setVectorDrawnPath resamples to max 256
            vecRecPoints = vecRecPoints.filter((_, idx) => idx % 2 === 0);
          }
        }
      }
      setSynthParam("vecX", x);
      setSynthParam("vecY", y);
      updateVectorPadDOM(true);
    } else {
      setSynthParam("vecX", x);
      setSynthParam("vecY", y);
      updateVectorPadDOM(true);
    }
  };

  svg.addEventListener("pointerdown", (e) => {
    if (e.button === 2) return;
    e.preventDefault();
    e.stopPropagation();
    prepareAudio();
    if (isLearnMode()) {
      const cur = getLearnTargetParam();
      selectLearnParam(cur === "vecX" ? "vecY" : "vecX");
      return;
    }
    pointerId = e.pointerId;
    try {
      svg.setPointerCapture(pointerId);
    } catch (err) {}
    setFromEvent(e, true);
  });

  svg.addEventListener("pointermove", (e) => {
    if (e.pointerId !== pointerId) return;
    e.preventDefault();
    setFromEvent(e, false);
  });

  const endDrag = (e: PointerEvent) => {
    if (e.pointerId !== pointerId) return;
    pointerId = null;
    if (vecRecPoints) {
      const recorded = vecRecPoints;
      vecRecPoints = null;
      if (recorded.length >= 2) {
        setVectorDrawnPath(recorded);
        setSynthParam("vecX", 0.5);
        setSynthParam("vecY", 0.5);
        setSynthParam("orbitMode", "drawn");
      }
      setSynthParam("orbitRec", "off");
      updateVectorPadDOM(true);
    }
  };

  svg.addEventListener("pointerup", endDrag);
  svg.addEventListener("pointercancel", endDrag);
  svg.addEventListener("lostpointercapture", endDrag);
  startVectorPadLoop();
}

function renderCustom(id: string): string {
  if (id === "fm-algo") return renderFmAlgo();
  if (id === "euclid-rings") { bindEuclidPlayhead(); return renderEuclidRings(); }
  if (id === "vector-pad") return renderVectorPad();
  if (id === "drum-transport") return renderDrumTransport();
  if (id === "drum-steps") return renderDrumSteps();
  if (id === "drum-voice") return renderDrumVoice();
  return "";
}

function renderSection(sec: SectionDef, index: number): string {
  const body = sec.custom
    ? `<div class="synth-custom" data-custom="${sec.custom}">${renderCustom(sec.custom)}</div>`
    : sec.controls.map(renderControl).join("");
  return renderInstrumentSection(sec,index,body);
}

function refreshCustom(id: string): void {
  if(document.getElementById("sy1-panel")?.dataset.studioInstrument)return;
  const el = document.querySelector(`.synth-custom[data-custom="${id}"]`);
  if (el) el.innerHTML = renderCustom(id);
}

// ---------------------------------------------------------- top bar etc ----
function renderChannelOptions(): string {
  const cur = getSelectedMidiChannel();
  let html = `<option value="0"${cur === 0 ? " selected" : ""}>Omni</option>`;
  for (let ch = 1; ch <= 16; ch++) html += `<option value="${ch}"${cur === ch ? " selected" : ""}>Ch ${ch}</option>`;
  return html;
}

function renderDeviceOptions(): string {
  const inputs = getMidiInputs();
  const cur = getSelectedMidiDevice();
  let html = `<option value=""${cur === "" ? " selected" : ""}>All inputs</option>`;
  let found = cur === "";
  inputs.forEach((inp) => {
    const sel = inp.id === cur;
    if (sel) found = true;
    html += `<option value="${escapeHtml(inp.id)}"${sel ? " selected" : ""}>${escapeHtml(inp.name)}</option>`;
  });
  if (!found && cur !== "") html += `<option value="${escapeHtml(cur)}" selected>(Disconnected)</option>`;
  return html;
}

/** The preset name in the top bar: tap it to open the sound library. */
function renderPresetButton(): string {
  const m = getMachine();
  let name: string;
  let sub: string;
  if (m.kind === "drums" && m.styles) {
    // drum machines: STYLE on top, the KIT it plays below
    const st = m.styles.find((x) => x.id === getSynthPresetId());
    const kit = getDrumKitDef();
    name = st ? st.name : "My pattern";
    sub = (kit ? kit.name : "Custom kit") + (isDrumKitEdited() ? " · edited" : "");
  } else {
    const cur = m.presets.find((p) => p.id === getSynthPresetId());
    name = cur ? cur.name : "Custom";
    sub = cur ? cur.group : "Edited sound";
  }
  return renderInstrumentPresetLabel(name,sub);
}

function renderMachineOptions(): string {
  const cur = getMachine().id;
  return getMachines().map((m) =>
    `<option value="${m.id}"${m.id === cur ? " selected" : ""}>${escapeHtml(m.name)}</option>`).join("");
}

// Small screens show the panel as pages (tabs); large screens show every section.
const PAGE_KEY = (id: string) => `sy1.m.${id}.page`;
const PAGED_MQ = "(max-width: 760px), (max-height: 560px) and (orientation: landscape)";
let currentPage = "";
const allowAllPage = () => !(globalThis as any).__SY1_PLUGIN__;
let connOpen = false;

function isPagedLayout(): boolean {
  const shell = document.querySelector<HTMLElement>(".sy1-shell");
  return window.matchMedia(PAGED_MQ).matches || (!!shell && shell.classList.contains("is-fit-paged"));
}

function setConnOpen(v: boolean): void {
  connOpen = v;
  const btn = document.getElementById("conn-btn");
  const pop = document.getElementById("conn-pop");
  if (btn) {
    btn.setAttribute("aria-expanded", v ? "true" : "false");
    btn.classList.toggle("is-open", v);
  }
  if (pop) pop.hidden = !v;
  if (v) updateMidiBarDOM();
}

function applyPageVisibility(): void {
  if (document.getElementById("sy1-panel")?.dataset.studioInstrument) return;
  const m = getMachine();
  const panel = document.querySelector<HTMLElement>("#sy1-panel .synth-panel");
  const shell = document.querySelector<HTMLElement>(".sy1-shell");
  if (!panel) return;
  if (!(allowAllPage() && currentPage === "all") && !m.pages.some((p) => p.id === currentPage)) currentPage = m.pages[0].id;
  panel.setAttribute("data-page", currentPage);

  const activePages = new Set<string>(currentPage === "all" ? m.pages.map(p => p.id) : [currentPage]);
  const wideFitPaged = !allowAllPage() && !!shell && shell.classList.contains("is-fit-paged") && window.innerWidth >= 761;
  if (wideFitPaged && m.pages.length > 1) {
    const curSecs = m.sections.filter((s) => s.page === currentPage);
    if (curSecs.length === 1) {
      const idx = m.pages.findIndex((p) => p.id === currentPage);
      const companion = m.pages[idx + 1] || m.pages[idx - 1];
      if (companion) activePages.add(companion.id);
    }
  }

  const visibleSecs: HTMLElement[] = [];
  panel.querySelectorAll<HTMLElement>(".synth-sec").forEach((el) => {
    const on = activePages.has(el.getAttribute("data-page") || "");
    el.classList.toggle("is-on-page", on);
    el.classList.remove("is-page-first");
    if (on) visibleSecs.push(el);
  });
  if (visibleSecs[0]) visibleSecs[0].classList.add("is-page-first");
  panel.setAttribute("data-count", String(visibleSecs.length));

  panel.querySelectorAll<HTMLElement>(".synth-tab").forEach((t) => {
    const pg = t.getAttribute("data-page") || "";
    const isPrimary = pg === currentPage;
    const isShown = activePages.has(pg);
    t.classList.toggle("active", currentPage === "all" ? isPrimary : isShown);
    t.setAttribute("aria-selected", isPrimary ? "true" : "false");
  });
}

export function setPanelPage(id: string): void {
  const m = getMachine();
  if (!(allowAllPage() && id === "all") && !m.pages.some((p) => p.id === id)) id = m.pages[0].id;
  currentPage = id;
  applyPageVisibility();
  try { localStorage.setItem(PAGE_KEY(m.id), id); } catch (e) {}
}

function stepPanelPage(dir: number): void {
  const pages = allowAllPage() ? [{id: "all", label: "All"}, ...getMachine().pages] : getMachine().pages;
  const i = pages.findIndex((p) => p.id === currentPage);
  const next = pages[Math.max(0, Math.min(pages.length - 1, i + dir))];
  if (next) setPanelPage(next.id);
}

export function previewPreset(presetId: string): void {
  applySynthPreset(presetId);
  const m = getMachine();
  // no preview for drums, arpeggios or HOLD patches (a held drone would never stop)
  const p = getSynthPatch();
  if (m.kind === "drums" || p.arpOn === "on" || p.hold === "on") return;
  const note = getBaseMidi() + 12;
  noteOn(note);
  setTimeout(() => noteOff(note), 450);
}

/** SYNC (plugin): light the button; while the DAW sets the tempo the own tempo controls are greyed. */
export function updateSyncDOM(): void {
  const synced = isHostSynced();
  document.documentElement.classList.toggle("is-synced", synced);
  document.querySelectorAll<HTMLElement>(".tempo-sync-btn").forEach((b) => {
    b.classList.toggle("active", getSync());
    b.setAttribute("aria-pressed", getSync() ? "true" : "false");
  });
  document.querySelectorAll<HTMLButtonElement>('.synth-tempo [data-action^="tempo-"]:not(.tempo-sync-btn)').forEach((b) => {
    if (b.dataset.title === undefined) b.dataset.title = b.title;
    b.disabled = synced;
    b.title = synced ? "Tempo from the DAW (turn SYNC off to set your own)" : b.dataset.title;
  });
}

export function renderSynthPanelHtml(): string {
  const m = getMachine();
  const tempo = m.tempo
    ? `<div class="synth-tempo" role="group" aria-label="Tempo">
        <button type="button" class="synth-midi-btn tempo-step-btn" data-action="tempo-down" aria-label="Slower">−</button>
        <button type="button" class="synth-tempo-val" id="tempo-val" data-action="tempo-tap" title="Tempo (BPM). Tap in time to set it.">${fmtBpm(getTempo())}</button>
        <button type="button" class="synth-midi-btn tempo-step-btn" data-action="tempo-up" aria-label="Faster">+</button>
        <button type="button" class="synth-midi-btn tempo-tap-btn" data-action="tempo-tap" title="Tap in time to set the tempo">TAP</button>
        <button type="button" class="synth-midi-btn tempo-sync-btn${getSync() ? " active" : ""}" data-action="tempo-sync" aria-pressed="${getSync() ? "true" : "false"}" title="SYNC on: tempo and Play/Stop follow the DAW. Off: SY-1 keeps its own tempo.">SYNC</button>
      </div>`
    : "";
  return renderOriginalFaceplate({
    attributes:`class="synth-panel" dir="ltr" data-machine="${m.id}"`,machineName:m.name,
    machineOptions:`<select class="sr-only" id="machine-select" aria-hidden="true" tabindex="-1">${renderMachineOptions()}</select>`,
    studioButton:!(globalThis as any).__SY1_PLUGIN__?'<button type="button" class="synth-midi-btn synth-studio-btn" id="open-studio-btn" data-action="studio-open" title="Open SY-1 Studio multi-track recorder">Studio</button>':"",
    output:renderMasterKnob()+renderRecButton(),
    connections:`<div class="synth-conn-wrap">
          <button type="button" class="synth-conn-btn${connOpen ? " is-open" : ""}" id="conn-btn" data-action="conn-toggle" aria-label="Connections" aria-haspopup="dialog" aria-expanded="${connOpen ? "true" : "false"}" title="Connections">
            <svg class="conn-icon" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M2 12h4" />
              <rect x="6" y="8.5" width="6" height="7" rx="1.5" />
              <path d="M12 12h4.5" />
              <path d="M14.5 10.5v3" />
              <path d="M18 7v10" />
              <path d="M18 8.5h3a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1h-3" />
            </svg>
            <span class="conn-dot" id="conn-dot" aria-hidden="true"></span>
          </button>
          <div class="conn-pop" id="conn-pop" role="dialog" aria-label="Connections"${connOpen ? "" : " hidden"}>
            <div class="conn-pop-row">
              <button type="button" class="synth-midi-btn" id="midi-btn" data-action="midi-enable">MIDI</button>
              <span class="midi-led" id="midi-led" title="MIDI Activity" aria-hidden="true"></span>
              <button type="button" class="synth-midi-btn" id="midi-learn-btn" data-action="midi-learn" title="Click LEARN, click a knob, then move a MIDI CC">LEARN</button>
              <button type="button" class="synth-midi-btn midi-pickup-btn" id="midi-pickup-btn" data-action="midi-pickup" aria-pressed="false" title="PICKUP: a controller moves a knob only after it reaches the knob's position (no jumps)">PICKUP</button>
              <button type="button" class="synth-midi-btn synth-panic-btn" id="midi-panic-btn" data-action="synth-panic" title="Release all notes">PANIC</button>
              <button type="button" class="synth-midi-btn" id="engine-btn" data-action="engine-toggle" aria-pressed="false">HQ</button>
            </div>
            <div class="conn-pop-selects" id="conn-pop-selects" hidden>
              <select class="synth-midi-select" id="midi-device" aria-label="MIDI Input Device" hidden>${renderDeviceOptions()}</select>
              <select class="synth-midi-select" id="midi-channel" aria-label="MIDI Channel" hidden>${renderChannelOptions()}</select>
            </div>
            <div class="synth-midi-msg" id="midi-msg" role="status" aria-live="polite" hidden></div>
            <div class="conn-pop-row">
              <label>CC mode <select class="synth-midi-select" id="midi-mode" aria-label="MIDI CC mode">${MIDI_MODES.map((m) => `<option value="${m}"${m === getMidiMode() ? " selected" : ""}>${m === "absolute" ? "Absolute" : `Relative: ${m}`}</option>`).join("")}</select></label>
              ${HOST_MIDI ? `<button type="button" class="synth-midi-btn" id="plugin-midi-out" data-action="plugin-midi-out" aria-pressed="${getPluginMidiOut()}">DRUM MIDI OUT ${getPluginMidiOut() ? "ON" : "OFF"}</button>` : ""}
            </div>
            <button type="button" class="synth-midi-btn conn-daw-btn" data-daw="open">DAW &amp; RECORDING…</button>
          </div>
        </div>`,
    previous:'data-action="preset-prev"',presetLabel:renderPresetButton(),next:'data-action="preset-next"',
    tempo,tabs:renderInstrumentTabs(allowAllPage()?[{id:"all",label:"ALL"},...m.pages]:m.pages),
    sections:m.sections.map(renderSection).join(""),
    hint:"Drag a knob up/down (or scroll / arrow keys) · double-click to reset · right-click (or long-press in LEARN) unmaps CC · keys A W S E D F T G Y H U J K · Z/X = octave"
  });
}

export function updateSynthPresetDOM(): void {
  if(document.getElementById("sy1-panel")?.dataset.studioInstrument)return;
  const btn = document.getElementById("preset-btn");
  if (btn) btn.innerHTML = renderPresetButton();
}

export function updateMidiBarDOM(): void {
  const unavail = isMidiUnavailable();
  const enabled = !unavail && isMidiEnabled();
  const learnUnavail = isLearnUnavailable();
  const learning = isLearnMode();
  const midiBtn = document.getElementById("midi-btn") as HTMLButtonElement | null;
  const devSelect = document.getElementById("midi-device") as HTMLSelectElement | null;
  const chSelect = document.getElementById("midi-channel") as HTMLSelectElement | null;
  const selectsWrap = document.getElementById("conn-pop-selects");
  const learnBtn = document.getElementById("midi-learn-btn") as HTMLButtonElement | null;
  const msgEl = document.getElementById("midi-msg");
  const connDot = document.getElementById("conn-dot");

  if (midiBtn) {
    midiBtn.disabled = unavail;
    midiBtn.classList.toggle("is-disabled", unavail);
    midiBtn.classList.toggle("active", enabled);
    midiBtn.setAttribute("aria-disabled", unavail ? "true" : "false");
    midiBtn.textContent = enabled ? "MIDI ON" : "MIDI";
  }
  // in the plugin MIDI comes from the DAW: only the channel choice is shown (no devices)
  if (selectsWrap) selectsWrap.hidden = !enabled && !HOST_MIDI;
  if (devSelect) {
    devSelect.hidden = !enabled;
    if (enabled) { devSelect.innerHTML = renderDeviceOptions(); devSelect.value = getSelectedMidiDevice(); }
  }
  if (chSelect) {
    chSelect.hidden = !enabled && !HOST_MIDI;
    if (enabled || HOST_MIDI) chSelect.value = String(getSelectedMidiChannel());
  }
  if (learnBtn) {
    learnBtn.disabled = learnUnavail;
    learnBtn.classList.toggle("is-disabled", learnUnavail);
    learnBtn.classList.toggle("active", learning);
    learnBtn.setAttribute("aria-disabled", learnUnavail ? "true" : "false");
  }
  const pickupBtn = document.getElementById("midi-pickup-btn");
  if (pickupBtn) {
    pickupBtn.classList.toggle("active", getMidiPickup());
    pickupBtn.setAttribute("aria-pressed", getMidiPickup() ? "true" : "false");
  }
  if (connDot) {
    connDot.className =
      "conn-dot" +
      (learning
        ? " is-learn"
        : enabled
          ? " is-connected"
          : unavail
            ? " is-unavailable"
            : "");
  }
  if (msgEl) {
    const statusMsg = getMidiStatusMessage();
    if (learning) {
      const target = getLearnTargetParam();
      const what = HOST_MIDI ? "a MIDI controller (or a SY-1 macro in the DAW)" : "a CC";
      msgEl.textContent = target ? `Move ${what} to map ${target}…` : `Click a knob, then move ${what}…`;
    } else if (HOST_MIDI) {
      msgEl.textContent = "";
    } else if (unavail) {
      msgEl.textContent = "MIDI needs Chrome or Edge on desktop or Android";
    } else if (statusMsg) {
      msgEl.textContent = statusMsg;
    } else {
      msgEl.textContent = "";
    }
    msgEl.hidden = !msgEl.textContent;
  }
  updateMidiLearnDOM();
  const modeSelect = document.getElementById("midi-mode") as HTMLSelectElement | null;
  if (modeSelect) modeSelect.value = getMidiMode();
  const outBtn = document.getElementById("plugin-midi-out");
  if (outBtn) {
    outBtn.textContent = `DRUM MIDI OUT ${getPluginMidiOut() ? "ON" : "OFF"}`;
    outBtn.setAttribute("aria-pressed", String(getPluginMidiOut()));
  }
}

function updateEngineDOM(): void {
  const btn = document.getElementById("engine-btn");
  if (!btn) return;
  const wantHQ = getEngine() === "hq";
  const failed = getHQState() === "failed";
  btn.classList.toggle("active", wantHQ && !failed);
  btn.classList.toggle("is-unavailable", failed);
  btn.setAttribute("aria-pressed", wantHQ && !failed ? "true" : "false");
  btn.title = failed
    ? "HQ engine is not available in this browser. Playing with the Classic engine."
    : wantHQ
      ? "HQ engine on (unison, glide, tunings, ornaments). Click to use the Classic engine."
      : "Classic engine on (unison, tunings and ornaments are ignored). Click to use the HQ engine.";
}

/** Re-render registered overlay panels (machine switch) and bind element listeners. */
const renderHooks = new Set<() => void>();
export function setPanelRenderHook(fn: () => void): void {
  renderHooks.add(fn);
}

let studioOpenHandler: (() => void) | null = null;
export function setStudioOpenHandler(fn: (() => void) | null): void {
  studioOpenHandler = fn;
}

export function renderPanel(): void {
  const container = document.getElementById("sy1-panel");
  if (!container || container.dataset.studioInstrument) return;
  container.innerHTML = renderSynthPanelHtml();
  bindPanelElements();
  let page = "";
  try { page = localStorage.getItem(PAGE_KEY(getMachine().id)) || ""; } catch (e) {}
  setPanelPage(page);
  updateEngineDOM();
  updateMidiBarDOM();
  renderHooks.forEach((fn) => fn());
  updateSyncDOM();
  fitPanel();
}

/**
 * The keyboard has one fixed height on every machine. When a machine's panel
 * does not fit in the space left above it, the panel switches to pages (tabs)
 * on any screen size, so nothing overflows and the keys never shrink.
 */
export function fitPanel(): void {
  if (document.getElementById("sy1-panel")?.dataset.studioInstrument) return;
  const shell = document.querySelector<HTMLElement>(".sy1-shell");
  const panel = document.querySelector<HTMLElement>("#sy1-panel .synth-panel");
  if (!shell || !panel) return;
  shell.classList.remove("is-fit-paged");
  applyPageVisibility();
  const secs = panel.querySelector<HTMLElement>(".synth-sections");
  const overflowing = () =>
    panel.scrollHeight > panel.clientHeight + 1 ||
    (!!secs && secs.scrollHeight > secs.clientHeight + 1) ||
    document.documentElement.scrollHeight > window.innerHeight + 1 ||
    Array.from(panel.querySelectorAll<HTMLElement>(".synth-sec")).some(
      (s) => getComputedStyle(s).display !== "none" && s.scrollHeight > s.clientHeight + 1
    );
  if (!allowAllPage() && currentPage !== "all" && !window.matchMedia(PAGED_MQ).matches && overflowing()) {
    shell.classList.add("is-fit-paged");
  }
  applyPageVisibility();
}

let fitRaf = 0;
window.addEventListener("resize", () => {
  cancelAnimationFrame(fitRaf);
  fitRaf = requestAnimationFrame(fitPanel);
});

function bindPanelElements(): void {
  document.getElementById("midi-mode")?.addEventListener("change", (e) => setMidiMode((e.target as HTMLSelectElement).value as MidiMode));
  const devSelect = document.getElementById("midi-device") as HTMLSelectElement | null;
  if (devSelect) devSelect.addEventListener("change", () => setSelectedMidiDevice(devSelect.value));
  const chSelect = document.getElementById("midi-channel") as HTMLSelectElement | null;
  if (chSelect) chSelect.addEventListener("change", () => setSelectedMidiChannel(parseInt(chSelect.value, 10) || 0));
  const machineSel = document.getElementById("machine-select") as HTMLSelectElement | null;
  if (machineSel) machineSel.addEventListener("change", () => { setMachine(machineSel.value); });
  document.querySelectorAll<HTMLSelectElement>("#sy1-panel .synth-param-select").forEach((sel) => {
    sel.addEventListener("change", () => { setSynthParam(sel.getAttribute("data-param")!, sel.value); sel.blur(); });
  });

  // Swipe left/right on empty panel space to change page (paged layouts only).
  const sections = document.querySelector("#sy1-panel .synth-sections") as HTMLElement | null;
  if (sections) {
    let swipe: { x: number; y: number; id: number } | null = null;
    sections.addEventListener("pointerdown", (e) => {
      const t = e.target as HTMLElement;
      if (!isPagedLayout() || t.closest(".sk, .vec-svg, .vec-axis-pill, button, select")) return;
      swipe = { x: e.clientX, y: e.clientY, id: e.pointerId };
    });
    sections.addEventListener("pointerup", (e) => {
      if (!swipe || e.pointerId !== swipe.id) return;
      const dx = e.clientX - swipe.x;
      const dy = e.clientY - swipe.y;
      swipe = null;
      if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) stepPanelPage(dx < 0 ? 1 : -1);
    });
    sections.addEventListener("pointercancel", () => { swipe = null; });
  }
  bindVectorPad();
}

export function initPanelInteractions(): void {
  onParamChange((key) => {
    queueVisualUpdate("param:" + key, () => updateSynthControlDOM(key));
    if (key === "fmAlgo") queueVisualUpdate("fm-algo", () => refreshCustom("fm-algo"));
    else if (key.startsWith("euc")) queueVisualUpdate("euclid-rings", () => refreshCustom("euclid-rings"));
    else if (key === "vecX" || key === "vecY" || key.startsWith("orbit")) queueVisualUpdate("vector", () => updateVectorPadDOM(true));
  });
  onPresetChange(() => queueVisualUpdate("preset", updateSynthPresetDOM));
  if ((globalThis as any).__SY1_PLUGIN__) onPluginVisualFrame(() => {
    if (getMachine().id === "nishapur") updateVectorPadDOM(false);
  });
  // a new kit can rename the slots (BONGO, COWBELL...): update every slot name in place
  onDrumKitChange(() => {
    refreshCustom("drum-steps");
    refreshCustom("drum-voice");
    renderKeyboard();
  });
  onMidiStateChange(() => queueVisualUpdate("midi-bar", updateMidiBarDOM));
  onDawChange(() => updateMidiBarDOM());
  onEngineChange(updateEngineDOM);
  onMachineChange(() => { connOpen = false; renderPanel(); });
  onTempoChange((bpm) => {
    document.querySelectorAll(".synth-tempo-val:not([data-st-project-bpm])").forEach((el) => (el.textContent = fmtBpm(bpm)));
  });
  onSyncChange(updateSyncDOM);
  updateSyncDOM();
  onDrumChange(() => {
    queueVisualUpdate("drum-transport", () => refreshCustom("drum-transport"));
    queueVisualUpdate("drum-steps", () => refreshCustom("drum-steps"));
  });
  onDrumStep((s) => {
    if (document.getElementById("sy1-panel")?.dataset.studioInstrument) return;
    document.querySelectorAll(".drum-step.playing").forEach((el) => el.classList.remove("playing"));
    if (s >= 0) {
      const el = document.querySelector(`.drum-step[data-index="${s}"]`);
      if (el) el.classList.add("playing");
    }
  });

  // Blink MIDI LED without per-message DOM queries or object allocations
  let ledEl: HTMLElement | null = null;
  let ledTimer: ReturnType<typeof setTimeout> | null = null;
  const clearLed = () => { if (ledEl) ledEl.classList.remove("is-on"); ledTimer = null; };
  setMidiActivityCallback(() => {
    if (!ledEl || !ledEl.isConnected) ledEl = document.getElementById("midi-led");
    if (!ledEl) return;
    ledEl.classList.add("is-on");
    if (ledTimer !== null) clearTimeout(ledTimer);
    ledTimer = setTimeout(clearLed, 90);
  });

  // Close Connections popover on outside tap or Escape
  document.addEventListener("pointerdown", (e) => {
    if (!connOpen) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.closest("#conn-pop") || t.closest("#conn-btn"))) return;
    setConnOpen(false);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && connOpen) {
      setConnOpen(false);
    }
  });

  document.addEventListener("click", (e) => {
    if ((e.target as HTMLElement)?.closest?.("[data-daw='open']")) { setConnOpen(false); return; }
    const btn = (e.target as HTMLElement)?.closest?.("[data-action]") as HTMLElement | null;
    if (!btn) return;
    const action = btn.getAttribute("data-action");
    switch (action) {
      case "conn-toggle": {
        setConnOpen(!connOpen);
        break;
      }
      case "studio-open": {
        setConnOpen(false);
        if (studioOpenHandler) studioOpenHandler();
        break;
      }
      case "synth-set": {
        if (isLearnMode()) return;
        const param = btn.getAttribute("data-param");
        const val = btn.getAttribute("data-value");
        if (param && val !== null) setSynthParam(param, val);
        break;
      }
      case "synth-toggle": {
        const param = btn.getAttribute("data-param")!;
        const on = btn.getAttribute("data-on")!;
        const off = btn.getAttribute("data-off")!;
        setSynthParam(param, getSynthPatch()[param] === on ? off : on);
        break;
      }
      case "synth-page": {
        const page = btn.getAttribute("data-page");
        if (page) setPanelPage(page);
        break;
      }
      case "preset-prev": stepPreset(-1); break;
      case "preset-next": stepPreset(1); break;
      case "tempo-down": if (!isHostSynced()) setTempo(Math.round(getTempo()) - 1); break;
      case "tempo-up": if (!isHostSynced()) setTempo(Math.round(getTempo()) + 1); break;
      case "tempo-tap": if (!isHostSynced()) tapTempo(); break;
      case "tempo-sync": setSync(!getSync()); break;
      case "engine-toggle": switchEngine(getEngine() === "hq" ? "classic" : "hq"); break;
      case "midi-enable": if (!isMidiUnavailable()) requestMidi(); break;
      case "midi-learn": if (!isLearnUnavailable()) toggleLearnMode(); break;
      case "midi-pickup": setMidiPickup(!getMidiPickup()); break;
      case "plugin-midi-out": setPluginMidiOut(!getPluginMidiOut()); break;
      case "synth-panic": stopDrums(); allNotesOff(); break;
      // drum machine
      case "drum-play":
        if (isDrumPlaying()) stopDrums();
        else { prepareAudio(); startDrums(); }
        break;
      case "drum-pattern": selectPattern(Number(btn.getAttribute("data-index"))); break;
      case "drum-len": setPatternLength(Number(btn.getAttribute("data-len"))); break;
      case "drum-edit": stepEdit = STEP_EDITS[(STEP_EDITS.indexOf(stepEdit) + 1) % STEP_EDITS.length]; refreshCustom("drum-transport"); break;
      case "drum-clear": clearPattern(); break;
      case "drum-export": exportDrumMidi((e as MouseEvent).shiftKey); break;
      case "drum-voice": {
        drumVoice = btn.getAttribute("data-voice") as DrumVoice;
        refreshCustom("drum-steps");
        refreshCustom("drum-voice");
        playDrum(drumVoice, 0.9);
        break;
      }
      case "drum-step": editStep(drumVoice, Number(btn.getAttribute("data-index")), stepEdit); break;
      default: break;
    }
  });
}

/** Pads trigger drums and select the voice for editing. */
export function selectDrumVoiceForNote(midi: number): void {
  const v = (Object.keys(DRUM_NOTES) as DrumVoice[]).find((k) => DRUM_NOTES[k] === midi);
  if (v && v !== drumVoice) {
    drumVoice = v;
    refreshCustom("drum-steps");
    refreshCustom("drum-voice");
  }
}
