import { escapeHtml } from "../engine/params";
import type { SectionDef } from "../machines/types";
/** Canonical instrument faceplate layout. Standalone and Studio supply actions
 * bound to their own engine; this view never selects or changes an engine. */
export interface InstrumentFrame {
  attributes: string;
  top: string;
  subbar: string;
  sections: string;
  sectionClass?: string;
  hint?: string;
  overlay?: string;
}
export function renderInstrumentFrame(frame: InstrumentFrame): string {
  return `<div ${frame.attributes}>
      <div class="synth-top">${frame.top}</div>
      <div class="synth-subbar">${frame.subbar}</div>
      <div class="synth-sections${frame.sectionClass || ""}">${frame.sections}</div>
      ${frame.hint ? `<div class="synth-hint">${frame.hint}</div>` : ""}
      ${frame.overlay || ""}
    </div>`;
}

/** Shared section cards and tabs: only the action namespace differs by engine. */
export function renderInstrumentSection(sec: SectionDef, index: number, body: string, visible?: boolean): string {
  const span = (sec.span && sec.span > 1 ? ` sec-span-${sec.span}` : "") + (sec.wide ? " sec-wide" : "");
  return `<section data-page="${escapeHtml(sec.page)}" data-sec="${index}" class="synth-sec${span}${sec.custom ? " synth-sec-custom" : ""}${visible ? " is-on-page" : ""}"><h4>${escapeHtml(sec.title)}</h4>${body}</section>`;
}
export function renderInstrumentTabs(pages: readonly {id:string;label:string}[], active?: string, track = false): string {
  return `<nav class="synth-tabs${track ? " st-inst-pages" : ""}" role="tablist" aria-label="Panel pages">${pages.map(pg => `<button type="button" class="synth-tab${track ? " st-inst-page-btn" : ""}${active === pg.id ? " active is-active" : ""}" role="tab" ${track ? `aria-selected="${active === pg.id}" data-st-action="inst-page" data-st-page` : `data-action="synth-page" data-page`}="${escapeHtml(pg.id)}">${escapeHtml(pg.label)}</button>`).join("")}</nav>`;
}
export function renderInstrumentPresetLabel(name: string, sub: string): string {
  return `<span class="pd-text"><span class="pd-name">${escapeHtml(name)}</span><span class="pd-sub">${escapeHtml(sub)}</span></span>` +
    `<svg class="pd-icon" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><rect x="4" y="4" width="7" height="7" rx="1.5" /><rect x="13" y="4" width="7" height="7" rx="1.5" /><rect x="4" y="13" width="7" height="7" rx="1.5" /><rect x="13" y="13" width="7" height="7" rx="1.5" /></svg>`;
}

export interface OriginalFaceplate {
  attributes:string; machineName:string; machineOptions?:string; studioButton:string;
  output:string; connections:string; previous:string; presetLabel:string; next:string;
  tempo:string; tabs:string; sections:string; sectionClass?:string; hint?:string; overlay?:string;
}
export function renderOriginalFaceplate(v:OriginalFaceplate):string {
  return renderInstrumentFrame({
    attributes:v.attributes,
    top:`<div class="synth-brand"><span class="synth-brand-maker">SY-1 </span><button type="button" class="synth-machine-select" id="machine-btn" aria-haspopup="dialog" aria-expanded="false" title="Choose an instrument">${escapeHtml(v.machineName)}</button>${v.machineOptions||""}${v.studioButton}</div>
        <canvas class="synth-scope" width="320" height="56" aria-hidden="true"></canvas><div class="synth-out">${v.output}</div>${v.connections}`,
    subbar:`<div class="synth-preset-nav"><button type="button" class="synth-midi-btn preset-step-btn" ${v.previous} aria-label="Previous preset">◀</button><button type="button" class="preset-display synth-preset-select" id="preset-btn" aria-haspopup="dialog" aria-expanded="false" title="Open the sound library">${v.presetLabel}</button><button type="button" class="synth-midi-btn preset-step-btn" ${v.next} aria-label="Next preset">▶</button></div>${v.tempo}${v.tabs}`,
    sections:v.sections,sectionClass:v.sectionClass,hint:v.hint,overlay:v.overlay
  });
}
