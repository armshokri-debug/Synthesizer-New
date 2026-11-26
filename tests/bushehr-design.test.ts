import { describe, expect, test } from "bun:test";
import { DRUM_VOICES, patternFrom } from "../src/engine/drums";
import { renderBushehrMatrix, renderBushehrPads } from "../src/ui/drum-steps-view";

describe("Bushehr web matrix",()=>{
  test("renders every voice and step, with isolated standalone and Studio actions",()=>{
    for(const len of [12,16]){
      const p=patternFrom(len,{kick:"X2f?",tom:"..g."});
      const before=JSON.stringify(p);
      for(const track of [false,true]){
        const html=renderBushehrMatrix(p,"kick",v=>v,track);
        expect((html.match(/data-grid-voice=/g)||[]).length).toBe(8*len);
        for(const v of DRUM_VOICES)expect((html.match(new RegExp('data-grid-voice="'+v+'"','g'))||[]).length).toBe(len);
        expect(html).toContain('data-mark="×2"');
        expect(html).toContain(track?'data-st-action="track-drum-step"':'data-action="drum-step"');
        expect(html).not.toContain(track?'data-action="drum-step"':'data-st-action="track-drum-step"');
      }
      expect(JSON.stringify(p)).toBe(before);
    }
  });
  test("pads have eight existing audition actions and selected voice",()=>{
    for(const track of [false,true]){
      const html=renderBushehrPads("tom",v=>v,track);
      expect((html.match(/<button /g)||[]).length).toBe(8);
      expect(html).toContain(track?'data-st-action="drum-audition"':'data-action="drum-voice"');
      expect(html).toContain('aria-pressed="true">');
      expect((html.match(/aria-pressed="true"/g)||[]).length).toBe(1);
    }
  });
});
