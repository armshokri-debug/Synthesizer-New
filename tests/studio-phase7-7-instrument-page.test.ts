import { describe, expect, test } from "bun:test";
import { studioEngine } from "../src/studio/studio-engine";
import { STUDIO_MACHINES } from "../src/studio/track-engine";
import { renderStudioHtml, setStudioDockTab, isStudioInstrumentFocusOpen, getStudioDockTab } from "../src/ui/studio-panel";
import { renderInstrumentTabs } from "../src/ui/instrument-frame";

describe("direct instrument page: shared faceplate and independent track context",()=>{
  test("all fifteen machines open without mounting the arrangement or dock, then restore Studio",()=>{
    const g=globalThis as any, oldDocument=g.document, oldWindow=g.window;
    g.document={querySelector:()=>null,getElementById:()=>null};g.window={matchMedia:()=>({matches:false})};
    const track=studioEngine.getFocusedTrack(), original=track.machineId;
    try {
      expect(STUDIO_MACHINES.length).toBe(15);
      for(const machine of STUDIO_MACHINES){
        studioEngine.setTrackMachine(track.id,machine.id);
        setStudioDockTab("instrument");
        const html=renderStudioHtml();
        expect(isStudioInstrumentFocusOpen()).toBe(true);
        expect(html).toContain('class="st-instrument-page"');
        expect(html).toContain(`data-track-id="${track.id}" data-machine="${machine.id}"`);
        expect(html).toContain('id="st-inst-back-btn"');
        expect(html).toContain('class="synth-subbar"');
        expect(html).not.toContain('class="st-arr-wrap"');
        expect(html).not.toContain('id="st-dock-body"');
        setStudioDockTab("mixer");
        expect(isStudioInstrumentFocusOpen()).toBe(false);
        expect(getStudioDockTab()).toBe("mixer");
        expect(renderStudioHtml()).toContain('class="st-arr-wrap"');
      }
    } finally {studioEngine.setTrackMachine(track.id,original);setStudioDockTab("mixer");g.document=oldDocument;g.window=oldWindow;}
  });
  test("shared tabs retain isolated controller namespaces",()=>{
    const pages=[{id:"all",label:"ALL"},{id:"osc",label:"OSC"}];
    expect(renderInstrumentTabs(pages)).toContain('data-action="synth-page" data-page="osc"');
    const track=renderInstrumentTabs(pages,"osc",true);
    expect(track).toContain('aria-selected="true" data-st-action="inst-page" data-st-page="osc"');
    expect(track).not.toContain('data-action="synth-page"');
  });
});
