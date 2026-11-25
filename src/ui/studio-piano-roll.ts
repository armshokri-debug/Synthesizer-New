/**
 * SY-1 Studio — Integrated MIDI Piano Roll & Drum Grid Editor
 *
 * Clean, edge-to-edge DAW piano roll rendered directly inside the resizable
 * bottom dock (no decorative card wrapper):
 * - Synth tracks: sticky audition piano keyboard (C6 down to C2, auto-expands
 *   to fit notes, crisp C + F pitch orientation labels)
 * - Drum Machine tracks: authentic 8-lane Drum Grid mapped to GM DRUM_NOTES
 *   (KICK..BELL or machine/kit custom labels like DOHOL..SENJ)
 * - Note creation (click on grid), selection (click / Shift+click), drag-move
 *   (pitch/lane + snapped tick), drag-resize (right handle), delete
 *   (Delete/Backspace, right-click, double-click, or toolbar button)
 * - Logic Pro iPad-style Velocity Editing Mode (vertical drag directly on notes
 *   or touch-friendly Velocity Lane, full 1–127 MIDI range, precise numeric input,
 *   relative multi-note velocity preservation)
 * - Snap selector (Off, 1/4, 1/8, 1/16, 1/32), Quantize button, Horizontal zoom
 */

import { DRUM_NOTES, DrumVoice, drumVoiceForNote } from "../engine/drums";
import { escapeHtml } from "../engine/params";
import { studioEngine } from "../studio/studio-engine";
import { getDrumLabelsForTrack, getStudioMachineDef } from "../studio/track-engine";
import {
  STUDIO_PPQ,
  STUDIO_QUANTIZE_OPTIONS,
  STUDIO_SNAP_OPTIONS,
  STUDIO_TICKS_PER_BAR,
  StudioNoteSpan
} from "../studio/types";

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const BLACK_KEY_PC = new Set([1, 3, 6, 8, 10]);

/** Top-to-bottom drum voice ordering in the Drum Grid (high percussion top, kick bottom). */
const DRUM_GRID_ORDER: readonly DrumVoice[] = ["bell", "oh", "tom", "ch", "clap", "snare", "rim", "kick"];

const editorNotes = (trackId: string) => studioEngine.regions.editorNotes(trackId);

export const PR_ROW_HEIGHT = 20;
const PR_DRUM_ROW_HEIGHT = 26;
const BASE_BAR_PX = 160;
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 3;

export const MIN_MIDI_VELOCITY = 1;
export const MAX_MIDI_VELOCITY = 127;
const DEFAULT_MIDI_VELOCITY = 108; // ~0.85

export function clampMidiVelocity(midiVel: number): number {
  const n = Number.isFinite(midiVel) ? Math.round(midiVel) : DEFAULT_MIDI_VELOCITY;
  return Math.max(MIN_MIDI_VELOCITY, Math.min(MAX_MIDI_VELOCITY, n));
}

export function velocityToMidi(velocity: number): number {
  const v = Number.isFinite(velocity) ? velocity : DEFAULT_MIDI_VELOCITY / MAX_MIDI_VELOCITY;
  return clampMidiVelocity(v * MAX_MIDI_VELOCITY);
}

export function midiToVelocity(midiVel: number): number {
  return clampMidiVelocity(midiVel) / MAX_MIDI_VELOCITY;
}

/**
 * Apply a signed MIDI velocity delta to selected notes using each note's captured
 * original MIDI velocity, preserving exact relative differences even if a continuous
 * drag temporarily hits 1 or 127 and moves back. Never modifies pitch or timing.
 */
export function applyRelativeVelocityDelta(
  spans: readonly StudioNoteSpan[],
  selectedIndices: ReadonlySet<number>,
  origMidis: ReadonlyMap<number, number>,
  deltaMidi: number
): StudioNoteSpan[] {
  const delta = Number.isFinite(deltaMidi) ? Math.round(deltaMidi) : 0;
  return spans.map((span, idx) => {
    if (!selectedIndices.has(idx)) return { ...span };
    const baseMidi = origMidis.get(idx) ?? velocityToMidi(span.velocity);
    return {
      ...span,
      velocity: midiToVelocity(baseMidi + delta)
    };
  });
}

/**
 * Apply a numeric target velocity (1–127) to selected notes:
 * - Single note (or equal-velocity selection): sets exact target velocity.
 * - Multi-note selection with mixed velocities: shifts every selected note by
 *   `(targetMidi - meanSelectedMidi)`, preserving relative velocity differences.
 */
export function applyNumericVelocity(
  spans: readonly StudioNoteSpan[],
  selectedIndices: ReadonlySet<number>,
  targetMidi: number
): StudioNoteSpan[] {
  const clampedTarget = clampMidiVelocity(targetMidi);
  const origMidis = new Map<number, number>();
  let sum = 0;
  let minV = MAX_MIDI_VELOCITY;
  let maxV = MIN_MIDI_VELOCITY;
  selectedIndices.forEach((idx) => {
    const s = spans[idx];
    if (!s) return;
    const m = velocityToMidi(s.velocity);
    origMidis.set(idx, m);
    sum += m;
    if (m < minV) minV = m;
    if (m > maxV) maxV = m;
  });
  if (origMidis.size === 0) return spans.map((s) => ({ ...s }));
  if (origMidis.size === 1 || minV === maxV) {
    return spans.map((span, idx) =>
      origMidis.has(idx) ? { ...span, velocity: midiToVelocity(clampedTarget) } : { ...span }
    );
  }
  const anchor = Math.round(sum / origMidis.size);
  const delta = clampedTarget - anchor;
  return applyRelativeVelocityDelta(spans, selectedIndices, origMidis, delta);
}

function velocitySummary(
  spans: readonly StudioNoteSpan[],
  selectedIndices: ReadonlySet<number>
): { count: number; avg: number; min: number; max: number; text: string } {
  let sum = 0;
  let count = 0;
  let minV = MAX_MIDI_VELOCITY;
  let maxV = MIN_MIDI_VELOCITY;
  selectedIndices.forEach((idx) => {
    const s = spans[idx];
    if (!s) return;
    const m = velocityToMidi(s.velocity);
    sum += m;
    count++;
    if (m < minV) minV = m;
    if (m > maxV) maxV = m;
  });
  if (count === 0) {
    return { count: 0, avg: state.defaultVelocityMidi, min: state.defaultVelocityMidi, max: state.defaultVelocityMidi, text: "—" };
  }
  const avg = clampMidiVelocity(sum / count);
  const text = minV === maxV ? String(avg) : `${minV}–${maxV}`;
  return { count, avg, min: minV, max: maxV, text };
}

function velMidiToLanePct(midiVel: number): number {
  return (clampMidiVelocity(midiVel) / MAX_MIDI_VELOCITY) * 100;
}

function velMidiToOpacity(midiVel: number): string {
  const norm = clampMidiVelocity(midiVel) / MAX_MIDI_VELOCITY;
  return (0.28 + 0.72 * norm).toFixed(3);
}

function clientYToMidiVelocity(clientY: number, rect: DOMRect): number {
  const pad = 2;
  const usable = Math.max(1, rect.height - pad * 2);
  const norm = Math.max(0, Math.min(1, 1 - (clientY - (rect.top + pad)) / usable));
  return clampMidiVelocity(MIN_MIDI_VELOCITY + norm * (MAX_MIDI_VELOCITY - MIN_MIDI_VELOCITY));
}

export interface PianoRollState {
  snapTicks: number;
  quantizeTicks: number;
  zoom: number;
  selectedIndices: Set<number>;
  multiSelectMode: boolean;
  audition: boolean;
  velMode: boolean;
  defaultVelocityMidi: number;
  scrollLeft: number;
  scrollTop: number;
  hasInitialScroll: boolean;
}

const state: PianoRollState = {
  snapTicks: 120, // default 1/16
  quantizeTicks: 120, // default 1/16 (independent from snapTicks)
  zoom: 1,
  selectedIndices: new Set<number>(),
  multiSelectMode: false,
  audition: true,
  velMode: false,
  defaultVelocityMidi: DEFAULT_MIDI_VELOCITY,
  scrollLeft: 0,
  scrollTop: 0,
  hasInitialScroll: false
};

let lastTrackId = "";
let lastWasDrum = false;

export function getPianoRollState(): Readonly<PianoRollState> {
  return state;
}

export function setPianoRollSnap(snapTicks: number): void {
  state.snapTicks = Math.max(0, Math.round(snapTicks));
}

export function setPianoRollQuantize(quantizeTicks: number): void {
  state.quantizeTicks = Math.max(1, Math.round(quantizeTicks));
}

export function setPianoRollZoom(zoom: number): void {
  state.zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.round(zoom * 100) / 100));
}

export function setPianoRollVelocityMode(enabled: boolean): void {
  state.velMode = !!enabled;
}

export function setPianoRollMultiSelectMode(enabled: boolean): void {
  state.multiSelectMode = !!enabled;
}

export function clearPianoRollSelection(): void {
  state.selectedIndices.clear();
}

export function selectAllPianoRollNotes(trackId = studioEngine.getFocusedTrack().id): number {
  const spans = editorNotes(trackId);
  state.selectedIndices.clear();
  for (let i = 0; i < spans.length; i++) state.selectedIndices.add(i);
  return spans.length;
}

export interface MarqueeBox {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export function findNotesInMarquee(
  spans: readonly StudioNoteSpan[],
  midiToRowIndex: ReadonlyMap<number, number>,
  totalTicks: number,
  gridWidth: number,
  rowHeight: number,
  box: MarqueeBox
): Set<number> {
  const hits = new Set<number>();
  if (totalTicks <= 0 || gridWidth <= 0 || rowHeight <= 0) return hits;
  const x0 = Math.min(box.left, box.right);
  const x1 = Math.max(box.left, box.right);
  const y0 = Math.min(box.top, box.bottom);
  const y1 = Math.max(box.top, box.bottom);
  for (let i = 0; i < spans.length; i++) {
    const s = spans[i];
    const rowIdx = midiToRowIndex.get(s.midi);
    if (rowIdx === undefined) continue;
    const nLeft = (s.startTick / totalTicks) * gridWidth;
    const nWidth = Math.max(10, ((s.endTick - s.startTick) / totalTicks) * gridWidth);
    const nRight = nLeft + nWidth;
    const nTop = rowIdx * rowHeight + 2;
    const nBottom = nTop + Math.max(4, rowHeight - 4);
    if (nRight >= x0 && nLeft <= x1 && nBottom >= y0 && nTop <= y1) {
      hits.add(i);
    }
  }
  return hits;
}

export function computeQuantizedSelectionRemap(
  prevSpans: readonly StudioNoteSpan[],
  selectedIndices: ReadonlySet<number>,
  nextSpans: readonly StudioNoteSpan[],
  gridTicks: number,
  limitTicks: number
): Set<number> {
  const remapped = new Set<number>();
  if (selectedIndices.size === 0 || nextSpans.length === 0) return remapped;
  const grid = Math.max(1, Math.round(gridTicks));
  const limit = Math.max(1, Math.round(limitTicks));
  const maxStart = Math.max(0, Math.floor((limit - 1) / grid) * grid);
  const used = new Set<number>();
  selectedIndices.forEach((idx) => {
    const prev = prevSpans[idx];
    if (!prev) return;
    const targetStart = Math.max(0, Math.min(maxStart, Math.round(prev.startTick / grid) * grid));
    const targetEnd = Math.min(limit, targetStart + Math.max(1, prev.endTick - prev.startTick));
    const matchIdx = nextSpans.findIndex(
      (candidate, cIdx) =>
        !used.has(cIdx) &&
        candidate.midi === prev.midi &&
        candidate.startTick === targetStart &&
        candidate.endTick === targetEnd
    );
    if (matchIdx >= 0) {
      used.add(matchIdx);
      remapped.add(matchIdx);
    }
  });
  return remapped;
}

export function midiNoteLabel(midi: number): string {
  const pc = ((midi % 12) + 12) % 12;
  const oct = Math.floor(midi / 12) - 1;
  return `${NOTE_NAMES[pc]}${oct}`;
}

export function snapTickValue(tick: number, snapTicks: number, mode: "round" | "floor" = "round"): number {
  if (snapTicks <= 0) return Math.max(0, Math.round(tick));
  const fn = mode === "floor" ? Math.floor : Math.round;
  return Math.max(0, fn(tick / snapTicks) * snapTicks);
}

/** Clamp a group as one unit so neither its note lengths nor its spacing changes. */
export function boundedNoteMove(
  spans: readonly StudioNoteSpan[], selected: readonly number[], anchorIndex: number,
  rowIndices: ReadonlyMap<number, number>, rowCount: number,
  rawDelta: number, rawRows: number, snap: number, totalTicks: number
): { tickShift: number; rowShift: number } {
  const anchor = spans[anchorIndex];
  const group = selected.map(i => spans[i]).filter(Boolean);
  if (!anchor || !group.length) return { tickShift: 0, rowShift: 0 };
  const minStart = Math.min(...group.map(n => n.startTick));
  const maxEnd = Math.max(...group.map(n => n.endTick));
  const wanted = snapTickValue(anchor.startTick + rawDelta, snap) - anchor.startTick;
  const tickShift = Math.max(-minStart, Math.min(totalTicks - maxEnd, wanted));
  const rows = selected.map(i => rowIndices.get(i)).filter((r): r is number => r !== undefined);
  const rowShift = rows.length ? Math.max(-Math.min(...rows), Math.min(rowCount - 1 - Math.max(...rows), rawRows)) : 0;
  return { tickShift, rowShift };
}

/** Re-select moved notes after the event layer sorts notes into time order. */
export function remapEditedSelection(
  edited: readonly StudioNoteSpan[], selected: ReadonlySet<number>, actual: readonly StudioNoteSpan[]
): Set<number> {
  const result = new Set<number>();
  for (const i of selected) {
    const n = edited[i];
    if (!n) continue;
    const index = actual.findIndex((a, j) => !result.has(j) && a.midi === n.midi &&
      a.startTick === n.startTick && a.endTick === n.endTick && Math.abs(a.velocity - n.velocity) < 1e-8);
    if (index >= 0) result.add(index);
  }
  return result;
}

function computePitchRange(spans: StudioNoteSpan[]): { minMidi: number; maxMidi: number } {
  let minMidi = 36; // C2
  let maxMidi = 84; // C6
  for (const s of spans) {
    if (s.midi - 2 < minMidi) minMidi = Math.max(12, s.midi - 2);
    if (s.midi + 2 > maxMidi) maxMidi = Math.min(108, s.midi + 2);
  }
  return { minMidi, maxMidi };
}

function barWidthPx(): number {
  return Math.round(BASE_BAR_PX * state.zoom);
}

interface RowSpec {
  midi: number;
  label: string;
  subHint: boolean;
  isBlack: boolean;
  isAccentLine: boolean;
}

function buildRowsForTrack(spans: StudioNoteSpan[]): {
  isDrum: boolean;
  rowHeight: number;
  keyColWidth: number;
  rows: RowSpec[];
  midiToRowIndex: Map<number, number>;
} {
  const track = studioEngine.getFocusedTrack();
  const isDrum = track.isDrumTrack();

  if (isDrum) {
    const labels = getDrumLabelsForTrack(track.machineId, track.patch, track.presetId);
    const rows: RowSpec[] = [];
    const seen = new Set<number>();
    for (const v of DRUM_GRID_ORDER) {
      const midi = DRUM_NOTES[v];
      seen.add(midi);
      rows.push({
        midi,
        label: labels[v],
        subHint: false,
        isBlack: v === "ch" || v === "rim" || v === "clap",
        isAccentLine: v === "kick" || v === "snare"
      });
    }
    // Include any additional MIDI pitches present in recorded spans so nothing is ever invisible
    const extras: number[] = [];
    for (const s of spans) {
      if (!seen.has(s.midi)) {
        seen.add(s.midi);
        extras.push(s.midi);
      }
    }
    extras.sort((a, b) => b - a);
    for (const midi of extras) {
      const dv = drumVoiceForNote(midi);
      rows.push({
        midi,
        label: dv ? `${labels[dv]} (${midi})` : midiNoteLabel(midi),
        subHint: true,
        isBlack: false,
        isAccentLine: false
      });
    }
    const midiToRowIndex = new Map<number, number>();
    rows.forEach((r, idx) => midiToRowIndex.set(r.midi, idx));
    return { isDrum: true, rowHeight: PR_DRUM_ROW_HEIGHT, keyColWidth: 76, rows, midiToRowIndex };
  }

  const { minMidi, maxMidi } = computePitchRange(spans);
  const rows: RowSpec[] = [];
  const midiToRowIndex = new Map<number, number>();
  for (let midi = maxMidi; midi >= minMidi; midi--) {
    const pc = ((midi % 12) + 12) % 12;
    const isBlack = BLACK_KEY_PC.has(pc);
    const isC = pc === 0;
    const isF = pc === 5;
    midiToRowIndex.set(midi, rows.length);
    rows.push({
      midi,
      label: isC || isF ? midiNoteLabel(midi) : "",
      subHint: isF,
      isBlack,
      isAccentLine: isC
    });
  }
  return { isDrum: false, rowHeight: PR_ROW_HEIGHT, keyColWidth: 56, rows, midiToRowIndex };
}

function formatNoteDisplayLabel(noteName: string, velMidi: number, widthPx: number, velMode: boolean): string {
  if (velMode) {
    if (widthPx >= 48) return `${noteName} · ${velMidi}`;
    return String(velMidi);
  }
  return widthPx >= 28 ? noteName : "";
}

export function renderPianoRollHtml(): string {
  const tr = studioEngine.getTransportSnapshot();
  const track = studioEngine.getFocusedTrack();
  const mDef = getStudioMachineDef(track.machineId);
  const isDrum = track.isDrumTrack();
  const region = studioEngine.regions.current(track.id);
  const editorId = region?.id ?? track.id;
  if (editorId !== lastTrackId || isDrum !== lastWasDrum) {
    lastTrackId = editorId;
    lastWasDrum = isDrum;
    state.selectedIndices.clear();
    state.hasInitialScroll = false;
  }

  const totalTicks = studioEngine.regions.editorLength(track.id);
  const spans = editorNotes(track.id);
  state.selectedIndices.forEach((idx) => {
    if (idx < 0 || idx >= spans.length) state.selectedIndices.delete(idx);
  });

  const { rowHeight, keyColWidth, rows, midiToRowIndex } = buildRowsForTrack(spans);
  const rowCount = rows.length;
  const gridHeight = rowCount * rowHeight;
  const gridWidth = Math.max(480, (totalTicks / STUDIO_TICKS_PER_BAR) * barWidthPx());
  const bpx = (gridWidth / totalTicks) * STUDIO_TICKS_PER_BAR;
  const playheadPct = Math.max(0, Math.min(100, ((tr.currentTick - (region?.startTick ?? 0)) / totalTicks) * 100));

  const velSum = velocitySummary(spans, state.selectedIndices);
  const velInputTitle =
    velSum.count > 1 && velSum.min !== velSum.max
      ? `Selected velocity range ${velSum.min}–${velSum.max} (average ${velSum.avg}; editing shifts notes relatively)`
      : velSum.count > 0
        ? `Selected note velocity (1–127)`
        : `New note velocity (1–127)`;

  // Ruler bar labels
  let rulerMarks = "";
  let vLines = "";
  const subStepTicks = state.snapTicks > 0 ? Math.max(120, state.snapTicks) : STUDIO_PPQ;
  for (let bar = 0; bar * STUDIO_TICKS_PER_BAR < totalTicks; bar++) {
    const x = bar * bpx;
    rulerMarks += `<span class="st-pr-bar-lbl" style="left:${x}px">${bar + 1}</span>`;
    vLines += `<span class="st-pr-vline is-bar" style="left:${x}px"></span>`;
    const beatsPerBar = STUDIO_TICKS_PER_BAR / STUDIO_PPQ;
    for (let beat = 1; beat < beatsPerBar; beat++) {
      const bx = x + (beat / beatsPerBar) * bpx;
      if (bx >= gridWidth) break;
      vLines += `<span class="st-pr-vline is-beat" style="left:${bx.toFixed(1)}px"></span>`;
    }
    if (bpx >= 140 && subStepTicks < STUDIO_PPQ) {
      for (let t = subStepTicks; t < STUDIO_TICKS_PER_BAR; t += subStepTicks) {
        if (t % STUDIO_PPQ === 0) continue;
        const sx = x + (t / STUDIO_TICKS_PER_BAR) * bpx;
        if (sx >= gridWidth) break;
        vLines += `<span class="st-pr-vline is-sub" style="left:${sx.toFixed(1)}px"></span>`;
      }
    }
  }

  const loopLeftPx = (tr.loopStartBar - 1) * bpx;
  const loopWidthPx = (tr.loopEndBar - tr.loopStartBar + 1) * bpx;

  let keysHtml = "";
  let rowsHtml = "";
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const keyCls = `st-pr-key${isDrum ? " is-drum" : ""}${r.isBlack ? " is-black" : ""}${r.isAccentLine ? " is-c" : ""}${r.subHint ? " is-hint" : ""}`;
    keysHtml += `<button type="button" class="${keyCls}" data-pr-key="${r.midi}" style="height:${rowHeight}px" aria-label="${escapeHtml(r.label || midiNoteLabel(r.midi))}"><span>${escapeHtml(r.label)}</span></button>`;
    rowsHtml += `<div class="st-pr-row${r.isBlack ? " is-black" : ""}${r.isAccentLine ? " is-c" : ""}" style="height:${rowHeight}px"></div>`;
  }

  let notesHtml = "";
  let velBarsHtml = "";
  const drumLabels = isDrum ? getDrumLabelsForTrack(track.machineId, track.patch, track.presetId) : null;
  for (let i = 0; i < spans.length; i++) {
    const s = spans[i];
    const rowIdx = midiToRowIndex.get(s.midi);
    if (rowIdx === undefined) continue;
    const leftPx = (s.startTick / totalTicks) * gridWidth;
    const widthPx = Math.max(10, ((s.endTick - s.startTick) / totalTicks) * gridWidth);
    const topPx = rowIdx * rowHeight + 2;
    const sel = state.selectedIndices.has(i);
    const velMidi = velocityToMidi(s.velocity);
    const velPct = velMidiToLanePct(velMidi).toFixed(2);
    const velOpacity = velMidiToOpacity(velMidi);
    const noteName = isDrum
      ? (() => {
          const dv = drumVoiceForNote(s.midi);
          return dv && drumLabels ? drumLabels[dv] : midiNoteLabel(s.midi);
        })()
      : midiNoteLabel(s.midi);
    const lbl = formatNoteDisplayLabel(noteName, velMidi, widthPx, state.velMode);
    const noteTitle = state.velMode
      ? `${noteName} · Vel ${velMidi} (drag up/down to adjust velocity)`
      : `${noteName} · Vel ${velMidi} (drag to move, right edge to resize, dbl-click or Del to remove)`;

    notesHtml += `<div class="st-pr-note${sel ? " is-selected" : ""}${isDrum ? " is-drum" : ""}" data-pr-note-idx="${i}" data-pr-midi="${s.midi}" data-pr-name="${escapeHtml(noteName)}" data-pr-vel-midi="${velMidi}" data-pr-row="${rowIdx}" style="left:${leftPx.toFixed(1)}px;width:${widthPx.toFixed(1)}px;top:${topPx}px;height:${rowHeight - 4}px;--vel-op:${velOpacity};--vel-pct:${velPct}%" title="${escapeHtml(noteTitle)}">
      <span class="st-pr-note-lbl">${escapeHtml(lbl)}</span>
      <span class="st-pr-note-resize" data-pr-resize="${i}" title="Resize note duration"></span>
    </div>`;

    velBarsHtml += `<div class="st-pr-vel-stem${sel ? " is-selected" : ""}" data-pr-vel-idx="${i}" data-pr-vel-midi="${velMidi}" style="left:${leftPx.toFixed(1)}px;height:${velPct}%" title="Velocity ${velMidi} (drag up/down)">
      <span class="st-pr-vel-head"></span>
    </div>`;
  }

  const snapOptionsHtml = STUDIO_SNAP_OPTIONS.map(
    (opt) => `<option value="${opt.ticks}"${state.snapTicks === opt.ticks ? " selected" : ""}>${escapeHtml(opt.label)}</option>`
  ).join("");
  const quantizeOptionsHtml = STUDIO_QUANTIZE_OPTIONS.map(
    (opt) => `<option value="${opt.ticks}"${state.quantizeTicks === opt.ticks ? " selected" : ""}>${escapeHtml(opt.label)}</option>`
  ).join("");
  const rowMidiAttr = rows.map((r) => r.midi).join(",");

  return `
    <div class="st-pr${isDrum ? " is-drum-mode" : ""}${state.velMode ? " is-vel-mode" : ""}${state.multiSelectMode ? " is-select-mode" : ""}" id="st-piano-roll" data-pr-mode="${isDrum ? "drums" : "synth"}" data-pr-vel-mode="${state.velMode ? "1" : "0"}" data-pr-select-mode="${state.multiSelectMode ? "1" : "0"}" data-pr-rows="${rowMidiAttr}" data-pr-row-h="${rowHeight}" data-pr-width="${gridWidth}" data-pr-total-ticks="${totalTicks}"${region ? ` data-pr-origin="${region.startTick}"` : ""}>
      <div class="st-pr-toolbar">
        <div class="st-pr-tb-group">
          <span class="st-pr-track-badge">${escapeHtml(mDef.name)}${region ? (region.loop ? " · Loop source" : " · Region") : ""}</span>
          <span class="st-pr-meta">${spans.length} ${isDrum ? (spans.length === 1 ? "hit" : "hits") : spans.length === 1 ? "note" : "notes"}${state.selectedIndices.size > 0 ? ` · ${state.selectedIndices.size} sel` : ""}</span>
          <div class="st-pr-sel-grp" role="group" aria-label="Note selection">
            <button type="button" class="st-btn st-pr-btn${state.multiSelectMode ? " is-active" : ""}" id="st-pr-select-mode" data-pr-action="toggle-select-mode" aria-pressed="${state.multiSelectMode}" title="Multi-select touch mode: tap notes to add/remove, or long-press and drag on grid for marquee selection">Select</button>
            <button type="button" class="st-btn st-pr-btn" id="st-pr-select-all" data-pr-action="select-all"${spans.length === 0 ? " disabled" : ""} title="Select all notes in region (Cmd/Ctrl+A)">All</button>
            <button type="button" class="st-btn st-pr-btn" id="st-pr-deselect-all" data-pr-action="deselect-all"${state.selectedIndices.size === 0 ? " disabled" : ""} title="Clear note selection (Esc)">None</button>
          </div>
        </div>
        <div class="st-pr-tb-group">
          <button type="button" class="st-btn st-pr-btn st-pr-vel-mode-btn${state.velMode ? " is-active" : ""}" id="st-pr-vel-mode" data-pr-action="toggle-vel-mode" aria-pressed="${state.velMode}" title="Velocity mode — drag up/down directly on notes to adjust velocity (1–127) without changing pitch or timing">Velocity</button>
          <div class="st-pr-vel-ctrl" role="group" aria-label="Note velocity">
            <label class="st-pr-vel-tag" for="st-pr-vel-input">Vel</label>
            <button type="button" class="st-btn st-pr-btn st-pr-vel-step" id="st-pr-vel-dec" data-pr-action="vel-dec" aria-label="Decrease velocity" title="Decrease velocity (−1, Shift −5)">−</button>
            <input type="number" class="st-pr-vel-input" id="st-pr-vel-input" min="${MIN_MIDI_VELOCITY}" max="${MAX_MIDI_VELOCITY}" step="1" inputmode="numeric" value="${velSum.avg}" aria-label="Note velocity (1 to 127)" title="${escapeHtml(velInputTitle)}" />
            <button type="button" class="st-btn st-pr-btn st-pr-vel-step" id="st-pr-vel-inc" data-pr-action="vel-inc" aria-label="Increase velocity" title="Increase velocity (+1, Shift +5)">+</button>
            <div class="st-pr-vel-slider-wrap" id="st-pr-vel-slider-wrap"${velSum.count === 0 ? " hidden" : ""}>
              <input type="range" class="st-range st-pr-vel-slider" id="st-pr-vel-slider" min="${MIN_MIDI_VELOCITY}" max="${MAX_MIDI_VELOCITY}" step="1" value="${velSum.avg}"${velSum.count === 0 ? " disabled" : ""} aria-label="Selected notes velocity slider" title="Drag to shift velocity of selected notes while keeping relative dynamics" />
            </div>
            <span class="st-pr-meta st-pr-vel-readout" id="st-pr-vel-readout">${velSum.count > 0 ? escapeHtml(velSum.text) : "—"}</span>
          </div>
          <label class="st-pr-field" title="Piano Roll note creation & move snap grid (independent from Arrangement Snap and Quantize)">
            <span>Snap</span>
            <select class="st-select st-pr-select" id="st-pr-snap" aria-label="Piano roll snap grid">
              ${snapOptionsHtml}
            </select>
          </label>
          <div class="st-pr-quantize-grp" role="group" aria-label="Note quantization">
            <select class="st-select st-pr-select" id="st-pr-quantize-div" aria-label="Quantize subdivision" title="Quantize grid subdivision (independent from Snap)">
              ${quantizeOptionsHtml}
            </select>
            <button type="button" class="st-btn st-pr-btn" id="st-pr-quantize" data-pr-action="quantize"${spans.length === 0 ? " disabled" : ""} title="Quantize selected notes (or all notes when none selected) to Quantize subdivision">Quantize</button>
            <button type="button" class="st-btn st-pr-btn" id="st-pr-quantize-all" data-pr-action="quantize-all"${spans.length === 0 ? " disabled" : ""} title="Explicitly quantize all notes in the current region">Q All</button>
          </div>
          <button type="button" class="st-btn st-pr-btn" id="st-pr-delete" data-pr-action="delete-selected"${state.selectedIndices.size === 0 ? " disabled" : ""} title="Delete selected notes (Delete / Backspace)">Delete</button>
          <button type="button" class="st-btn st-pr-btn${state.audition ? " is-active" : ""}" id="st-pr-audition" data-pr-action="toggle-audition" aria-pressed="${state.audition}" title="Audition notes while editing">Audition</button>
        </div>
        <div class="st-pr-tb-group">
          <button type="button" class="st-btn st-pr-btn" data-pr-action="zoom-out" aria-label="Zoom out piano roll">−</button>
          <span class="st-pr-zoom-lbl">${Math.round(state.zoom * 100)}%</span>
          <button type="button" class="st-btn st-pr-btn" data-pr-action="zoom-in" aria-label="Zoom in piano roll">+</button>
        </div>
      </div>

      <div class="st-pr-main">
        <div class="st-pr-body-scroll" id="st-pr-scroll">
          <div class="st-pr-canvas" style="width:${gridWidth + keyColWidth}px">
            <div class="st-pr-ruler-row">
              <div class="st-pr-corner">${isDrum ? "Drums" : "Keys"}</div>
              <div class="st-pr-ruler" data-st-ruler="1" style="width:${gridWidth}px" title="Click to seek playhead">
                ${tr.loopEnabled && !region ? `<div class="st-pr-loop" style="left:${loopLeftPx}px;width:${loopWidthPx}px"></div>` : ""}
                ${rulerMarks}
                <div class="st-playhead" data-st-playhead="1" style="left:${playheadPct.toFixed(3)}%"></div>
              </div>
            </div>
            <div class="st-pr-grid-row">
              <div class="st-pr-keys" style="height:${gridHeight}px">${keysHtml}</div>
              <div class="st-pr-grid" id="st-pr-grid" tabindex="0" aria-label="MIDI note grid" style="width:${gridWidth}px;height:${gridHeight}px">
                <div class="st-pr-rows">${rowsHtml}</div>
                <div class="st-pr-vlines">${vLines}</div>
                <div class="st-pr-notes" id="st-pr-notes">${notesHtml}</div>
                <div class="st-playhead" data-st-playhead="1" style="left:${playheadPct.toFixed(3)}%"></div>
              </div>
            </div>
          </div>
        </div>

        <div class="st-pr-vel-bar${state.velMode ? " is-vel-mode" : ""}">
          <div class="st-pr-vel-lbl">VEL<span class="st-pr-vel-scale">127<br>1</span></div>
          <div class="st-pr-vel-scroll" id="st-pr-vel-scroll">
            <div class="st-pr-vel-lane" id="st-pr-vel-lane" style="width:${gridWidth}px" aria-label="Velocity lane (1 to 127)">
              <div class="st-pr-vel-midline"></div>
              ${velBarsHtml}
            </div>
          </div>
        </div>
      </div>
    </div>`;
}

function parseRowMidis(prRoot: HTMLElement): number[] {
  const raw = prRoot.dataset.prRows || "";
  if (!raw) return [];
  return raw.split(",").map((v) => Number(v)).filter((n) => Number.isFinite(n));
}

/** Restore scroll positions after DOM re-render (or center on C4 / top of drum grid on first open). */
export function syncPianoRollScroll(container: HTMLElement): void {
  const scrollEl = container.querySelector<HTMLElement>("#st-pr-scroll");
  const velScrollEl = container.querySelector<HTMLElement>("#st-pr-vel-scroll");
  const prRoot = container.querySelector<HTMLElement>("#st-piano-roll");
  if (!scrollEl || !prRoot) return;

  if (!state.hasInitialScroll) {
    if (prRoot.dataset.prMode === "drums") {
      state.scrollTop = 0;
    } else {
      const rows = parseRowMidis(prRoot);
      const rowH = Number(prRoot.dataset.prRowH || PR_ROW_HEIGHT);
      const rulerH = prRoot.querySelector<HTMLElement>(".st-pr-ruler-row")?.offsetHeight || 22;
      const visibleGridH = Math.max(rowH, scrollEl.clientHeight - rulerH);
      const track = studioEngine.getFocusedTrack();
      const spans = editorNotes(track.id);
      let midRow = Math.floor(rows.length / 2);
      if (spans.length > 0) {
        let minRow = Infinity;
        let maxRow = -Infinity;
        for (const s of spans) {
          const rIdx = rows.indexOf(s.midi);
          if (rIdx >= 0) {
            if (rIdx < minRow) minRow = rIdx;
            if (rIdx > maxRow) maxRow = rIdx;
          }
        }
        if (Number.isFinite(minRow) && Number.isFinite(maxRow)) {
          midRow = (minRow + maxRow) * 0.5;
        }
      } else {
        const c4Idx = rows.indexOf(60);
        if (c4Idx >= 0) midRow = c4Idx;
      }
      state.scrollTop = Math.max(0, (midRow + 0.5) * rowH - visibleGridH * 0.5);
    }
    state.hasInitialScroll = true;
  }

  scrollEl.scrollLeft = state.scrollLeft;
  scrollEl.scrollTop = state.scrollTop;
  if (velScrollEl) velScrollEl.scrollLeft = state.scrollLeft;
}

function previewNote(midi: number, velocity = 0.82, durationMs = 220): void {
  if (!state.audition) return;
  studioEngine.prepareAudioSync();
  const track = studioEngine.getFocusedTrack();
  track.noteOn(midi, velocity);
  if (!track.isDrumTrack()) {
    setTimeout(() => track.noteOff(midi), durationMs);
  }
}

/** Attach Piano Roll delegated events once on the Studio root container. */
export function bindPianoRollEvents(container: HTMLElement, requestRender: () => void, onError: (message: string) => void): void {
  let heldAuditionKey: { midi: number; pointerId: number; el: HTMLElement } | null = null;
  let noteDrag: {
    mode: "move" | "resize" | "velocity";
    index: number;
    pointerId: number;
    startClientX: number;
    startClientY: number;
    origSpans: StudioNoteSpan[];
    workingSpans: StudioNoteSpan[];
    selectedList: number[];
    selectedSet: Set<number>;
    origMidis: Map<number, number>;
    gridWidth: number;
    totalTicks: number;
    rowMidis: number[];
    rowHeight: number;
    origRowIndices: Map<number, number>;
    moved: boolean;
    toggleOffOnTapUp: number | null;
    collapseToIndexOnTapUp: number | null;
    lastAuditionMidi: number;
    lastDeltaMidi: number;
    el: HTMLElement;
  } | null = null;
  let velDrag: {
    index: number;
    pointerId: number;
    laneEl: HTMLElement;
    origSpans: StudioNoteSpan[];
    workingSpans: StudioNoteSpan[];
    selectedSet: Set<number>;
    origMidis: Map<number, number>;
    anchorOrigMidi: number;
    changed: boolean;
  } | null = null;
  let sliderDrag: {
    origSpans: StudioNoteSpan[];
    workingSpans: StudioNoteSpan[];
    selectedSet: Set<number>;
    origMidis: Map<number, number>;
    startAvg: number;
  } | null = null;
  let longPressPending: {
    pointerId: number;
    pointerType: string;
    startClientX: number;
    startClientY: number;
    gridEl: HTMLElement;
    prRoot: HTMLElement;
    addMode: boolean;
    timer: number;
  } | null = null;
  let marqueeDrag: {
    pointerId: number;
    gridEl: HTMLElement;
    marqueeEl: HTMLElement;
    startX: number;
    startY: number;
    curX: number;
    curY: number;
    addMode: boolean;
    baseSelection: Set<number>;
    spans: StudioNoteSpan[];
    midiToRowIndex: Map<number, number>;
    gridWidth: number;
    totalTicks: number;
    rowHeight: number;
    moved: boolean;
  } | null = null;
  const activeTouchPointers = new Map<number, { x: number; y: number }>();
  let touchPan: {
    pointerId: number;
    scrollEl: HTMLElement;
    startX: number;
    startY: number;
    startScrollLeft: number;
    startScrollTop: number;
    scrolling: boolean;
  } | null = null;
  let pinchZoom: {
    scrollEl: HTMLElement;
    startDist: number;
    startZoom: number;
    lastRenderedZoom: number;
    anchorContentX: number;
    localMidX: number;
  } | null = null;
  let suppressGridClickUntil = 0;

  const commitSpans = (spans: StudioNoteSpan[], remap = false) => {
    const track = studioEngine.getFocusedTrack();
    try {
      const selected = new Set(state.selectedIndices);
      studioEngine.replaceTrackNotes(track.id, spans);
      if (remap) {
        state.selectedIndices = remapEditedSelection(spans, selected, editorNotes(track.id));
        requestRender();
      }
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
      requestRender();
    }
  };

  const runQuantize = (allNotes: boolean) => {
    const grid = Math.max(1, state.quantizeTicks || 120);
    const track = studioEngine.getFocusedTrack();
    const prevSpans = editorNotes(track.id);
    if (prevSpans.length === 0) return;
    const limit = studioEngine.regions.editorLength(track.id);
    const targetSelection = !allNotes && state.selectedIndices.size > 0
      ? new Set(state.selectedIndices)
      : undefined;
    try {
      const changed = studioEngine.quantizeTrackNotes(
        track.id,
        grid,
        targetSelection ? Array.from(targetSelection) : undefined
      );
      if (changed > 0 && state.selectedIndices.size > 0) {
        const nextSpans = editorNotes(track.id);
        state.selectedIndices = computeQuantizedSelectionRemap(
          prevSpans,
          state.selectedIndices,
          nextSpans,
          grid,
          limit
        );
        requestRender();
      }
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
      requestRender();
    }
  };

  const deleteSelectedNotes = () => {
    if (state.selectedIndices.size === 0) return;
    const track = studioEngine.getFocusedTrack();
    const spans = editorNotes(track.id);
    const remaining = spans.filter((_, idx) => !state.selectedIndices.has(idx));
    state.selectedIndices.clear();
    commitSpans(remaining);
  };

  const syncVelocityDOM = (spans: readonly StudioNoteSpan[], selectedSet: ReadonlySet<number>) => {
    const laneEl = container.querySelector<HTMLElement>("#st-pr-vel-lane");
    const notesRoot = container.querySelector<HTMLElement>("#st-pr-notes");
    selectedSet.forEach((i) => {
      const span = spans[i];
      if (!span) return;
      const velMidi = velocityToMidi(span.velocity);
      const pct = `${velMidiToLanePct(velMidi).toFixed(2)}%`;
      const op = velMidiToOpacity(velMidi);
      if (laneEl) {
        const stem = laneEl.querySelector<HTMLElement>(`[data-pr-vel-idx="${i}"]`);
        if (stem) {
          stem.style.height = pct;
          stem.dataset.prVelMidi = String(velMidi);
          stem.title = `Velocity ${velMidi} (drag up/down)`;
        }
      }
      if (notesRoot) {
        const noteEl = notesRoot.querySelector<HTMLElement>(`[data-pr-note-idx="${i}"]`);
        if (noteEl) {
          noteEl.style.setProperty("--vel-op", op);
          noteEl.style.setProperty("--vel-pct", pct);
          noteEl.dataset.prVelMidi = String(velMidi);
          const name = noteEl.dataset.prName || midiNoteLabel(span.midi);
          noteEl.title = state.velMode
            ? `${name} · Vel ${velMidi} (drag up/down to adjust velocity)`
            : `${name} · Vel ${velMidi} (drag to move, right edge to resize, dbl-click or Del to remove)`;
          if (state.velMode) {
            const lblEl = noteEl.querySelector<HTMLElement>(".st-pr-note-lbl");
            if (lblEl) {
              const w = noteEl.offsetWidth || parseFloat(noteEl.style.width) || 0;
              lblEl.textContent = formatNoteDisplayLabel(name, velMidi, w, true);
            }
          }
        }
      }
    });
    const summary = velocitySummary(spans, selectedSet);
    const inputEl = container.querySelector<HTMLInputElement>("#st-pr-vel-input");
    if (inputEl && document.activeElement !== inputEl) {
      inputEl.value = String(summary.avg);
    }
    const sliderEl = container.querySelector<HTMLInputElement>("#st-pr-vel-slider");
    if (sliderEl && document.activeElement !== sliderEl && !sliderDrag) {
      sliderEl.value = String(summary.avg);
    }
    const readout = container.querySelector<HTMLElement>("#st-pr-vel-readout");
    if (readout) {
      readout.textContent = summary.count > 0 ? summary.text : "—";
    }
  };

  const syncSelectionDOM = (spans: readonly StudioNoteSpan[]) => {
    const notesRoot = container.querySelector<HTMLElement>("#st-pr-notes");
    const laneEl = container.querySelector<HTMLElement>("#st-pr-vel-lane");
    if (notesRoot) {
      notesRoot.querySelectorAll<HTMLElement>("[data-pr-note-idx]").forEach((el) => {
        const idx = Number(el.getAttribute("data-pr-note-idx"));
        el.classList.toggle("is-selected", state.selectedIndices.has(idx));
      });
    }
    if (laneEl) {
      laneEl.querySelectorAll<HTMLElement>("[data-pr-vel-idx]").forEach((el) => {
        const idx = Number(el.getAttribute("data-pr-vel-idx"));
        el.classList.toggle("is-selected", state.selectedIndices.has(idx));
      });
    }
    const summary = velocitySummary(spans, state.selectedIndices);
    const metaEl = container.querySelector<HTMLElement>(".st-pr-toolbar .st-pr-meta");
    if (metaEl) {
      const prRoot = container.querySelector<HTMLElement>("#st-piano-roll");
      const isDrum = prRoot?.dataset.prMode === "drums";
      const unit = isDrum ? (spans.length === 1 ? "hit" : "hits") : spans.length === 1 ? "note" : "notes";
      metaEl.textContent = `${spans.length} ${unit}${state.selectedIndices.size > 0 ? ` · ${state.selectedIndices.size} sel` : ""}`;
    }
    const delBtn = container.querySelector<HTMLButtonElement>("#st-pr-delete");
    if (delBtn) delBtn.disabled = state.selectedIndices.size === 0;
    const noneBtn = container.querySelector<HTMLButtonElement>("#st-pr-deselect-all");
    if (noneBtn) noneBtn.disabled = state.selectedIndices.size === 0;
    const sliderWrap = container.querySelector<HTMLElement>("#st-pr-vel-slider-wrap");
    if (sliderWrap) sliderWrap.hidden = summary.count === 0;
    const sliderEl = container.querySelector<HTMLInputElement>("#st-pr-vel-slider");
    if (sliderEl) {
      sliderEl.disabled = summary.count === 0;
      sliderEl.value = String(summary.avg);
    }
    const inputEl = container.querySelector<HTMLInputElement>("#st-pr-vel-input");
    if (inputEl && document.activeElement !== inputEl) inputEl.value = String(summary.avg);
    const readout = container.querySelector<HTMLElement>("#st-pr-vel-readout");
    if (readout) readout.textContent = summary.count > 0 ? summary.text : "—";
  };

  const clearLongPress = () => {
    if (!longPressPending) return;
    clearTimeout(longPressPending.timer);
    longPressPending = null;
  };

  const abortMarquee = () => {
    if (!marqueeDrag) return;
    marqueeDrag.marqueeEl.remove();
    marqueeDrag.gridEl.classList.remove("is-marquee-active");
    marqueeDrag = null;
  };

  const commitNumericVelocityInput = (rawValue: string) => {
    const parsed = Number(rawValue);
    if (!Number.isFinite(parsed)) {
      requestRender();
      return;
    }
    const clamped = clampMidiVelocity(parsed);
    const track = studioEngine.getFocusedTrack();
    const spans = editorNotes(track.id);
    if (state.selectedIndices.size === 0) {
      state.defaultVelocityMidi = clamped;
      requestRender();
      return;
    }
    const next = applyNumericVelocity(spans, state.selectedIndices, clamped);
    const firstSel = Array.from(state.selectedIndices)[0];
    if (firstSel !== undefined && next[firstSel]) {
      previewNote(next[firstSel].midi, next[firstSel].velocity, 160);
    }
    commitSpans(next);
  };

  const nudgeSelectedVelocity = (deltaMidi: number) => {
    const track = studioEngine.getFocusedTrack();
    const spans = editorNotes(track.id);
    if (state.selectedIndices.size === 0) {
      state.defaultVelocityMidi = clampMidiVelocity(state.defaultVelocityMidi + deltaMidi);
      requestRender();
      return;
    }
    const origMidis = new Map<number, number>();
    state.selectedIndices.forEach((idx) => {
      if (spans[idx]) origMidis.set(idx, velocityToMidi(spans[idx].velocity));
    });
    if (origMidis.size === 0) return;
    const next = applyRelativeVelocityDelta(spans, state.selectedIndices, origMidis, deltaMidi);
    const firstSel = Array.from(state.selectedIndices)[0];
    if (firstSel !== undefined && next[firstSel]) {
      previewNote(next[firstSel].midi, next[firstSel].velocity, 160);
    }
    commitSpans(next);
  };

  const findNearestVelocityStemIndex = (laneEl: HTMLElement, clientX: number, maxDistPx = 24): number => {
    const stems = laneEl.querySelectorAll<HTMLElement>("[data-pr-vel-idx]");
    let bestIdx = -1;
    let bestDist = maxDistPx;
    let bestSelected = false;
    stems.forEach((stem) => {
      const idx = Number(stem.getAttribute("data-pr-vel-idx"));
      if (!Number.isFinite(idx)) return;
      const r = stem.getBoundingClientRect();
      const cx = r.left + r.width * 0.5;
      const dist = Math.abs(clientX - cx);
      const isSel = state.selectedIndices.has(idx);
      if (dist <= bestDist) {
        if (dist < bestDist - 1.5 || (Math.abs(dist - bestDist) <= 1.5 && isSel && !bestSelected)) {
          bestDist = dist;
          bestIdx = idx;
          bestSelected = isSel;
        }
      }
    });
    return bestIdx;
  };

  // Sync horizontal scroll between Piano Roll grid and Velocity lane
  container.addEventListener(
    "scroll",
    (e) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      if (target.id === "st-pr-scroll") {
        state.scrollLeft = target.scrollLeft;
        state.scrollTop = target.scrollTop;
        const velScroll = container.querySelector<HTMLElement>("#st-pr-vel-scroll");
        if (velScroll && Math.abs(velScroll.scrollLeft - target.scrollLeft) > 1) {
          velScroll.scrollLeft = target.scrollLeft;
        }
      } else if (target.id === "st-pr-vel-scroll") {
        state.scrollLeft = target.scrollLeft;
        const gridScroll = container.querySelector<HTMLElement>("#st-pr-scroll");
        if (gridScroll && Math.abs(gridScroll.scrollLeft - target.scrollLeft) > 1) {
          gridScroll.scrollLeft = target.scrollLeft;
        }
      }
    },
    true
  );

  const beginSliderSession = (): NonNullable<typeof sliderDrag> | null => {
    if (state.selectedIndices.size === 0) return null;
    const track = studioEngine.getFocusedTrack();
    const origSpans = editorNotes(track.id);
    const selectedSet = new Set<number>(state.selectedIndices);
    const origMidis = new Map<number, number>();
    selectedSet.forEach((idx) => {
      if (origSpans[idx]) origMidis.set(idx, velocityToMidi(origSpans[idx].velocity));
    });
    if (origMidis.size === 0) return null;
    const summary = velocitySummary(origSpans, selectedSet);
    sliderDrag = {
      origSpans,
      workingSpans: origSpans.map((s) => ({ ...s })),
      selectedSet,
      origMidis,
      startAvg: summary.avg
    };
    return sliderDrag;
  };

  container.addEventListener("input", (e) => {
    const el = e.target as HTMLInputElement | null;
    if (!el || el.id !== "st-pr-vel-slider") return;
    if (state.selectedIndices.size === 0) return;
    const session = sliderDrag ?? beginSliderSession();
    if (!session) return;
    const targetVal = clampMidiVelocity(Number(el.value));
    const delta = targetVal - session.startAvg;
    session.workingSpans = applyRelativeVelocityDelta(
      session.origSpans,
      session.selectedSet,
      session.origMidis,
      delta
    );
    syncVelocityDOM(session.workingSpans, session.selectedSet);
  });

  container.addEventListener("change", (e) => {
    const el = e.target as HTMLInputElement | HTMLSelectElement | null;
    if (!el) return;
    if (el.id === "st-pr-snap") {
      setPianoRollSnap(Number(el.value));
      requestRender();
      return;
    }
    if (el.id === "st-pr-quantize-div") {
      setPianoRollQuantize(Number(el.value));
      requestRender();
      return;
    }
    if (el.id === "st-pr-vel-slider") {
      const session = sliderDrag ?? beginSliderSession();
      sliderDrag = null;
      if (!session) return;
      const targetVal = clampMidiVelocity(Number(el.value));
      const delta = targetVal - session.startAvg;
      const updated = applyRelativeVelocityDelta(
        session.origSpans,
        session.selectedSet,
        session.origMidis,
        delta
      );
      const firstSel = Array.from(session.selectedSet)[0];
      if (firstSel !== undefined && updated[firstSel]) {
        previewNote(updated[firstSel].midi, updated[firstSel].velocity, 160);
      }
      commitSpans(updated);
      return;
    }
    if (el.id === "st-pr-vel-input") {
      commitNumericVelocityInput(el.value);
    }
  });

  container.addEventListener("keydown", (e) => {
    const target = e.target as HTMLInputElement | null;
    if (!target || target.id !== "st-pr-vel-input") return;
    e.stopPropagation();
    if (e.key === "Enter") {
      e.preventDefault();
      commitNumericVelocityInput(target.value);
      target.blur();
    } else if (e.key === "Escape") {
      e.preventDefault();
      target.blur();
      requestRender();
    }
  });

  container.addEventListener("click", (e) => {
    const target = e.target as HTMLElement | null;
    if (!target) return;

    const btn = target.closest<HTMLElement>("[data-pr-action]");
    if (btn) {
      const action = btn.getAttribute("data-pr-action");
      switch (action) {
        case "toggle-select-mode":
          state.multiSelectMode = !state.multiSelectMode;
          requestRender();
          break;
        case "select-all":
          selectAllPianoRollNotes();
          requestRender();
          break;
        case "deselect-all":
          state.selectedIndices.clear();
          requestRender();
          break;
        case "toggle-vel-mode":
          state.velMode = !state.velMode;
          requestRender();
          break;
        case "vel-dec":
          nudgeSelectedVelocity(e.shiftKey ? -5 : -1);
          break;
        case "vel-inc":
          nudgeSelectedVelocity(e.shiftKey ? 5 : 1);
          break;
        case "quantize":
          runQuantize(false);
          break;
        case "quantize-all":
          runQuantize(true);
          break;
        case "delete-selected":
          deleteSelectedNotes();
          break;
        case "toggle-audition":
          state.audition = !state.audition;
          requestRender();
          break;
        case "zoom-in":
          setPianoRollZoom(state.zoom + 0.25);
          requestRender();
          break;
        case "zoom-out":
          setPianoRollZoom(state.zoom - 0.25);
          requestRender();
          break;
      }
      return;
    }

    // Clicking empty Piano Roll / Drum Grid creates a new snapped MIDI note (or clears selection in Velocity / Select modes)
    const grid = target.closest<HTMLElement>("#st-pr-grid");
    if (grid && !target.closest(".st-pr-note")) {
      if (performance.now() < suppressGridClickUntil) return;
      grid.focus({ preventScroll: true });
      if (state.velMode || state.multiSelectMode) {
        if (state.selectedIndices.size > 0) {
          state.selectedIndices.clear();
          requestRender();
        }
        return;
      }
      const prRoot = container.querySelector<HTMLElement>("#st-piano-roll");
      if (!prRoot) return;
      const rect = grid.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;

      const totalTicks = Number(prRoot.dataset.prTotalTicks || studioEngine.getTotalTicks());
      const rowMidis = parseRowMidis(prRoot);
      const rowHeight = Number(prRoot.dataset.prRowH || PR_ROW_HEIGHT);
      if (rowMidis.length === 0) return;

      const x = Math.max(0, Math.min(rect.width - 1, e.clientX - rect.left));
      const y = Math.max(0, Math.min(rect.height - 1, e.clientY - rect.top));

      const rawTick = (x / rect.width) * totalTicks;
      const startTick = Math.min(totalTicks - 1, snapTickValue(rawTick, state.snapTicks, "floor"));
      const dur = state.snapTicks > 0 ? Math.max(120, state.snapTicks) : STUDIO_PPQ;
      const rowIdx = Math.max(0, Math.min(rowMidis.length - 1, Math.floor(y / rowHeight)));
      const midi = rowMidis[rowIdx];

      const track = studioEngine.getFocusedTrack();
      const spans = editorNotes(track.id);
      const endTick = Math.min(totalTicks, Math.max(startTick + 30, startTick + dur));
      const vel = midiToVelocity(state.defaultVelocityMidi);
      spans.push({ midi, startTick, endTick, velocity: vel });
      spans.sort((a, b) => a.startTick - b.startTick || a.midi - b.midi);
      const newIdx = spans.findIndex((s) => s.midi === midi && s.startTick === startTick && s.endTick === endTick);
      state.selectedIndices.clear();
      if (newIdx >= 0) state.selectedIndices.add(newIdx);

      previewNote(midi, vel, 220);
      commitSpans(spans);
    }
  });

  // Double-click a note to delete it quickly (disabled in Velocity Mode so touch taps never delete notes)
  container.addEventListener("dblclick", (e) => {
    if (state.velMode || state.multiSelectMode) return;
    const target = e.target as HTMLElement | null;
    if (!target) return;
    const noteEl = target.closest<HTMLElement>(".st-pr-note");
    if (!noteEl) return;
    const idx = Number(noteEl.getAttribute("data-pr-note-idx"));
    if (!Number.isFinite(idx)) return;
    const track = studioEngine.getFocusedTrack();
    const spans = editorNotes(track.id);
    if (idx < 0 || idx >= spans.length) return;
    spans.splice(idx, 1);
    state.selectedIndices.clear();
    commitSpans(spans);
  });

  // Right-click a note to delete it
  container.addEventListener("contextmenu", (e) => {
    const target = e.target as HTMLElement | null;
    const noteEl = target?.closest<HTMLElement>(".st-pr-note");
    if (!noteEl) return;
    e.preventDefault();
    const idx = Number(noteEl.getAttribute("data-pr-note-idx"));
    if (!Number.isFinite(idx)) return;
    const track = studioEngine.getFocusedTrack();
    const spans = editorNotes(track.id);
    if (idx < 0 || idx >= spans.length) return;
    spans.splice(idx, 1);
    state.selectedIndices.clear();
    commitSpans(spans);
  });

  const activateMarquee = (
    pointerId: number,
    gridEl: HTMLElement,
    prRoot: HTMLElement,
    clientX: number,
    clientY: number,
    addMode: boolean
  ) => {
    const rect = gridEl.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const x = Math.max(0, Math.min(rect.width, clientX - rect.left));
    const y = Math.max(0, Math.min(rect.height, clientY - rect.top));
    const track = studioEngine.getFocusedTrack();
    const spans = editorNotes(track.id);
    const rowMidis = parseRowMidis(prRoot);
    const midiToRowIndex = new Map<number, number>();
    rowMidis.forEach((m, i) => midiToRowIndex.set(m, i));
    const marqueeEl = document.createElement("div");
    marqueeEl.className = "st-pr-marquee";
    marqueeEl.id = "st-pr-marquee";
    marqueeEl.style.left = `${x.toFixed(1)}px`;
    marqueeEl.style.top = `${y.toFixed(1)}px`;
    marqueeEl.style.width = "10px";
    marqueeEl.style.height = "10px";
    gridEl.append(marqueeEl);
    gridEl.classList.add("is-marquee-active");
    try { gridEl.setPointerCapture(pointerId); } catch {}
    marqueeDrag = {
      pointerId,
      gridEl,
      marqueeEl,
      startX: x,
      startY: y,
      curX: x,
      curY: y,
      addMode,
      baseSelection: addMode ? new Set(state.selectedIndices) : new Set<number>(),
      spans,
      midiToRowIndex,
      gridWidth: Number(prRoot.dataset.prWidth || rect.width),
      totalTicks: Number(prRoot.dataset.prTotalTicks || studioEngine.getTotalTicks()),
      rowHeight: Number(prRoot.dataset.prRowH || PR_ROW_HEIGHT),
      moved: false
    };
  };

  const updateMarquee = (clientX: number, clientY: number) => {
    if (!marqueeDrag) return;
    const rect = marqueeDrag.gridEl.getBoundingClientRect();
    const x = Math.max(0, Math.min(rect.width, clientX - rect.left));
    const y = Math.max(0, Math.min(rect.height, clientY - rect.top));
    marqueeDrag.curX = x;
    marqueeDrag.curY = y;
    const left = Math.min(marqueeDrag.startX, x);
    const top = Math.min(marqueeDrag.startY, y);
    const width = Math.max(2, Math.abs(x - marqueeDrag.startX));
    const height = Math.max(2, Math.abs(y - marqueeDrag.startY));
    if (width > 4 || height > 4) marqueeDrag.moved = true;
    marqueeDrag.marqueeEl.style.left = `${left.toFixed(1)}px`;
    marqueeDrag.marqueeEl.style.top = `${top.toFixed(1)}px`;
    marqueeDrag.marqueeEl.style.width = `${width.toFixed(1)}px`;
    marqueeDrag.marqueeEl.style.height = `${height.toFixed(1)}px`;

    const hits = findNotesInMarquee(
      marqueeDrag.spans,
      marqueeDrag.midiToRowIndex,
      marqueeDrag.totalTicks,
      marqueeDrag.gridWidth,
      marqueeDrag.rowHeight,
      { left, top, right: left + width, bottom: top + height }
    );
    const nextSel = new Set(marqueeDrag.baseSelection);
    hits.forEach((idx) => nextSel.add(idx));
    state.selectedIndices = nextSel;
    syncSelectionDOM(marqueeDrag.spans);
  };

  // Pointerdown: piano/drum key audition, contextual slider, velocity lane drag, note move/resize/velocity drag, long-press marquee & pinch guard
  container.addEventListener("pointerdown", (e) => {
    if (e.button === 2) return;
    const target = e.target as HTMLElement | null;
    if (!target) return;

    if (target.id === "st-pr-vel-slider") {
      beginSliderSession();
      return;
    }

    if (e.pointerType === "touch" && target.closest("#st-pr-scroll")) {
      activeTouchPointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (activeTouchPointers.size >= 2) {
        clearLongPress();
        abortMarquee();
        touchPan = null;
        if (noteDrag) {
          noteDrag.el.classList.remove("is-dragging");
          noteDrag = null;
        }
        const pts = Array.from(activeTouchPointers.values());
        const scrollEl = container.querySelector<HTMLElement>("#st-pr-scroll");
        const prRoot = container.querySelector<HTMLElement>("#st-piano-roll");
        if (scrollEl && prRoot) {
          const rect = scrollEl.getBoundingClientRect();
          const midClientX = (pts[0].x + pts[1].x) * 0.5;
          const localMidX = Math.max(0, midClientX - rect.left);
          pinchZoom = {
            scrollEl,
            startDist: Math.max(20, Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y)),
            startZoom: state.zoom,
            lastRenderedZoom: state.zoom,
            anchorContentX: scrollEl.scrollLeft + localMidX,
            localMidX
          };
          suppressGridClickUntil = performance.now() + 450;
        }
        return;
      }
    }

    const keyBtn = target.closest<HTMLElement>("[data-pr-key]");
    if (keyBtn) {
      e.preventDefault();
      const midi = Number(keyBtn.getAttribute("data-pr-key"));
      if (!Number.isFinite(midi)) return;
      studioEngine.prepareAudioSync();
      studioEngine.getFocusedTrack().noteOn(midi, 0.88);
      keyBtn.classList.add("is-pressed");
      heldAuditionKey = { midi, pointerId: e.pointerId, el: keyBtn };
      try { keyBtn.setPointerCapture(e.pointerId); } catch (err) {}
      return;
    }

    if (target.closest(".st-pr-note, [data-pr-vel-idx], #st-pr-vel-lane")) {
      container.querySelector<HTMLElement>("#st-pr-grid")?.focus({ preventScroll: true });
    }

    const velStem = target.closest<HTMLElement>("[data-pr-vel-idx]");
    const velLaneHit = velStem ? container.querySelector<HTMLElement>("#st-pr-vel-lane") : target.closest<HTMLElement>("#st-pr-vel-lane");
    if (velLaneHit) {
      const idx = velStem
        ? Number(velStem.getAttribute("data-pr-vel-idx"))
        : findNearestVelocityStemIndex(velLaneHit, e.clientX, 24);
      if (!Number.isFinite(idx) || idx < 0) return;
      e.preventDefault();
      const track = studioEngine.getFocusedTrack();
      const origSpans = editorNotes(track.id);
      if (idx >= origSpans.length) return;

      if (e.shiftKey || state.multiSelectMode) {
        if (!state.selectedIndices.has(idx)) state.selectedIndices.add(idx);
      } else if (!state.selectedIndices.has(idx)) {
        state.selectedIndices.clear();
        state.selectedIndices.add(idx);
      }

      const selectedSet = new Set<number>(state.selectedIndices.size > 0 ? state.selectedIndices : [idx]);
      selectedSet.add(idx);
      const origMidis = new Map<number, number>();
      selectedSet.forEach((si) => {
        if (origSpans[si]) origMidis.set(si, velocityToMidi(origSpans[si].velocity));
      });
      const anchorOrigMidi = origMidis.get(idx) ?? velocityToMidi(origSpans[idx].velocity);

      velDrag = {
        index: idx,
        pointerId: e.pointerId,
        laneEl: velLaneHit,
        origSpans,
        workingSpans: origSpans.map((s) => ({ ...s })),
        selectedSet,
        origMidis,
        anchorOrigMidi,
        changed: false
      };
      const captureTarget = velStem || velLaneHit;
      try { captureTarget.setPointerCapture(e.pointerId); } catch (err) {}
      updateVelocityFromLanePointer(e.clientY);
      return;
    }

    const resizeEl = state.velMode ? null : target.closest<HTMLElement>("[data-pr-resize]");
    const noteEl = target.closest<HTMLElement>(".st-pr-note");
    if (noteEl) {
      e.preventDefault();
      e.stopPropagation();
      const idx = Number(noteEl.getAttribute("data-pr-note-idx"));
      const prRoot = container.querySelector<HTMLElement>("#st-piano-roll");
      if (!prRoot || !Number.isFinite(idx)) return;
      const track = studioEngine.getFocusedTrack();
      const totalTicks = Number(prRoot.dataset.prTotalTicks || studioEngine.getTotalTicks());
      const rowMidis = parseRowMidis(prRoot);
      const rowHeight = Number(prRoot.dataset.prRowH || PR_ROW_HEIGHT);
      const origSpans = editorNotes(track.id);
      if (idx < 0 || idx >= origSpans.length || rowMidis.length === 0) return;

      const origSelectedSize = state.selectedIndices.size;
      const wasSelected = state.selectedIndices.has(idx);
      const additive = e.shiftKey || state.multiSelectMode;
      let toggleOffOnTapUp: number | null = null;
      let collapseToIndexOnTapUp: number | null = null;

      if (additive) {
        if (wasSelected) {
          toggleOffOnTapUp = idx;
        } else {
          state.selectedIndices.add(idx);
        }
      } else if (!wasSelected) {
        state.selectedIndices.clear();
        state.selectedIndices.add(idx);
      } else if (origSelectedSize > 1 && !resizeEl && !state.velMode) {
        collapseToIndexOnTapUp = idx;
      }

      const selectedList = state.selectedIndices.size > 0 ? Array.from(state.selectedIndices) : [idx];
      const selectedSet = new Set<number>(selectedList);
      const origRowIndices = new Map<number, number>();
      const origMidis = new Map<number, number>();
      for (const si of selectedList) {
        const s = origSpans[si];
        if (!s) continue;
        const rIdx = rowMidis.indexOf(s.midi);
        if (rIdx >= 0) origRowIndices.set(si, rIdx);
        origMidis.set(si, velocityToMidi(s.velocity));
      }

      noteDrag = {
        mode: state.velMode ? "velocity" : resizeEl ? "resize" : "move",
        index: idx,
        pointerId: e.pointerId,
        startClientX: e.clientX,
        startClientY: e.clientY,
        origSpans,
        workingSpans: origSpans.map((s) => ({ ...s })),
        selectedList,
        selectedSet,
        origMidis,
        gridWidth: Number(prRoot.dataset.prWidth || 640),
        totalTicks,
        rowMidis,
        rowHeight,
        origRowIndices,
        moved: false,
        toggleOffOnTapUp,
        collapseToIndexOnTapUp,
        lastAuditionMidi: origSpans[idx].midi,
        lastDeltaMidi: 0,
        el: noteEl
      };
      noteEl.classList.add("is-dragging");
      syncSelectionDOM(origSpans);
      try { noteEl.setPointerCapture(e.pointerId); } catch (err) {}
      if (!resizeEl) previewNote(origSpans[idx].midi, origSpans[idx].velocity, 160);
      return;
    }

    // Empty grid press: long-press (touch/pen/mouse) or Shift/Select-mode drag starts rectangular marquee selection
    const gridEl = target.closest<HTMLElement>("#st-pr-grid");
    const prRoot = container.querySelector<HTMLElement>("#st-piano-roll");
    if (gridEl && prRoot) {
      if (e.pointerType === "touch" && !state.multiSelectMode) {
        const scrollEl = container.querySelector<HTMLElement>("#st-pr-scroll");
        if (scrollEl) {
          touchPan = {
            pointerId: e.pointerId,
            scrollEl,
            startX: e.clientX,
            startY: e.clientY,
            startScrollLeft: scrollEl.scrollLeft,
            startScrollTop: scrollEl.scrollTop,
            scrolling: false
          };
        }
      }
      if (!state.velMode) {
        const addMode = e.shiftKey || state.multiSelectMode;
        if (e.pointerType !== "touch" && (e.shiftKey || state.multiSelectMode)) {
          e.preventDefault();
          longPressPending = {
            pointerId: e.pointerId,
            pointerType: e.pointerType,
            startClientX: e.clientX,
            startClientY: e.clientY,
            gridEl,
            prRoot,
            addMode,
            timer: window.setTimeout(() => {
              if (!longPressPending || longPressPending.pointerId !== e.pointerId) return;
              const pending = longPressPending;
              longPressPending = null;
              touchPan = null;
              activateMarquee(pending.pointerId, pending.gridEl, pending.prRoot, pending.startClientX, pending.startClientY, pending.addMode);
            }, 160)
          };
        } else if (e.pointerType === "touch" && state.multiSelectMode) {
          e.preventDefault();
          activateMarquee(e.pointerId, gridEl, prRoot, e.clientX, e.clientY, true);
          suppressGridClickUntil = performance.now() + 450;
        } else {
          // Stationary long-press (~300ms) allows 1-finger touch scroll if finger moves > 7px before threshold
          longPressPending = {
            pointerId: e.pointerId,
            pointerType: e.pointerType,
            startClientX: e.clientX,
            startClientY: e.clientY,
            gridEl,
            prRoot,
            addMode,
            timer: window.setTimeout(() => {
              if (!longPressPending || longPressPending.pointerId !== e.pointerId) return;
              const pending = longPressPending;
              longPressPending = null;
              touchPan = null;
              activateMarquee(pending.pointerId, pending.gridEl, pending.prRoot, pending.startClientX, pending.startClientY, pending.addMode);
              suppressGridClickUntil = performance.now() + 600;
            }, 300)
          };
        }
      }
    }
  });

  const updateVelocityFromLanePointer = (clientY: number) => {
    if (!velDrag) return;
    const rect = velDrag.laneEl.getBoundingClientRect();
    if (rect.height <= 0) return;
    const targetMidi = clientYToMidiVelocity(clientY, rect);
    const deltaMidi = targetMidi - velDrag.anchorOrigMidi;
    velDrag.workingSpans = applyRelativeVelocityDelta(
      velDrag.origSpans,
      velDrag.selectedSet,
      velDrag.origMidis,
      deltaMidi
    );
    velDrag.changed = true;
    syncVelocityDOM(velDrag.workingSpans, velDrag.selectedSet);
  };

  container.addEventListener("pointermove", (e) => {
    if (e.pointerType === "touch" && activeTouchPointers.has(e.pointerId)) {
      activeTouchPointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pinchZoom && activeTouchPointers.size >= 2) {
        e.preventDefault();
        const pts = Array.from(activeTouchPointers.values());
        const dist = Math.max(20, Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y));
        const ratio = dist / pinchZoom.startDist;
        const nextZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.round(pinchZoom.startZoom * ratio * 100) / 100));
        if (Math.abs(nextZoom - pinchZoom.lastRenderedZoom) >= 0.06) {
          const prevZoom = pinchZoom.lastRenderedZoom;
          state.zoom = nextZoom;
          pinchZoom.lastRenderedZoom = nextZoom;
          state.scrollLeft = Math.max(0, pinchZoom.anchorContentX * (nextZoom / prevZoom) - pinchZoom.localMidX);
          pinchZoom.anchorContentX = state.scrollLeft + pinchZoom.localMidX;
          requestRender();
        }
        return;
      }
    }

    if (longPressPending && e.pointerId === longPressPending.pointerId) {
      const dist = Math.hypot(e.clientX - longPressPending.startClientX, e.clientY - longPressPending.startClientY);
      if (longPressPending.pointerType !== "touch" && longPressPending.addMode && dist > 4) {
        const pending = longPressPending;
        clearLongPress();
        activateMarquee(pending.pointerId, pending.gridEl, pending.prRoot, pending.startClientX, pending.startClientY, pending.addMode);
        updateMarquee(e.clientX, e.clientY);
        return;
      }
      if (dist > 7) {
        clearLongPress();
      }
    }

    if (touchPan && e.pointerId === touchPan.pointerId && !marqueeDrag) {
      const dx = e.clientX - touchPan.startX;
      const dy = e.clientY - touchPan.startY;
      if (!touchPan.scrolling && Math.hypot(dx, dy) > 7) {
        touchPan.scrolling = true;
        suppressGridClickUntil = performance.now() + 350;
      }
      if (touchPan.scrolling) {
        e.preventDefault();
        touchPan.scrollEl.scrollLeft = Math.max(0, touchPan.startScrollLeft - dx);
        touchPan.scrollEl.scrollTop = Math.max(0, touchPan.startScrollTop - dy);
        return;
      }
    }

    if (marqueeDrag && e.pointerId === marqueeDrag.pointerId) {
      e.preventDefault();
      updateMarquee(e.clientX, e.clientY);
      return;
    }

    if (velDrag && e.pointerId === velDrag.pointerId) {
      e.preventDefault();
      updateVelocityFromLanePointer(e.clientY);
      return;
    }
    if (!noteDrag || e.pointerId !== noteDrag.pointerId) return;
    e.preventDefault();

    const dx = e.clientX - noteDrag.startClientX;
    const dy = e.clientY - noteDrag.startClientY;
    if (Math.abs(dx) > 4 || Math.abs(dy) > 4) noteDrag.moved = true;
    if (!noteDrag.moved) return;

    if (noteDrag.mode === "velocity") {
      const pxPerStep = e.shiftKey ? 4 : 1.5;
      const deltaMidi = Math.round(-dy / pxPerStep);
      if (deltaMidi !== noteDrag.lastDeltaMidi) {
        noteDrag.lastDeltaMidi = deltaMidi;
        noteDrag.workingSpans = applyRelativeVelocityDelta(
          noteDrag.origSpans,
          noteDrag.selectedSet,
          noteDrag.origMidis,
          deltaMidi
        );
        syncVelocityDOM(noteDrag.workingSpans, noteDrag.selectedSet);
      }
      return;
    }

    const deltaTicksRaw = (dx / noteDrag.gridWidth) * noteDrag.totalTicks;
    const snap = state.snapTicks;
    const notesRoot = container.querySelector<HTMLElement>("#st-pr-notes");
    const velLane = container.querySelector<HTMLElement>("#st-pr-vel-lane");

    if (noteDrag.mode === "resize") {
      const minDur = Math.max(1, snap);
      for (const si of noteDrag.selectedList) {
        const s = noteDrag.origSpans[si];
        if (!s) continue;
        const snappedEnd = Math.max(
          Math.min(noteDrag.totalTicks, s.startTick + minDur),
          Math.min(noteDrag.totalTicks, snapTickValue(s.endTick + deltaTicksRaw, snap, "round"))
        );
        const widthPx = Math.max(10, ((snappedEnd - s.startTick) / noteDrag.totalTicks) * noteDrag.gridWidth);
        const el = si === noteDrag.index ? noteDrag.el : notesRoot?.querySelector<HTMLElement>(`[data-pr-note-idx="${si}"]`);
        if (el) el.style.width = `${widthPx.toFixed(1)}px`;
      }
    } else {
      const { tickShift, rowShift: deltaRows } = boundedNoteMove(
        noteDrag.origSpans, noteDrag.selectedList, noteDrag.index, noteDrag.origRowIndices,
        noteDrag.rowMidis.length, deltaTicksRaw, Math.round(dy / noteDrag.rowHeight), snap, noteDrag.totalTicks
      );

      for (const si of noteDrag.selectedList) {
        const s = noteDrag.origSpans[si];
        if (!s) continue;
        const nextStart = s.startTick + tickShift;
        const origRow = noteDrag.origRowIndices.get(si) ?? 0;
        const nextRow = Math.max(0, Math.min(noteDrag.rowMidis.length - 1, origRow + deltaRows));
        const leftPx = (nextStart / noteDrag.totalTicks) * noteDrag.gridWidth;
        const topPx = nextRow * noteDrag.rowHeight + 2;
        const el = si === noteDrag.index ? noteDrag.el : notesRoot?.querySelector<HTMLElement>(`[data-pr-note-idx="${si}"]`);
        if (el) {
          el.style.left = `${leftPx.toFixed(1)}px`;
          el.style.top = `${topPx}px`;
        }
        const stemEl = velLane?.querySelector<HTMLElement>(`[data-pr-vel-idx="${si}"]`);
        if (stemEl) {
          stemEl.style.left = `${leftPx.toFixed(1)}px`;
        }
        if (si === noteDrag.index) {
          const nextMidi = noteDrag.rowMidis[nextRow];
          if (nextMidi !== noteDrag.lastAuditionMidi) {
            noteDrag.lastAuditionMidi = nextMidi;
            previewNote(nextMidi, s.velocity, 120);
          }
        }
      }
    }
  });

  const endPointerOps = (e?: PointerEvent) => {
    if (e && e.pointerType === "touch") {
      activeTouchPointers.delete(e.pointerId);
      if (activeTouchPointers.size < 2 && pinchZoom) {
        pinchZoom = null;
        suppressGridClickUntil = performance.now() + 350;
      }
    } else if (!e) {
      activeTouchPointers.clear();
      pinchZoom = null;
    }

    if (longPressPending && (!e || e.pointerId === longPressPending.pointerId)) {
      clearLongPress();
    }

    if (touchPan && (!e || e.pointerId === touchPan.pointerId)) {
      if (touchPan.scrolling) suppressGridClickUntil = performance.now() + 260;
      touchPan = null;
    }

    if (marqueeDrag && (!e || e.pointerId === marqueeDrag.pointerId)) {
      const m = marqueeDrag;
      abortMarquee();
      suppressGridClickUntil = performance.now() + 380;
      if (e && e.type !== "pointercancel") {
        updateMarqueeStateAfterDrop(m);
      } else {
        state.selectedIndices = new Set(m.baseSelection);
      }
      requestRender();
      return;
    }

    if (heldAuditionKey && (!e || e.pointerId === heldAuditionKey.pointerId)) {
      studioEngine.getFocusedTrack().noteOff(heldAuditionKey.midi);
      heldAuditionKey.el.classList.remove("is-pressed");
      heldAuditionKey = null;
    }

    if (velDrag && (!e || e.pointerId === velDrag.pointerId)) {
      const drag = velDrag;
      velDrag = null;
      if (!e || e.type === "pointercancel") { requestRender(); return; }
      const updated = drag.workingSpans.map((s) => ({ ...s }));
      const anchor = updated[drag.index];
      if (anchor) previewNote(anchor.midi, anchor.velocity, 160);
      commitSpans(updated);
    }

    if (noteDrag && (!e || e.pointerId === noteDrag.pointerId)) {
      const drag = noteDrag;
      noteDrag = null;
      drag.el.classList.remove("is-dragging");
      if (!e || e.type === "pointercancel") { requestRender(); return; }

      if (drag.mode === "velocity") {
        if (!drag.moved || drag.lastDeltaMidi === 0) {
          if (drag.toggleOffOnTapUp !== null) {
            state.selectedIndices.delete(drag.toggleOffOnTapUp);
          }
          requestRender();
          return;
        }
        const updated = drag.workingSpans.map((s) => ({ ...s }));
        const anchor = updated[drag.index];
        if (anchor) previewNote(anchor.midi, anchor.velocity, 160);
        commitSpans(updated);
        return;
      }

      if (!drag.moved) {
        if (drag.toggleOffOnTapUp !== null) {
          state.selectedIndices.delete(drag.toggleOffOnTapUp);
        } else if (drag.collapseToIndexOnTapUp !== null) {
          state.selectedIndices.clear();
          state.selectedIndices.add(drag.collapseToIndexOnTapUp);
        }
        requestRender();
        return;
      }

      const dx = (e ? e.clientX : drag.startClientX) - drag.startClientX;
      const dy = (e ? e.clientY : drag.startClientY) - drag.startClientY;
      const deltaTicksRaw = (dx / drag.gridWidth) * drag.totalTicks;
      const snap = state.snapTicks;
      const nextSpans = drag.origSpans.map((s) => ({ ...s }));

      if (drag.mode === "resize") {
        const minDur = Math.max(1, snap);
        for (const i of drag.selectedList) {
          const s = nextSpans[i];
          if (!s) continue;
          const nextEnd = Math.max(
            Math.min(drag.totalTicks, s.startTick + minDur),
            Math.min(drag.totalTicks, snapTickValue(s.endTick + deltaTicksRaw, snap, "round"))
          );
          s.endTick = nextEnd;
        }
      } else {
        const { tickShift, rowShift: deltaRows } = boundedNoteMove(
          drag.origSpans, drag.selectedList, drag.index, drag.origRowIndices,
          drag.rowMidis.length, deltaTicksRaw, Math.round(dy / drag.rowHeight), snap, drag.totalTicks
        );

        for (const i of drag.selectedList) {
          const s = nextSpans[i];
          if (!s) continue;
          s.startTick += tickShift;
          s.endTick += tickShift;
          const origRow = drag.origRowIndices.get(i);
          if (origRow !== undefined) {
            const nextRow = Math.max(0, Math.min(drag.rowMidis.length - 1, origRow + deltaRows));
            s.midi = drag.rowMidis[nextRow];
          }
        }
      }

      commitSpans(nextSpans, true);
    }
  };

  const updateMarqueeStateAfterDrop = (m: NonNullable<typeof marqueeDrag>) => {
    const left = Math.min(m.startX, m.curX);
    const top = Math.min(m.startY, m.curY);
    const right = Math.max(m.startX, m.curX);
    const bottom = Math.max(m.startY, m.curY);
    const hits = findNotesInMarquee(
      m.spans,
      m.midiToRowIndex,
      m.totalTicks,
      m.gridWidth,
      m.rowHeight,
      { left, top, right, bottom }
    );
    const nextSel = new Set(m.baseSelection);
    hits.forEach((idx) => nextSel.add(idx));
    state.selectedIndices = nextSel;
  };

  container.addEventListener(
    "touchmove",
    (e) => {
      if (marqueeDrag || pinchZoom || activeTouchPointers.size >= 2 || noteDrag || velDrag) {
        if (e.cancelable) e.preventDefault();
      }
    },
    { passive: false }
  );

  container.addEventListener("pointerup", endPointerOps);
  container.addEventListener("pointercancel", endPointerOps);
  window.addEventListener("blur", () => endPointerOps());

  document.addEventListener("keydown", (e) => {
    if (!studioEngine.isActive() || container.hidden) return;
    const active = document.activeElement as HTMLElement | null;
    if (active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA" || active.tagName === "SELECT")) return;
    const mod = e.metaKey || e.ctrlKey;
    const key = e.key.toLowerCase();
    if (mod && key === "a" && active?.closest("#st-piano-roll")) {
      e.preventDefault();
      selectAllPianoRollNotes();
      requestRender();
      return;
    }
    if (e.key === "Escape" && (state.selectedIndices.size > 0 || state.multiSelectMode) && active?.closest("#st-piano-roll")) {
      e.preventDefault();
      state.selectedIndices.clear();
      state.multiSelectMode = false;
      requestRender();
      return;
    }
    if (state.selectedIndices.size === 0) return;
    if (e.key !== "Delete" && e.key !== "Backspace") return;
    e.preventDefault();
    deleteSelectedNotes();
  });
}
