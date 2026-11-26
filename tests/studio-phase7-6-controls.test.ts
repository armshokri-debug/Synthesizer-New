import { describe, expect, test } from "bun:test";
import { renderInstrumentControl, renderInstrumentKnob, type InstrumentControlContext } from "../src/ui/instrument-controls";
import { choice, row, toggles } from "../src/machines/types";

const standalone: InstrumentControlContext = {
  kind: "standalone", patch: Object.freeze({ cutoff: 4200, arpOn: "on", filterType: "lowpass" }),
  decoration: () => ({ mapped: true, learning: false, knobTitle: "Mapped knob", choiceTitle: "Mapped choice" })
};
const track: InstrumentControlContext = {
  kind: "track", patch: Object.freeze({ cutoff: 1450, arpOn: "off", filterType: "highpass" })
};

const filterChoices: [string,string][] = [["lowpass", "LP"], ["highpass", "HP"]];

describe("shared instrument rendering: explicit patch and action ownership", () => {
  test("knobs read only their own patch and preserve event namespaces", () => {
    const a = renderInstrumentKnob(standalone, "cutoff", "CUT");
    const b = renderInstrumentKnob(track, "cutoff", "CUT");
    expect(a).toContain('data-param="cutoff"');
    expect(a).toContain('aria-valuetext="4.2k"');
    expect(a).toContain('is-mapped');
    expect(a).not.toContain('data-st-param');
    expect(b).toContain('data-st-param="cutoff"');
    expect(b).toContain('aria-valuetext="1.4k"');
    expect(b).not.toContain('data-param=');
    expect(b).not.toContain('is-mapped');
  });
  test("choices and toggles keep selected state and dispatch namespaces separate", () => {
    const filter = choice("filterType", [["lowpass", "LP"], ["highpass", "HP"]]);
    const latch = toggles([{ key: "arpOn", label: "ARP ON" }]);
    const a = renderInstrumentControl(standalone, filter);
    const b = renderInstrumentControl(track, filter);
    expect(a).toContain('class="synth-choice-btn active" data-action="synth-set" data-param="filterType" data-value="lowpass"');
    expect(b).toContain('class="synth-choice-btn active" data-st-action="param-choice" data-st-param="filterType" data-st-value="highpass"');
    expect(renderInstrumentControl(standalone, latch)).toContain('aria-pressed="true"');
    expect(renderInstrumentControl(track, latch)).toContain('aria-pressed="false"');
  });
  test("shared row and select renderers preserve original layout classes and read-only data", () => {
    const r = row([["cutoff", "CUT"]]);
    expect(renderInstrumentControl(standalone, r)).toContain('class="sk-row sk-row-lg"');
    expect(renderInstrumentControl(track, r)).toContain('class="sk-row sk-row-lg"');
    const select = { kind: "select" as const, key: "filterType", label: "Filter", options: filterChoices };
    expect(renderInstrumentControl(standalone, select)).toContain('value="lowpass" selected');
    expect(renderInstrumentControl(track, select)).toContain('value="highpass" selected');
    expect(renderInstrumentControl(track, select)).toContain('data-st-param-select="filterType"');
    expect(track.patch.cutoff).toBe(1450);
    expect(standalone.patch.cutoff).toBe(4200);
  });
});
