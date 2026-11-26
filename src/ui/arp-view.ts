import { fmtBpm } from "../engine/tempo";
import { ARP_MODE_OPTS, choice, row, toggles, type ControlDef } from "../machines/types";
import type { SynthPatch } from "../engine/params";

/** Identical panel markup in both hosts; all mutations are dispatched by the host. */
export function renderArpPanelHtml(patch: SynthPatch, bpm: number, render: (c: ControlDef) => string, studio = false): string {
  const attr = studio ? 'data-st-action' : 'data-action';
  const down = studio ? 'bpm-down' : 'tempo-down', up = studio ? 'bpm-up' : 'tempo-up', tap = studio ? 'bpm-tap' : 'tempo-tap';
  const modeOptions = studio && patch.arpMode === 'euclid' ? [...ARP_MODE_OPTS, ['euclid','EUC','Euclidean rings'] as [string,string,string]] : ARP_MODE_OPTS;
  return `<div class="arp-pop${studio ? ' st-arp-pop' : ''}" role="dialog" aria-label="Arpeggiator"><div class="arp-pop-inner">
    <div class="arp-pop-head"><h4>ARPEGGIATOR</h4>
      <div class="synth-tempo" role="group" aria-label="Tempo">
        <button type="button" class="synth-midi-btn" ${attr}="${down}" aria-label="Slower">−</button>
        <button type="button" class="synth-tempo-val" ${attr}="${tap}" title="Tempo (BPM). Tap in time to set it.">${fmtBpm(bpm)}</button>
        <button type="button" class="synth-midi-btn" ${attr}="${up}" aria-label="Faster">+</button>
      </div>
      <button type="button" class="synth-midi-btn arp-pop-close" ${studio ? 'data-st-action="close-arp"' : 'data-arp-close'} aria-label="Close">✕</button>
    </div>
    ${render(toggles([{ key:"arpOn",label:"ARP ON",title:"Arpeggiator on/off" },{key:"hold",label:"LATCH",title:"Keep the chord playing after you let go"}]))}
    ${render(choice("arpMode", modeOptions))}
    ${render(row([["arpRate","RATE"],["arpOct","OCT"],["arpGate","GATE"],["arpSwing","SWING"]]))}
  </div></div>`;
}
