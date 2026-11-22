import { snapRegionTick } from "../studio/midi-regions";
import { bindRegionControls, renderRegions } from "./studio-regions";
/**
 * SY-1 Studio UI — Phase 4 Professional DAW Workspace
 *
 * Strictly web-only (never initialized when window.__SY1_PLUGIN__ is present).
 * Every control binds exclusively to SY1StudioEngine / SY1TrackEngine without
 * touching standalone synth.ts state or standalone localStorage keys.
 *
 * Architecture:
 * - Fixed Top Transport Bar (Play, Stop, Rec, Loop, Clock, BPM, Bars, Save, Open, Export, Keys)
 * - Collapsible Left Instrument Browser (7 HQEngine Iranian city synths, categories, favorites, search)
 * - Full-Width Arrangement Timeline (zoom, horizontal scroll, aligned sticky track headers, draggable loop)
 * - Resizable Bottom Dock switching between Piano Roll, Mixer, and unchanged Original Synth Instrument View
 */

import { getMasterVolume, setMasterVolume } from "../engine/bus";
import { DRUM_NOTES, DrumVoice } from "../engine/drums";
import { escapeHtml, SYNTH_PARAMS, synthDenorm, synthNorm } from "../engine/params";
import { fmtBpm } from "../engine/tempo";
import type { MachineDef } from "../machines/types";
import { parseStudioProjectJson, projectFilename } from "../studio/project-io";
import { studioStorage } from "../studio/storage";
import { studioEngine } from "../studio/studio-engine";
import {
  getStudioMachineDef,
  STUDIO_DRUM_MACHINES,
  STUDIO_MACHINES,
  STUDIO_SYNTH_MACHINES,
  SY1TrackEngine
} from "../studio/track-engine";
import {
  STUDIO_BAR_PRESETS,
  STUDIO_MAX_TRACKS,
  STUDIO_TICKS_PER_BAR,
  StudioSavedProjectMeta
} from "../studio/types";
import { machineArt } from "./machine-browser";
import {
  renderStudioInstrumentHtml,
  setStudioSelectedDrumVoice,
  updateStudioInstrumentKnobDOM,
  updateStudioVectorPadDOM
} from "./studio-instrument";
import { bindPianoRollEvents, renderPianoRollHtml, syncPianoRollScroll } from "./studio-piano-roll";

export type StudioDockTab = "piano-roll" | "mixer" | "instrument";
type StatusTone = "info" | "ok" | "error";

const STUDIO_FAVS_KEY = "sy1_studio_favs";
const TRACK_COLORS = ["#f0a233", "#4ba3d9", "#55b884", "#cf6e8a"];

let activeDockTab: StudioDockTab = "piano-roll";
let dockExpanded = false;
let dockCollapsed = false;
let dockHeightPx = 310;

let browserOpen = true;
let browserMachineId = "all"; // "all" or specific city synth id
let browserCategory = "All";
let browserSearch = "";
let browserFavsOnly = false;
let studioFavs = new Set<string>();

let arrZoom = 1; // 1..4
let arrScrollLeft = 0;
let arrScrollTop = 0;
let instPageFilter = "all";
let exportMenuOpen = false;
let pendingClearTrackId: string | null = null;
let keysVisible = false;

let rafId = 0;
let initialized = false;
let exporting = false;
let exportingStems = false;
let statusMessage = "";
let statusTone: StatusTone = "info";
let openDrawerVisible = false;
let savedProjectsCache: StudioSavedProjectMeta[] = [];
let autosaveMetaCache: { name: string; updatedAt: number; trackCount: number; bpm: number; bars: number } | null = null;
let autosaveTimer: ReturnType<typeof setTimeout> | null = null;
let suppressNextAutosave = false;
let onCloseStudio: (() => void) | null = null;

let cachedPlayheadEls: HTMLElement[] = [];
let cachedClockEl: HTMLElement | null = null;
let cachedMeterEls: { id: string; el: HTMLElement; axis: "x" | "y" }[] = [];
let lastPlayheadPctStr = "";
let lastClockStr = "";

// Load Studio-isolated favorites (never touches standalone sy1.* keys)
try {
  const raw = localStorage.getItem(STUDIO_FAVS_KEY);
  if (raw) {
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) {
      arr.forEach((k) => {
        if (typeof k === "string") studioFavs.add(k);
      });
    }
  }
} catch (e) {}

function saveStudioFavs(): void {
  try {
    localStorage.setItem(STUDIO_FAVS_KEY, JSON.stringify(Array.from(studioFavs)));
  } catch (e) {}
}

function favKey(machineId: string, presetId: string): string {
  return `${machineId}:${presetId}`;
}

/** Diagnostics helper: true only while transport playhead animation loop is actively running. */
export function isStudioPlayheadLoopActive(): boolean {
  return rafId !== 0;
}

export function getStudioDockTab(): StudioDockTab {
  return activeDockTab;
}

export function setStudioDockTab(tab: StudioDockTab): void {
  activeDockTab = tab;
  dockCollapsed = false;
  renderStudioPanel();
}

function setStatus(msg: string, tone: StatusTone = "info"): void {
  statusMessage = msg;
  statusTone = tone;
}

function fmtSavedTime(ts: number): string {
  try {
    const d = new Date(ts);
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch (e) {
    return "";
  }
}

function fmtDb(vol: number): string {
  if (vol <= 0.001) return "-∞ dB";
  const db = 20 * Math.log10(vol);
  return `${db >= 0 ? "+" : ""}${db.toFixed(1)} dB`;
}

function fmtPan(pan: number): string {
  if (Math.abs(pan) < 0.04) return "C";
  return pan < 0 ? `L${Math.round(-pan * 100)}` : `R${Math.round(pan * 100)}`;
}

function trackColor(idx: number): string {
  return TRACK_COLORS[idx % TRACK_COLORS.length];
}

export async function saveStudioProjectNow(): Promise<boolean> {
  const proj = studioEngine.exportProject();
  const res = await studioStorage.saveProject(proj);
  if (!res.ok) {
    setStatus(res.message, "error");
    renderStudioPanel();
    return false;
  }
  const autoRes = await studioStorage.saveAutosave(proj);
  if (!autoRes.ok) {
    setStatus(autoRes.message, "error");
    renderStudioPanel();
    return false;
  }
  setStatus(`Saved "${proj.name}"`, "ok");
  if (openDrawerVisible) await refreshOpenDrawerData();
  renderStudioPanel();
  return true;
}

export async function importStudioProjectJson(text: string): Promise<{ ok: boolean; error?: string }> {
  const parsed = parseStudioProjectJson(text);
  if (!parsed.ok) {
    setStatus(parsed.error, "error");
    renderStudioPanel();
    return { ok: false, error: parsed.error };
  }
  try {
    suppressNextAutosave = true;
    await studioEngine.loadProject(parsed.project);
    pendingClearTrackId = null;
    await studioStorage.saveAutosave(studioEngine.exportProject());
    openDrawerVisible = false;
    exportMenuOpen = false;
    setStatus(`Imported "${parsed.project.name}"`, "ok");
    renderStudioPanel();
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to import project.";
    setStatus(msg, "error");
    renderStudioPanel();
    return { ok: false, error: msg };
  } finally {
    suppressNextAutosave = false;
  }
}

async function refreshOpenDrawerData(): Promise<void> {
  const [listRes, autoRes] = await Promise.all([
    studioStorage.listProjects(),
    studioStorage.loadAutosave()
  ]);
  if (listRes.ok) {
    savedProjectsCache = listRes.data;
  } else {
    savedProjectsCache = [];
    setStatus(listRes.message, "error");
  }
  if (autoRes.ok && autoRes.data) {
    const p = autoRes.data.project;
    autosaveMetaCache = {
      name: p.name,
      updatedAt: autoRes.data.updatedAt,
      trackCount: p.tracks.length,
      bpm: p.bpm,
      bars: p.bars
    };
  } else {
    autosaveMetaCache = null;
    if (!autoRes.ok) setStatus(autoRes.message, "error");
  }
}

export async function hydrateStudioFromStorage(): Promise<boolean> {
  if (!studioStorage.isAvailable()) return false;
  const res = await studioStorage.loadAutosave();
  if (!res.ok) {
    setStatus(res.message, "error");
    return false;
  }
  if (!res.data) return false;
  try {
    suppressNextAutosave = true;
    await studioEngine.loadProject(res.data.project);
    setStatus(`Restored "${res.data.project.name}"`, "ok");
    return true;
  } catch (err) {
    setStatus("Autosave recovery skipped: invalid data", "error");
    return false;
  } finally {
    suppressNextAutosave = false;
  }
}

export function scheduleAutosave(): void {
  if (suppressNextAutosave || !studioStorage.isAvailable()) return;
  if (autosaveTimer !== null) clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(() => {
    autosaveTimer = null;
    void flushAutosave();
  }, 800);
}

async function flushAutosave(): Promise<void> {
  if (!studioStorage.isAvailable()) return;
  const res = await studioStorage.saveAutosave(studioEngine.exportProject());
  if (!res.ok && res.kind === "quota") {
    setStatus(res.message, "error");
    renderStudioPanel();
  }
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function machineOptionsHtml(selectedMachineId: string): string {
  const synthOpts = STUDIO_SYNTH_MACHINES.map(
    (m) => `<option value="${escapeHtml(m.id)}"${m.id === selectedMachineId ? " selected" : ""}>${escapeHtml(m.name)}</option>`
  ).join("");
  const drumOpts = STUDIO_DRUM_MACHINES.map(
    (m) => `<option value="${escapeHtml(m.id)}"${m.id === selectedMachineId ? " selected" : ""}>${escapeHtml(m.name)} (Drums)</option>`
  ).join("");
  return `<optgroup label="Synthesizers">${synthOpts}</optgroup><optgroup label="Drum Machines">${drumOpts}</optgroup>`;
}

function presetGroupsHtml(machineId: string, selectedId: string): string {
  const m = getStudioMachineDef(machineId);
  let html = selectedId === "custom" ? `<option value="custom" selected>Custom (Edited)</option>` : "";
  if (m.kind === "drums" && m.kits && m.kits.length > 0) {
    html += `<optgroup label="Drum Kits">`;
    for (const k of m.kits) {
      const val = `kit:${k.id}`;
      html += `<option value="${escapeHtml(val)}"${val === selectedId ? " selected" : ""}>${escapeHtml(k.name)}</option>`;
    }
    html += `</optgroup>`;
  }
  const groups = new Map<string, { id: string; name: string }[]>();
  for (const p of m.presets) {
    let list = groups.get(p.group);
    if (!list) {
      list = [];
      groups.set(p.group, list);
    }
    list.push({ id: p.id, name: p.name });
  }
  groups.forEach((items, groupName) => {
    html += `<optgroup label="${escapeHtml(groupName)}">`;
    for (const item of items) {
      html += `<option value="${escapeHtml(item.id)}"${item.id === selectedId ? " selected" : ""}>${escapeHtml(item.name)}</option>`;
    }
    html += `</optgroup>`;
  });
  return html;
}

function midiChannelOptionsHtml(selected: number): string {
  let html = `<option value="0"${selected === 0 ? " selected" : ""}>Ch All</option>`;
  for (let ch = 1; ch <= 16; ch++) {
    html += `<option value="${ch}"${selected === ch ? " selected" : ""}>Ch ${ch}</option>`;
  }
  return html;
}

// ------------------------------------------------------------ Instrument Browser ----

function renderInstrumentBrowserHtml(focused: SY1TrackEngine): string {
  const machines: readonly MachineDef[] = STUDIO_MACHINES;
  const activeMachines =
    browserMachineId === "all"
      ? machines
      : browserMachineId === "synths"
        ? STUDIO_SYNTH_MACHINES
        : browserMachineId === "drums"
          ? STUDIO_DRUM_MACHINES
          : machines.filter((m) => m.id === browserMachineId);

  // Collect categories across active machines
  const catSet = new Set<string>();
  for (const m of activeMachines) {
    for (const p of m.presets) catSet.add(p.group);
  }
  const categories = ["All", ...Array.from(catSet)];
  const effCategory = categories.includes(browserCategory) ? browserCategory : "All";

  const q = browserSearch.trim().toLowerCase();
  const entries: { machine: MachineDef; id: string; name: string; group: string; fav: boolean }[] = [];

  for (const m of activeMachines) {
    for (const p of m.presets) {
      const isFav = studioFavs.has(favKey(m.id, p.id));
      if (browserFavsOnly && !isFav) continue;
      if (effCategory !== "All" && p.group !== effCategory) continue;
      if (
        q &&
        !p.name.toLowerCase().includes(q) &&
        !p.group.toLowerCase().includes(q) &&
        !m.name.toLowerCase().includes(q) &&
        !(m.role || "").toLowerCase().includes(q)
      ) {
        continue;
      }
      entries.push({ machine: m, id: p.id, name: p.name, group: p.group, fav: isFav });
    }
  }

  return `
    <aside class="st-browser${browserOpen ? "" : " is-collapsed"}" id="st-browser" aria-label="Instrument Browser"${browserOpen ? "" : " hidden"}>
      <div class="st-br-head">
        <div class="st-br-title-row">
          <span class="st-br-title">Instruments</span>
          <span class="st-br-target">→ ${escapeHtml(focused.name)}</span>
          <button type="button" class="st-icon-btn" data-st-action="toggle-browser" aria-label="Close instrument browser" title="Hide Browser">✕</button>
        </div>
        <div class="st-br-search-row">
          <input type="search" class="st-br-search" id="st-browser-search" value="${escapeHtml(browserSearch)}" placeholder="Search synths, drums, presets…" aria-label="Search instruments and presets" />
          <button type="button" class="st-btn st-br-fav-btn${browserFavsOnly ? " is-active" : ""}" id="st-browser-fav-btn" data-st-action="browser-toggle-favs" aria-pressed="${browserFavsOnly}" title="Show favorites only">★</button>
        </div>
      </div>

      <div class="st-br-machines" role="listbox" aria-label="Iranian city synthesizers and drum machines">
        <div class="st-br-filter-row">
          <button type="button" class="st-br-fchip${browserMachineId === "all" ? " is-active" : ""}" data-st-action="browser-machine" data-st-machine="all">All (${machines.length})</button>
          <button type="button" class="st-br-fchip${browserMachineId === "synths" ? " is-active" : ""}" data-st-action="browser-machine" data-st-machine="synths">Synths (${STUDIO_SYNTH_MACHINES.length})</button>
          <button type="button" class="st-br-fchip${browserMachineId === "drums" ? " is-active" : ""}" data-st-action="browser-machine" data-st-machine="drums">Drums (${STUDIO_DRUM_MACHINES.length})</button>
        </div>
        ${machines
          .map((m) => {
            const active = browserMachineId === m.id;
            const loaded = focused.machineId === m.id;
            return `<button type="button" class="st-br-mcard${active ? " is-active" : ""}${loaded ? " is-loaded" : ""}" data-st-action="browser-machine" data-st-machine="${escapeHtml(m.id)}" aria-selected="${active}">
              <span class="st-br-mart">${machineArt(m)}</span>
              <span class="st-br-minfo">
                <span class="st-br-mname">${escapeHtml(m.name)}${m.kind === "drums" ? " · Drums" : ""}</span>
                <span class="st-br-mrole">${escapeHtml(m.role)}</span>
              </span>
            </button>`;
          })
          .join("")}
      </div>

      <label class="st-br-cats">
        <span>Category</span>
        <select id="st-browser-category" aria-label="Preset category">
        ${categories
          .map(
            (cat) =>
              `<option value="${escapeHtml(cat)}"${effCategory === cat ? " selected" : ""}>${escapeHtml(cat)}</option>`
          )
          .join("")}
        </select>
      </label>

      <div class="st-br-list" id="st-browser-list" role="listbox" aria-label="Presets">
        ${
          entries.length > 0
            ? entries
                .map((e) => {
                  const isCurrent = focused.machineId === e.machine.id && focused.presetId === e.id;
                  return `<div class="st-br-item${isCurrent ? " is-current" : ""}">
                    <button type="button" class="st-br-preset-btn" data-st-action="browser-pick-preset" data-st-machine="${escapeHtml(e.machine.id)}" data-st-preset="${escapeHtml(e.id)}" aria-selected="${isCurrent}">
                      <span class="st-br-pname">${escapeHtml(e.name)}</span>
                      <span class="st-br-pmeta">${escapeHtml(e.machine.name)} · ${escapeHtml(e.group)}</span>
                    </button>
                    <button type="button" class="st-br-star${e.fav ? " is-fav" : ""}" data-st-action="browser-star" data-st-machine="${escapeHtml(e.machine.id)}" data-st-preset="${escapeHtml(e.id)}" aria-pressed="${e.fav}" aria-label="${e.fav ? "Remove favorite" : "Add favorite"}">★</button>
                  </div>`;
                })
                .join("")
            : `<div class="st-br-empty">${browserFavsOnly ? "No favorite presets yet. Tap ★ on any preset." : "No matching presets."}</div>`
        }
      </div>
    </aside>`;
}

// ------------------------------------------------------------ Arrangement Timeline ----

function renderRulerMarks(bars: number, zoom: number): string {
  const effectiveBars = bars / Math.max(1, zoom);
  const step = effectiveBars <= 16 ? 1 : effectiveBars <= 32 ? 2 : effectiveBars <= 64 ? 4 : effectiveBars <= 128 ? 8 : 16;
  let html = "";
  for (let b = 0; b < bars; b += step) {
    const pct = (b / bars) * 100;
    html += `<span class="st-ruler-mark" style="left:${pct.toFixed(4)}%">${b + 1}</span>`;
  }
  return html;
}

function renderLaneGrid(bars: number, zoom: number): string {
  const effectiveBars = bars / Math.max(1, zoom);
  const step = effectiveBars <= 16 ? 1 : effectiveBars <= 64 ? 4 : effectiveBars <= 128 ? 8 : 16;
  let html = "";
  for (let b = 0; b < bars; b += step) {
    const pct = (b / bars) * 100;
    const major = b % (step * 4) === 0;
    html += `<span class="st-lane-barline${major ? " is-major" : ""}" style="left:${pct.toFixed(4)}%"></span>`;
  }
  return html;
}

// ------------------------------------------------------------ Mixer View ----

function renderMixerHtml(tracks: readonly SY1TrackEngine[], focused: SY1TrackEngine): string {
  const masterVol = getMasterVolume();
  const strips = tracks
    .map((t, idx) => {
      const color = trackColor(idx);
      const isFocused = t.id === focused.id;
      const mDef = getStudioMachineDef(t.machineId);
      const panStr = fmtPan(t.pan);
      return `<div class="st-mix-strip${isFocused ? " is-focused" : ""}" data-mix-track="${escapeHtml(t.id)}" style="--trk-color:${color}">
        <div class="st-mix-top">
          <button type="button" class="st-mix-name" data-st-action="focus-track" data-track-id="${escapeHtml(t.id)}">${escapeHtml(t.name)}</button>
          <span class="st-mix-sub" title="${escapeHtml(mDef.name)} · ${escapeHtml(t.presetName)}">${escapeHtml(mDef.name)} · ${escapeHtml(t.presetName)}</span>
        </div>
        <div class="st-mix-pan">
          <span class="st-mix-lbl" data-st-pan-lbl="${escapeHtml(t.id)}">${panStr}</span>
          <input type="range" class="st-range" min="-1" max="1" step="0.02" value="${t.pan.toFixed(2)}" data-st-range="pan" data-track-id="${escapeHtml(t.id)}" aria-label="${escapeHtml(t.name)} mixer pan" />
        </div>
        <div class="st-mix-btns">
          <button type="button" class="st-btn st-mini-btn is-rec${t.armed ? " is-active" : ""}" data-st-action="toggle-arm" data-track-id="${escapeHtml(t.id)}" aria-pressed="${t.armed}" title="Record Arm">R</button>
          <button type="button" class="st-btn st-mini-btn is-mute${t.mute ? " is-active" : ""}" data-st-action="toggle-mute" data-track-id="${escapeHtml(t.id)}" aria-pressed="${t.mute}" title="Mute">M</button>
          <button type="button" class="st-btn st-mini-btn is-solo${t.solo ? " is-active" : ""}" data-st-action="toggle-solo" data-track-id="${escapeHtml(t.id)}" aria-pressed="${t.solo}" title="Solo">S</button>
        </div>
        <div class="st-mix-fader-row">
          <div class="st-mix-meter" aria-hidden="true">
            <div class="st-mix-meter-fill" data-st-meter="${escapeHtml(t.id)}" style="transform:scaleY(0)"></div>
          </div>
          <div class="st-mix-vfader-wrap">
            <input type="range" class="st-vrange" min="0" max="1" step="0.01" value="${t.volume.toFixed(2)}" data-st-range="volume" data-track-id="${escapeHtml(t.id)}" aria-label="${escapeHtml(t.name)} mixer fader" />
          </div>
        </div>
        <div class="st-mix-db" data-st-db-lbl="${escapeHtml(t.id)}">${fmtDb(t.volume)}</div>
        <label class="st-mix-routing">MIDI input
          <select class="st-select" data-st-select="channel" data-track-id="${escapeHtml(t.id)}" aria-label="${escapeHtml(mDef.name)} MIDI input channel">${midiChannelOptionsHtml(t.midiChannel)}</select>
        </label>
      </div>`;
    })
    .join("");

  return `
    <div class="st-mixer" id="st-mixer">
      <div class="st-mix-channels">${strips}</div>
      <div class="st-mix-strip is-master">
        <div class="st-mix-top">
          <span class="st-mix-name">Master</span>
          <span class="st-mix-sub">Stereo Out</span>
        </div>
        <div class="st-mix-pan">
          <span class="st-mix-lbl">Stereo</span>
        </div>
        <div class="st-mix-btns">
          <span class="st-mix-tag">24-bit Bus</span>
        </div>
        <div class="st-mix-fader-row">
          <div class="st-mix-meter is-master" aria-hidden="true">
            <div class="st-mix-meter-fill" data-st-meter="master" style="transform:scaleY(0)"></div>
          </div>
          <div class="st-mix-vfader-wrap">
            <input type="range" class="st-vrange" min="0" max="1" step="0.01" value="${masterVol.toFixed(2)}" data-st-master-vol="1" aria-label="Master output volume" />
          </div>
        </div>
        <div class="st-mix-db" id="st-master-db">${fmtDb(masterVol * masterVol)}</div>
      </div>
    </div>`;
}

// ------------------------------------------------------------ Full Studio Shell ----

function renderStudioHtml(): string {
  const tr = studioEngine.getTransportSnapshot();
  const tracks = studioEngine.getTracks();
  const focused = studioEngine.getFocusedTrack();
  const focusedMachine = getStudioMachineDef(focused.machineId);

  const loopLeftPct = ((tr.loopStartBar - 1) / tr.bars) * 100;
  const loopWidthPct = ((tr.loopEndBar - tr.loopStartBar + 1) / tr.bars) * 100;
  const playheadPct = tr.totalTicks > 0 ? (tr.currentTick / tr.totalTicks) * 100 : 0;

  const barButtons = STUDIO_BAR_PRESETS.map(
    (b) =>
      `<button type="button" class="st-btn st-bar-btn${tr.bars === b ? " is-active" : ""}" data-st-action="set-bars" data-st-bars="${b}">${b}</button>`
  ).join("");

  const laneZoomStyle = arrZoom > 1 ? `min-width:${Math.round(arrZoom * 100)}%` : "";

  const trackRows = tracks
    .map((t, idx) => {
      const color = trackColor(idx);
      const isFocused = t.id === focused.id;
      const panStr = fmtPan(t.pan);
      const noteCount = t.getNoteCount();
      const mDef = getStudioMachineDef(t.machineId);
      const noteUnit = t.isDrumTrack() ? (noteCount === 1 ? "hit" : "hits") : noteCount === 1 ? "note" : "notes";

      return `<div class="st-track${isFocused ? " is-focused" : ""}" data-track-id="${escapeHtml(t.id)}" data-track-idx="${idx}" style="--trk-color:${color}">
        <div class="st-track-ctl">
          <div class="st-track-top">
            <button type="button" class="st-track-title st-track-focus" data-st-action="focus-track" data-track-id="${escapeHtml(t.id)}" aria-label="Focus ${escapeHtml(mDef.name)}" title="Focus instrument">●</button>
            <select class="st-select st-machine-sel" data-st-select="machine" data-track-id="${escapeHtml(t.id)}" aria-label="${escapeHtml(t.name)} instrument" title="Select instrument for ${escapeHtml(t.name)}">
              ${machineOptionsHtml(t.machineId)}
            </select>
            <button type="button" class="st-track-city" data-st-action="open-track-instrument" data-track-id="${escapeHtml(t.id)}" title="Open ${escapeHtml(mDef.name)} instrument panel">Edit</button>
          </div>
          <div class="st-track-preset-row">
            <button type="button" class="st-btn st-mini-btn is-rec${t.armed ? " is-active" : ""}" data-st-action="toggle-arm" data-track-id="${escapeHtml(t.id)}" aria-pressed="${t.armed}" title="Record Arm">R</button>
            <button type="button" class="st-btn st-mini-btn is-mute${t.mute ? " is-active" : ""}" data-st-action="toggle-mute" data-track-id="${escapeHtml(t.id)}" aria-pressed="${t.mute}" title="Mute">M</button>
            <button type="button" class="st-btn st-mini-btn is-solo${t.solo ? " is-active" : ""}" data-st-action="toggle-solo" data-track-id="${escapeHtml(t.id)}" aria-pressed="${t.solo}" title="Solo">S</button>
            <select class="st-select st-preset-sel" data-st-select="preset" data-track-id="${escapeHtml(t.id)}" aria-label="${escapeHtml(t.name)} preset">
              ${presetGroupsHtml(t.machineId, t.presetId)}
            </select>
          </div>
          <div class="st-track-mid">
            <div class="st-fader-wrap" title="Track Volume">
              <span class="st-fader-lbl">Vol</span>
              <input type="range" class="st-range" min="0" max="1" step="0.01" value="${t.volume.toFixed(2)}" data-st-range="volume" data-track-id="${escapeHtml(t.id)}" aria-label="${escapeHtml(t.name)} volume" />
            </div>
            <div class="st-fader-wrap st-pan-wrap" title="Track Pan (${panStr})">
              <span class="st-fader-lbl" data-st-pan-lbl="${escapeHtml(t.id)}">${panStr}</span>
              <input type="range" class="st-range" min="-1" max="1" step="0.02" value="${t.pan.toFixed(2)}" data-st-range="pan" data-track-id="${escapeHtml(t.id)}" aria-label="${escapeHtml(t.name)} pan" />
            </div>
          </div>
          <div class="st-track-meta">
            <div class="st-hdr-meter" aria-hidden="true"><span class="st-hdr-meter-fill" data-st-hdr-meter="${escapeHtml(t.id)}" style="transform:scaleX(0)"></span></div>
            <span class="st-track-stats" data-st-meta="${escapeHtml(t.id)}">${noteCount} ${noteUnit}</span>
            <div class="st-track-tools">
              <button type="button" class="st-btn st-tiny-btn" data-st-action="clear-track" data-track-id="${escapeHtml(t.id)}"${studioEngine.regions.regions(t.id).length === 0 ? " disabled" : ""}>Clear</button>
            </div>
          </div>
        </div>
        <div class="st-lane" data-st-lane="1" data-track-id="${escapeHtml(t.id)}" style="${laneZoomStyle}" title="Click to focus track & seek · Double-click to edit in Piano Roll">
          <div class="st-lane-grid">${renderLaneGrid(tr.bars, arrZoom)}</div>
          <div class="st-lane-notes">${renderRegions(t, tr.totalTicks, color)}</div>
          <div class="st-playhead" data-st-playhead="1" style="left:${playheadPct.toFixed(3)}%"></div>
        </div>
      </div>`;
    })
    .join("");

  let dockContent = "";
  if (!dockCollapsed) {
    if (activeDockTab === "piano-roll") {
      dockContent = renderPianoRollHtml();
    } else if (activeDockTab === "mixer") {
      dockContent = renderMixerHtml(tracks, focused);
    } else {
      dockContent = renderStudioInstrumentHtml(focused, instPageFilter);
    }
  }

  const canUndo = studioEngine.regions.canUndo() && !tr.recording;
  const canRedo = studioEngine.regions.canRedo() && !tr.recording;
  const pendingClearTrack = pendingClearTrackId ? studioEngine.getTrack(pendingClearTrackId) : null;
  if (pendingClearTrackId && !pendingClearTrack) pendingClearTrackId = null;
  const clearDialogHtml = pendingClearTrack
    ? (() => {
        const clearMachine = getStudioMachineDef(pendingClearTrack.machineId);
        const clearRegions = studioEngine.regions.regions(pendingClearTrack.id).length;
        const clearNotes = pendingClearTrack.getNoteCount();
        const regionLabel = clearRegions === 1 ? "1 MIDI region" : `${clearRegions} MIDI regions`;
        const noteUnit = pendingClearTrack.isDrumTrack()
          ? clearNotes === 1 ? "hit" : "hits"
          : clearNotes === 1 ? "note" : "notes";
        return `<div class="st-dialog-backdrop">
          <div class="st-dialog-scrim" data-st-action="cancel-clear-track" aria-hidden="true"></div>
          <div class="st-dialog" id="st-clear-dialog" role="alertdialog" aria-modal="true" aria-labelledby="st-clear-dialog-title" aria-describedby="st-clear-dialog-desc">
            <h2 class="st-dialog-title" id="st-clear-dialog-title">Clear ${escapeHtml(pendingClearTrack.name)}?</h2>
            <p class="st-dialog-desc" id="st-clear-dialog-desc">Remove ${regionLabel} (${clearNotes} ${noteUnit}) from ${escapeHtml(clearMachine.name)}. You can restore this track immediately with Undo.</p>
            <div class="st-dialog-actions">
              <button type="button" class="st-btn" id="st-clear-cancel-btn" data-st-action="cancel-clear-track">Cancel</button>
              <button type="button" class="st-btn is-danger" id="st-clear-confirm-btn" data-st-action="confirm-clear-track" data-track-id="${escapeHtml(pendingClearTrack.id)}">Clear Track</button>
            </div>
          </div>
        </div>`;
      })()
    : "";

  return `
    <div class="st-daw${dockExpanded ? " is-dock-expanded" : ""}${dockCollapsed ? " is-dock-collapsed" : ""}" dir="ltr" style="--st-dock-h:${dockHeightPx}px">
      <header class="st-topbar">
        <div class="st-tb-left">
          <button type="button" class="st-btn" id="st-back-btn" data-st-action="close-studio" title="Return to standalone SY-1 Synth">← Synth</button>
          <div class="st-brand">SY-1 <span>Studio</span></div>
          <button type="button" class="st-btn${browserOpen ? " is-active" : ""}" id="st-browser-toggle" data-st-action="toggle-browser" aria-pressed="${browserOpen}" title="Toggle Instrument Browser">Browser</button>
          <input type="text" class="st-name-input" id="st-project-name" value="${escapeHtml(tr.projectName)}" maxlength="80" aria-label="Project name" placeholder="Untitled Session" />
        </div>

        <div class="st-tb-center" role="group" aria-label="Master Transport">
          <div class="st-seg">
            <button type="button" class="st-btn is-play${tr.playing ? " is-active" : ""}" id="st-play-btn" data-st-action="play" aria-pressed="${tr.playing}">${tr.playing ? "Playing" : "▶ Play"}</button>
            <button type="button" class="st-btn" id="st-stop-btn" data-st-action="stop">■ Stop</button>
            <button type="button" class="st-btn is-rec${tr.recording ? " is-active" : ""}" id="st-rec-btn" data-st-action="record" aria-pressed="${tr.recording}">● Rec</button>
            <button type="button" class="st-btn${tr.loopEnabled ? " is-active" : ""}" id="st-loop-btn" data-st-action="toggle-loop" aria-pressed="${tr.loopEnabled}">Loop</button>
          </div>
          <div class="st-clock" id="st-clock" aria-label="Transport position">${String(tr.currentBar).padStart(2, "0")} : ${tr.currentBeat}</div>
          <div class="st-seg" role="group" aria-label="Tempo">
            <button type="button" class="st-btn st-step-btn" data-st-action="bpm-down" aria-label="Decrease BPM">−</button>
            <button type="button" class="st-btn st-bpm-val" id="st-bpm-val" data-st-action="bpm-tap" title="Tap tempo">${fmtBpm(tr.bpm)} BPM</button>
            <button type="button" class="st-btn st-step-btn" data-st-action="bpm-up" aria-label="Increase BPM">+</button>
          </div>
          <div class="st-bars-group" role="group" aria-label="Timeline length in bars">
            ${barButtons}
            <input type="number" class="st-bar-input" id="st-bars-custom" min="1" max="512" value="${tr.bars}" aria-label="Custom bar count" title="Custom bar length (1–512)" />
          </div>
        </div>

        <div class="st-tb-right">
          <button type="button" class="st-btn" id="st-save-btn" data-st-action="save-project">Save</button>
          <button type="button" class="st-btn${openDrawerVisible ? " is-active" : ""}" id="st-open-btn" data-st-action="toggle-open-drawer">Open</button>
          <div class="st-export-wrap">
            <button type="button" class="st-btn${exportMenuOpen ? " is-active" : ""}" id="st-export-menu-btn" data-st-action="toggle-export-menu" aria-haspopup="menu" aria-expanded="${exportMenuOpen}">${exporting ? "Rendering…" : exportingStems ? "Stems…" : "More ▾"}</button>
            <div class="st-export-menu" id="st-export-menu" role="menu"${exportMenuOpen ? "" : " hidden"}>
              <button type="button" class="st-menu-item" role="menuitem" id="st-export-wav" data-st-action="export-wav"${exporting || exportingStems ? " disabled" : ""}>24-bit WAV Mix</button>
              <button type="button" class="st-menu-item" role="menuitem" id="st-export-stems" data-st-action="export-stems"${exporting || exportingStems ? " disabled" : ""}>24-bit WAV Stems</button>
              <button type="button" class="st-menu-item" role="menuitem" id="st-export-midi" data-st-action="export-midi">MIDI (SMF-1)</button>
              ${tr.hasLiveTake ? `<button type="button" class="st-menu-item" role="menuitem" id="st-export-live" data-st-action="export-live">Live Take WAV (${tr.liveTakeDurationSec.toFixed(1)}s)</button>` : ""}
              <div class="st-menu-sep"></div>
              <button type="button" class="st-menu-item" role="menuitem" id="st-export-project" data-st-action="export-project">Export .sy1studio</button>
              <button type="button" class="st-menu-item" role="menuitem" id="st-import-project-btn" data-st-action="trigger-import-project">Import .sy1studio</button>
              <div class="st-menu-sep"></div>
              <button type="button" class="st-menu-item" role="menuitem" data-st-action="metronome" aria-pressed="${studioEngine.getRecordingSettings().metronome}">Metronome: ${studioEngine.getRecordingSettings().metronome ? "On" : "Off"}</button>
              <button type="button" class="st-menu-item" role="menuitem" data-st-action="count-in" aria-pressed="${studioEngine.getRecordingSettings().countIn}">1-bar Count-in: ${studioEngine.getRecordingSettings().countIn ? "On" : "Off"}</button>
              <label class="st-click-level">Click volume <input id="st-click-volume" type="range" min="0" max="1" step="0.01" value="${studioEngine.getRecordingSettings().clickVolume}" aria-label="Metronome volume"></label>
            </div>
            <input type="file" id="st-import-file" accept=".sy1studio,.json,application/json" hidden />
          </div>
          <button type="button" class="st-btn${keysVisible ? " is-active" : ""}" id="st-keys-toggle" data-st-action="toggle-keys" aria-pressed="${keysVisible}" title="Show or hide on-screen keyboard">Keys</button>
        </div>
      </header>

      ${
        tr.liveRecWarning || statusMessage
          ? `<div class="st-status-strip">
              ${tr.liveRecWarning ? `<span class="st-export-status is-error" id="st-rec-warn">${escapeHtml(tr.liveRecWarning)}</span>` : ""}
              ${statusMessage ? `<span class="st-export-status${statusTone === "error" ? " is-error" : statusTone === "ok" ? " is-ok" : ""}" id="st-status">${escapeHtml(statusMessage)}</span>` : ""}
            </div>`
          : ""
      }

      ${
        openDrawerVisible
          ? `<div class="st-drawer" id="st-open-drawer" role="region" aria-label="Saved Projects">
              <div class="st-drawer-head">
                <span>Saved Projects &amp; Recovery</span>
                <button type="button" class="st-btn st-tiny-btn" data-st-action="toggle-open-drawer">Close</button>
              </div>
              <div class="st-drawer-list">
                ${
                  autosaveMetaCache
                    ? `<div class="st-drawer-item">
                        <div>
                          <div class="st-drawer-item-title">Autosave Recovery · ${escapeHtml(autosaveMetaCache.name)}</div>
                          <div class="st-drawer-item-meta">${autosaveMetaCache.trackCount} tracks · ${autosaveMetaCache.bpm} BPM · ${autosaveMetaCache.bars} bars · ${escapeHtml(fmtSavedTime(autosaveMetaCache.updatedAt))}</div>
                        </div>
                        <button type="button" class="st-btn st-tiny-btn" data-st-action="restore-autosave">Restore</button>
                      </div>`
                    : ""
                }
                ${
                  savedProjectsCache.length > 0
                    ? savedProjectsCache
                        .map(
                          (p) => `<div class="st-drawer-item" data-project-id="${escapeHtml(p.id)}">
                            <div>
                              <div class="st-drawer-item-title">${escapeHtml(p.name)}</div>
                              <div class="st-drawer-item-meta">${p.trackCount} tracks · ${p.noteCount} notes · ${p.bpm} BPM · ${p.bars} bars · ${escapeHtml(fmtSavedTime(p.savedAt))}</div>
                            </div>
                            <div class="st-drawer-actions">
                              <button type="button" class="st-btn st-tiny-btn" data-st-action="open-saved-project" data-project-id="${escapeHtml(p.id)}">Open</button>
                              <button type="button" class="st-btn st-tiny-btn" data-st-action="delete-saved-project" data-project-id="${escapeHtml(p.id)}">Delete</button>
                            </div>
                          </div>`
                        )
                        .join("")
                    : `<div class="st-drawer-empty">No saved projects in browser storage yet. Click Save or Import .sy1studio.</div>`
                }
              </div>
            </div>`
          : ""
      }

      <div class="st-workspace">
        ${renderInstrumentBrowserHtml(focused)}
        ${browserOpen ? `<div class="st-browser-backdrop" data-st-action="toggle-browser" aria-hidden="true"></div>` : ""}

        <div class="st-main">
          <section class="st-arr-wrap" aria-label="Arrangement Timeline">
            <div class="st-arr-toolbar">
              <div class="st-arr-tb-left">
                <span class="st-arr-count">Tracks ${tracks.length}/${STUDIO_MAX_TRACKS}</span>
                ${
                  tracks.length < STUDIO_MAX_TRACKS
                    ? `<button type="button" class="st-btn st-tiny-btn" id="st-add-track-btn" data-st-action="add-track">+ Track</button>`
                    : ""
                }
                <div class="st-seg st-history-seg" role="group" aria-label="Edit history">
                  <button type="button" class="st-btn st-tiny-btn st-hist-btn" id="st-undo-btn" data-st-action="undo" aria-label="Undo" title="Undo (Cmd/Ctrl+Z)"${canUndo ? "" : " disabled"}>↶ Undo</button>
                  <button type="button" class="st-btn st-tiny-btn st-hist-btn" id="st-redo-btn" data-st-action="redo" aria-label="Redo" title="Redo (Shift+Cmd/Ctrl+Z)"${canRedo ? "" : " disabled"}>↷ Redo</button>
                </div>
                <span class="st-arr-loop-info${tr.loopEnabled ? " is-on" : ""}">Loop Bar ${tr.loopStartBar}–${tr.loopEndBar}</span>
              </div>
              <div class="st-arr-tb-right">
                <span class="st-arr-zoom-lbl">Zoom</span>
                <button type="button" class="st-btn st-tiny-btn" data-st-action="arr-zoom-out" aria-label="Zoom out timeline">−</button>
                <input type="range" class="st-range st-arr-zoom-range" id="st-arr-zoom" min="1" max="4" step="0.25" value="${arrZoom.toFixed(2)}" aria-label="Arrangement horizontal zoom" />
                <button type="button" class="st-btn st-tiny-btn" data-st-action="arr-zoom-in" aria-label="Zoom in timeline">+</button>
                <button type="button" class="st-btn st-tiny-btn${arrZoom === 1 ? " is-active" : ""}" data-st-action="arr-zoom-fit">Fit</button>
              </div>
            </div>

            <div class="st-arr-scroll" id="st-arr-scroll">
              <div class="st-arr-canvas">
                <div class="st-ruler-row">
                  <div class="st-ruler-label">Track</div>
                  <div class="st-ruler" id="st-ruler" data-st-ruler="1" style="${laneZoomStyle}" title="Click or drag to seek · drag loop edges to adjust loop range">
                    ${
                      tr.loopEnabled
                        ? `<div class="st-ruler-loop" style="left:${loopLeftPct.toFixed(3)}%;width:${loopWidthPct.toFixed(3)}%">
                            <span class="st-loop-handle is-start" data-st-loop-handle="start" title="Drag to set loop start bar"></span>
                            <span class="st-loop-handle is-end" data-st-loop-handle="end" title="Drag to set loop end bar"></span>
                          </div>`
                        : ""
                    }
                    <div class="st-ruler-marks">${renderRulerMarks(tr.bars, arrZoom)}</div>
                    <div class="st-playhead" data-st-playhead="1" style="left:${playheadPct.toFixed(3)}%"></div>
                  </div>
                </div>
                <div class="st-tracks">${trackRows}</div>
              </div>
            </div>
          </section>

          <div class="st-dock-resizer" id="st-dock-resizer" role="separator" aria-orientation="horizontal" aria-label="Resize bottom editor panel" title="Drag to resize · Double-click to reset height">
            <span class="st-dock-grip"></span>
          </div>

          <section class="st-dock" id="st-dock" aria-label="Studio Bottom Editor">
            <div class="st-dock-head">
              <div class="st-dock-tabs" role="tablist" aria-label="Studio views">
                <button type="button" class="st-dock-tab${activeDockTab === "piano-roll" && !dockCollapsed ? " is-active" : ""}" id="st-tab-pianoroll" role="tab" aria-selected="${activeDockTab === "piano-roll" && !dockCollapsed}" data-st-action="dock-tab" data-st-dock-tab="piano-roll">Piano Roll</button>
                <button type="button" class="st-dock-tab${activeDockTab === "mixer" && !dockCollapsed ? " is-active" : ""}" id="st-tab-mixer" role="tab" aria-selected="${activeDockTab === "mixer" && !dockCollapsed}" data-st-action="dock-tab" data-st-dock-tab="mixer">Mixer</button>
                <button type="button" class="st-dock-tab${activeDockTab === "instrument" && !dockCollapsed ? " is-active" : ""}" id="st-tab-instrument" role="tab" aria-selected="${activeDockTab === "instrument" && !dockCollapsed}" data-st-action="dock-tab" data-st-dock-tab="instrument">Instrument</button>
              </div>
              <div class="st-dock-focused">
                <span class="st-dock-track-name">${escapeHtml(focusedMachine.name)}</span>
                <span class="st-dock-track-sub">${escapeHtml(focused.presetName)}</span>
              </div>
              <div class="st-dock-actions">
                <div class="st-seg st-dock-history" role="group" aria-label="Edit history">
                  <button type="button" class="st-btn st-tiny-btn st-hist-btn" data-st-action="undo" aria-label="Undo" title="Undo (Cmd/Ctrl+Z)"${canUndo ? "" : " disabled"}>↶ Undo</button>
                  <button type="button" class="st-btn st-tiny-btn st-hist-btn" data-st-action="redo" aria-label="Redo" title="Redo (Shift+Cmd/Ctrl+Z)"${canRedo ? "" : " disabled"}>↷ Redo</button>
                </div>
                <button type="button" class="st-btn st-tiny-btn${dockExpanded ? " is-active" : ""}" id="st-dock-expand" data-st-action="dock-expand" aria-pressed="${dockExpanded}" title="Toggle full-height focused view">${dockExpanded ? "Split" : "Expand"}</button>
                <button type="button" class="st-btn st-tiny-btn" id="st-dock-collapse" data-st-action="dock-collapse" aria-pressed="${dockCollapsed}" title="Collapse or expand bottom panel">${dockCollapsed ? "Show" : "Hide"}</button>
              </div>
            </div>
            <div class="st-dock-body" id="st-dock-body"${dockCollapsed ? " hidden" : ""}>
              ${dockContent}
            </div>
          </section>
        </div>
      </div>
      ${clearDialogHtml}
    </div>`;
}

// ------------------------------------------------------------ Live Playhead & Meters ----

function updateMetersDOM(zeroOut = false): void {
  if (cachedMeterEls.length === 0) return;
  for (let i = 0; i < cachedMeterEls.length; i++) {
    const m = cachedMeterEls[i];
    let level = 0;
    if (!zeroOut) {
      if (m.id === "master") {
        level = studioEngine.readMasterMeterLevel();
      } else {
        const trk = studioEngine.getTrack(m.id);
        level = trk ? trk.readMeterLevel() : 0;
      }
    }
    const scaled = Math.min(1, Math.pow(level, 0.65));
    m.el.style.transform = m.axis === "y" ? `scaleY(${scaled.toFixed(3)})` : `scaleX(${scaled.toFixed(3)})`;
  }
}

function updatePlayheadOnly(): void {
  const container = document.getElementById("sy1-studio");
  if (!container || container.hidden) return;
  const pos = studioEngine.getPlayheadPosition();
  const pct = pos.totalTicks > 0 ? Math.max(0, Math.min(100, (pos.currentTick / pos.totalTicks) * 100)) : 0;
  const pctStr = pct.toFixed(3) + "%";
  if (pctStr !== lastPlayheadPctStr) {
    lastPlayheadPctStr = pctStr;
    for (let i = 0; i < cachedPlayheadEls.length; i++) {
      const line = cachedPlayheadEls[i];
      const region = line.closest<HTMLElement>("[data-pr-origin]");
      if (!region) line.style.left = pctStr;
      else {
        const local = pos.currentTick - Number(region.dataset.prOrigin);
        const length = Number(region.dataset.prTotalTicks);
        line.style.visibility = local >= 0 && local <= length ? "visible" : "hidden";
        line.style.left = `${Math.max(0, Math.min(100, local / length * 100))}%`;
      }
    }
  }
  const countInBeat = studioEngine.getCountInBeat();
  const clockStr = countInBeat ? `IN : ${countInBeat}` : `${String(pos.currentBar).padStart(2, "0")} : ${pos.currentBeat}`;
  if (cachedClockEl && clockStr !== lastClockStr) {
    lastClockStr = clockStr;
    cachedClockEl.textContent = clockStr;
  }
  updateMetersDOM(!studioEngine.isPlaying());
}

function startPlayheadLoop(): void {
  if (rafId || !studioEngine.isPlaying()) return;
  const step = () => {
    const container = document.getElementById("sy1-studio");
    if (!container || container.hidden || !studioEngine.isPlaying()) {
      rafId = 0;
      if (container && !container.hidden) updatePlayheadOnly();
      return;
    }
    updatePlayheadOnly();
    rafId = requestAnimationFrame(step);
  };
  rafId = requestAnimationFrame(step);
}

function stopPlayheadLoop(): void {
  if (rafId) {
    cancelAnimationFrame(rafId);
    rafId = 0;
  }
  updateMetersDOM(true);
}

function applyKeyboardVisibility(): void {
  const kbArea = document.querySelector<HTMLElement>(".kb-area");
  if (!kbArea) return;
  if (studioEngine.isActive()) {
    kbArea.hidden = !keysVisible;
  } else {
    kbArea.hidden = false;
  }
}

export function renderStudioPanel(): void {
  const container = document.getElementById("sy1-studio");
  if (!container || container.hidden) return;

  // Preserve active search input focus & caret across browser search updates
  const activeEl = document.activeElement as HTMLInputElement | null;
  const restoreNoteFocus = activeEl?.id === "st-pr-grid";
  const restoreSearch = activeEl?.id === "st-browser-search";
  const searchSelStart = restoreSearch ? activeEl.selectionStart : null;
  const searchSelEnd = restoreSearch ? activeEl.selectionEnd : null;

  const previousScroll = container.querySelector<HTMLElement>("#st-arr-scroll");
  if (previousScroll) arrScrollTop = previousScroll.scrollTop;
  container.innerHTML = renderStudioHtml();

  cachedPlayheadEls = Array.from(container.querySelectorAll<HTMLElement>("[data-st-playhead]"));
  cachedClockEl = document.getElementById("st-clock");
  cachedMeterEls = [];
  container.querySelectorAll<HTMLElement>("[data-st-meter]").forEach((el) => {
    const id = el.getAttribute("data-st-meter");
    if (id) cachedMeterEls.push({ id, el, axis: "y" });
  });
  container.querySelectorAll<HTMLElement>("[data-st-hdr-meter]").forEach((el) => {
    const id = el.getAttribute("data-st-hdr-meter");
    if (id) cachedMeterEls.push({ id, el, axis: "x" });
  });
  lastPlayheadPctStr = "";
  lastClockStr = "";

  const arrScrollEl = container.querySelector<HTMLElement>("#st-arr-scroll");
  if (arrScrollEl) {
    arrScrollEl.scrollLeft = arrScrollLeft;
    arrScrollEl.scrollTop = arrScrollTop;
  }

  if (activeDockTab === "piano-roll" && !dockCollapsed) {
    syncPianoRollScroll(container);
    if (restoreNoteFocus) container.querySelector<HTMLElement>("#st-pr-grid")?.focus({ preventScroll: true });
  }

  if (exportMenuOpen) {
    clampExportMenuToViewport(container);
  }

  if (restoreSearch) {
    const nextSearch = document.getElementById("st-browser-search") as HTMLInputElement | null;
    if (nextSearch) {
      nextSearch.focus();
      if (searchSelStart !== null && searchSelEnd !== null) {
        try {
          nextSearch.setSelectionRange(searchSelStart, searchSelEnd);
        } catch (e) {}
      }
    }
  }
}

function clampExportMenuToViewport(container: HTMLElement): void {
  const menu = container.querySelector<HTMLElement>("#st-export-menu");
  if (!menu || menu.hidden) return;
  menu.style.left = "";
  menu.style.right = "0";
  const r = menu.getBoundingClientRect();
  const vw = window.innerWidth;
  if (r.left < 8) {
    menu.style.right = "auto";
    menu.style.left = "0";
    const r2 = menu.getBoundingClientRect();
    if (r2.right > vw - 8) {
      const shift = vw - 8 - r2.right;
      menu.style.left = `${Math.round(shift)}px`;
    }
  } else if (r.right > vw - 8) {
    menu.style.right = `${Math.round(r.right - (vw - 8))}px`;
  }
}

function seekFromPointer(el: HTMLElement, clientX: number): void {
  const rect = el.getBoundingClientRect();
  if (rect.width <= 0) return;
  const ratio = Math.max(0, Math.min(0.9999, (clientX - rect.left) / rect.width));
  const tick = snapRegionTick(ratio * studioEngine.getTotalTicks(), studioEngine.regions.grid);
  studioEngine.seekToTick(tick);
  updatePlayheadOnly();
}

export function showStudioPianoRoll(): void {
  activeDockTab = "piano-roll";
  dockCollapsed = false;
  renderStudioPanel();
}

export function initStudioPanel(opts: { onClose: () => void }): void {
  onCloseStudio = opts.onClose;
  if (initialized) return;
  initialized = true;

  const container = document.getElementById("sy1-studio");
  if (!container) return;

  // Trap modal focus & intercept Escape/background shortcuts before region key handlers
  document.addEventListener(
    "keydown",
    (e) => {
      if (!pendingClearTrackId || container.hidden) return;
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        const restoreId = pendingClearTrackId;
        pendingClearTrackId = null;
        renderStudioPanel();
        container.querySelector<HTMLElement>(`button[data-st-action="clear-track"][data-track-id="${restoreId}"]`)?.focus();
        return;
      }
      if (e.key === "Tab") {
        const dialog = container.querySelector<HTMLElement>("#st-clear-dialog");
        const focusables = dialog ? Array.from(dialog.querySelectorAll<HTMLElement>("button:not(:disabled)")) : [];
        if (focusables.length > 0) {
          e.preventDefault();
          e.stopImmediatePropagation();
          const idx = focusables.indexOf(document.activeElement as HTMLElement);
          const next = idx < 0 ? 0 : (idx + (e.shiftKey ? -1 : 1) + focusables.length) % focusables.length;
          focusables[next]?.focus();
        }
        return;
      }
      const inDialog = (e.target as HTMLElement | null)?.closest("#st-clear-dialog");
      if (inDialog && (e.key === "Enter" || e.key === " ")) return;
      e.preventDefault();
      e.stopImmediatePropagation();
    },
    true
  );

  bindRegionControls(container, {
    render: renderStudioPanel,
    openEditor: showStudioPianoRoll,
    error: message => setStatus(message, "error")
  });

  // Responsive initial browser state: collapsed on narrow portrait screens so timeline has full width
  if (typeof window !== "undefined" && window.innerWidth <= 768) {
    browserOpen = false;
  }

  // Coalesce rapid state updates into a single microtask render
  let renderQueued = false;
  let draggingKnobParam: string | null = null;
  let draggingRange: { trackId: string; type: string } | null = null;
  let pendingAutosaveAfterDrag = false;

  const requestRender = () => {
    if (container.hidden) return;
    if (renderQueued) return;
    renderQueued = true;
    queueMicrotask(() => {
      renderQueued = false;
      renderStudioPanel();
    });
  };

  bindPianoRollEvents(container, requestRender, message => setStatus(message, "error"));

  const updateTrackRangeLabelsDOM = (trackId: string) => {
    const t = studioEngine.getTrack(trackId);
    if (!t) return;
    const panStr = fmtPan(t.pan);
    container.querySelectorAll<HTMLElement>(`[data-st-pan-lbl="${trackId}"]`).forEach((el) => {
      el.textContent = panStr;
    });
    container.querySelectorAll<HTMLElement>(`[data-st-db-lbl="${trackId}"]`).forEach((el) => {
      el.textContent = fmtDb(t.volume);
    });
    container.querySelectorAll<HTMLInputElement>(`input[data-st-range="volume"][data-track-id="${trackId}"]`).forEach((inp) => {
      if (document.activeElement !== inp) inp.value = t.volume.toFixed(2);
    });
    container.querySelectorAll<HTMLInputElement>(`input[data-st-range="pan"][data-track-id="${trackId}"]`).forEach((inp) => {
      if (document.activeElement !== inp) inp.value = t.pan.toFixed(2);
    });
    const metaEl = container.querySelector<HTMLElement>(`[data-st-meta="${trackId}"]`);
    if (metaEl) {
      const noteCount = t.getNoteCount();
      const noteUnit = t.isDrumTrack() ? (noteCount === 1 ? "hit" : "hits") : noteCount === 1 ? "note" : "notes";
      metaEl.textContent = `${noteCount} ${noteUnit}`;
    }
  };

  studioEngine.onChange(() => {
    if (studioEngine.isActive()) {
      if (draggingKnobParam || draggingRange) {
        pendingAutosaveAfterDrag = true;
      } else {
        scheduleAutosave();
      }
      if (studioEngine.isPlaying()) startPlayheadLoop();
      else stopPlayheadLoop();
    }
    if (container.hidden) return;
    if (draggingKnobParam) {
      updateStudioInstrumentKnobDOM(container, studioEngine.getFocusedTrack(), draggingKnobParam);
      return;
    }
    if (draggingRange) {
      updateTrackRangeLabelsDOM(draggingRange.trackId);
      return;
    }
    if (document.activeElement && (document.activeElement.id === "st-project-name" || document.activeElement.id === "st-browser-search")) {
      return;
    }
    requestRender();
  });

  // Preserve arrangement horizontal scroll
  container.addEventListener(
    "scroll",
    (e) => {
      const target = e.target as HTMLElement | null;
      if (target && target.id === "st-arr-scroll") {
        arrScrollLeft = target.scrollLeft;
        arrScrollTop = target.scrollTop;
      }
    },
    true
  );

  // Flush pending autosave cleanly on page hide / tab switch
  window.addEventListener("pagehide", () => {
    if (studioEngine.isActive() || studioEngine.getTransportSnapshot().recording) void flushAutosave();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden && (studioEngine.isActive() || studioEngine.getTransportSnapshot().recording)) void flushAutosave();
  });

  // Close Export menu on outside click
  document.addEventListener("click", (e) => {
    if (!exportMenuOpen) return;
    const t = e.target as HTMLElement | null;
    if (!t || !t.closest(".st-export-wrap")) {
      exportMenuOpen = false;
      renderStudioPanel();
    }
  });

  // ---- Click actions ----
  container.addEventListener("click", (e) => {
    const target = e.target as HTMLElement | null;
    if (!target) return;

    const btn = target.closest<HTMLElement>("[data-st-action]");
    if (btn) {
      const action = btn.getAttribute("data-st-action");
      const trackId = btn.getAttribute("data-track-id") || "";

      switch (action) {
        case "close-studio":
          if (onCloseStudio) onCloseStudio();
          break;
        case "toggle-browser":
          browserOpen = !browserOpen;
          renderStudioPanel();
          break;
        case "toggle-keys":
          keysVisible = !keysVisible;
          applyKeyboardVisibility();
          renderStudioPanel();
          break;
        case "toggle-export-menu":
          exportMenuOpen = !exportMenuOpen;
          renderStudioPanel();
          container.querySelector<HTMLElement>(exportMenuOpen ? "#st-export-menu [role='menuitem']:not(:disabled)" : "#st-export-menu-btn")?.focus();
          break;
        case "metronome":
          studioEngine.setRecordingSettings({metronome:!studioEngine.getRecordingSettings().metronome});
          container.querySelector<HTMLElement>("[data-st-action='metronome']")?.focus();
          break;
        case "count-in":
          studioEngine.setRecordingSettings({countIn:!studioEngine.getRecordingSettings().countIn});
          container.querySelector<HTMLElement>("[data-st-action='count-in']")?.focus();
          break;
        case "play":
          if (studioEngine.getTransportSnapshot().playing) void studioEngine.stop();
          else void studioEngine.play();
          break;
        case "stop":
          void studioEngine.stop();
          break;
        case "record":
          if (studioEngine.getTransportSnapshot().recording) void studioEngine.stop();
          else void studioEngine.record();
          break;
        case "toggle-loop":
          studioEngine.setLoopEnabled(!studioEngine.getTransportSnapshot().loopEnabled);
          break;
        case "bpm-down":
          studioEngine.setBpm(studioEngine.getBpm() - 1);
          break;
        case "bpm-up":
          studioEngine.setBpm(studioEngine.getBpm() + 1);
          break;
        case "bpm-tap":
          studioEngine.tapBpm();
          break;
        case "set-bars": {
          const b = Number(btn.getAttribute("data-st-bars"));
          if (b > 0) studioEngine.setBars(b);
          break;
        }
        case "add-track":
          studioEngine.addTrack();
          break;
        case "focus-track":
          if (trackId) studioEngine.setFocusedTrack(trackId);
          break;
        case "open-track-instrument":
          if (trackId) studioEngine.setFocusedTrack(trackId);
          activeDockTab = "instrument";
          dockCollapsed = false;
          renderStudioPanel();
          break;
        case "open-browser-for-track":
          browserOpen = true;
          renderStudioPanel();
          break;
        case "toggle-arm": {
          const t = studioEngine.getTrack(trackId);
          if (t) studioEngine.setTrackArmed(trackId, !t.armed);
          break;
        }
        case "toggle-mute": {
          const t = studioEngine.getTrack(trackId);
          if (t) studioEngine.setTrackMute(trackId, !t.mute);
          break;
        }
        case "toggle-solo": {
          const t = studioEngine.getTrack(trackId);
          if (t) studioEngine.setTrackSolo(trackId, !t.solo);
          break;
        }
        case "clear-track": {
          if (!trackId) break;
          if (studioEngine.getTransportSnapshot().recording) {
            setStatus("Stop recording before editing regions.", "error");
            renderStudioPanel();
            break;
          }
          const t = studioEngine.getTrack(trackId);
          if (!t || (studioEngine.regions.regions(trackId).length === 0 && t.events.length === 0)) {
            setStatus("Track is already empty.", "info");
            renderStudioPanel();
            break;
          }
          pendingClearTrackId = trackId;
          exportMenuOpen = false;
          renderStudioPanel();
          container.querySelector<HTMLElement>("#st-clear-cancel-btn")?.focus();
          break;
        }
        case "cancel-clear-track": {
          const restoreId = pendingClearTrackId;
          pendingClearTrackId = null;
          renderStudioPanel();
          if (restoreId) {
            container.querySelector<HTMLElement>(`button[data-st-action="clear-track"][data-track-id="${restoreId}"]`)?.focus();
          }
          break;
        }
        case "confirm-clear-track": {
          const targetId = trackId || pendingClearTrackId || "";
          pendingClearTrackId = null;
          if (targetId) {
            try {
              studioEngine.clearTrackClip(targetId);
              setStatus("Cleared MIDI regions — use Undo to restore.", "info");
            } catch (error) {
              setStatus(error instanceof Error ? error.message : String(error), "error");
            }
          }
          renderStudioPanel();
          const undoBtn = container.querySelector<HTMLButtonElement>("#st-undo-btn");
          if (undoBtn && !undoBtn.disabled) undoBtn.focus();
          break;
        }
        case "undo":
          if (!studioEngine.regions.canUndo()) break;
          try {
            studioEngine.regions.undo();
          } catch (error) {
            setStatus(error instanceof Error ? error.message : String(error), "error");
          }
          renderStudioPanel();
          break;
        case "redo":
          if (!studioEngine.regions.canRedo()) break;
          try {
            studioEngine.regions.redo();
          } catch (error) {
            setStatus(error instanceof Error ? error.message : String(error), "error");
          }
          renderStudioPanel();
          break;
        case "arr-zoom-in":
          arrZoom = Math.min(4, Math.round((arrZoom + 0.5) * 100) / 100);
          renderStudioPanel();
          break;
        case "arr-zoom-out":
          arrZoom = Math.max(1, Math.round((arrZoom - 0.5) * 100) / 100);
          renderStudioPanel();
          break;
        case "arr-zoom-fit":
          arrZoom = 1;
          arrScrollLeft = 0;
          renderStudioPanel();
          break;
        case "dock-tab": {
          const tab = btn.getAttribute("data-st-dock-tab") as StudioDockTab | null;
          if (tab) {
            activeDockTab = tab;
            dockCollapsed = false;
            renderStudioPanel();
          }
          break;
        }
        case "dock-expand":
          dockExpanded = !dockExpanded;
          if (dockExpanded) dockCollapsed = false;
          renderStudioPanel();
          break;
        case "dock-collapse":
          dockCollapsed = !dockCollapsed;
          if (dockCollapsed) dockExpanded = false;
          renderStudioPanel();
          break;
        case "inst-page": {
          const pg = btn.getAttribute("data-st-page") || "all";
          instPageFilter = pg;
          renderStudioPanel();
          break;
        }
        case "inst-preset-prev":
        case "inst-preset-next": {
          const ft = studioEngine.getFocusedTrack();
          const m = getStudioMachineDef(ft.machineId);
          const idx = m.presets.findIndex((p) => p.id === ft.presetId);
          const dir = action === "inst-preset-next" ? 1 : -1;
          const nextIdx = ((idx < 0 ? 0 : idx) + dir + m.presets.length) % m.presets.length;
          studioEngine.prepareAudioSync();
          studioEngine.setTrackMachinePreset(ft.id, m.id, m.presets[nextIdx].id);
          break;
        }
        case "browser-machine": {
          browserMachineId = btn.getAttribute("data-st-machine") || "all";
          browserCategory = "All";
          renderStudioPanel();
          break;
        }
        case "browser-toggle-favs": {
          browserFavsOnly = !browserFavsOnly;
          renderStudioPanel();
          break;
        }
        case "browser-star": {
          const mid = btn.getAttribute("data-st-machine") || "sy1";
          const pid = btn.getAttribute("data-st-preset") || "init";
          const k = favKey(mid, pid);
          if (studioFavs.has(k)) studioFavs.delete(k);
          else studioFavs.add(k);
          saveStudioFavs();
          renderStudioPanel();
          break;
        }
        case "browser-pick-preset": {
          const mid = btn.getAttribute("data-st-machine") || "sy1";
          const pid = btn.getAttribute("data-st-preset") || "init";
          const ft = studioEngine.getFocusedTrack();
          studioEngine.prepareAudioSync();
          studioEngine.setTrackMachinePreset(ft.id, mid, pid);
          instPageFilter = "all";
          // Gentle preview hit/note if not hold/arp
          if (ft.isDrumTrack()) {
            ft.noteOn(DRUM_NOTES.kick, 0.88);
          } else if (ft.patch.hold !== "on" && ft.patch.arpOn !== "on") {
            ft.noteOn(60, 0.78);
            setTimeout(() => ft.noteOff(60), 320);
          }
          break;
        }
        case "drum-select-voice": {
          const dv = btn.getAttribute("data-st-drum-voice") as DrumVoice | null;
          const tid = trackId || studioEngine.getFocusedTrack().id;
          if (dv && DRUM_NOTES[dv] !== undefined) {
            setStudioSelectedDrumVoice(tid, dv);
            renderStudioPanel();
          }
          break;
        }
        case "drum-audition": {
          const dv = btn.getAttribute("data-st-drum-voice") as DrumVoice | null;
          const ft = trackId ? studioEngine.getTrack(trackId) || studioEngine.getFocusedTrack() : studioEngine.getFocusedTrack();
          if (dv && DRUM_NOTES[dv] !== undefined) {
            setStudioSelectedDrumVoice(ft.id, dv);
            studioEngine.prepareAudioSync();
            ft.noteOn(DRUM_NOTES[dv], 0.9);
            renderStudioPanel();
          }
          break;
        }
        case "drum-pick-kit": {
          const kid = btn.getAttribute("data-st-kit") || "";
          const ft = trackId ? studioEngine.getTrack(trackId) || studioEngine.getFocusedTrack() : studioEngine.getFocusedTrack();
          if (kid) {
            studioEngine.prepareAudioSync();
            studioEngine.setTrackMachinePreset(ft.id, ft.machineId, `kit:${kid}`);
            ft.noteOn(DRUM_NOTES.kick, 0.88);
          }
          break;
        }
        case "param-choice": {
          const param = btn.getAttribute("data-st-param");
          const val = btn.getAttribute("data-st-value");
          if (param && val !== null) {
            studioEngine.prepareAudioSync();
            studioEngine.getFocusedTrack().setParam(param, val);
          }
          break;
        }
        case "param-toggle": {
          const param = btn.getAttribute("data-st-param");
          const on = btn.getAttribute("data-st-on") || "on";
          const off = btn.getAttribute("data-st-off") || "off";
          if (param) {
            studioEngine.prepareAudioSync();
            const ft = studioEngine.getFocusedTrack();
            ft.setParam(param, String(ft.patch[param]) === on ? off : on);
          }
          break;
        }
        case "save-project": {
          void saveStudioProjectNow();
          break;
        }
        case "toggle-open-drawer": {
          openDrawerVisible = !openDrawerVisible;
          if (openDrawerVisible) {
            void refreshOpenDrawerData().then(() => renderStudioPanel());
          } else {
            renderStudioPanel();
          }
          break;
        }
        case "open-saved-project": {
          const pid = btn.getAttribute("data-project-id") || "";
          if (!pid) break;
          void studioStorage.loadProject(pid).then(async (res) => {
            if (!res.ok) {
              setStatus(res.message, "error");
              renderStudioPanel();
              return;
            }
            if (!res.data) {
              setStatus("Saved project not found", "error");
              renderStudioPanel();
              return;
            }
            try {
              suppressNextAutosave = true;
              await studioEngine.loadProject(res.data);
              pendingClearTrackId = null;
              await studioStorage.saveAutosave(studioEngine.exportProject());
              openDrawerVisible = false;
              setStatus(`Opened "${res.data.name}"`, "ok");
            } catch (err) {
              setStatus(err instanceof Error ? err.message : "Failed to open project", "error");
            } finally {
              suppressNextAutosave = false;
              renderStudioPanel();
            }
          });
          break;
        }
        case "delete-saved-project": {
          const pid = btn.getAttribute("data-project-id") || "";
          if (!pid) break;
          void studioStorage.deleteProject(pid).then(async (res) => {
            if (!res.ok) setStatus(res.message, "error");
            else setStatus("Deleted saved project", "info");
            await refreshOpenDrawerData();
            renderStudioPanel();
          });
          break;
        }
        case "restore-autosave": {
          void studioStorage.loadAutosave().then(async (res) => {
            if (!res.ok || !res.data) {
              setStatus(res.ok ? "No autosave available" : res.message, "error");
              renderStudioPanel();
              return;
            }
            try {
              suppressNextAutosave = true;
              await studioEngine.loadProject(res.data.project);
              pendingClearTrackId = null;
              openDrawerVisible = false;
              setStatus(`Recovered "${res.data.project.name}"`, "ok");
            } catch (err) {
              setStatus(err instanceof Error ? err.message : "Recovery failed", "error");
            } finally {
              suppressNextAutosave = false;
              renderStudioPanel();
            }
          });
          break;
        }
        case "export-project": {
          exportMenuOpen = false;
          const proj = studioEngine.exportProject();
          downloadBlob(studioEngine.exportProjectBlob(), projectFilename(proj));
          setStatus(`Exported ${projectFilename(proj)}`, "ok");
          renderStudioPanel();
          break;
        }
        case "trigger-import-project": {
          exportMenuOpen = false;
          const inp = document.getElementById("st-import-file") as HTMLInputElement | null;
          if (inp) {
            inp.value = "";
            inp.click();
          }
          renderStudioPanel();
          break;
        }
        case "export-midi": {
          exportMenuOpen = false;
          const blob = studioEngine.exportMidiBlob();
          const bpm = Math.round(studioEngine.getBpm());
          downloadBlob(blob, `sy1-studio-${bpm}bpm.mid`);
          setStatus("Exported SMF-1 MIDI", "ok");
          renderStudioPanel();
          break;
        }
        case "export-wav": {
          exportMenuOpen = false;
          if (exporting || exportingStems) break;
          exporting = true;
          setStatus("Rendering 24-bit mix…", "info");
          renderStudioPanel();
          studioEngine
            .bounceArrangementWav()
            .then((take) => {
              downloadBlob(take.wav, `sy1-studio-${Math.round(take.bpm)}bpm-24bit.wav`);
              setStatus(`Mix WAV ${take.durationSec.toFixed(1)}s · 24-bit · ${take.sampleRate}Hz`, "ok");
            })
            .catch((err) => {
              setStatus(err instanceof Error ? err.message : "WAV bounce failed", "error");
            })
            .finally(() => {
              exporting = false;
              renderStudioPanel();
            });
          break;
        }
        case "export-stems": {
          exportMenuOpen = false;
          if (exporting || exportingStems) break;
          exportingStems = true;
          setStatus("Rendering stems…", "info");
          renderStudioPanel();
          studioEngine
            .bounceTrackStemsWav({
              onProgress: (done, total, trackName) => {
                if (done < total) {
                  setStatus(`Stem ${done + 1}/${total}: ${trackName}…`, "info");
                  renderStudioPanel();
                }
              }
            })
            .then((stems) => {
              stems.forEach((st, idx) => {
                setTimeout(() => downloadBlob(st.wav, st.filename), idx * 180);
              });
              const first = stems[0];
              setStatus(`Exported ${stems.length} stems · 24-bit · ${first.sampleRate}Hz`, "ok");
            })
            .catch((err) => {
              setStatus(err instanceof Error ? err.message : "Stem export failed", "error");
            })
            .finally(() => {
              exportingStems = false;
              renderStudioPanel();
            });
          break;
        }
        case "export-live": {
          exportMenuOpen = false;
          const live = studioEngine.getLastLiveTake();
          if (live) {
            downloadBlob(live.wav, `sy1-studio-live-${Math.round(live.bpm)}bpm-24bit.wav`);
            setStatus(`Live WAV ${live.durationSec.toFixed(1)}s · 24-bit`, "ok");
            renderStudioPanel();
          }
          break;
        }
        default:
          break;
      }
      return;
    }

    // Clicking a timeline lane focuses that track and seeks
    const lane = target.closest<HTMLElement>("[data-st-lane]");
    if (lane) {
      const tid = lane.getAttribute("data-track-id");
      if (tid) studioEngine.setFocusedTrack(tid);
      seekFromPointer(lane, e.clientX);
      return;
    }

    const ruler = target.closest<HTMLElement>("[data-st-ruler]");
    if (ruler && !target.closest("[data-st-loop-handle]")) {
      seekFromPointer(ruler, e.clientX);
    }
  });

  // ---- Selects & inputs ----
  container.addEventListener("change", (e) => {
    const el = e.target as HTMLInputElement | HTMLSelectElement | null;
    if (!el) return;

    if (el.id === "st-click-volume") {
      studioEngine.setRecordingSettings({clickVolume:Number(el.value)});
      return;
    }

    if (el.id === "st-browser-category") {
      browserCategory = el.value;
      renderStudioPanel();
      container.querySelector<HTMLSelectElement>("#st-browser-category")?.focus();
      return;
    }

    if (el.id === "st-project-name") {
      studioEngine.setProjectName(el.value);
      return;
    }
    if (el.id === "st-import-file") {
      const file = (el as HTMLInputElement).files?.[0];
      if (!file) return;
      file
        .text()
        .then((text) => importStudioProjectJson(text))
        .catch(() => {
          setStatus("Failed to read selected file.", "error");
          renderStudioPanel();
        });
      return;
    }
    if (el.id === "st-bars-custom") {
      studioEngine.setBars(Number(el.value));
      return;
    }
    if (el.id === "st-arr-zoom") {
      arrZoom = Math.max(1, Math.min(4, Number(el.value) || 1));
      renderStudioPanel();
      return;
    }
    const instSelectParam = el.getAttribute("data-st-param-select");
    if (instSelectParam) {
      studioEngine.prepareAudioSync();
      studioEngine.getFocusedTrack().setParam(instSelectParam, el.value);
      return;
    }
    const rangeType = el.getAttribute("data-st-range");
    if (rangeType) {
      if (draggingRange) {
        draggingRange = null;
        if (pendingAutosaveAfterDrag) {
          pendingAutosaveAfterDrag = false;
          scheduleAutosave();
        }
        renderStudioPanel();
      }
      return;
    }
    const selType = el.getAttribute("data-st-select");
    const trackId = el.getAttribute("data-track-id") || "";
    if (selType === "machine" && trackId) {
      studioEngine.prepareAudioSync();
      studioEngine.setTrackMachine(trackId, el.value);
      instPageFilter = "all";
      return;
    }
    if (selType === "preset" && trackId) {
      studioEngine.prepareAudioSync();
      if (el.value !== "custom") {
        const t = studioEngine.getTrack(trackId);
        if (t) studioEngine.setTrackMachinePreset(trackId, t.machineId, el.value);
      }
      return;
    }
    if (selType === "channel" && trackId) {
      studioEngine.setTrackMidiChannel(trackId, Number(el.value));
    }
  });

  // ---- Live inputs (volume, pan, master volume, zoom, search, project name) ----
  container.addEventListener("input", (e) => {
    const el = e.target as HTMLInputElement | null;
    if (!el) return;
    if (el.id === "st-project-name") {
      studioEngine.setProjectName(el.value);
      return;
    }
    if (el.id === "st-browser-search") {
      browserSearch = el.value;
      renderStudioPanel();
      return;
    }
    if (el.id === "st-arr-zoom") {
      arrZoom = Math.max(1, Math.min(4, Number(el.value) || 1));
      renderStudioPanel();
      return;
    }
    if (el.getAttribute("data-st-master-vol")) {
      const v = Number(el.value);
      setMasterVolume(v);
      const dbEl = document.getElementById("st-master-db");
      if (dbEl) dbEl.textContent = fmtDb(v * v);
      return;
    }
    const rangeType = el.getAttribute("data-st-range");
    const trackId = el.getAttribute("data-track-id") || "";
    if (!rangeType || !trackId) return;
    draggingRange = { trackId, type: rangeType };
    if (rangeType === "volume") studioEngine.setTrackVolume(trackId, Number(el.value));
    else if (rangeType === "pan") studioEngine.setTrackPan(trackId, Number(el.value));
    updateTrackRangeLabelsDOM(trackId);
  });

  // ---- Pointer interactions: Dock resizer, Loop handles, Ruler scrub, Embedded Original Synth Knobs ----
  let knobDrag: {
    key: string;
    startY: number;
    startX: number;
    startN: number;
    pointerId: number;
    el: HTMLElement;
  } | null = null;
  let rulerDrag: {
    el: HTMLElement;
    pointerId: number;
  } | null = null;
  let loopDrag: {
    edge: "start" | "end";
    rulerEl: HTMLElement;
    pointerId: number;
  } | null = null;
  let dockResizeDrag: {
    startY: number;
    startHeight: number;
    pointerId: number;
    dawEl: HTMLElement;
  } | null = null;

  let vecPadDrag: {
    svg: SVGSVGElement;
    pointerId: number;
  } | null = null;

  const updateVectorFromPointer = (svg: SVGSVGElement, clientX: number, clientY: number) => {
    const rect = svg.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const ux = ((clientX - rect.left) / rect.width) * 200;
    const uy = ((clientY - rect.top) / rect.height) * 200;
    const nx = Math.max(0, Math.min(1, (ux - 12) / 176));
    const ny = Math.max(0, Math.min(1, (uy - 12) / 176));
    const ft = studioEngine.getFocusedTrack();
    ft.setParam("vecX", nx);
    ft.setParam("vecY", ny);
    updateStudioVectorPadDOM(container, ft);
  };

  container.addEventListener("pointerdown", (e) => {
    if (e.button === 2) return;
    const target = e.target as HTMLElement | null;
    if (!target) return;

    // Nishapur embedded Vector XY pad drag
    const vecPad = target.closest<SVGSVGElement>("[data-st-vec-pad]");
    if (vecPad) {
      e.preventDefault();
      studioEngine.prepareAudioSync();
      draggingKnobParam = "vecX";
      vecPadDrag = { svg: vecPad, pointerId: e.pointerId };
      try { vecPad.setPointerCapture(e.pointerId); } catch (err) {}
      updateVectorFromPointer(vecPad, e.clientX, e.clientY);
      return;
    }

    // Dock horizontal splitter drag
    const resizer = target.closest<HTMLElement>("#st-dock-resizer");
    if (resizer) {
      e.preventDefault();
      const dawEl = container.querySelector<HTMLElement>(".st-daw");
      if (!dawEl) return;
      dockCollapsed = false;
      dockExpanded = false;
      dockResizeDrag = {
        startY: e.clientY,
        startHeight: dockHeightPx,
        pointerId: e.pointerId,
        dawEl
      };
      resizer.classList.add("is-dragging");
      try { resizer.setPointerCapture(e.pointerId); } catch (err) {}
      return;
    }

    // Track/Mixer range drag guard
    const rangeEl = target.closest<HTMLInputElement>("[data-st-range]");
    if (rangeEl) {
      const rangeType = rangeEl.getAttribute("data-st-range") || "";
      const trackId = rangeEl.getAttribute("data-track-id") || "";
      if (rangeType && trackId) {
        studioEngine.prepareAudioSync();
        draggingRange = { trackId, type: rangeType };
      }
      return;
    }

    // Draggable Loop Start/End handle on ruler
    const loopHandle = target.closest<HTMLElement>("[data-st-loop-handle]");
    if (loopHandle) {
      e.preventDefault();
      e.stopPropagation();
      const rulerEl = loopHandle.closest<HTMLElement>("[data-st-ruler]");
      if (!rulerEl) return;
      const edge = loopHandle.getAttribute("data-st-loop-handle") === "start" ? "start" : "end";
      loopDrag = { edge, rulerEl, pointerId: e.pointerId };
      try { loopHandle.setPointerCapture(e.pointerId); } catch (err) {}
      return;
    }

    // Ruler scrub
    const ruler = target.closest<HTMLElement>("[data-st-ruler]");
    if (ruler) {
      e.preventDefault();
      studioEngine.prepareAudioSync();
      rulerDrag = { el: ruler, pointerId: e.pointerId };
      seekFromPointer(ruler, e.clientX);
      try { ruler.setPointerCapture(e.pointerId); } catch (err) {}
      return;
    }

    // Embedded original synthesizer .sk knob drag
    const knob = target.closest<HTMLElement>(".st-inst-knob");
    if (!knob) return;
    const key = knob.getAttribute("data-st-param");
    if (!key) return;
    e.preventDefault();
    studioEngine.prepareAudioSync();
    const track = studioEngine.getFocusedTrack();
    draggingKnobParam = key;
    knobDrag = {
      key,
      startY: e.clientY,
      startX: e.clientX,
      startN: synthNorm(key, Number(track.patch[key])),
      pointerId: e.pointerId,
      el: knob
    };
    knob.classList.add("is-dragging");
    try { knob.setPointerCapture(e.pointerId); } catch (err) {}
  });

  container.addEventListener("pointermove", (e) => {
    if (vecPadDrag && e.pointerId === vecPadDrag.pointerId) {
      e.preventDefault();
      updateVectorFromPointer(vecPadDrag.svg, e.clientX, e.clientY);
      return;
    }
    if (dockResizeDrag && e.pointerId === dockResizeDrag.pointerId) {
      e.preventDefault();
      const delta = dockResizeDrag.startY - e.clientY;
      const maxH = Math.max(260, Math.round(window.innerHeight * 0.72));
      dockHeightPx = Math.max(190, Math.min(maxH, Math.round(dockResizeDrag.startHeight + delta)));
      dockResizeDrag.dawEl.style.setProperty("--st-dock-h", `${dockHeightPx}px`);
      return;
    }
    if (loopDrag && e.pointerId === loopDrag.pointerId) {
      e.preventDefault();
      const rect = loopDrag.rulerEl.getBoundingClientRect();
      if (rect.width <= 0) return;
      const tr = studioEngine.getTransportSnapshot();
      const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      const bar = Math.max(1, Math.min(tr.bars, Math.round(ratio * tr.bars) + (loopDrag.edge === "start" ? 1 : 0)));
      if (loopDrag.edge === "start") {
        studioEngine.setLoopRange(Math.min(bar, tr.loopEndBar), tr.loopEndBar);
      } else {
        studioEngine.setLoopRange(tr.loopStartBar, Math.max(tr.loopStartBar, bar));
      }
      return;
    }
    if (rulerDrag && e.pointerId === rulerDrag.pointerId) {
      e.preventDefault();
      seekFromPointer(rulerDrag.el, e.clientX);
      return;
    }
    if (!knobDrag || e.pointerId !== knobDrag.pointerId) return;
    e.preventDefault();
    const dy = knobDrag.startY - e.clientY;
    const dx = e.clientX - knobDrag.startX;
    const sens = e.shiftKey ? 700 : 200;
    const nextVal = synthDenorm(knobDrag.key, knobDrag.startN + (dy + dx * 0.5) / sens);
    studioEngine.getFocusedTrack().setParam(knobDrag.key, nextVal);
  });

  const endInteractiveDrags = (e?: PointerEvent) => {
    if (vecPadDrag && (!e || e.pointerId === vecPadDrag.pointerId)) {
      vecPadDrag = null;
      draggingKnobParam = null;
      if (pendingAutosaveAfterDrag) {
        pendingAutosaveAfterDrag = false;
        scheduleAutosave();
      }
      renderStudioPanel();
    }
    if (dockResizeDrag && (!e || e.pointerId === dockResizeDrag.pointerId)) {
      container.querySelector("#st-dock-resizer")?.classList.remove("is-dragging");
      dockResizeDrag = null;
    }
    if (loopDrag && (!e || e.pointerId === loopDrag.pointerId)) {
      loopDrag = null;
    }
    if (rulerDrag && (!e || e.pointerId === rulerDrag.pointerId)) {
      rulerDrag = null;
    }
    if (draggingRange) {
      draggingRange = null;
      if (pendingAutosaveAfterDrag) {
        pendingAutosaveAfterDrag = false;
        scheduleAutosave();
      }
      renderStudioPanel();
    }
    if (!knobDrag || (e && e.pointerId !== knobDrag.pointerId)) return;
    knobDrag.el.classList.remove("is-dragging");
    knobDrag = null;
    draggingKnobParam = null;
    if (pendingAutosaveAfterDrag) {
      pendingAutosaveAfterDrag = false;
      scheduleAutosave();
    }
    renderStudioPanel();
  };

  container.addEventListener("pointerup", endInteractiveDrags);
  container.addEventListener("pointercancel", endInteractiveDrags);
  window.addEventListener("blur", () => endInteractiveDrags());

  // Double-click: reset embedded synth knob, reset dock height, or open Piano Roll from lane
  container.addEventListener("dblclick", (e) => {
    const target = e.target as HTMLElement | null;
    if (!target) return;

    if (target.closest("#st-dock-resizer")) {
      dockHeightPx = 310;
      dockExpanded = false;
      dockCollapsed = false;
      renderStudioPanel();
      return;
    }

    const lane = target.closest<HTMLElement>("[data-st-lane]");
    if (lane) {
      const tid = lane.getAttribute("data-track-id");
      if (tid) studioEngine.setFocusedTrack(tid);
      activeDockTab = "piano-roll";
      dockCollapsed = false;
      renderStudioPanel();
      return;
    }

    const knob = target.closest<HTMLElement>(".st-inst-knob");
    if (!knob) return;
    const key = knob.getAttribute("data-st-param");
    if (key && SYNTH_PARAMS[key]) {
      studioEngine.getFocusedTrack().setParam(key, SYNTH_PARAMS[key].def);
    }
  });

  // Wheel adjusts embedded synth knobs cleanly
  container.addEventListener(
    "wheel",
    (e) => {
      const knob = (e.target as HTMLElement | null)?.closest<HTMLElement>(".st-inst-knob");
      if (!knob) return;
      const key = knob.getAttribute("data-st-param");
      if (!key) return;
      e.preventDefault();
      const track = studioEngine.getFocusedTrack();
      const curN = synthNorm(key, Number(track.patch[key]));
      track.setParam(key, synthDenorm(key, curN - Math.sign(e.deltaY) * 0.03));
    },
    { passive: false }
  );

  // Arrow keys adjust focused embedded synth knob
  container.addEventListener("keydown", (e) => {
    if (exportMenuOpen && e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      exportMenuOpen = false;
      renderStudioPanel();
      container.querySelector<HTMLElement>("#st-export-menu-btn")?.focus();
      return;
    }
    const inExportMenu = (e.target as HTMLElement | null)?.closest("#st-export-menu");
    if (inExportMenu && ["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) {
      e.preventDefault();
      e.stopPropagation();
      const items = Array.from(inExportMenu.querySelectorAll<HTMLElement>("[role='menuitem']:not(:disabled)"));
      const current = items.indexOf(document.activeElement as HTMLElement);
      const next = e.key === "Home" ? 0 : e.key === "End" ? items.length - 1 :
        (current + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
      items[next]?.focus();
      return;
    }
    const knob = (e.target as HTMLElement | null)?.closest<HTMLElement>(".st-inst-knob");
    if (!knob) return;
    const dirMap: Record<string, number> = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1 };
    const dir = dirMap[e.key];
    if (!dir) return;
    e.preventDefault();
    e.stopPropagation();
    const key = knob.getAttribute("data-st-param");
    if (!key) return;
    const def = SYNTH_PARAMS[key];
    if (!def) return;
    const track = studioEngine.getFocusedTrack();
    const next = def.step
      ? Number(track.patch[key]) + dir * def.step
      : synthDenorm(key, synthNorm(key, Number(track.patch[key])) + dir * 0.02);
    track.setParam(key, next);
  });
}

export function showStudioPanel(): void {
  document.documentElement.classList.add("is-studio");
  // Keep Instrument Browser collapsed by default on narrow portrait tablets/phones so timeline is immediately unobstructed
  if (typeof window !== "undefined" && window.innerWidth <= 768) {
    browserOpen = false;
  }
  const synthEl = document.getElementById("sy1-panel");
  const studioEl = document.getElementById("sy1-studio");
  if (synthEl) synthEl.hidden = true;
  if (studioEl) studioEl.hidden = false;
  applyKeyboardVisibility();
  renderStudioPanel();
  if (studioEngine.isPlaying()) startPlayheadLoop();
}

export function hideStudioPanel(): void {
  stopPlayheadLoop();
  cachedPlayheadEls = [];
  cachedClockEl = null;
  cachedMeterEls = [];
  exportMenuOpen = false;
  pendingClearTrackId = null;
  document.documentElement.classList.remove("is-studio");
  const synthEl = document.getElementById("sy1-panel");
  const studioEl = document.getElementById("sy1-studio");
  if (studioEl) studioEl.hidden = true;
  if (synthEl) synthEl.hidden = false;
  applyKeyboardVisibility();
}
