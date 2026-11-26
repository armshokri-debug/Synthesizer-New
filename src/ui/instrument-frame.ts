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
