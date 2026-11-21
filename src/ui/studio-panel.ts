/**
 * SY-1 Studio UI — Dedicated Multi-Track Recording & Editing Workspace
 *
 * Strictly web-only (never initialized when window.__SY1_PLUGIN__ is present).
 * Every control binds exclusively to SY1StudioEngine / SY1TrackEngine without
 * touching standalone synth.ts state or localStorage keys.
 */

import { escapeHtml, SYNTH_PARAMS, synthDenorm, synthNorm } from "../engine/params";
import { fmtBpm } from "../engine/tempo";
import { SY1 } from "../machines/sy1";
import { parseStudioProjectJson, projectFilename } from "../studio/project-io";
import { studioStorage } from "../studio/storage";
import { studioEngine } from "../studio/studio-engine";
import { SY1TrackEngine } from "../studio/track-engine";
import {
  STUDIO_BAR_PRESETS,
  STUDIO_MAX_TRACKS,
  STUDIO_TICKS_PER_BAR,
  StudioSavedProjectMeta
} from "../studio/types";

type InspectorTab = "osc" | "filter" | "amp" | "fx" | "voice";
type StatusTone = "info" | "ok" | "error";

let activeTab: InspectorTab = "filter";
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
    await studioStorage.saveAutosave(studioEngine.exportProject());
    openDrawerVisible = false;
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

function scheduleAutosave(): void {
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

function presetGroupsHtml(selectedId: string): string {
  const groups = new Map<string, { id: string; name: string }[]>();
  for (const p of SY1.presets) {
    let list = groups.get(p.group);
    if (!list) {
      list = [];
      groups.set(p.group, list);
    }
    list.push({ id: p.id, name: p.name });
  }
  let html = selectedId === "custom" ? `<option value="custom" selected>Custom (Edited)</option>` : "";
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

function renderKnob(track: SY1TrackEngine, key: string, label: string): string {
  const def = SYNTH_PARAMS[key];
  const val = track.patch[key];
  const n = Math.max(0, Math.min(1, synthNorm(key, Number(val))));
  const fmt = def?.fmt ? def.fmt(Number(val)) : String(val);
  return `<div class="st-knob" data-st-param="${escapeHtml(key)}" role="slider" tabindex="0" aria-label="${escapeHtml(label)}" aria-valuetext="${escapeHtml(fmt)}">
    <div class="st-knob-dial" style="--n:${n.toFixed(4)}">
      <span class="st-knob-ptr"></span>
    </div>
    <span class="st-knob-lbl">${escapeHtml(label)}</span>
    <span class="st-knob-val">${escapeHtml(fmt)}</span>
  </div>`;
}

function renderChoice(track: SY1TrackEngine, key: string, options: [string, string][]): string {
  const cur = String(track.patch[key]);
  return `<div class="st-choice" data-st-choice="${escapeHtml(key)}">` +
    options.map(([val, lbl]) =>
      `<button type="button" class="st-choice-btn${cur === val ? " is-active" : ""}" data-st-action="param-choice" data-st-param="${escapeHtml(key)}" data-st-value="${escapeHtml(val)}">${escapeHtml(lbl)}</button>`
    ).join("") +
    `</div>`;
}

function renderInspectorBody(track: SY1TrackEngine): string {
  if (activeTab === "osc") {
    return `
      <div class="st-ctrl-group">
        <div class="st-ctrl-cap">Osc 1</div>
        ${renderChoice(track, "osc1Wave", [["sawtooth", "Saw"], ["square", "Sqr"], ["triangle", "Tri"], ["sine", "Sin"]])}
        <div class="st-knob-row">
          ${renderKnob(track, "osc1Oct", "Oct")}
          ${renderKnob(track, "sub", "Sub")}
          ${renderKnob(track, "noise", "Noise")}
        </div>
      </div>
      <div class="st-ctrl-group">
        <div class="st-ctrl-cap">Osc 2 &amp; Mix</div>
        ${renderChoice(track, "osc2Wave", [["sawtooth", "Saw"], ["square", "Sqr"], ["triangle", "Tri"], ["sine", "Sin"]])}
        <div class="st-knob-row">
          ${renderKnob(track, "osc2Oct", "Oct")}
          ${renderKnob(track, "osc2Detune", "Detune")}
          ${renderKnob(track, "oscMix", "Mix")}
        </div>
      </div>
      <div class="st-ctrl-group">
        <div class="st-ctrl-cap">Unison &amp; Analog</div>
        <div class="st-knob-row">
          ${renderKnob(track, "unison", "Voices")}
          ${renderKnob(track, "uniDetune", "Spread")}
          ${renderKnob(track, "uniWidth", "Width")}
          ${renderKnob(track, "drift", "Drift")}
        </div>
      </div>`;
  }
  if (activeTab === "filter") {
    return `
      <div class="st-ctrl-group">
        <div class="st-ctrl-cap">Filter Type</div>
        ${renderChoice(track, "filterType", [["lowpass", "LP12"], ["lp24", "LP24"], ["ladder", "Ladder"], ["bandpass", "BP"], ["highpass", "HP"]])}
        <div class="st-knob-row">
          ${renderKnob(track, "cutoff", "Cutoff")}
          ${renderKnob(track, "res", "Res")}
          ${renderKnob(track, "envAmt", "Env Amt")}
          ${renderKnob(track, "filterDrive", "Drive")}
          ${renderKnob(track, "keyTrack", "Key Trk")}
        </div>
      </div>
      <div class="st-ctrl-group">
        <div class="st-ctrl-cap">Filter Envelope</div>
        <div class="st-knob-row">
          ${renderKnob(track, "fA", "Attack")}
          ${renderKnob(track, "fD", "Decay")}
          ${renderKnob(track, "fS", "Sustain")}
          ${renderKnob(track, "fR", "Release")}
        </div>
      </div>`;
  }
  if (activeTab === "amp") {
    return `
      <div class="st-ctrl-group">
        <div class="st-ctrl-cap">Amp Envelope</div>
        <div class="st-knob-row">
          ${renderKnob(track, "aA", "Attack")}
          ${renderKnob(track, "aD", "Decay")}
          ${renderKnob(track, "aS", "Sustain")}
          ${renderKnob(track, "aR", "Release")}
          ${renderKnob(track, "velSens", "Vel")}
          ${renderKnob(track, "volume", "Synth Vol")}
        </div>
      </div>
      <div class="st-ctrl-group">
        <div class="st-ctrl-cap">LFO</div>
        ${renderChoice(track, "lfoTarget", [["pitch", "Pitch"], ["filter", "Filter"], ["amp", "Amp"]])}
        <div class="st-knob-row">
          ${renderKnob(track, "lfoRate", "Rate")}
          ${renderKnob(track, "lfoDepth", "Depth")}
          ${renderKnob(track, "lfoSync", "Sync")}
        </div>
      </div>`;
  }
  if (activeTab === "fx") {
    return `
      <div class="st-ctrl-group">
        <div class="st-ctrl-cap">Drive &amp; EQ</div>
        <div class="st-knob-row">
          ${renderKnob(track, "drive", "Drive")}
          ${renderKnob(track, "eqLow", "Low")}
          ${renderKnob(track, "eqMid", "Mid")}
          ${renderKnob(track, "eqHigh", "High")}
        </div>
      </div>
      <div class="st-ctrl-group">
        <div class="st-ctrl-cap">Chorus &amp; Delay</div>
        <div class="st-knob-row">
          ${renderKnob(track, "chorusMix", "Chorus")}
          ${renderKnob(track, "chorusRate", "Rate")}
          ${renderKnob(track, "delayTime", "Dly Time")}
          ${renderKnob(track, "delayFb", "Feedback")}
          ${renderKnob(track, "delayMix", "Dly Mix")}
        </div>
      </div>
      <div class="st-ctrl-group">
        <div class="st-ctrl-cap">Reverb</div>
        <div class="st-knob-row">
          ${renderKnob(track, "revSize", "Size")}
          ${renderKnob(track, "revMix", "Rev Mix")}
        </div>
      </div>`;
  }
  return `
    <div class="st-ctrl-group">
      <div class="st-ctrl-cap">Voice Mode</div>
      ${renderChoice(track, "polyMode", [["poly", "Poly"], ["mono", "Mono"]])}
      ${renderChoice(track, "legato", [["on", "Legato On"], ["off", "Legato Off"]])}
      <div class="st-knob-row">
        ${renderKnob(track, "glide", "Glide")}
        ${renderKnob(track, "bendRange", "Bend")}
      </div>
    </div>`;
}

function renderRulerMarks(bars: number): string {
  const step = bars <= 16 ? 1 : bars <= 32 ? 2 : bars <= 64 ? 4 : bars <= 128 ? 8 : 16;
  let html = "";
  for (let b = 0; b < bars; b += step) {
    const pct = (b / bars) * 100;
    html += `<span class="st-ruler-mark" style="left:${pct.toFixed(4)}%">${b + 1}</span>`;
  }
  return html;
}

function renderLaneGrid(bars: number): string {
  const step = bars <= 16 ? 1 : bars <= 64 ? 4 : bars <= 128 ? 8 : 16;
  let html = "";
  for (let b = 0; b < bars; b += step) {
    const pct = (b / bars) * 100;
    const major = b % (step * 4) === 0;
    html += `<span class="st-lane-barline${major ? " is-major" : ""}" style="left:${pct.toFixed(4)}%"></span>`;
  }
  return html;
}

function renderTrackNotes(track: SY1TrackEngine, totalTicks: number): string {
  const spans = track.getNoteSpans(totalTicks);
  if (spans.length === 0) {
    return `<div class="st-lane-empty">No recorded notes · arm R and press Rec</div>`;
  }
  let minM = 127;
  let maxM = 0;
  for (const s of spans) {
    if (s.midi < minM) minM = s.midi;
    if (s.midi > maxM) maxM = s.midi;
  }
  const lo = Math.min(minM, 48);
  const hi = Math.max(maxM, lo + 24);
  const spanM = Math.max(12, hi - lo);

  return spans.map((s) => {
    const leftPct = Math.max(0, Math.min(100, (s.startTick / totalTicks) * 100));
    const widthPct = Math.max(0.4, Math.min(100 - leftPct, ((s.endTick - s.startTick) / totalTicks) * 100));
    const topPct = 92 - ((s.midi - lo) / spanM) * 86;
    return `<span class="st-note-bar" style="left:${leftPct.toFixed(3)}%;width:${widthPct.toFixed(3)}%;top:${topPct.toFixed(1)}%"></span>`;
  }).join("");
}

function renderStudioHtml(): string {
  const tr = studioEngine.getTransportSnapshot();
  const tracks = studioEngine.getTracks();
  const focused = studioEngine.getFocusedTrack();
  const loopLeftPct = ((tr.loopStartBar - 1) / tr.bars) * 100;
  const loopWidthPct = ((tr.loopEndBar - tr.loopStartBar + 1) / tr.bars) * 100;
  const playheadPct = tr.totalTicks > 0 ? (tr.currentTick / tr.totalTicks) * 100 : 0;

  const barButtons = STUDIO_BAR_PRESETS.map((b) =>
    `<button type="button" class="st-btn st-bar-btn${tr.bars === b ? " is-active" : ""}" data-st-action="set-bars" data-st-bars="${b}">${b}</button>`
  ).join("");

  const trackRows = tracks.map((t, idx) => {
    const isFocused = t.id === focused.id;
    const volPct = Math.round(t.volume * 100);
    const panStr = Math.abs(t.pan) < 0.04 ? "C" : (t.pan < 0 ? `L${Math.round(-t.pan * 100)}` : `R${Math.round(t.pan * 100)}`);
    const noteCount = t.getNoteCount();
    const audioTag = t.getAudioState() === "hq" ? "HQ" : t.getAudioState() === "classic" ? "Classic" : "Ready";

    return `<div class="st-track${isFocused ? " is-focused" : ""}" data-track-id="${escapeHtml(t.id)}" data-track-idx="${idx}">
      <div class="st-track-ctl">
        <div class="st-track-top">
          <button type="button" class="st-track-title" data-st-action="focus-track" data-track-id="${escapeHtml(t.id)}" title="Focus this track for keyboard & synth controls">${escapeHtml(t.name)}</button>
          <select class="st-select" data-st-select="preset" data-track-id="${escapeHtml(t.id)}" aria-label="${escapeHtml(t.name)} preset">
            ${presetGroupsHtml(t.presetId)}
          </select>
        </div>
        <div class="st-track-mid">
          <button type="button" class="st-btn st-mini-btn is-rec${t.armed ? " is-active" : ""}" data-st-action="toggle-arm" data-track-id="${escapeHtml(t.id)}" aria-pressed="${t.armed}" title="Record Arm">R</button>
          <button type="button" class="st-btn st-mini-btn is-mute${t.mute ? " is-active" : ""}" data-st-action="toggle-mute" data-track-id="${escapeHtml(t.id)}" aria-pressed="${t.mute}" title="Mute">M</button>
          <button type="button" class="st-btn st-mini-btn is-solo${t.solo ? " is-active" : ""}" data-st-action="toggle-solo" data-track-id="${escapeHtml(t.id)}" aria-pressed="${t.solo}" title="Solo">S</button>
          <div class="st-fader-wrap" title="Track Volume">
            <span class="st-fader-lbl">Vol</span>
            <input type="range" class="st-range" min="0" max="1" step="0.01" value="${t.volume.toFixed(2)}" data-st-range="volume" data-track-id="${escapeHtml(t.id)}" aria-label="${escapeHtml(t.name)} volume" />
          </div>
          <div class="st-fader-wrap" title="Track Pan (${panStr})" style="max-width:74px">
            <span class="st-fader-lbl">${panStr}</span>
            <input type="range" class="st-range" min="-1" max="1" step="0.02" value="${t.pan.toFixed(2)}" data-st-range="pan" data-track-id="${escapeHtml(t.id)}" aria-label="${escapeHtml(t.name)} pan" />
          </div>
        </div>
        <div class="st-track-meta">
          <span>${noteCount} ${noteCount === 1 ? "note" : "notes"} · ${volPct}% · ${audioTag}</span>
          <div class="st-group" style="gap:4px">
            <select class="st-select st-ch-select" data-st-select="channel" data-track-id="${escapeHtml(t.id)}" aria-label="${escapeHtml(t.name)} MIDI input channel">
              ${midiChannelOptionsHtml(t.midiChannel)}
            </select>
            <button type="button" class="st-btn" style="min-height:26px;padding:0 7px;font-size:0.64rem" data-st-action="clear-track" data-track-id="${escapeHtml(t.id)}"${t.events.length === 0 ? " disabled" : ""}>Clear</button>
          </div>
        </div>
      </div>
      <div class="st-lane" data-st-lane="1" data-track-id="${escapeHtml(t.id)}" title="Click to focus track and seek playhead">
        <div class="st-lane-grid">${renderLaneGrid(tr.bars)}</div>
        <div class="st-lane-notes">${renderTrackNotes(t, tr.totalTicks)}</div>
        <div class="st-playhead" data-st-playhead="1" style="left:${playheadPct.toFixed(3)}%"></div>
      </div>
    </div>`;
  }).join("");

  const tabs: [InspectorTab, string][] = [
    ["osc", "Osc"],
    ["filter", "Filter"],
    ["amp", "Amp & LFO"],
    ["fx", "Effects"],
    ["voice", "Voice"]
  ];

  return `
    <div class="st-panel" dir="ltr">
      <div class="st-header">
        <div class="st-group">
          <button type="button" class="st-btn" id="st-back-btn" data-st-action="close-studio" title="Return to standalone SY-1 Synth">← Synth</button>
          <div class="st-brand">SY-1 <span>Studio</span></div>
        </div>

        <div class="st-group" role="group" aria-label="Master Transport">
          <button type="button" class="st-btn is-play${tr.playing ? " is-active" : ""}" id="st-play-btn" data-st-action="play" aria-pressed="${tr.playing}">${tr.playing ? "Playing" : "▶ Play"}</button>
          <button type="button" class="st-btn" id="st-stop-btn" data-st-action="stop">■ Stop</button>
          <button type="button" class="st-btn is-rec${tr.recording ? " is-active" : ""}" id="st-rec-btn" data-st-action="record" aria-pressed="${tr.recording}">● Rec</button>
          <button type="button" class="st-btn${tr.loopEnabled ? " is-active" : ""}" id="st-loop-btn" data-st-action="toggle-loop" aria-pressed="${tr.loopEnabled}">Loop</button>
          <div class="st-clock" id="st-clock" aria-label="Transport position">${String(tr.currentBar).padStart(2, "0")} : ${tr.currentBeat}</div>
        </div>

        <div class="st-group" role="group" aria-label="Tempo">
          <button type="button" class="st-btn" data-st-action="bpm-down" aria-label="Decrease BPM">−</button>
          <button type="button" class="st-btn st-bpm-val" id="st-bpm-val" data-st-action="bpm-tap" title="Tap tempo">${fmtBpm(tr.bpm)} BPM</button>
          <button type="button" class="st-btn" data-st-action="bpm-up" aria-label="Increase BPM">+</button>
        </div>

        <div class="st-group" role="group" aria-label="Timeline length in bars">
          <div class="st-bars-group">
            ${barButtons}
            <input type="number" class="st-bar-input" id="st-bars-custom" min="1" max="512" value="${tr.bars}" aria-label="Custom bar count" title="Custom bar length (1–512)" />
          </div>
          <button type="button" class="st-btn" id="st-export-midi" data-st-action="export-midi">MIDI</button>
          <button type="button" class="st-btn" id="st-export-wav" data-st-action="export-wav"${exporting || exportingStems ? " disabled" : ""}>${exporting ? "Rendering…" : "WAV Mix"}</button>
          <button type="button" class="st-btn" id="st-export-stems" data-st-action="export-stems"${exporting || exportingStems ? " disabled" : ""}>${exportingStems ? "Stems…" : "Export Stems"}</button>
          ${tr.hasLiveTake ? `<button type="button" class="st-btn" id="st-export-live" data-st-action="export-live" title="Download last live recorded mix (${tr.liveTakeDurationSec.toFixed(1)}s)">Live WAV</button>` : ""}
        </div>
      </div>

      <div class="st-project-bar" role="group" aria-label="Project management">
        <div class="st-group">
          <input type="text" class="st-name-input" id="st-project-name" value="${escapeHtml(tr.projectName)}" maxlength="80" aria-label="Project name" placeholder="Project name" />
          <button type="button" class="st-btn st-proj-btn" id="st-save-btn" data-st-action="save-project">Save</button>
          <button type="button" class="st-btn st-proj-btn${openDrawerVisible ? " is-active" : ""}" id="st-open-btn" data-st-action="toggle-open-drawer">Open</button>
          <button type="button" class="st-btn st-proj-btn" id="st-export-project" data-st-action="export-project">Export Project</button>
          <button type="button" class="st-btn st-proj-btn" id="st-import-project-btn" data-st-action="trigger-import-project">Import .sy1studio</button>
          <input type="file" id="st-import-file" accept=".sy1studio,.json,application/json" hidden />
        </div>
        <div class="st-group">
          ${tr.liveRecWarning ? `<span class="st-export-status is-error" id="st-rec-warn">${escapeHtml(tr.liveRecWarning)}</span>` : ""}
          ${statusMessage ? `<span class="st-export-status${statusTone === "error" ? " is-error" : statusTone === "ok" ? " is-ok" : ""}" id="st-status">${escapeHtml(statusMessage)}</span>` : ""}
        </div>
      </div>

      ${openDrawerVisible ? `
      <div class="st-drawer" id="st-open-drawer" role="region" aria-label="Saved Projects">
        <div class="st-drawer-head">
          <span>Saved Projects &amp; Recovery</span>
          <button type="button" class="st-btn st-proj-btn" data-st-action="toggle-open-drawer">Close</button>
        </div>
        <div class="st-drawer-list">
          ${autosaveMetaCache ? `
            <div class="st-drawer-item">
              <div>
                <div class="st-drawer-item-title">Autosave Recovery · ${escapeHtml(autosaveMetaCache.name)}</div>
                <div class="st-drawer-item-meta">${autosaveMetaCache.trackCount} tracks · ${autosaveMetaCache.bpm} BPM · ${autosaveMetaCache.bars} bars · ${escapeHtml(fmtSavedTime(autosaveMetaCache.updatedAt))}</div>
              </div>
              <button type="button" class="st-btn st-proj-btn" data-st-action="restore-autosave">Restore</button>
            </div>` : ""}
          ${savedProjectsCache.length > 0
            ? savedProjectsCache.map((p) => `
              <div class="st-drawer-item" data-project-id="${escapeHtml(p.id)}">
                <div>
                  <div class="st-drawer-item-title">${escapeHtml(p.name)}</div>
                  <div class="st-drawer-item-meta">${p.trackCount} tracks · ${p.noteCount} notes · ${p.bpm} BPM · ${p.bars} bars · ${escapeHtml(fmtSavedTime(p.savedAt))}</div>
                </div>
                <div class="st-group" style="gap:4px">
                  <button type="button" class="st-btn st-proj-btn" data-st-action="open-saved-project" data-project-id="${escapeHtml(p.id)}">Open</button>
                  <button type="button" class="st-btn st-proj-btn" data-st-action="delete-saved-project" data-project-id="${escapeHtml(p.id)}">Delete</button>
                </div>
              </div>`).join("")
            : `<div class="st-drawer-empty">No saved projects in browser storage yet. Click Save or Import .sy1studio.</div>`}
        </div>
      </div>` : ""}

      <div class="st-body">
        <div class="st-ruler-row">
          <div class="st-ruler-label">
            <span>Tracks (${tracks.length}/${STUDIO_MAX_TRACKS})</span>
            ${tracks.length < STUDIO_MAX_TRACKS ? `<button type="button" class="st-btn" style="min-height:24px;padding:0 8px;font-size:0.64rem" data-st-action="add-track">+ Track</button>` : ""}
          </div>
          <div class="st-ruler" id="st-ruler" data-st-ruler="1" title="Click or drag to seek playhead">
            ${tr.loopEnabled ? `<div class="st-ruler-loop" style="left:${loopLeftPct.toFixed(3)}%;width:${loopWidthPct.toFixed(3)}%"></div>` : ""}
            <div class="st-ruler-marks">${renderRulerMarks(tr.bars)}</div>
            <div class="st-playhead" data-st-playhead="1" style="left:${playheadPct.toFixed(3)}%"></div>
          </div>
        </div>

        <div class="st-tracks">${trackRows}</div>

        <div class="st-inspector">
          <div class="st-insp-head">
            <div>
              <span class="st-insp-title">${escapeHtml(focused.name)}</span>
              <span class="st-insp-sub">${escapeHtml(focused.presetName)}</span>
            </div>
            <div class="st-tabs" role="tablist" aria-label="Focused track SY-1 sections">
              ${tabs.map(([id, lbl]) =>
                `<button type="button" class="st-btn st-tab${activeTab === id ? " is-active" : ""}" role="tab" aria-selected="${activeTab === id}" data-st-action="insp-tab" data-st-tab="${id}">${lbl}</button>`
              ).join("")}
            </div>
          </div>
          <div class="st-insp-body" id="st-insp-body">
            ${renderInspectorBody(focused)}
          </div>
        </div>
      </div>
    </div>`;
}

function updatePlayheadOnly(): void {
  const container = document.getElementById("sy1-studio");
  if (!container || container.hidden) return;
  const tr = studioEngine.getTransportSnapshot();
  const pct = tr.totalTicks > 0 ? Math.max(0, Math.min(100, (tr.currentTick / tr.totalTicks) * 100)) : 0;
  container.querySelectorAll<HTMLElement>("[data-st-playhead]").forEach((el) => {
    el.style.left = pct.toFixed(3) + "%";
  });
  const clock = document.getElementById("st-clock");
  if (clock) {
    clock.textContent = `${String(tr.currentBar).padStart(2, "0")} : ${tr.currentBeat}`;
  }
}

function startPlayheadLoop(): void {
  if (rafId) return;
  const step = () => {
    const container = document.getElementById("sy1-studio");
    if (!container || container.hidden) {
      rafId = 0;
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
}

export function renderStudioPanel(): void {
  const container = document.getElementById("sy1-studio");
  if (!container || container.hidden) return;
  container.innerHTML = renderStudioHtml();
}

function updateFocusedKnobDOM(key: string): void {
  const container = document.getElementById("sy1-studio");
  if (!container || container.hidden) return;
  const track = studioEngine.getFocusedTrack();
  const def = SYNTH_PARAMS[key];
  if (!def) return;
  const val = track.patch[key];
  const knob = container.querySelector<HTMLElement>(`.st-knob[data-st-param="${key}"]`);
  if (knob) {
    const n = Math.max(0, Math.min(1, synthNorm(key, Number(val))));
    const dial = knob.querySelector<HTMLElement>(".st-knob-dial");
    if (dial) dial.style.setProperty("--n", n.toFixed(4));
    const valEl = knob.querySelector<HTMLElement>(".st-knob-val");
    const fmt = def.fmt ? def.fmt(Number(val)) : String(val);
    if (valEl) valEl.textContent = fmt;
    knob.setAttribute("aria-valuetext", fmt);
  }
}

function seekFromPointer(el: HTMLElement, clientX: number): void {
  const rect = el.getBoundingClientRect();
  if (rect.width <= 0) return;
  const ratio = Math.max(0, Math.min(0.9999, (clientX - rect.left) / rect.width));
  const bars = studioEngine.getTransportSnapshot().bars;
  const barIndex = Math.floor(ratio * bars);
  studioEngine.seekToTick(barIndex * STUDIO_TICKS_PER_BAR);
  updatePlayheadOnly();
}

export function initStudioPanel(opts: { onClose: () => void }): void {
  onCloseStudio = opts.onClose;
  if (initialized) return;
  initialized = true;

  const container = document.getElementById("sy1-studio");
  if (!container) return;

  // Coalesce rapid state updates into a single microtask render (avoids thrashing during drag)
  let renderQueued = false;
  let draggingKnobParam: string | null = null;

  studioEngine.onChange(() => {
    if (studioEngine.isActive()) {
      scheduleAutosave();
    }
    if (container.hidden) return;
    if (draggingKnobParam) {
      updateFocusedKnobDOM(draggingKnobParam);
      return;
    }
    // Preserve focus inside text input while typing project name
    if (document.activeElement && document.activeElement.id === "st-project-name") {
      return;
    }
    if (renderQueued) return;
    renderQueued = true;
    queueMicrotask(() => {
      renderQueued = false;
      renderStudioPanel();
    });
  });

  // Flush pending autosave cleanly on page hide / tab switch
  window.addEventListener("pagehide", () => {
    if (studioEngine.isActive()) void flushAutosave();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden && studioEngine.isActive()) void flushAutosave();
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
        case "clear-track":
          if (trackId) studioEngine.clearTrackClip(trackId);
          break;
        case "insp-tab": {
          const tab = btn.getAttribute("data-st-tab") as InspectorTab | null;
          if (tab) {
            activeTab = tab;
            renderStudioPanel();
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
          const proj = studioEngine.exportProject();
          downloadBlob(studioEngine.exportProjectBlob(), projectFilename(proj));
          setStatus(`Exported ${projectFilename(proj)}`, "ok");
          renderStudioPanel();
          break;
        }
        case "trigger-import-project": {
          const inp = document.getElementById("st-import-file") as HTMLInputElement | null;
          if (inp) {
            inp.value = "";
            inp.click();
          }
          break;
        }
        case "export-midi": {
          const blob = studioEngine.exportMidiBlob();
          const bpm = Math.round(studioEngine.getBpm());
          downloadBlob(blob, `sy1-studio-${bpm}bpm.mid`);
          setStatus("Exported SMF-1 MIDI", "ok");
          renderStudioPanel();
          break;
        }
        case "export-wav": {
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
              setStatus(
                `Exported ${stems.length} stems · 24-bit · ${first.sampleRate}Hz`,
                "ok"
              );
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
    if (ruler) {
      seekFromPointer(ruler, e.clientX);
    }
  });

  // ---- Selects & inputs ----
  container.addEventListener("change", (e) => {
    const el = e.target as HTMLInputElement | HTMLSelectElement | null;
    if (!el) return;

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
    const selType = el.getAttribute("data-st-select");
    const trackId = el.getAttribute("data-track-id") || "";
    if (selType === "preset" && trackId) {
      studioEngine.prepareAudioSync();
      if (el.value !== "custom") studioEngine.setTrackPreset(trackId, el.value);
      return;
    }
    if (selType === "channel" && trackId) {
      studioEngine.setTrackMidiChannel(trackId, Number(el.value));
    }
  });

  // ---- Track volume, pan & project name live input ----
  container.addEventListener("input", (e) => {
    const el = e.target as HTMLInputElement | null;
    if (!el) return;
    if (el.id === "st-project-name") {
      studioEngine.setProjectName(el.value);
      return;
    }
    const rangeType = el.getAttribute("data-st-range");
    const trackId = el.getAttribute("data-track-id") || "";
    if (!rangeType || !trackId) return;
    if (rangeType === "volume") studioEngine.setTrackVolume(trackId, Number(el.value));
    else if (rangeType === "pan") studioEngine.setTrackPan(trackId, Number(el.value));
  });

  // ---- Studio Rotary Knob pointer / wheel / dblclick / keyboard ----
  let knobDrag: {
    key: string;
    startY: number;
    startX: number;
    startN: number;
    pointerId: number;
    el: HTMLElement;
  } | null = null;

  container.addEventListener("pointerdown", (e) => {
    if (e.button === 2) return;
    const knob = (e.target as HTMLElement | null)?.closest<HTMLElement>(".st-knob");
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
    if (!knobDrag || e.pointerId !== knobDrag.pointerId) return;
    e.preventDefault();
    const dy = knobDrag.startY - e.clientY;
    const dx = e.clientX - knobDrag.startX;
    const sens = e.shiftKey ? 700 : 200;
    const nextVal = synthDenorm(knobDrag.key, knobDrag.startN + (dy + dx * 0.5) / sens);
    studioEngine.getFocusedTrack().setParam(knobDrag.key, nextVal);
  });

  const endKnobDrag = (e?: PointerEvent) => {
    if (!knobDrag || (e && e.pointerId !== knobDrag.pointerId)) return;
    knobDrag.el.classList.remove("is-dragging");
    knobDrag = null;
    draggingKnobParam = null;
    renderStudioPanel();
  };

  container.addEventListener("pointerup", endKnobDrag);
  container.addEventListener("pointercancel", endKnobDrag);
  window.addEventListener("blur", () => endKnobDrag());

  container.addEventListener("dblclick", (e) => {
    const knob = (e.target as HTMLElement | null)?.closest<HTMLElement>(".st-knob");
    if (!knob) return;
    const key = knob.getAttribute("data-st-param");
    if (key && SYNTH_PARAMS[key]) {
      studioEngine.getFocusedTrack().setParam(key, SYNTH_PARAMS[key].def);
    }
  });

  container.addEventListener(
    "wheel",
    (e) => {
      const knob = (e.target as HTMLElement | null)?.closest<HTMLElement>(".st-knob");
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

  container.addEventListener("keydown", (e) => {
    const knob = (e.target as HTMLElement | null)?.closest<HTMLElement>(".st-knob");
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
  const synthEl = document.getElementById("sy1-panel");
  const studioEl = document.getElementById("sy1-studio");
  if (synthEl) synthEl.hidden = true;
  if (studioEl) studioEl.hidden = false;
  renderStudioPanel();
  startPlayheadLoop();
}

export function hideStudioPanel(): void {
  stopPlayheadLoop();
  const synthEl = document.getElementById("sy1-panel");
  const studioEl = document.getElementById("sy1-studio");
  if (studioEl) studioEl.hidden = true;
  if (synthEl) synthEl.hidden = false;
}
