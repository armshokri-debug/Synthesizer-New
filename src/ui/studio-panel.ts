import { editTrackDrumStep } from "../studio/track-drum-patterns";
import { renderArpPanelHtml } from "./arp-view";
import { renderInstrumentControl } from "./instrument-controls";
import { renderOrientalPanelHtml } from "./oriental-view";
import { getScale } from "../engine/scales";
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
import { DRUM_NOTES, DrumVoice, STEP_EDITS, emptyPattern } from "../engine/drums";
import { escapeHtml, SYNTH_PARAMS, synthDenorm, synthNorm, parseScalaScl } from "../engine/params";
import { fmtBpm } from "../engine/tempo";
import type { MachineDef } from "../machines/types";
import { createProjectId, parseStudioProjectJson, projectFilename, sanitizeProjectName } from "../studio/project-io";
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
  STUDIO_REGION_SNAP_OPTIONS,
  STUDIO_TICKS_PER_BAR,
  StudioRecordingMode,
  StudioSavedProjectMeta
} from "../studio/types";
import { machineArt } from "./machine-browser";
import {
  getStudioSelectedDrumVoice,
  getTrackDrumEdit, setTrackDrumEdit, setTrackDrumLiveView, setTrackDrumPreviewView,
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
let dockCollapsed = true;
let dockPinnedOpen = false;
let dockHeightPx = 326;
let instrumentFocusMode = false;
// The original instrument host is reused in Studio rather than creating a second
// independent page. Its standalone contents remain detached and are restored
// when returning to the arrangement. All track events still bubble to Studio.
let instrumentHostHome: Comment | null = null;
let standaloneInstrumentContents: DocumentFragment | null = null;

function detachTrackInstrumentHost(container: HTMLElement): void {
  const host = document.getElementById("sy1-panel");
  if (host && container.contains(host) && instrumentHostHome?.parentNode) {
    instrumentHostHome.parentNode.insertBefore(host, instrumentHostHome);
    host.hidden = true;
  }
}

function mountTrackInstrumentHost(container: HTMLElement): void {
  const slot = container.querySelector<HTMLElement>(".st-instrument-page");
  const host = document.getElementById("sy1-panel");
  if (!slot || !host || !host.parentNode) return;
  if (!instrumentHostHome) {
    instrumentHostHome = document.createComment("Original SY-1 instrument host");
    host.parentNode.insertBefore(instrumentHostHome, host);
    standaloneInstrumentContents = document.createDocumentFragment();
    while (host.firstChild) standaloneInstrumentContents.appendChild(host.firstChild);
  }
  host.dataset.studioInstrument = "true";
  host.replaceChildren(...Array.from(slot.childNodes));
  host.hidden = false;
  slot.appendChild(host);
}

function restoreStandaloneInstrumentHost(): void {
  const host = document.getElementById("sy1-panel");
  if (!host || !instrumentHostHome) return;
  instrumentHostHome.replaceWith(host);
  instrumentHostHome = null;
  host.replaceChildren();
  if (standaloneInstrumentContents) host.appendChild(standaloneInstrumentContents);
  standaloneInstrumentContents = null;
  delete host.dataset.studioInstrument;
  host.hidden = true;
}
let arpTrackKey: string | null = null;
function studioArpTrack(): SY1TrackEngine | null {
  if (!instrumentFocusMode || !arpTrackKey) return null;
  const ft = studioEngine.getFocusedTrack();
  return !ft.isDrumTrack() && arpTrackKey === `${ft.id}:${ft.machineId}` ? ft : null;
}
let orientalTrackId: string | null = null;
let orientalMachineId: string | null = null;
let orientalStatus = "";
let orientalError = false;
let orientalSession = 0;
function closeStudioOriental(): void {
  orientalTrackId = null;
  orientalMachineId = null;
  orientalStatus = "";
  orientalError = false;
  orientalSession++;
}
function studioOrientalTrack(): SY1TrackEngine | null {
  if (!instrumentFocusMode || !orientalTrackId) return null;
  const ft = studioEngine.getFocusedTrack();
  return ft.id === orientalTrackId && ft.machineId === orientalMachineId && !ft.isDrumTrack() ? ft : null;
}
let preInstFocusState: {
  dockTab: StudioDockTab;
  dockCollapsed: boolean;
  dockExpanded: boolean;
  browserOpen: boolean;
  keysVisible: boolean;
} | null = null;

let browserOpen = false;
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
let studioMenuKind: "settings" | "project" = "project";
let pendingClearTrackId: string | null = null;
let pendingDeleteProject: { id: string; name: string } | null = null;
let pendingProjectNameModal: {
  kind: "new" | "rename-current" | "rename-saved" | "duplicate-current" | "duplicate-saved";
  projectId?: string;
  initialName: string;
} | null = null;
let pendingUnsavedAction: {
  label: string;
  run: () => void | Promise<void>;
} | null = null;
let keysVisible = false;

let projectDirty = false;
let saveState: "saved" | "unsaved" | "saving" | "error" = "saved";
let suppressDirtyTracking = false;

let rafId = 0;
let initialized = false;
let exporting = false;
let exportingStems = false;
let statusMessage = "";
let statusTone: StatusTone = "info";
let openDrawerVisible = false;
let savedProjectsCache: StudioSavedProjectMeta[] = [];
let autosaveMetaCache: { id: string; name: string; updatedAt: number; trackCount: number; bpm: number; bars: number } | null = null;
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

export function isStudioInstrumentFocusOpen(): boolean {
  return instrumentFocusMode;
}

function exitInstrumentFocusMode(restoreState = true): void {
  studioEngine.stopDrumPreview();
  if (!instrumentFocusMode) return;
  instrumentFocusMode = false;
  arpTrackKey = null;
  closeStudioOriental();
  const prev = preInstFocusState;
  preInstFocusState = null;
  if (restoreState && prev) {
    activeDockTab = prev.dockTab;
    dockCollapsed = prev.dockCollapsed;
    dockExpanded = prev.dockExpanded;
    browserOpen = prev.browserOpen;
    keysVisible = prev.keysVisible;
    applyKeyboardVisibility();
  }
  renderStudioPanel();
}

export function getStudioDockTab(): StudioDockTab {
  return activeDockTab;
}

function preferExpandedNoteEditor(): boolean {
  return window.matchMedia("(max-width: 600px), (max-height: 500px)").matches;
}

function openInstrumentPage(): void {
  if (!instrumentFocusMode) {
    preInstFocusState = {dockTab:activeDockTab,dockCollapsed,dockExpanded,browserOpen,keysVisible};
    instrumentFocusMode = true;
    browserOpen = false;
    keysVisible = true;
    applyKeyboardVisibility();
  }
  activeDockTab = "instrument";
  dockCollapsed = false;
  renderStudioPanel();
}
export function setStudioDockTab(tab: StudioDockTab): void {
  if (tab === "instrument") { openInstrumentPage(); return; }
  studioEngine.stopDrumPreview();
  if (instrumentFocusMode) exitInstrumentFocusMode(true);
  activeDockTab = tab;
  if (tab === "piano-roll" && preferExpandedNoteEditor()) dockExpanded = true;
  dockCollapsed = false;
  dockPinnedOpen = true;
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

function markProjectDirty(): void {
  if (suppressDirtyTracking) return;
  projectDirty = true;
  if (saveState !== "saving") saveState = "unsaved";
}

function markProjectSaved(): void {
  projectDirty = false;
  saveState = "saved";
}

export async function saveStudioProjectNow(): Promise<boolean> {
  saveState = "saving";
  const proj = studioEngine.exportProject();
  const res = await studioStorage.saveProject(proj);
  if (!res.ok) {
    saveState = "error";
    setStatus(res.message, "error");
    renderStudioPanel();
    return false;
  }
  const autoRes = await studioStorage.saveAutosave(proj);
  if (!autoRes.ok) {
    saveState = "error";
    setStatus(autoRes.message, "error");
    renderStudioPanel();
    return false;
  }
  markProjectSaved();
  setStatus(`Saved "${proj.name}" locally`, "ok");
  if (openDrawerVisible) await refreshOpenDrawerData();
  renderStudioPanel();
  return true;
}

export async function importStudioProjectJson(text: string): Promise<{ ok: boolean; error?: string }> {
  if (studioEngine.getTransportSnapshot().recording) {
    const msg = "Stop recording before importing a project.";
    setStatus(msg, "error");
    renderStudioPanel();
    return { ok: false, error: msg };
  }
  const parsed = parseStudioProjectJson(text);
  if (!parsed.ok) {
    setStatus(parsed.error, "error");
    renderStudioPanel();
    return { ok: false, error: parsed.error };
  }
  try {
    // Prevent an imported .sy1studio file from colliding with & overwriting an existing saved project ID
    const candidate = { ...parsed.project };
    if (studioStorage.isAvailable()) {
      const existing = await studioStorage.loadProject(candidate.id);
      if (existing.ok && existing.data) {
        candidate.id = createProjectId();
      }
    }
    suppressNextAutosave = true;
    suppressDirtyTracking = true;
    await studioEngine.loadProject(candidate);
    pendingClearTrackId = null;
    dockCollapsed = true;
    dockPinnedOpen = false;
    dockExpanded = false;
    await studioStorage.saveAutosave(studioEngine.exportProject());
    markProjectSaved();
    openDrawerVisible = false;
    exportMenuOpen = false;
    setStatus(`Imported "${candidate.name}"`, "ok");
    renderStudioPanel();
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to import project.";
    setStatus(msg, "error");
    renderStudioPanel();
    return { ok: false, error: msg };
  } finally {
    suppressNextAutosave = false;
    suppressDirtyTracking = false;
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
      id: p.id,
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
    suppressDirtyTracking = true;
    await studioEngine.loadProject(res.data.project);
    markProjectSaved();
    setStatus(`Restored "${res.data.project.name}"`, "ok");
    return true;
  } catch (err) {
    setStatus("Autosave recovery skipped: invalid data", "error");
    return false;
  } finally {
    suppressNextAutosave = false;
    suppressDirtyTracking = false;
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
  if (!res.ok) {
    if (res.kind === "quota") {
      saveState = "error";
      setStatus(res.message, "error");
      renderStudioPanel();
    }
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
          <span class="st-br-title">Browser</span>
          <button type="button" class="st-icon-btn" data-st-action="toggle-browser" aria-label="Close instrument browser" title="Hide Browser">✕</button>
        </div>
        <div class="st-br-search-row">
          <input type="search" class="st-br-search" id="st-browser-search" value="${escapeHtml(browserSearch)}" placeholder="Search instruments, presets…" aria-label="Search instruments and presets" />
          <button type="button" class="st-btn st-br-fav-btn${browserFavsOnly ? " is-active" : ""}" id="st-browser-fav-btn" data-st-action="browser-toggle-favs" aria-pressed="${browserFavsOnly}" title="Show favorites only">★</button>
        </div>
      </div>

      <div class="st-br-machines" role="listbox" aria-label="Synthesizers and drum machines">
        <div class="st-br-filter-row">
          <button type="button" class="st-br-fchip${browserMachineId === "all" ? " is-active" : ""}" data-st-action="browser-machine" data-st-machine="all">All</button>
          <button type="button" class="st-br-fchip${browserMachineId === "synths" ? " is-active" : ""}" data-st-action="browser-machine" data-st-machine="synths">Synths</button>
          <button type="button" class="st-br-fchip${browserMachineId === "drums" ? " is-active" : ""}" data-st-action="browser-machine" data-st-machine="drums">Drums</button>
        </div>
        ${machines
          .map((m) => {
            const active = browserMachineId === m.id;
            const loaded = focused.machineId === m.id;
            return `<button type="button" class="st-br-mcard${active ? " is-active" : ""}${loaded ? " is-loaded" : ""}" data-st-action="browser-machine" data-st-machine="${escapeHtml(m.id)}" aria-selected="${active}">
              <span class="st-br-mart">${machineArt(m)}</span>
              <span class="st-br-mname">${escapeHtml(m.name)}</span>
              ${m.kind === "drums" ? `<span class="st-br-mkind">Drums</span>` : ""}
            </button>`;
          })
          .join("")}
      </div>

      <div class="st-br-cats">
        <select id="st-browser-category" aria-label="Preset category">
        ${categories
          .map(
            (cat) =>
              `<option value="${escapeHtml(cat)}"${effCategory === cat ? " selected" : ""}>${cat === "All" ? "All Categories" : escapeHtml(cat)}</option>`
          )
          .join("")}
        </select>
      </div>

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
            : `<div class="st-br-empty">${browserFavsOnly ? "No favorite presets yet." : "No matching presets."}</div>`
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

function renderTrackIconHtml(isDrum: boolean): string {
  if (isDrum) {
    return `<svg class="st-trk-svg" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><rect x="2" y="2" width="5" height="5" rx="1.2" fill="currentColor" opacity="0.9"/><rect x="9" y="2" width="5" height="5" rx="1.2" fill="currentColor" opacity="0.55"/><rect x="2" y="9" width="5" height="5" rx="1.2" fill="currentColor" opacity="0.55"/><rect x="9" y="9" width="5" height="5" rx="1.2" fill="currentColor" opacity="0.9"/></svg>`;
  }
  return `<svg class="st-trk-svg" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M1.5 9.5L4 4.5l3 7 3-6 2.5 4h2" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

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
          <button type="button" class="st-mix-name" data-st-action="focus-track" data-track-id="${escapeHtml(t.id)}">${escapeHtml(mDef.name)}</button>
          <span class="st-mix-sub" title="${escapeHtml(t.name)} · ${escapeHtml(t.presetName)}">${escapeHtml(t.name)}</span>
        </div>
        <div class="st-mix-pan">
          <span class="st-mix-lbl" data-st-pan-lbl="${escapeHtml(t.id)}">${panStr}</span>
          <input type="range" class="st-range" min="-1" max="1" step="0.02" value="${t.pan.toFixed(2)}" data-st-range="pan" data-track-id="${escapeHtml(t.id)}" aria-label="${escapeHtml(t.name)} mixer pan" />
        </div>
        <div class="st-mix-btns">
          <button type="button" class="st-btn st-mini-btn is-mute${t.mute ? " is-active" : ""}" data-st-action="toggle-mute" data-track-id="${escapeHtml(t.id)}" aria-pressed="${t.mute}" title="Mute">M</button>
          <button type="button" class="st-btn st-mini-btn is-solo${t.solo ? " is-active" : ""}" data-st-action="toggle-solo" data-track-id="${escapeHtml(t.id)}" aria-pressed="${t.solo}" title="Solo">S</button>
          <button type="button" class="st-btn st-mini-btn is-rec${t.armed ? " is-active" : ""}" data-st-action="toggle-arm" data-track-id="${escapeHtml(t.id)}" aria-pressed="${t.armed}" title="Record Arm">R</button>
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
        <select class="st-select st-mix-ch-sel" data-st-select="channel" data-track-id="${escapeHtml(t.id)}" aria-label="${escapeHtml(mDef.name)} MIDI input channel">${midiChannelOptionsHtml(t.midiChannel)}</select>
      </div>`;
    })
    .join("");

  return `
    <div class="st-mixer" id="st-mixer">
      <div class="st-mix-channels">${strips}</div>
      <div class="st-mix-strip is-master">
        <div class="st-mix-top">
          <span class="st-mix-name">Master</span>
          <span class="st-mix-sub">Out</span>
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

// Small, consistent line icons for the Studio shell; no icon font or dependency.
const STUDIO_ICONS = {
  instrument: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M8 5v14M12 5v14M16 5v14M6 5v8M10 5v8M14 5v8"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  rewind: '<path d="M5 5v14"/><path d="m19 5-11 7 11 7z" fill="currentColor" stroke="none"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="1.5" fill="currentColor" stroke="none"/>',
  play: '<path d="M8 4.5v15L20 12z" fill="currentColor" stroke="none"/>',
  pause: '<path d="M8 5v14M16 5v14" stroke-width="3.5"/>',
  record: '<circle cx="12" cy="12" r="7" fill="currentColor" stroke="none"/>',
  loop: '<path d="M17 2l4 4-4 4M21 6H7a4 4 0 0 0-4 4M7 22l-4-4 4-4M3 18h14a4 4 0 0 0 4-4"/>',
  metronome: '<path d="M8 4h8l5 16H3L8 4zM12 16l7-11M12 8v3"/><circle cx="12" cy="16" r="1" fill="currentColor"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3m0 14v3M2 12h3m14 0h3M5 5l2 2m10 10 2 2M19 5l-2 2M7 17l-2 2"/><circle cx="12" cy="12" r="7"/>',
  more: '<circle cx="5" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.6" fill="currentColor" stroke="none"/>',
  save: '<path d="M5 3h12l4 4v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zM8 3v6h8V3M7 21v-7h10v7"/>',
  undo: '<path d="M9 5 4 10l5 5M4 10h10a6 6 0 0 1 0 12"/>',
  redo: '<path d="m15 5 5 5-5 5m5-5H10a6 6 0 0 0 0 12"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  browser: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16M5 8h2M5 12h2"/>',
  mixer: '<path d="M5 3v18M12 3v18M19 3v18"/><path d="M2 8h6M9 15h6M16 10h6" stroke-width="3"/>',
  notes: '<path d="M4 5h9v3H4zM10 11h10v3H10zM4 17h7v3H4z"/>',
  edit: '<path d="m4 16 12-12 4 4L8 20H4v-4zM13 7l4 4"/>',
  keys: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M9 5v14M15 5v14"/>'
} as const;
function stIcon(name: keyof typeof STUDIO_ICONS): string {
  return `<svg class="st-ui-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${STUDIO_ICONS[name]}</svg>`;
}

export function renderStudioHtml(): string {
  const tr = studioEngine.getTransportSnapshot();
  const tracks = studioEngine.getTracks();
  const focused = studioEngine.getFocusedTrack();
  const focusedMachine = getStudioMachineDef(focused.machineId);

  const loopLeftPct = ((tr.loopStartBar - 1) / tr.bars) * 100;
  const loopWidthPct = ((tr.loopEndBar - tr.loopStartBar + 1) / tr.bars) * 100;
  const playheadPct = tr.totalTicks > 0 ? (tr.currentTick / tr.totalTicks) * 100 : 0;

  const barButtons = STUDIO_BAR_PRESETS.map(
    (b) =>
      `<button type="button" class="st-btn st-tiny-btn st-bar-btn${tr.bars === b ? " is-active" : ""}" data-st-action="set-bars" data-st-bars="${b}">${b}</button>`
  ).join("");

  const laneZoomStyle = arrZoom > 1 ? `min-width:${Math.round(arrZoom * 100)}%` : "";

  const trackRows = tracks
    .map((t, idx) => {
      const color = trackColor(idx);
      const isFocused = t.id === focused.id;
      const mDef = getStudioMachineDef(t.machineId);

      return `<div class="st-track${isFocused ? " is-focused" : ""}" data-track-id="${escapeHtml(t.id)}" data-track-idx="${idx}" style="--trk-color:${color}">
        <div class="st-track-ctl">
          <div class="st-track-top">
            <button type="button" class="st-track-focus" data-st-action="focus-track" data-track-id="${escapeHtml(t.id)}" aria-label="Select ${escapeHtml(mDef.name)}" title="Select track">${renderTrackIconHtml(t.isDrumTrack())}</button>
            <select class="st-select st-machine-sel" data-st-select="machine" data-track-id="${escapeHtml(t.id)}" aria-label="${escapeHtml(t.name)} instrument" title="Change instrument">
              ${machineOptionsHtml(t.machineId)}
            </select>
            <button type="button" class="st-track-city" data-st-action="open-track-instrument" data-track-id="${escapeHtml(t.id)}" title="Edit ${escapeHtml(mDef.name)}">Edit</button>
          </div>
          <div class="st-track-mid">
            <div class="st-track-msr">
              <button type="button" class="st-btn st-mini-btn is-mute${t.mute ? " is-active" : ""}" data-st-action="toggle-mute" data-track-id="${escapeHtml(t.id)}" aria-pressed="${t.mute}" title="Mute">M</button>
              <button type="button" class="st-btn st-mini-btn is-solo${t.solo ? " is-active" : ""}" data-st-action="toggle-solo" data-track-id="${escapeHtml(t.id)}" aria-pressed="${t.solo}" title="Solo">S</button>
              <button type="button" class="st-btn st-mini-btn is-rec${t.armed ? " is-active" : ""}" data-st-action="toggle-arm" data-track-id="${escapeHtml(t.id)}" aria-pressed="${t.armed}" title="Record Arm">R</button>
            </div>
            <input type="range" class="st-range st-track-vol" min="0" max="1" step="0.01" value="${t.volume.toFixed(2)}" data-st-range="volume" data-track-id="${escapeHtml(t.id)}" aria-label="${escapeHtml(mDef.name)} volume" title="Volume" />
          </div>
        </div>
        <div class="st-lane" data-st-lane="1" data-track-id="${escapeHtml(t.id)}" style="${laneZoomStyle}" title="Click to select track & seek · Double-click to open Piano Roll">
          <div class="st-lane-grid">${renderLaneGrid(tr.bars, arrZoom)}</div>
          <div class="st-lane-notes">${renderRegions(t, tr.totalTicks, color, isFocused)}</div>
          <div class="st-playhead" data-st-playhead="1" style="left:${playheadPct.toFixed(3)}%"></div>
        </div>
      </div>`;
    })
    .join("");

  setTrackDrumLiveView(focused,studioEngine.isLiveDrumEnabled(focused.id));
  setTrackDrumPreviewView(focused,studioEngine.isDrumPreviewEnabled(focused.id));
  let dockContent = "";
  if (instrumentFocusMode) {
    const orient = studioOrientalTrack();
    const arp = studioArpTrack();
    const overlay = orient ? renderOrientalPanelHtml(orient.patch, orient.getTrackCustomTuning(), orientalStatus, orientalError, true)
      : arp ? renderArpPanelHtml(arp.patch, studioEngine.getBpm(), c => renderInstrumentControl({kind:"track",patch:arp.patch}, c), true) : "";
    dockContent = renderStudioInstrumentHtml(focused, instPageFilter, true, overlay, tr.bpm);
  } else if (!dockCollapsed) {
    if (activeDockTab === "piano-roll") {
      dockContent = renderPianoRollHtml();
    } else if (activeDockTab === "mixer") {
      dockContent = renderMixerHtml(tracks, focused);
    }
  }

  const canUndo = studioEngine.regions.canUndo() && !tr.recording;
  const canRedo = studioEngine.regions.canRedo() && !tr.recording;
  const recSettings = studioEngine.getRecordingSettings();
  const recMode = studioEngine.getRecordingMode();
  const countInBeat = studioEngine.getCountInBeat();
  const clockLabel = countInBeat
    ? `IN : ${countInBeat}`
    : `${String(tr.currentBar).padStart(2, "0")} : ${tr.currentBeat}`;
  const saveStateLabel =
    saveState === "saving"
      ? "Saving…"
      : saveState === "error"
        ? "Save failed"
        : saveState === "unsaved" || projectDirty
          ? "Unsaved"
          : "Saved";
  const saveStateClass =
    saveState === "error"
      ? " is-error"
      : saveState === "unsaved" || projectDirty
        ? " is-dirty"
        : " is-saved";

  const pendingClearTrack = pendingClearTrackId ? studioEngine.getTrack(pendingClearTrackId) : null;
  if (pendingClearTrackId && !pendingClearTrack) pendingClearTrackId = null;

  let activeDialogHtml = "";
  if (pendingClearTrack) {
    const clearMachine = getStudioMachineDef(pendingClearTrack.machineId);
    const clearRegions = studioEngine.regions.regions(pendingClearTrack.id).length;
    const clearNotes = pendingClearTrack.getNoteCount();
    const regionLabel = clearRegions === 1 ? "1 MIDI region" : `${clearRegions} MIDI regions`;
    const noteUnit = pendingClearTrack.isDrumTrack()
      ? clearNotes === 1 ? "hit" : "hits"
      : clearNotes === 1 ? "note" : "notes";
    activeDialogHtml = `<div class="st-dialog-backdrop">
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
  } else if (pendingUnsavedAction) {
    activeDialogHtml = `<div class="st-dialog-backdrop">
      <div class="st-dialog-scrim" data-st-action="cancel-unsaved-action" aria-hidden="true"></div>
      <div class="st-dialog" id="st-unsaved-dialog" role="alertdialog" aria-modal="true" aria-labelledby="st-unsaved-dialog-title" aria-describedby="st-unsaved-dialog-desc">
        <h2 class="st-dialog-title" id="st-unsaved-dialog-title">Save changes to "${escapeHtml(tr.projectName)}"?</h2>
        <p class="st-dialog-desc" id="st-unsaved-dialog-desc">You have unsaved recordings or edits. Save locally to this browser before ${escapeHtml(pendingUnsavedAction.label)} so nothing is lost.</p>
        <div class="st-dialog-actions">
          <button type="button" class="st-btn" id="st-unsaved-cancel-btn" data-st-action="cancel-unsaved-action">Cancel</button>
          <button type="button" class="st-btn is-danger" id="st-unsaved-discard-btn" data-st-action="discard-unsaved-action">Discard</button>
          <button type="button" class="st-btn is-active" id="st-unsaved-save-btn" data-st-action="save-and-continue-action">Save &amp; Continue</button>
        </div>
      </div>
    </div>`;
  } else if (pendingDeleteProject) {
    activeDialogHtml = `<div class="st-dialog-backdrop">
      <div class="st-dialog-scrim" data-st-action="cancel-delete-project" aria-hidden="true"></div>
      <div class="st-dialog" id="st-delete-project-dialog" role="alertdialog" aria-modal="true" aria-labelledby="st-delete-project-title" aria-describedby="st-delete-project-desc">
        <h2 class="st-dialog-title" id="st-delete-project-title">Delete "${escapeHtml(pendingDeleteProject.name)}"?</h2>
        <p class="st-dialog-desc" id="st-delete-project-desc">This permanently removes the saved project from this browser's local storage. Other projects are unaffected.</p>
        <div class="st-dialog-actions">
          <button type="button" class="st-btn" id="st-delete-project-cancel-btn" data-st-action="cancel-delete-project">Cancel</button>
          <button type="button" class="st-btn is-danger" id="st-delete-project-confirm-btn" data-st-action="confirm-delete-project" data-project-id="${escapeHtml(pendingDeleteProject.id)}">Delete Project</button>
        </div>
      </div>
    </div>`;
  } else if (pendingProjectNameModal) {
    const titleMap = {
      new: "New Project",
      "rename-current": "Rename Project",
      "rename-saved": "Rename Saved Project",
      "duplicate-current": "Save Project As (Duplicate)",
      "duplicate-saved": "Duplicate Saved Project"
    } as const;
    const descMap = {
      new: "Creates an independent local project with a unique ID. Existing projects remain untouched.",
      "rename-current": "Update the display name of the active project.",
      "rename-saved": "Update the display name of this saved local project.",
      "duplicate-current": "Saves an independent copy with a new project ID. The original project will not be overwritten.",
      "duplicate-saved": "Creates an independent copy in local browser storage with a new project ID."
    } as const;
    const confirmMap = {
      new: "Create Project",
      "rename-current": "Rename",
      "rename-saved": "Rename",
      "duplicate-current": "Save Copy",
      "duplicate-saved": "Duplicate"
    } as const;
    const k = pendingProjectNameModal.kind;
    activeDialogHtml = `<div class="st-dialog-backdrop">
      <div class="st-dialog-scrim" data-st-action="cancel-project-name-modal" aria-hidden="true"></div>
      <div class="st-dialog" id="st-project-name-dialog" role="dialog" aria-modal="true" aria-labelledby="st-project-name-title" aria-describedby="st-project-name-desc">
        <h2 class="st-dialog-title" id="st-project-name-title">${titleMap[k]}</h2>
        <p class="st-dialog-desc" id="st-project-name-desc">${descMap[k]}</p>
        <input type="text" class="st-dialog-input" id="st-project-name-modal-input" value="${escapeHtml(pendingProjectNameModal.initialName)}" maxlength="80" aria-label="Project name" placeholder="Project name" />
        <div class="st-dialog-actions">
          <button type="button" class="st-btn" id="st-project-name-cancel-btn" data-st-action="cancel-project-name-modal">Cancel</button>
          <button type="button" class="st-btn is-active" id="st-project-name-confirm-btn" data-st-action="confirm-project-name-modal">${confirmMap[k]}</button>
        </div>
      </div>
    </div>`;
  }

  const topbarLeftHtml = instrumentFocusMode
    ? `<select class="st-select st-inst-focus-sel" id="st-inst-track-select" data-st-select="focus-track" aria-label="Editing track">
         ${tracks
           .map(
             (t) =>
               `<option value="${escapeHtml(t.id)}"${t.id === focused.id ? " selected" : ""}>${escapeHtml(t.name)} · ${escapeHtml(getStudioMachineDef(t.machineId).name)}</option>`
           )
           .join("")}
       </select>
       <button type="button" class="st-btn${browserOpen ? " is-active" : ""}" id="st-browser-toggle" data-st-action="toggle-browser" aria-pressed="${browserOpen}" title="Toggle Instrument Browser" aria-label="Instrument browser">${stIcon("browser")}</button>`
    : `<button type="button" class="st-btn st-ghost-btn" id="st-back-btn" data-st-action="close-studio" title="Return to synths" aria-label="Return to synths">${stIcon("instrument")}</button>
       <input type="text" class="st-name-input" id="st-project-name" value="${escapeHtml(tr.projectName)}" maxlength="80" aria-label="Project name" placeholder="Untitled Project" />`;

  return `
    <div class="st-daw${dockExpanded ? " is-dock-expanded" : ""}${dockCollapsed && !instrumentFocusMode ? " is-dock-collapsed" : ""}${instrumentFocusMode ? " is-inst-focus" : ""}" dir="ltr" style="--st-dock-h:${dockHeightPx}px">
      <header class="st-topbar">
        <div class="st-tb-left">
          ${topbarLeftHtml}
        </div>

        <div class="st-tb-center" role="group" aria-label="Master Transport">
          <div class="st-seg st-transport-seg">
            <button type="button" class="st-btn st-tool" id="st-rewind-btn" data-st-action="rewind"${tr.recording ? " disabled" : ""} title="Go to beginning" aria-label="Go to beginning">${stIcon("rewind")}</button>
            <button type="button" class="st-btn st-tool" id="st-stop-btn" data-st-action="stop" title="Stop" aria-label="Stop">${stIcon("stop")}</button>
            <button type="button" class="st-btn st-tool is-play${tr.playing ? " is-active" : ""}" id="st-play-btn" data-st-action="play" aria-pressed="${tr.playing}" title="Play / Pause" aria-label="${tr.playing ? "Pause" : "Play"}">${stIcon(tr.playing ? "pause" : "play")}</button>
            <button type="button" class="st-btn st-tool is-rec${tr.recording ? " is-active" : ""}" id="st-rec-btn" data-st-action="record" aria-pressed="${tr.recording}" title="Record" aria-label="Record">${stIcon("record")}</button>
          </div>
          <div class="st-lcd" aria-label="Position and tempo">
            <div class="st-clock${countInBeat ? " is-countin" : ""}" id="st-clock" aria-label="Transport position">${clockLabel}</div>
            <button type="button" class="st-btn st-bpm-val" id="st-bpm-val" data-st-action="bpm-tap" title="Tap tempo · precise BPM in Settings" aria-label="Tap tempo">${fmtBpm(tr.bpm)} <small>BPM</small></button>
          </div>
          <div class="st-seg st-performance-seg">
            <button type="button" class="st-btn st-tool${tr.loopEnabled ? " is-active" : ""}" id="st-loop-btn" data-st-action="toggle-loop" aria-pressed="${tr.loopEnabled}" title="Loop" aria-label="Loop">${stIcon("loop")}</button>
            <button type="button" class="st-btn st-tool${recSettings.metronome ? " is-active" : ""}" id="st-click-btn" data-st-action="metronome" aria-pressed="${recSettings.metronome}" title="Metronome (monitor only)" aria-label="Metronome">${stIcon("metronome")}</button>
          </div>
        </div>

        <div class="st-tb-right">
          <span class="st-save-state${saveStateClass}" id="st-save-state" title="Stored locally in this browser">${saveStateLabel}</span>
          <button type="button" class="st-btn st-tool${projectDirty ? " is-dirty" : ""}" id="st-save-btn" data-st-action="save-project" title="Save project locally" aria-label="Save project">${stIcon("save")}</button>
          <button type="button" class="st-btn st-tool${openDrawerVisible ? " is-active" : ""}" id="st-open-btn" data-st-action="toggle-open-drawer" title="Projects" aria-label="Projects">${stIcon("folder")}</button>
          ${instrumentFocusMode ? `<button type="button" class="st-btn st-tool${keysVisible ? " is-active" : ""}" id="st-keys-toggle" data-st-action="toggle-keys" aria-pressed="${keysVisible}" title="On-screen keyboard" aria-label="On-screen keyboard">${stIcon("keys")}</button>` : ""}
          <div class="st-export-wrap st-menu-anchor">
            <button type="button" class="st-btn st-tool${exportMenuOpen && studioMenuKind === "settings" ? " is-active" : ""}" id="st-settings-btn" data-st-action="toggle-settings-menu" aria-haspopup="menu" aria-expanded="${exportMenuOpen && studioMenuKind === "settings"}" aria-label="Studio settings" title="Studio settings">${stIcon("settings")}</button>
            <button type="button" class="st-btn st-tool${exportMenuOpen && studioMenuKind === "project" ? " is-active" : ""}" id="st-export-menu-btn" data-st-action="toggle-export-menu" aria-haspopup="menu" aria-expanded="${exportMenuOpen && studioMenuKind === "project"}" aria-label="Project actions" title="Project actions">${exporting || exportingStems ? "…" : stIcon("more")}</button>
            <div class="st-export-menu" id="st-export-menu" role="menu" aria-label="${studioMenuKind === "settings" ? "Studio settings" : "Project actions"}"${exportMenuOpen ? "" : " hidden"}>
              <div class="st-menu-title">${studioMenuKind === "settings" ? "Studio settings" : "Project actions"}</div>
              <div class="st-menu-view"${studioMenuKind !== "settings" ? " hidden" : ""}>
                <label class="st-setting-field">Tempo <input id="st-bpm-input" type="number" min="40" max="240" step="1" value="${tr.bpm}" aria-label="Tempo BPM" /><span>BPM</span></label>
                <button type="button" class="st-menu-item${recSettings.countIn ? " is-checked" : ""}" id="st-countin-btn" role="menuitemcheckbox" aria-checked="${recSettings.countIn}" data-st-action="count-in">${recSettings.countIn ? "✓ " : ""}1-Bar Count-in</button>
                ${!instrumentFocusMode ? `<button type="button" class="st-menu-item${keysVisible ? " is-checked" : ""}" role="menuitemcheckbox" aria-checked="${keysVisible}" id="st-keys-toggle" data-st-action="toggle-keys">${keysVisible ? "✓ " : ""}On-Screen Keys</button>` : ""}
              <div class="st-menu-label">Arrangement Length (Bars)</div>
              <div class="st-menu-bars">
                ${barButtons}
                <input type="number" class="st-bar-input" id="st-bars-custom" min="1" max="512" value="${tr.bars}" aria-label="Custom bar count" title="Custom bar length (1–512)" />
              </div>
              <div class="st-menu-sep"></div>
              <label class="st-click-level">Click volume <input id="st-click-volume" type="range" min="0" max="1" step="0.01" value="${recSettings.clickVolume}" aria-label="Metronome volume"></label>
              <div class="st-menu-label">Recording Mode</div>
              <button type="button" class="st-menu-item${recMode === "overdub" ? " is-checked" : ""}" role="menuitemradio" aria-checked="${recMode === "overdub"}" data-st-action="set-rec-mode" data-rec-mode="overdub">${recMode === "overdub" ? "✓ " : ""}Overdub (Merge)</button>
              <button type="button" class="st-menu-item${recMode === "takes" ? " is-checked" : ""}" role="menuitemradio" aria-checked="${recMode === "takes"}" data-st-action="set-rec-mode" data-rec-mode="takes">${recMode === "takes" ? "✓ " : ""}Separate Takes</button>
              <button type="button" class="st-menu-item${recMode === "replace" ? " is-checked" : ""}" role="menuitemradio" aria-checked="${recMode === "replace"}" data-st-action="set-rec-mode" data-rec-mode="replace">${recMode === "replace" ? "✓ " : ""}Replace Armed Track</button>

              </div>
              <div class="st-menu-view"${studioMenuKind !== "project" ? " hidden" : ""}>
                <button type="button" class="st-menu-item" role="menuitem" data-st-action="toggle-open-drawer">My Projects…</button>
                <button type="button" class="st-menu-item" role="menuitem" data-st-action="save-project">Save project</button>
                <div class="st-menu-sep"></div>
              <button type="button" class="st-menu-item" role="menuitem" id="st-export-wav" data-st-action="export-wav"${exporting || exportingStems ? " disabled" : ""}>Export 24-bit WAV Mix</button>
              <button type="button" class="st-menu-item" role="menuitem" id="st-export-stems" data-st-action="export-stems"${exporting || exportingStems ? " disabled" : ""}>Export 24-bit WAV Stems</button>
              <button type="button" class="st-menu-item" role="menuitem" id="st-export-midi" data-st-action="export-midi">Export MIDI (SMF-1)</button>
              ${tr.hasLiveTake ? `<button type="button" class="st-menu-item" role="menuitem" id="st-export-live" data-st-action="export-live">Live Take WAV (${tr.liveTakeDurationSec.toFixed(1)}s)</button>` : ""}
              <div class="st-menu-sep"></div>
              <button type="button" class="st-menu-item" role="menuitem" id="st-export-project" data-st-action="export-project">Export .sy1studio</button>
              <button type="button" class="st-menu-item" role="menuitem" id="st-import-project-btn" data-st-action="trigger-import-project"${tr.recording ? " disabled" : ""}>Import .sy1studio</button>

                <div class="st-menu-sep"></div>
                <button type="button" class="st-menu-item st-menu-destructive" role="menuitem" data-st-action="clear-track" data-track-id="${escapeHtml(focused.id)}"${studioEngine.regions.regions(focused.id).length === 0 ? " disabled" : ""}>Clear ${escapeHtml(focusedMachine.name)} Track…</button>
              </div>
            </div>
            <input type="file" id="st-import-file" accept=".sy1studio,.json,application/json" hidden />
          </div>
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
          ? `<div class="st-drawer" id="st-open-drawer" role="region" aria-label="My Projects">
              <div class="st-drawer-head">
                <div class="st-drawer-head-title">
                  <span>My Projects</span>
                  <span class="st-drawer-local-note">Saved locally in this browser · No cloud sync</span>
                </div>
                <button type="button" class="st-btn st-tiny-btn" data-st-action="toggle-open-drawer">Close</button>
              </div>
              <div class="st-drawer-toolbar">
                <button type="button" class="st-btn st-tiny-btn is-active" id="st-new-project-btn" data-st-action="new-project"${tr.recording ? " disabled" : ""}>+ New Project</button>
                <button type="button" class="st-btn st-tiny-btn" id="st-duplicate-project-btn" data-st-action="duplicate-current-project"${tr.recording ? " disabled" : ""}>Save As / Duplicate</button>
                <button type="button" class="st-btn st-tiny-btn" id="st-rename-project-btn" data-st-action="rename-current-project"${tr.recording ? " disabled" : ""}>Rename Current</button>
                <button type="button" class="st-btn st-tiny-btn" data-st-action="trigger-import-project"${tr.recording ? " disabled" : ""}>Import .sy1studio</button>
                ${tr.recording ? `<span class="st-drawer-rec-guard">Stop recording to switch or create projects</span>` : ""}
              </div>
              <div class="st-drawer-list">
                ${
                  autosaveMetaCache
                    ? `<div class="st-drawer-item is-recovery">
                        <div>
                          <div class="st-drawer-item-title">Autosave Recovery · ${escapeHtml(autosaveMetaCache.name)}</div>
                          <div class="st-drawer-item-meta">${autosaveMetaCache.trackCount} tracks · ${autosaveMetaCache.bpm} BPM · ${autosaveMetaCache.bars} bars · ${escapeHtml(fmtSavedTime(autosaveMetaCache.updatedAt))}</div>
                        </div>
                        <button type="button" class="st-btn st-tiny-btn" data-st-action="restore-autosave"${tr.recording ? " disabled" : ""}>Recover</button>
                      </div>`
                    : ""
                }
                ${
                  savedProjectsCache.length > 0
                    ? savedProjectsCache
                        .map(
                          (p) => {
                            const isCurrent = p.id === tr.projectId;
                            return `<div class="st-drawer-item${isCurrent ? " is-current" : ""}" data-project-id="${escapeHtml(p.id)}">
                              <div>
                                <div class="st-drawer-item-title">${escapeHtml(p.name)}${isCurrent ? ` <span class="st-current-tag">Active</span>` : ""}</div>
                                <div class="st-drawer-item-meta">${p.trackCount} tracks · ${p.noteCount} notes · ${p.bpm} BPM · ${p.bars} bars · ${escapeHtml(fmtSavedTime(p.savedAt))}</div>
                              </div>
                              <div class="st-drawer-actions">
                                <button type="button" class="st-btn st-tiny-btn" data-st-action="open-saved-project" data-project-id="${escapeHtml(p.id)}"${tr.recording ? " disabled" : ""}>Open</button>
                                <button type="button" class="st-btn st-tiny-btn" data-st-action="duplicate-saved-project" data-project-id="${escapeHtml(p.id)}"${tr.recording ? " disabled" : ""}>Duplicate</button>
                                <button type="button" class="st-btn st-tiny-btn" data-st-action="rename-saved-project" data-project-id="${escapeHtml(p.id)}"${tr.recording ? " disabled" : ""}>Rename</button>
                                <button type="button" class="st-btn st-tiny-btn" data-st-action="delete-saved-project" data-project-id="${escapeHtml(p.id)}"${tr.recording ? " disabled" : ""}>Delete</button>
                              </div>
                            </div>`;
                          }
                        )
                        .join("")
                    : `<div class="st-drawer-empty">No saved projects in local browser storage yet. Click Save or + New Project.</div>`
                }
              </div>
            </div>`
          : ""
      }

      <div class="st-workspace">
        ${renderInstrumentBrowserHtml(focused)}
        ${browserOpen ? `<div class="st-browser-backdrop" data-st-action="toggle-browser" aria-hidden="true"></div>` : ""}

        <div class="st-main">
          ${instrumentFocusMode ? `<main class="st-instrument-page" aria-label="${escapeHtml(focusedMachine.name)} instrument">${dockContent}</main>` : `
          <section class="st-arr-wrap" aria-label="Arrangement Timeline">
            <div class="st-arr-toolbar">
              <div class="st-arr-tb-left">
                ${
                  !instrumentFocusMode
                    ? `<button type="button" class="st-btn st-tiny-btn${browserOpen ? " is-active" : ""}" id="st-browser-toggle" data-st-action="toggle-browser" aria-pressed="${browserOpen}" title="Toggle Instrument Browser" aria-label="Instrument browser">${stIcon("browser")}</button>`
                    : ""
                }
                ${
                  tracks.length < STUDIO_MAX_TRACKS
                    ? `<button type="button" class="st-btn st-tiny-btn" id="st-add-track-btn" data-st-action="add-track" aria-label="Add track" title="Add track">${stIcon("plus")}<span class="st-tool-label">Track</span></button>`
                    : ""
                }
                <div class="st-seg st-history-seg" role="group" aria-label="Edit history">
                  <button type="button" class="st-btn st-tiny-btn st-hist-btn" id="st-undo-btn" data-st-action="undo" aria-label="Undo" title="Undo (Cmd/Ctrl+Z)"${canUndo ? "" : " disabled"}>${stIcon("undo")}</button>
                  <button type="button" class="st-btn st-tiny-btn st-hist-btn" id="st-redo-btn" data-st-action="redo" aria-label="Redo" title="Redo (Shift+Cmd/Ctrl+Z)"${canRedo ? "" : " disabled"}>${stIcon("redo")}</button>
                </div>
                <label class="st-arr-snap-field" title="Arrangement region snap grid (independent from Piano Roll Snap)">
                  <span class="st-arr-snap-lbl">Snap</span>
                  <select class="st-select st-arr-snap-sel" id="st-arr-snap" aria-label="Arrangement region snap">
                    ${STUDIO_REGION_SNAP_OPTIONS.map(
                      (opt) =>
                        `<option value="${opt.ticks}"${studioEngine.regions.grid === opt.ticks ? " selected" : ""}>${escapeHtml(opt.label)}</option>`
                    ).join("")}
                  </select>
                </label>
                ${
                  recMode !== "overdub" || tr.recording
                    ? `<span class="st-rec-mode-tag${recMode === "replace" ? " is-replace" : ""}" id="st-rec-mode-tag">${recMode === "replace" ? "Replace" : recMode === "takes" ? "New Take" : "Overdub"}</span>`
                    : ""
                }
              </div>
              <div class="st-arr-tb-right">
                <button type="button" class="st-btn st-tiny-btn" data-st-action="arr-zoom-out" aria-label="Zoom out timeline">−</button>
                <input type="range" class="st-range st-arr-zoom-range" id="st-arr-zoom" min="1" max="4" step="0.25" value="${arrZoom.toFixed(2)}" aria-label="Arrangement horizontal zoom" />
                <button type="button" class="st-btn st-tiny-btn" data-st-action="arr-zoom-in" aria-label="Zoom in timeline">+</button>
                <button type="button" class="st-btn st-tiny-btn${arrZoom === 1 ? " is-active" : ""}" data-st-action="arr-zoom-fit">Fit</button>
              </div>
            </div>

            <div class="st-arr-scroll" id="st-arr-scroll">
              <div class="st-arr-canvas">
                <div class="st-ruler-row">
                  <div class="st-ruler-label">Tracks</div>
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

          <div class="st-dock-resizer" id="st-dock-resizer" role="separator" aria-orientation="horizontal" aria-label="Resize bottom editor panel" title="Drag to resize · Double-click to reset height"${dockCollapsed && !instrumentFocusMode ? " hidden" : ""}>
            <span class="st-dock-grip"></span>
          </div>

          <section class="st-dock" id="st-dock" aria-label="Studio Bottom Editor">
            <div class="st-dock-head">
              <div class="st-dock-tabs" role="tablist" aria-label="Studio views">
                <button type="button" class="st-dock-tab${activeDockTab === "piano-roll" && !dockCollapsed ? " is-active" : ""}" id="st-tab-pianoroll" role="tab" aria-selected="${activeDockTab === "piano-roll" && !dockCollapsed}" data-st-action="dock-tab" data-st-dock-tab="piano-roll" aria-label="Piano Roll">${stIcon("notes")}<span class="st-dock-label">Piano Roll</span></button>
                <button type="button" class="st-dock-tab${activeDockTab === "mixer" && !dockCollapsed ? " is-active" : ""}" id="st-tab-mixer" role="tab" aria-selected="${activeDockTab === "mixer" && !dockCollapsed}" data-st-action="dock-tab" data-st-dock-tab="mixer" aria-label="Mixer">${stIcon("mixer")}<span class="st-dock-label">Mixer</span></button>
                <button type="button" class="st-dock-tab${activeDockTab === "instrument" && !dockCollapsed ? " is-active" : ""}" id="st-tab-instrument" role="tab" aria-selected="${activeDockTab === "instrument" && !dockCollapsed}" data-st-action="dock-tab" data-st-dock-tab="instrument" aria-label="Instrument">${stIcon("instrument")}<span class="st-dock-label">Instrument</span></button>
              </div>
              <div class="st-dock-focused">
                <span class="st-dock-track-name">${escapeHtml(focusedMachine.name)}</span>
                <select class="st-select st-dock-preset-sel" data-st-select="preset" data-track-id="${escapeHtml(focused.id)}" aria-label="${escapeHtml(focusedMachine.name)} preset">
                  ${presetGroupsHtml(focused.machineId, focused.presetId)}
                </select>
              </div>
              <div class="st-dock-actions">
                <div class="st-seg st-dock-history" role="group" aria-label="Edit history">
                  <button type="button" class="st-btn st-tiny-btn st-hist-btn" data-st-action="undo" aria-label="Undo" title="Undo (Cmd/Ctrl+Z)"${canUndo ? "" : " disabled"}>${stIcon("undo")}</button>
                  <button type="button" class="st-btn st-tiny-btn st-hist-btn" data-st-action="redo" aria-label="Redo" title="Redo (Shift+Cmd/Ctrl+Z)"${canRedo ? "" : " disabled"}>${stIcon("redo")}</button>
                </div>
                ${
                  !dockCollapsed
                    ? `<button type="button" class="st-btn st-tiny-btn${dockExpanded ? " is-active" : ""}" id="st-dock-expand" data-st-action="dock-expand" aria-pressed="${dockExpanded}" title="Toggle full-height focused view">${dockExpanded ? "Split" : "Expand"}</button>`
                    : ""
                }
                <button type="button" class="st-btn st-tiny-btn" id="st-dock-collapse" data-st-action="dock-collapse" aria-pressed="${dockCollapsed}" title="Collapse or expand bottom panel">${dockCollapsed ? "Open" : "Close"}</button>
              </div>
            </div>
            <div class="st-dock-body" id="st-dock-body"${dockCollapsed && !instrumentFocusMode ? " hidden" : ""}>
              ${dockContent}
            </div>
          </section>`}
        </div>
      </div>
      ${activeDialogHtml}
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
    cachedClockEl.classList.toggle("is-countin", !!countInBeat);
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
  if (orientalTrackId && !studioOrientalTrack()) closeStudioOriental();
  if (arpTrackKey && !studioArpTrack()) arpTrackKey = null;
  const previousOrientalScroll = container.querySelector<HTMLElement>(".oriental-pop")?.scrollTop ?? 0;
  const previousFace = container.querySelector<HTMLElement>(".st-embedded-chassis");
  const previousFaceTrack = previousFace?.dataset.trackId;
  const previousFaceMachine = previousFace?.dataset.machine;
  const previousFaceScroll = container.querySelector<HTMLElement>(".st-inst-wrap")?.scrollTop ?? 0;
  // Detach the stable original host before replacing the arrangement DOM.
  detachTrackInstrumentHost(container);
  if (!instrumentFocusMode) restoreStandaloneInstrumentHost();
  container.innerHTML = renderStudioHtml();
  if (instrumentFocusMode) mountTrackInstrumentHost(container);
  const face = container.querySelector<HTMLElement>(".st-embedded-chassis");
  const faceWrap = container.querySelector<HTMLElement>(".st-inst-wrap");
  if (faceWrap && face?.dataset.trackId === previousFaceTrack && face?.dataset.machine === previousFaceMachine) faceWrap.scrollTop = previousFaceScroll;
  const orientalPop = container.querySelector<HTMLElement>(".oriental-pop");
  if (orientalPop) orientalPop.scrollTop = previousOrientalScroll;
  document.documentElement.classList.toggle("is-studio-instrument", instrumentFocusMode);
  const arpBtn = document.getElementById("kb-arp");
  arpBtn?.classList.toggle("active", studioEngine.getFocusedTrack().patch.arpOn === "on");
  arpBtn?.classList.toggle("is-open", !!studioArpTrack());
  arpBtn?.setAttribute("aria-expanded", studioArpTrack() ? "true" : "false");
  const orientalBtn = document.getElementById("kb-oriental");
  orientalBtn?.classList.toggle("is-open", !!orientalPop);
  orientalBtn?.setAttribute("aria-expanded", orientalPop ? "true" : "false");

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
  setStudioDockTab("piano-roll");
}

export function initStudioPanel(opts: { onClose: () => void }): void {
  onCloseStudio = opts.onClose;
  if (initialized) return;
  initialized = true;

  const container = document.getElementById("sy1-studio");
  if (!container) return;

  document.getElementById("kb-arp")?.addEventListener("click", () => {
    if (container.hidden || !instrumentFocusMode) return;
    const ft = studioEngine.getFocusedTrack();
    if (ft.isDrumTrack()) return;
    closeStudioOriental();
    arpTrackKey = studioArpTrack() ? null : `${ft.id}:${ft.machineId}`;
    renderStudioPanel();
  });
  document.getElementById("kb-oriental")?.addEventListener("click", () => {
    if (container.hidden || !instrumentFocusMode) return;
    const ft = studioEngine.getFocusedTrack();
    if (ft.isDrumTrack()) return;
    arpTrackKey = null;
    if (studioOrientalTrack()) closeStudioOriental();
    else { closeStudioOriental(); orientalTrackId = ft.id; orientalMachineId = ft.machineId; }
    renderStudioPanel();
  });

  // Trap modal focus & intercept Escape/Enter/background shortcuts for all in-app Studio dialogs
  const hasActiveModal = () =>
    Boolean(pendingClearTrackId || pendingUnsavedAction || pendingDeleteProject || pendingProjectNameModal);

  const dismissActiveModal = () => {
    if (pendingClearTrackId) {
      const restoreId = pendingClearTrackId;
      pendingClearTrackId = null;
      renderStudioPanel();
      container.querySelector<HTMLElement>(`button[data-st-action="clear-track"][data-track-id="${restoreId}"]`)?.focus();
      return;
    }
    if (pendingUnsavedAction) {
      pendingUnsavedAction = null;
      renderStudioPanel();
      return;
    }
    if (pendingDeleteProject) {
      pendingDeleteProject = null;
      renderStudioPanel();
      return;
    }
    if (pendingProjectNameModal) {
      pendingProjectNameModal = null;
      renderStudioPanel();
    }
  };

  document.addEventListener(
    "keydown",
    (e) => {
      if (container.hidden) return;
      if (!hasActiveModal()) {
        if (e.key === "Escape" && studioArpTrack() && !exportMenuOpen && !openDrawerVisible) {
          e.preventDefault(); e.stopPropagation(); arpTrackKey = null; renderStudioPanel();
          document.getElementById("kb-arp")?.focus(); return;
        }
        if (e.key === "Escape" && studioOrientalTrack() && !exportMenuOpen && !openDrawerVisible) {
          e.preventDefault(); e.stopPropagation(); closeStudioOriental(); renderStudioPanel();
          document.getElementById("kb-oriental")?.focus(); return;
        }
        if (e.key === "Escape" && instrumentFocusMode && !exportMenuOpen && !openDrawerVisible) {
          e.preventDefault();
          e.stopPropagation();
          exitInstrumentFocusMode(true);
        }
        return;
      }
      const dialog = container.querySelector<HTMLElement>(".st-dialog");
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        dismissActiveModal();
        return;
      }
      if (e.key === "Tab") {
        const focusables = dialog
          ? Array.from(dialog.querySelectorAll<HTMLElement>("input:not(:disabled), button:not(:disabled)"))
          : [];
        if (focusables.length > 0) {
          e.preventDefault();
          e.stopImmediatePropagation();
          const idx = focusables.indexOf(document.activeElement as HTMLElement);
          const next = idx < 0 ? 0 : (idx + (e.shiftKey ? -1 : 1) + focusables.length) % focusables.length;
          focusables[next]?.focus();
        }
        return;
      }
      const targetEl = e.target as HTMLElement | null;
      if (targetEl?.id === "st-project-name-modal-input") {
        if (e.key === "Enter") {
          e.preventDefault();
          e.stopImmediatePropagation();
          container.querySelector<HTMLButtonElement>("#st-project-name-confirm-btn")?.click();
          return;
        }
        // Allow normal text editing inside the project name input without triggering DAW shortcuts
        e.stopPropagation();
        return;
      }
      const inDialog = targetEl?.closest(".st-dialog");
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

  // Coalesce rapid state updates into a single microtask render
  let renderQueued = false;
  let draggingKnobParam: string | null = null;
  let draggingKnobTrackId: string | null = null;
  let draggingRange: { trackId: string; type: string } | null = null;
  let pendingAutosaveAfterDrag = false;
  let wasRecordingUi = false;
  let pendingAutosaveAfterRecord = false;
  let lastSavedContentSig = "";

  const computeProjectContentSig = (): string => {
    const tr = studioEngine.getTransportSnapshot();
    const rs = studioEngine.getRecordingSettings();
    const tracks = studioEngine.getTracks();
    const parts: string[] = [
      tr.projectId,
      tr.projectName,
      String(tr.bpm),
      String(tr.bars),
      tr.loopEnabled ? "1" : "0",
      String(tr.loopStartBar),
      String(tr.loopEndBar),
      rs.metronome ? "1" : "0",
      rs.countIn ? "1" : "0",
      rs.mode ?? "overdub"
    ];
    for (let i = 0; i < tracks.length; i++) {
      const t = tracks[i];
      const regs = t.getRegions(tr.totalTicks);
      let evHash = 0;
      for (let j = 0; j < t.events.length; j++) {
        const ev = t.events[j];
        const code =
          ev.type === "noteOn"
            ? (ev.midi << 8) ^ Math.round(ev.velocity * 127)
            : ev.type === "noteOff"
              ? ev.midi ^ 0x1000
              : ev.type === "cc"
                ? (ev.cc << 8) ^ Math.round(ev.value) ^ 0x2000
                : Math.round((ev.value + 1) * 1000) ^ 0x3000;
        evHash = ((evHash * 31) ^ (ev.tick + code)) | 0;
      }
      parts.push(
        `${t.id}:${t.name}:${t.machineId}:${t.presetId}:${t.volume.toFixed(3)}:${t.pan.toFixed(3)}:${t.mute ? 1 : 0}:${t.solo ? 1 : 0}:${t.midiChannel}:${t.events.length}:${evHash}:${regs.length}:${JSON.stringify(t.patch)}:${regs.map((r) => `${r.id}@${r.startTick}:${r.length}:${r.offset}:${r.loop ? 1 : 0}:${r.events.length}`).join(",")}`
      );
    }
    return parts.join("|");
  };
  lastSavedContentSig = computeProjectContentSig();

  const syncCleanContentBaseline = () => {
    lastSavedContentSig = computeProjectContentSig();
    markProjectSaved();
  };

  const updateRecordingStatsDOM = () => {
    const tracks = studioEngine.getTracks();
    for (let i = 0; i < tracks.length; i++) {
      const t = tracks[i];
      const metaEl = container.querySelector<HTMLElement>(`[data-st-meta="${t.id}"]`);
      if (metaEl) {
        const noteCount = t.getNoteCount();
        const noteUnit = t.isDrumTrack() ? (noteCount === 1 ? "hit" : "hits") : noteCount === 1 ? "note" : "notes";
        const nextText = `${noteCount} ${noteUnit}`;
        if (metaEl.textContent !== nextText) metaEl.textContent = nextText;
      }
    }
    const saveEl = container.querySelector<HTMLElement>("#st-save-state");
    if (saveEl && saveEl.textContent !== "Unsaved") {
      saveEl.textContent = "Unsaved";
      saveEl.className = "st-save-state is-dirty";
    }
    const saveBtn = container.querySelector<HTMLElement>("#st-save-btn");
    if (saveBtn && !saveBtn.classList.contains("is-dirty")) {
      saveBtn.classList.add("is-dirty");
    }
  };

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
    const isRec = studioEngine.getTransportSnapshot().recording;

    if (studioEngine.isActive()) {
      if (studioEngine.isPlaying()) startPlayheadLoop();
      else stopPlayheadLoop();
    }

    // While live recording is already active, avoid full innerHTML rebuilds and IndexedDB churn on every incoming MIDI event
    if (isRec && wasRecordingUi) {
      markProjectDirty();
      pendingAutosaveAfterRecord = true;
      if (!container.hidden) updateRecordingStatsDOM();
      return;
    }

    if (isRec && !wasRecordingUi) {
      wasRecordingUi = true;
      pendingAutosaveAfterRecord = true;
      if (!container.hidden) requestRender();
      return;
    }

    if (!isRec && wasRecordingUi) {
      wasRecordingUi = false;
      if (pendingAutosaveAfterRecord) {
        pendingAutosaveAfterRecord = false;
        scheduleAutosave();
      }
    }

    if (!suppressDirtyTracking && !draggingKnobParam && !draggingRange) {
      const sig = computeProjectContentSig();
      if (sig !== lastSavedContentSig) {
        markProjectDirty();
      }
    } else if (suppressDirtyTracking) {
      lastSavedContentSig = computeProjectContentSig();
    }

    if (studioEngine.isActive()) {
      if (draggingKnobParam || draggingRange) {
        pendingAutosaveAfterDrag = true;
      } else {
        scheduleAutosave();
      }
    }
    if (container.hidden) return;
    if (draggingKnobParam) {
      const dragTrack = (draggingKnobTrackId ? studioEngine.getTrack(draggingKnobTrackId) : null) || studioEngine.getFocusedTrack();
      markProjectDirty();
      updateStudioInstrumentKnobDOM(container, dragTrack, draggingKnobParam);
      return;
    }
    if (draggingRange) {
      markProjectDirty();
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

    const oriental = target.closest<HTMLElement>(".oriental-pop");
    if (oriental) {
      const ft = studioOrientalTrack();
      if (!ft) return;
      const control = target.closest<HTMLElement>("button");
      if (!control) return;
      const d = control.dataset;
      if (control.hasAttribute("data-oriental-close")) {
        closeStudioOriental(); renderStudioPanel(); document.getElementById("kb-oriental")?.focus(); return;
      }
      if (d.orScale && (d.orScale === "custom" || getScale(d.orScale))) {
        if (ft.patch.tuning !== d.orScale) { ft.setParam("scaleAlt", 0); ft.setParam("tuning", d.orScale); }
        ft.setParam("oriental", "on");
      } else if (d.orRoot !== undefined) {
        ft.setParam("tuneRoot", Number(d.orRoot)); ft.setParam("oriental", "on");
      } else if (d.orAlt !== undefined) {
        ft.setParam("scaleAlt", (Number(ft.patch.scaleAlt) || 0) ^ (1 << Number(d.orAlt)));
      } else if (d.orMicro === "24tet" || d.orMicro === "practice") {
        ft.setParam("microTone", d.orMicro);
      } else if (d.orAction === "toggle") {
        ft.setParam("oriental", ft.patch.oriental === "on" ? "off" : "on");
      } else if (d.orAction === "reset") {
        ft.setTrackCustomTuning(Array(12).fill(0)); orientalStatus = "";
      } else if (d.orAction === "import") {
        oriental.querySelector<HTMLInputElement>("#st-scl-file-input")?.click(); return;
      } else return;
      renderStudioPanel(); return;
    }

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
        case "toggle-settings-menu":
        case "toggle-export-menu": {
          const kind = action === "toggle-settings-menu" ? "settings" : "project";
          exportMenuOpen = !(exportMenuOpen && studioMenuKind === kind);
          studioMenuKind = kind;
          renderStudioPanel();
          container.querySelector<HTMLElement>(exportMenuOpen ? "#st-export-menu .st-menu-view:not([hidden]) [role^='menuitem']:not(:disabled)" : kind === "settings" ? "#st-settings-btn" : "#st-export-menu-btn")?.focus();
          break;
        }
        case "metronome":
          studioEngine.setRecordingSettings({ metronome: !studioEngine.getRecordingSettings().metronome });
          break;
        case "count-in":
          studioEngine.setRecordingSettings({ countIn: !studioEngine.getRecordingSettings().countIn });
          break;
        case "set-rec-mode": {
          const mode = btn.getAttribute("data-rec-mode") as StudioRecordingMode | null;
          if (mode === "overdub" || mode === "takes" || mode === "replace") {
            studioEngine.setRecordingSettings({ mode });
            setStatus(
              mode === "replace"
                ? "Recording mode: Replace armed track (undoable)"
                : mode === "takes"
                  ? "Recording mode: Separate takes"
                  : "Recording mode: Overdub (merge)",
              "info"
            );
            renderStudioPanel();
          }
          break;
        }
        case "play":
          if (studioEngine.getTransportSnapshot().playing) void studioEngine.pause();
          else void studioEngine.play();
          break;
        case "rewind":
          studioEngine.seekToTick(0);
          break;
        case "stop":
          void studioEngine.stop();
          break;
        case "record":
          if (studioEngine.getTransportSnapshot().recording) void studioEngine.pause();
          else void studioEngine.record({ patternTrackId: instrumentFocusMode && studioEngine.getFocusedTrack().isDrumTrack() ? studioEngine.getFocusedTrack().id : undefined });
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
          if (trackId) focusTrackSelection(trackId);
          break;
        case "open-track-instrument":
          if (trackId) focusTrackSelection(trackId);
          openInstrumentPage();
          break;
        case "close-arp":
          arpTrackKey = null; renderStudioPanel(); document.getElementById("kb-arp")?.focus();
          break;
        case "close-track-instrument":
          exitInstrumentFocusMode(true);
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
          if (tab) setStudioDockTab(tab);
          break;
        }
        case "dock-expand":
          dockExpanded = !dockExpanded;
          if (dockExpanded) {
            dockCollapsed = false;
            dockPinnedOpen = true;
          }
          renderStudioPanel();
          break;
        case "dock-collapse":
          dockCollapsed = !dockCollapsed;
          if (dockCollapsed) {
            studioEngine.stopDrumPreview();
            dockExpanded = false;
            dockPinnedOpen = false;
          } else {
            dockPinnedOpen = true;
          }
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
          const ft = resolveInstrumentTrack(btn);
          const m = getStudioMachineDef(ft.machineId);
          const orderedIds = [
            ...(m.kind === "drums" && m.kits ? m.kits.map((k) => `kit:${k.id}`) : []),
            ...m.presets.map((p) => p.id)
          ];
          if (orderedIds.length === 0) break;
          const idx = orderedIds.indexOf(ft.presetId);
          const dir = action === "inst-preset-next" ? 1 : -1;
          const nextIdx = ((idx < 0 ? 0 : idx) + dir + orderedIds.length) % orderedIds.length;
          studioEngine.prepareAudioSync();
          studioEngine.setTrackMachinePreset(ft.id, m.id, orderedIds[nextIdx]);
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
            ft.auditionNote(60, 0.78, 320);
          }
          break;
        }
        case "track-drum-preview": {
          const track = resolveInstrumentTrack(btn);
          try {
            if (studioEngine.isDrumPreviewEnabled(track.id)) studioEngine.stopDrumPreview();
            else studioEngine.startDrumPreview(track.id);
          } catch (error) { setStatus(error instanceof Error ? error.message : String(error), "error"); }
          renderStudioPanel(); break;
        }
        case "track-drum-live": {
          const ft = resolveInstrumentTrack(btn);
          try {
            const enabled = !studioEngine.isLiveDrumEnabled(ft.id);
            studioEngine.setLiveDrumEnabled(ft.id,enabled);
            setStatus(enabled ? "Live pattern ready · use Play or Record" : "Live pattern off", "ok");
          } catch(error) { setStatus(error instanceof Error ? error.message : String(error),"error"); }
          renderStudioPanel(); break;
        }
        case "track-drum-pattern":
        case "track-drum-len":
        case "track-drum-edit":
        case "track-drum-clear":
        case "track-drum-step":
        case "track-drum-insert": {
          const ft = resolveInstrumentTrack(btn);
          if (!ft.isDrumTrack()) break;
          if (action === "track-drum-insert" && studioEngine.getTransportSnapshot().recording) { setStatus("Stop recording before inserting a MIDI region.","error"); renderStudioPanel(); break; }
          const bank = ft.getTrackDrumBank(), pat = bank.patterns[bank.selected];
          if (action === "track-drum-edit") {
            setTrackDrumEdit(ft, STEP_EDITS[(STEP_EDITS.indexOf(getTrackDrumEdit(ft))+1)%STEP_EDITS.length]);
          } else if (action === "track-drum-insert") {
            try {
              const tick = studioEngine.insertDrumPattern(ft.id);
              const bar = Math.floor(tick / STUDIO_TICKS_PER_BAR) + 1;
              setStatus(`Pattern inserted as MIDI · bar ${bar}`, "ok");
              if (instrumentFocusMode) exitInstrumentFocusMode(true);
            } catch (error) { setStatus(error instanceof Error ? error.message : String(error), "error"); }
          } else {
            if (action === "track-drum-pattern") {
              const i = Number(btn.dataset.index); if (!Number.isInteger(i)||i<0||i>7) break; bank.selected=i;
            } else if (action === "track-drum-len") pat.len=btn.dataset.len==="12"?12:16;
            else if (action === "track-drum-clear") bank.patterns[bank.selected]=emptyPattern(pat.len);
            else if (!editTrackDrumStep(pat,getStudioSelectedDrumVoice(ft.id),Number(btn.dataset.index),getTrackDrumEdit(ft))) break;
            ft.setTrackDrumBank(bank);
          }
          renderStudioPanel(); break;
        }
        case "drum-select-voice": {
          const dv = btn.getAttribute("data-st-drum-voice") as DrumVoice | null;
          const ft = resolveInstrumentTrack(btn);
          if (dv && DRUM_NOTES[dv] !== undefined) {
            setStudioSelectedDrumVoice(ft.id, dv);
            renderStudioPanel();
          }
          break;
        }
        case "drum-audition": {
          const dv = btn.getAttribute("data-st-drum-voice") as DrumVoice | null;
          const ft = resolveInstrumentTrack(btn);
          if (dv && DRUM_NOTES[dv] !== undefined) {
            const prevVoice = getStudioSelectedDrumVoice(ft.id);
            setStudioSelectedDrumVoice(ft.id, dv);
            studioEngine.prepareAudioSync();
            if (ft.id === studioEngine.getFocusedTrack().id) {
              studioEngine.liveNoteOn(DRUM_NOTES[dv], 0.9);
              studioEngine.liveNoteOff(DRUM_NOTES[dv]);
            } else {
              ft.noteOn(DRUM_NOTES[dv], 0.9);
            }
            if (prevVoice !== dv) renderStudioPanel();
          }
          break;
        }
        case "drum-pick-kit": {
          const kid = btn.getAttribute("data-st-kit") || "";
          const ft = resolveInstrumentTrack(btn);
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
            resolveInstrumentTrack(btn).setParam(param, val);
          }
          break;
        }
        case "param-toggle": {
          const param = btn.getAttribute("data-st-param");
          const on = btn.getAttribute("data-st-on") || "on";
          const off = btn.getAttribute("data-st-off") || "off";
          if (param) {
            studioEngine.prepareAudioSync();
            const ft = resolveInstrumentTrack(btn);
            ft.setParam(param, String(ft.patch[param]) === on ? off : on);
          }
          break;
        }
        case "save-project": {
          void saveStudioProjectNow().then((ok) => {
            if (ok) syncCleanContentBaseline();
          });
          break;
        }
        case "toggle-open-drawer": {
          exportMenuOpen = false;
          openDrawerVisible = !openDrawerVisible;
          if (openDrawerVisible) {
            void refreshOpenDrawerData().then(() => renderStudioPanel());
          } else {
            renderStudioPanel();
          }
          break;
        }
        case "new-project": {
          if (studioEngine.getTransportSnapshot().recording) {
            setStatus("Stop recording before creating a new project.", "error");
            renderStudioPanel();
            break;
          }
          const openNewModal = () => {
            pendingProjectNameModal = { kind: "new", initialName: `Session ${savedProjectsCache.length + 1}` };
            renderStudioPanel();
            const inp = container.querySelector<HTMLInputElement>("#st-project-name-modal-input");
            inp?.focus();
            inp?.select();
          };
          if (projectDirty) {
            pendingUnsavedAction = { label: "creating a new project", run: openNewModal };
            renderStudioPanel();
            container.querySelector<HTMLElement>("#st-unsaved-save-btn")?.focus();
          } else {
            openNewModal();
          }
          break;
        }
        case "duplicate-current-project": {
          if (studioEngine.getTransportSnapshot().recording) {
            setStatus("Stop recording before duplicating the project.", "error");
            renderStudioPanel();
            break;
          }
          pendingProjectNameModal = {
            kind: "duplicate-current",
            initialName: `${studioEngine.getProjectName()} Copy`
          };
          renderStudioPanel();
          const inp = container.querySelector<HTMLInputElement>("#st-project-name-modal-input");
          inp?.focus();
          inp?.select();
          break;
        }
        case "rename-current-project": {
          if (studioEngine.getTransportSnapshot().recording) {
            setStatus("Stop recording before renaming the project.", "error");
            renderStudioPanel();
            break;
          }
          pendingProjectNameModal = {
            kind: "rename-current",
            initialName: studioEngine.getProjectName()
          };
          renderStudioPanel();
          const inp = container.querySelector<HTMLInputElement>("#st-project-name-modal-input");
          inp?.focus();
          inp?.select();
          break;
        }
        case "duplicate-saved-project": {
          if (studioEngine.getTransportSnapshot().recording) {
            setStatus("Stop recording before duplicating a project.", "error");
            renderStudioPanel();
            break;
          }
          const pid = btn.getAttribute("data-project-id") || "";
          const meta = savedProjectsCache.find((p) => p.id === pid);
          if (!pid || !meta) break;
          pendingProjectNameModal = {
            kind: "duplicate-saved",
            projectId: pid,
            initialName: `${meta.name} Copy`
          };
          renderStudioPanel();
          const inp = container.querySelector<HTMLInputElement>("#st-project-name-modal-input");
          inp?.focus();
          inp?.select();
          break;
        }
        case "rename-saved-project": {
          if (studioEngine.getTransportSnapshot().recording) {
            setStatus("Stop recording before renaming a project.", "error");
            renderStudioPanel();
            break;
          }
          const pid = btn.getAttribute("data-project-id") || "";
          const meta = savedProjectsCache.find((p) => p.id === pid);
          if (!pid || !meta) break;
          pendingProjectNameModal = {
            kind: "rename-saved",
            projectId: pid,
            initialName: meta.name
          };
          renderStudioPanel();
          const inp = container.querySelector<HTMLInputElement>("#st-project-name-modal-input");
          inp?.focus();
          inp?.select();
          break;
        }
        case "cancel-project-name-modal": {
          pendingProjectNameModal = null;
          renderStudioPanel();
          break;
        }
        case "confirm-project-name-modal": {
          const modal = pendingProjectNameModal;
          if (!modal) break;
          const inp = container.querySelector<HTMLInputElement>("#st-project-name-modal-input");
          const nextName = sanitizeProjectName(inp ? inp.value : modal.initialName);
          pendingProjectNameModal = null;
          if (modal.kind === "new") {
            void (async () => {
              try {
                suppressNextAutosave = true;
                suppressDirtyTracking = true;
                await studioEngine.createNewProject({ name: nextName });
                instrumentFocusMode = false;
                preInstFocusState = null;
                pendingClearTrackId = null;
                dockCollapsed = true;
                dockPinnedOpen = false;
                dockExpanded = false;
                await studioStorage.saveAutosave(studioEngine.exportProject());
                syncCleanContentBaseline();
                openDrawerVisible = false;
                setStatus(`Created "${nextName}"`, "ok");
              } catch (err) {
                setStatus(err instanceof Error ? err.message : "Failed to create project.", "error");
              } finally {
                suppressNextAutosave = false;
                suppressDirtyTracking = false;
                await refreshOpenDrawerData();
                renderStudioPanel();
              }
            })();
          } else if (modal.kind === "duplicate-current") {
            void (async () => {
              try {
                suppressNextAutosave = true;
                suppressDirtyTracking = true;
                studioEngine.duplicateCurrentProject(nextName);
                const saved = await saveStudioProjectNow();
                if (saved) {
                  syncCleanContentBaseline();
                  setStatus(`Saved independent copy "${nextName}"`, "ok");
                }
              } catch (err) {
                setStatus(err instanceof Error ? err.message : "Failed to duplicate project.", "error");
              } finally {
                suppressNextAutosave = false;
                suppressDirtyTracking = false;
                await refreshOpenDrawerData();
                renderStudioPanel();
              }
            })();
          } else if (modal.kind === "rename-current") {
            void (async () => {
              studioEngine.setProjectName(nextName);
              const curId = studioEngine.getProjectId();
              const existing = await studioStorage.loadProject(curId);
              if (existing.ok && existing.data) {
                await studioStorage.renameProject(curId, nextName);
              }
              await studioStorage.saveAutosave(studioEngine.exportProject());
              if (!projectDirty) syncCleanContentBaseline();
              setStatus(`Renamed to "${nextName}"`, "ok");
              await refreshOpenDrawerData();
              renderStudioPanel();
            })();
          } else if (modal.kind === "rename-saved" && modal.projectId) {
            const targetId = modal.projectId;
            void studioStorage.renameProject(targetId, nextName).then(async (res) => {
              if (!res.ok) {
                setStatus(res.message, "error");
              } else {
                if (studioEngine.getProjectId() === targetId) {
                  suppressDirtyTracking = true;
                  studioEngine.setProjectName(nextName);
                  if (!projectDirty) syncCleanContentBaseline();
                  suppressDirtyTracking = false;
                }
                setStatus(`Renamed project to "${nextName}"`, "ok");
              }
              await refreshOpenDrawerData();
              renderStudioPanel();
            });
          } else if (modal.kind === "duplicate-saved" && modal.projectId) {
            const targetId = modal.projectId;
            void studioStorage.duplicateProject(targetId, nextName).then(async (res) => {
              if (!res.ok) setStatus(res.message, "error");
              else setStatus(`Duplicated as "${res.data.name}"`, "ok");
              await refreshOpenDrawerData();
              renderStudioPanel();
            });
          }
          break;
        }
        case "cancel-unsaved-action": {
          pendingUnsavedAction = null;
          renderStudioPanel();
          break;
        }
        case "discard-unsaved-action": {
          const next = pendingUnsavedAction;
          pendingUnsavedAction = null;
          projectDirty = false;
          renderStudioPanel();
          if (next) void next.run();
          break;
        }
        case "save-and-continue-action": {
          const next = pendingUnsavedAction;
          pendingUnsavedAction = null;
          void saveStudioProjectNow().then(async (ok) => {
            if (!ok) return;
            syncCleanContentBaseline();
            if (next) await next.run();
          });
          break;
        }
        case "open-saved-project": {
          if (studioEngine.getTransportSnapshot().recording) {
            setStatus("Stop recording before opening another project.", "error");
            renderStudioPanel();
            break;
          }
          const pid = btn.getAttribute("data-project-id") || "";
          if (!pid) break;
          const performOpen = async () => {
            const res = await studioStorage.loadProject(pid);
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
              suppressDirtyTracking = true;
              await studioEngine.loadProject(res.data);
              instrumentFocusMode = false;
              preInstFocusState = null;
              pendingClearTrackId = null;
              dockCollapsed = true;
              dockPinnedOpen = false;
              dockExpanded = false;
              await studioStorage.saveAutosave(studioEngine.exportProject());
              syncCleanContentBaseline();
              openDrawerVisible = false;
              setStatus(`Opened "${res.data.name}"`, "ok");
            } catch (err) {
              setStatus(err instanceof Error ? err.message : "Failed to open project", "error");
            } finally {
              suppressNextAutosave = false;
              suppressDirtyTracking = false;
              renderStudioPanel();
            }
          };
          if (projectDirty) {
            pendingUnsavedAction = { label: "opening another project", run: performOpen };
            renderStudioPanel();
            container.querySelector<HTMLElement>("#st-unsaved-save-btn")?.focus();
          } else {
            void performOpen();
          }
          break;
        }
        case "delete-saved-project": {
          if (studioEngine.getTransportSnapshot().recording) {
            setStatus("Stop recording before deleting a project.", "error");
            renderStudioPanel();
            break;
          }
          const pid = btn.getAttribute("data-project-id") || "";
          if (!pid) break;
          const meta = savedProjectsCache.find((p) => p.id === pid);
          pendingDeleteProject = { id: pid, name: meta?.name || "this project" };
          renderStudioPanel();
          container.querySelector<HTMLElement>("#st-delete-project-cancel-btn")?.focus();
          break;
        }
        case "cancel-delete-project": {
          pendingDeleteProject = null;
          renderStudioPanel();
          break;
        }
        case "confirm-delete-project": {
          const target = pendingDeleteProject;
          const pid = btn.getAttribute("data-project-id") || target?.id || "";
          const deletedName = target?.name || "project";
          pendingDeleteProject = null;
          if (!pid) {
            renderStudioPanel();
            break;
          }
          void studioStorage.deleteProject(pid).then(async (res) => {
            if (!res.ok) setStatus(res.message, "error");
            else setStatus(`Deleted "${deletedName}"`, "info");
            await refreshOpenDrawerData();
            renderStudioPanel();
          });
          break;
        }
        case "restore-autosave": {
          if (studioEngine.getTransportSnapshot().recording) {
            setStatus("Stop recording before recovering autosave.", "error");
            renderStudioPanel();
            break;
          }
          const performRestore = async () => {
            const res = await studioStorage.loadAutosave();
            if (!res.ok || !res.data) {
              setStatus(res.ok ? "No autosave available" : res.message, "error");
              renderStudioPanel();
              return;
            }
            try {
              suppressNextAutosave = true;
              suppressDirtyTracking = true;
              await studioEngine.loadProject(res.data.project);
              instrumentFocusMode = false;
              preInstFocusState = null;
              pendingClearTrackId = null;
              dockCollapsed = true;
              dockPinnedOpen = false;
              dockExpanded = false;
              syncCleanContentBaseline();
              openDrawerVisible = false;
              setStatus(`Recovered "${res.data.project.name}"`, "ok");
            } catch (err) {
              setStatus(err instanceof Error ? err.message : "Recovery failed", "error");
            } finally {
              suppressNextAutosave = false;
              suppressDirtyTracking = false;
              renderStudioPanel();
            }
          };
          if (projectDirty) {
            pendingUnsavedAction = { label: "recovering autosave", run: performRestore };
            renderStudioPanel();
            container.querySelector<HTMLElement>("#st-unsaved-save-btn")?.focus();
          } else {
            void performRestore();
          }
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
          if (studioEngine.getTransportSnapshot().recording) {
            setStatus("Stop recording before importing a project.", "error");
            renderStudioPanel();
            break;
          }
          const openPicker = () => {
            const inp = document.getElementById("st-import-file") as HTMLInputElement | null;
            if (inp) {
              inp.value = "";
              inp.click();
            }
            renderStudioPanel();
          };
          if (projectDirty) {
            pendingUnsavedAction = { label: "importing a .sy1studio project", run: openPicker };
            renderStudioPanel();
            container.querySelector<HTMLElement>("#st-unsaved-save-btn")?.focus();
          } else {
            openPicker();
          }
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

    // Clicking anywhere in a track header (outside native selects/inputs/buttons) focuses that track
    if (!target.closest("select, input, button")) {
      const trackRow = target.closest<HTMLElement>(".st-track[data-track-id]");
      if (trackRow && target.closest(".st-track-ctl")) {
        const tid = trackRow.getAttribute("data-track-id");
        if (tid) focusTrackSelection(tid);
        return;
      }
      const mixStrip = target.closest<HTMLElement>(".st-mix-strip[data-mix-track]");
      if (mixStrip) {
        const tid = mixStrip.getAttribute("data-mix-track");
        if (tid) focusTrackSelection(tid);
        return;
      }
    }

    // Clicking a timeline lane focuses that track and seeks
    const lane = target.closest<HTMLElement>("[data-st-lane]");
    if (lane) {
      const tid = lane.getAttribute("data-track-id");
      if (tid) focusTrackSelection(tid);
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

    if (el.closest(".oriental-pop")) {
      const ft = studioOrientalTrack();
      if (!ft) return;
      if (el.classList.contains("or-cent-input")) {
        const degree = Number(el.dataset.deg), value = Number(el.value);
        if (Number.isInteger(degree) && degree >= 0 && degree < 12 && Number.isFinite(value)) {
          const offsets = ft.getTrackCustomTuning(); offsets[degree] = value; ft.setTrackCustomTuning(offsets);
        }
        renderStudioPanel();
      } else if (el.id === "st-scl-file-input") {
        const file = (el as HTMLInputElement).files?.[0];
        if (!file) return;
        const session = orientalSession;
        file.text().then(text => {
          if (session !== orientalSession || studioOrientalTrack() !== ft) return;
          const res = parseScalaScl(text);
          if (res.ok === true) { ft.setTrackCustomTuning(res.offsets); orientalStatus = `Loaded: ${res.description || file.name}`; orientalError = false; }
          else { orientalStatus = res.error; orientalError = true; }
          renderStudioPanel();
        }).catch(() => {
          if (session !== orientalSession || studioOrientalTrack() !== ft) return;
          orientalStatus = "Could not read tuning file."; orientalError = true; renderStudioPanel();
        });
      }
      return;
    }

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
    if (el.id === "st-bpm-input") {
      const bpm = Number(el.value);
      if (Number.isFinite(bpm) && el.value.trim()) studioEngine.setBpm(bpm);
      renderStudioPanel();
      return;
    }
    if (el.id === "st-bars-custom") {
      studioEngine.setBars(Number(el.value));
      return;
    }
    if (el.id === "st-arr-snap") {
      studioEngine.regions.grid = Math.max(0, Number(el.value) || 0);
      renderStudioPanel();
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
      resolveInstrumentTrack(el).setParam(instSelectParam, el.value);
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
    if (selType === "focus-track" && el.value) {
      focusTrackSelection(el.value);
      renderStudioPanel();
      return;
    }
    if (selType === "machine" && trackId) {
      focusTrackSelection(trackId);
      instPageFilter = "all";
      studioEngine.prepareAudioSync();
      studioEngine.setTrackMachine(trackId, el.value);
      return;
    }
    if (selType === "preset" && trackId) {
      focusTrackSelection(trackId);
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
    trackId: string;
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
    trackId: string;
    svg: SVGSVGElement;
    pointerId: number;
  } | null = null;

  const resolveInstrumentTrack = (el: HTMLElement | SVGElement | null): SY1TrackEngine => {
    const synthRoot = el?.closest<HTMLElement>(".st-embedded-synth[data-track-id]");
    const tid = synthRoot?.getAttribute("data-track-id") || el?.getAttribute("data-track-id") || "";
    return (tid ? studioEngine.getTrack(tid) : undefined) || studioEngine.getFocusedTrack();
  };

  const focusTrackSelection = (targetTrackId: string): void => {
    if (!targetTrackId || !studioEngine.getTrack(targetTrackId)) return;
    const prevId = studioEngine.getFocusedTrack().id;
    if (prevId !== targetTrackId) {
      instPageFilter = "all";
      if (studioEngine.regions.selection().length > 0) {
        const curRegion = studioEngine.regions.current(targetTrackId);
        if (!curRegion) studioEngine.regions.clearSelection();
      }
      if (knobDrag) {
        knobDrag.el.classList.remove("is-dragging");
        knobDrag = null;
      }
      if (vecPadDrag) {
        vecPadDrag = null;
      }
      draggingKnobParam = null;
      draggingKnobTrackId = null;
    }
    studioEngine.setFocusedTrack(targetTrackId);
    // Keep Piano Roll minimized when switching to a track that has no regions and no active selection
    if (
      activeDockTab === "piano-roll" &&
      !dockCollapsed &&
      studioEngine.regions.selection().length === 0 &&
      studioEngine.regions.regions(targetTrackId).length === 0
    ) {
      dockCollapsed = true;
      dockPinnedOpen = false;
      dockExpanded = false;
    }
    // GarageBand workflow: selecting a track arms it cleanly when not recording (unless multi-channel MIDI routing is active)
    if (!studioEngine.getTransportSnapshot().recording) {
      const allTracks = studioEngine.getTracks();
      const hasExplicitChannels = allTracks.some((t) => t.midiChannel > 0);
      if (!hasExplicitChannels) {
        for (const t of allTracks) {
          if (t.armed !== (t.id === targetTrackId)) {
            studioEngine.setTrackArmed(t.id, t.id === targetTrackId);
          }
        }
      }
    }
  };

  const updateVectorFromPointer = (trackId: string, svg: SVGSVGElement, clientX: number, clientY: number) => {
    const rect = svg.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const ux = ((clientX - rect.left) / rect.width) * 200;
    const uy = ((clientY - rect.top) / rect.height) * 200;
    const nx = Math.max(0, Math.min(1, (ux - 12) / 176));
    const ny = Math.max(0, Math.min(1, (uy - 12) / 176));
    const ft = studioEngine.getTrack(trackId);
    if (!ft) return;
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
      const track = resolveInstrumentTrack(vecPad);
      draggingKnobParam = "vecX";
      draggingKnobTrackId = track.id;
      vecPadDrag = { trackId: track.id, svg: vecPad, pointerId: e.pointerId };
      try { vecPad.setPointerCapture(e.pointerId); } catch (err) {}
      updateVectorFromPointer(track.id, vecPad, e.clientX, e.clientY);
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
    const track = resolveInstrumentTrack(knob);
    draggingKnobParam = key;
    draggingKnobTrackId = track.id;
    knobDrag = {
      trackId: track.id,
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
      updateVectorFromPointer(vecPadDrag.trackId, vecPadDrag.svg, e.clientX, e.clientY);
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
    studioEngine.setTrackParam(knobDrag.trackId, knobDrag.key, nextVal);
  });

  const endInteractiveDrags = (e?: PointerEvent) => {
    if (vecPadDrag && (!e || e.pointerId === vecPadDrag.pointerId)) {
      vecPadDrag = null;
      draggingKnobParam = null;
      draggingKnobTrackId = null;
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
    draggingKnobTrackId = null;
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
      if (tid) focusTrackSelection(tid);
      showStudioPianoRoll();
      return;
    }

    const knob = target.closest<HTMLElement>(".st-inst-knob");
    if (!knob) return;
    const key = knob.getAttribute("data-st-param");
    if (key && SYNTH_PARAMS[key]) {
      resolveInstrumentTrack(knob).setParam(key, SYNTH_PARAMS[key].def);
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
      const track = resolveInstrumentTrack(knob);
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
      container.querySelector<HTMLElement>(studioMenuKind === "settings" ? "#st-settings-btn" : "#st-export-menu-btn")?.focus();
      return;
    }
    const inExportMenu = (e.target as HTMLElement | null)?.closest("#st-export-menu");
    if (inExportMenu && ["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) {
      e.preventDefault();
      e.stopPropagation();
      const items = Array.from(inExportMenu.querySelectorAll<HTMLElement>(".st-menu-view:not([hidden]) [role^='menuitem']:not(:disabled)"));
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
    const track = resolveInstrumentTrack(knob);
    const next = def.step
      ? Number(track.patch[key]) + dir * def.step
      : synthDenorm(key, synthNorm(key, Number(track.patch[key])) + dir * 0.02);
    track.setParam(key, next);
  });
}

export function showStudioPanel(): void {
  document.documentElement.classList.add("is-studio");
  if (!dockPinnedOpen && studioEngine.regions.selection().length === 0) {
    dockCollapsed = true;
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
  restoreStandaloneInstrumentHost();
  stopPlayheadLoop();
  cachedPlayheadEls = [];
  cachedClockEl = null;
  cachedMeterEls = [];
  instrumentFocusMode = false;
  preInstFocusState = null;
  exportMenuOpen = false;
  pendingClearTrackId = null;
  pendingDeleteProject = null;
  pendingProjectNameModal = null;
  pendingUnsavedAction = null;
  closeStudioOriental();
  arpTrackKey = null;
  document.getElementById("kb-arp")?.classList.remove("is-open");
  document.getElementById("kb-arp")?.setAttribute("aria-expanded", "false");
  document.documentElement.classList.remove("is-studio", "is-studio-instrument");
  document.getElementById("kb-oriental")?.classList.remove("is-open");
  document.getElementById("kb-oriental")?.setAttribute("aria-expanded", "false");
  const synthEl = document.getElementById("sy1-panel");
  const studioEl = document.getElementById("sy1-studio");
  if (studioEl) studioEl.hidden = true;
  if (synthEl) synthEl.hidden = false;
  applyKeyboardVisibility();
}
