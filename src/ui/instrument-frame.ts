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
