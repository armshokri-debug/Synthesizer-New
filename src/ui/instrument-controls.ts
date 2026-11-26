/** Shared, read-only rendering for instrument controls. The caller owns the patch
 * and event namespace: a track control must never dispatch a standalone action.
 * This module has no editor focus, write callbacks, or global MIDI state. */
import { escapeHtml, SYNTH_PARAMS, synthNorm } from "../engine/params";
import type { ControlDef, ChoiceOption } from "../machines/types";

export type InstrumentControlContext =
  | { kind: "standalone"; patch: Readonly<Record<string, any>>; decoration: (key: string) => MidiDecoration }
  | { kind: "track"; patch: Readonly<Record<string, any>> };
export interface MidiDecoration {
  mapped: boolean;
  learning: boolean;
  knobTitle: string;
  choiceTitle: string;
}

function buildKnobScaleSvg(bipolar: boolean): string {
  let lines = "";
  let nums = "";
  for (let i = 0; i <= 10; i++) {
    const deg = -135 + i * 27;
    const rad = (deg * Math.PI) / 180;
    const sin = Math.sin(rad);
    const cos = -Math.cos(rad);
    const major = bipolar ? i === 0 || i === 5 || i === 10 : i % 2 === 0;
    const r1 = major ? 34.5 : 35.8;
    const r2 = major ? 40.5 : 39.4;
    const x1 = (50 + sin * r1).toFixed(2);
    const y1 = (50 + cos * r1).toFixed(2);
    const x2 = (50 + sin * r2).toFixed(2);
    const y2 = (50 + cos * r2).toFixed(2);
    lines += `<line class="sk-tick${major ? " is-major" : ""}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" />`;

    if (bipolar) {
      if (i === 0 || i === 5 || i === 10) {
        const txt = i === 0 ? "−" : i === 5 ? "0" : "+";
        const rt = 45.6;
        const tx = (50 + sin * rt).toFixed(2);
        const ty = (50 + cos * rt).toFixed(2);
        nums += `<text class="sk-num is-bipolar" x="${tx}" y="${ty}">${txt}</text>`;
      }
    } else {
      const rt = 45.8;
      const tx = (50 + sin * rt).toFixed(2);
      const ty = (50 + cos * rt).toFixed(2);
      nums += `<text class="sk-num" x="${tx}" y="${ty}">${i}</text>`;
    }
  }
  return `<svg class="sk-scale" viewBox="0 0 100 100" aria-hidden="true">${lines}${nums}</svg>`;
}

export const UNIPOLAR_SCALE_SVG = buildKnobScaleSvg(false);
export const BIPOLAR_SCALE_SVG = buildKnobScaleSvg(true);

export function renderInstrumentKnob(context: InstrumentControlContext, key: string, label: string): string {
  const def = SYNTH_PARAMS[key];
  const raw = context.patch[key];
  const track = context.kind === "track";
  const v = track && typeof raw !== "number" ? Number(def?.def ?? 0) : raw;
  const norm = synthNorm(key, v);
  const n = track ? Math.max(0, Math.min(1, norm)) : norm;
  const fmtVal = def && def.fmt ? def.fmt(v) : String(v);
  const midi = context.kind === "standalone" ? context.decoration(key) : null;
  const classes = track ? " st-inst-knob" : `${midi?.mapped ? " is-mapped" : ""}${midi?.learning ? " is-learning" : ""}`;
  const title = midi?.mapped ? ` title="${escapeHtml(midi.knobTitle)}"` : "";
  const attr = track ? "data-st-param" : "data-param";
  const isBipolar = typeof def?.min === "number" && typeof def?.max === "number" && def.min < 0 && def.max > 0;
  const scaleSvg = isBipolar ? BIPOLAR_SCALE_SVG : UNIPOLAR_SCALE_SVG;
  return `<div class="sk${classes}" ${attr}="${escapeHtml(key)}" role="slider" tabindex="0" aria-label="${escapeHtml(label)}" aria-valuetext="${escapeHtml(fmtVal)}"${title}>
      <div class="sk-dial" style="--n:${n.toFixed(4)}">${scaleSvg}<span class="sk-skirt"></span><span class="sk-cap"></span><span class="sk-rotor"><span class="sk-ind"></span></span><span class="sk-dot"></span></div>
      <div class="sk-label">${escapeHtml(label)}</div>
      <div class="sk-val">${escapeHtml(fmtVal)}</div>
    </div>`;
}

export function renderInstrumentChoice(context: InstrumentControlContext, key: string, options: ChoiceOption[]): string {
  const track = context.kind === "track";
  const midi = context.kind === "standalone" ? context.decoration(key) : null;
  const classes = `${midi?.mapped ? " is-mapped" : ""}${midi?.learning ? " is-learning" : ""}`;
  const title = midi?.mapped ? ` title="${escapeHtml(midi.choiceTitle)}"` : "";
  const attr = track ? "data-st-choice" : "data-param";
  const attrs = track ? `data-st-action="param-choice" data-st-param="${escapeHtml(key)}" data-st-value` : `data-action="synth-set" data-param="${escapeHtml(key)}" data-value`;
  return `<div class="synth-choice${classes}" ${attr}="${escapeHtml(key)}"${title}>` +
    options.map(([value, text, tooltip]) => {
      const active = track ? String(context.patch[key]) === value : context.patch[key] === value;
      // Labels are trusted machine definitions and may contain static HTML entities.
      return `<button type="button" class="synth-choice-btn${active ? " active" : ""}" ${attrs}="${escapeHtml(value)}" title="${escapeHtml(tooltip || value)}">${text}</button>`;
    }).join("") + `<span class="sk-dot"></span></div>`;
}

export function renderInstrumentControl(context: InstrumentControlContext, c: ControlDef): string {
  const track = context.kind === "track";
  const equals = (key: string, value: string) => track ? String(context.patch[key]) === value : context.patch[key] === value;
  if (c.kind === "choice") return renderInstrumentChoice(context, c.key, c.options);
  if (c.kind === "toggles") {
    return `<div class="synth-choice synth-toggles">` + c.items.map((item) => {
      const on = item.on || "on", off = item.off || "off";
      const active = equals(item.key, on);
      const attrs = track ? `data-st-action="param-toggle" data-st-param="${escapeHtml(item.key)}" data-st-on="${escapeHtml(on)}" data-st-off="${escapeHtml(off)}"` : `data-action="synth-toggle" data-param="${escapeHtml(item.key)}" data-on="${escapeHtml(on)}" data-off="${escapeHtml(off)}"`;
      return `<button type="button" class="synth-choice-btn synth-toggle-btn${active ? " active" : ""}" ${attrs} aria-pressed="${active}" title="${escapeHtml(item.title || item.label)}">${track ? escapeHtml(item.label) : item.label}</button>`;
    }).join("") + `</div>`;
  }
  if (c.kind === "select") {
    const attrs = track ? `class="synth-midi-select st-synth-param-select" data-st-param-select="${escapeHtml(c.key)}"` : `class="synth-midi-select synth-param-select" data-param="${escapeHtml(c.key)}"`;
    return `<label class="synth-param-select-wrap"><span>${escapeHtml(c.label)}</span><select ${attrs} aria-label="${escapeHtml(c.label)}">` +
      c.options.map(([v, t]) => `<option value="${escapeHtml(v)}"${equals(c.key, v) ? " selected" : ""}>${escapeHtml(t)}</option>`).join("") + `</select></label>`;
  }
  const isLg = !c.small && c.knobs.some(([key]) => ["cutoff", "res", "oscMix", "volume", "delayMix", "revMix"].includes(key));
  const cls = "sk-row" + (c.small ? " sk-row-small" : isLg ? " sk-row-lg" : "");
  return (c.caption ? `<div class="sk-caption">${escapeHtml(c.caption)}</div>` : "") +
    `<div class="${cls}">${c.knobs.map(([key, label]) => renderInstrumentKnob(context, key, label)).join("")}</div>`;
}
