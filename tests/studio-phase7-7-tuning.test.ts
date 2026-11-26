import { describe, expect, test } from "bun:test";
import { SY1TrackEngine } from "../src/studio/track-engine";
import { SY1StudioEngine } from "../src/studio/studio-engine";
import { STUDIO_TUNING_KEY, normalizeStudioTuning } from "../src/studio/track-tuning";
import { getCustomTuning, setCustomTuning } from "../src/engine/params";
import { parseStudioProjectJson } from "../src/studio/project-io";
import { renderOrientalPanelHtml } from "../src/ui/oriental-view";
const offsets = (v: number) => Array.from({length: 12}, (_, i) => i === 2 ? v : 0);
const track = (id: string) => new SY1TrackEngine({id, name: id, machineId: "sy1"});
describe("7.7B — independent Oriental tuning", () => {
  test("same-machine custom tunings are independent from one another and standalone", () => {
    const before = getCustomTuning("sy1").slice();
    const a = track("a"), b = track("b");
    a.setTrackCustomTuning(offsets(-50)); b.setTrackCustomTuning(offsets(35));
    a.setParam("oriental", "on"); b.setParam("oriental", "on");
    expect(a.centsFor(62)).toBe(-50); expect(b.centsFor(62)).toBe(35);
    expect(a.freqFor(62)).toBeCloseTo(440 * Math.pow(2, (62-69)/12-50/1200), 8);
    expect(getCustomTuning("sy1")).toEqual(before);
    const copy = a.getTrackCustomTuning(); copy[2] = 99;
    expect(a.centsFor(62)).toBe(-50);
    a.setParam("tuneRoot", 2); expect(a.centsFor(64)).toBe(-50); expect(b.centsFor(64)).toBe(0);
    a.dispose(); b.dispose();
  });
  test("legacy custom tuning is copied on load rather than bound to standalone cache", () => {
    const before = getCustomTuning("sy1").slice();
    const a = track("a");
    try {
      setCustomTuning("sy1", offsets(-40));
      const p: typeof a.patch = {...a.patch, tuning: "custom", oriental: "on", tuneRoot: 0};
      delete p[STUDIO_TUNING_KEY];
      a.loadPatchSnapshot(p, "custom", "Custom", "sy1");
      setCustomTuning("sy1", offsets(20));
      expect(a.centsFor(62)).toBe(-40);
    } finally { setCustomTuning("sy1", before); a.dispose(); }
  });
  test("preset scale and custom tuning can be switched without losing the track custom value", () => {
    const a = track("a"); a.setParam("oriental", "on"); a.setTrackCustomTuning(offsets(-48));
    a.setParam("tuning", "shur"); a.setParam("microTone", "practice");
    expect(a.centsFor(62)).toBe(-35);
    a.setParam("tuning", "custom"); expect(a.centsFor(62)).toBe(-48);
    a.setParam("oriental", "off"); expect(a.centsFor(62)).toBe(0); a.dispose();
  });
  test("project round trip persists separate custom tuning and rejects malformed offsets", async () => {
    const e = new SY1StudioEngine({isolatedTempo:true});
    const a = e.getTracks()[0], b = e.getTracks()[1];
    a.setTrackCustomTuning(offsets(-50)); b.setTrackCustomTuning(offsets(25));
    a.setParam("oriental", "on"); b.setParam("oriental", "on");
    const parsed = parseStudioProjectJson(e.exportProjectJson()); expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error("project invalid");
    const restored = new SY1StudioEngine({isolatedTempo:true});
    await restored.loadProject(parsed.project);
    expect(restored.getTracks()[0].centsFor(62)).toBe(-50);
    expect(restored.getTracks()[1].centsFor(62)).toBe(25);
    const bad = JSON.parse(e.exportProjectJson()); bad.tracks[0].patch[STUDIO_TUNING_KEY] = [1, "bad"];
    const invalid = parseStudioProjectJson(JSON.stringify(bad)); expect(invalid.ok).toBe(true);
    if (invalid.ok) expect(invalid.project.tracks[0].patch[STUDIO_TUNING_KEY]).toBe(undefined);
    e.dispose(); restored.dispose();
  });
  test("normalization rejects invalid values, clamps and copies valid offsets", () => {
    expect(normalizeStudioTuning([NaN])).toBe(undefined);
    expect(normalizeStudioTuning(Array(12).fill(Infinity))).toBe(undefined);
    expect(normalizeStudioTuning(Array(12).fill("12"))).toBe(undefined);
    expect(normalizeStudioTuning(offsets(-105))?.[2]).toBe(-100);
    const d = new SY1TrackEngine({id:"d", name:"drum",machineId:"bushehr"});
    expect(d.setTrackCustomTuning(offsets(20))).toBe(false); d.dispose();
  });
  test("shared panel retains original markup and uses independent custom data and import IDs", () => {
    const patch = {tuning:"custom", oriental:"on", tuneRoot:0};
    const a = renderOrientalPanelHtml(patch, offsets(-50));
    const b = renderOrientalPanelHtml(patch, offsets(35), "<test>", false, true);
    expect(a).toContain('class="arp-pop oriental-pop"');
    expect(a).toContain('id="scl-file-input"');
    expect(a).toContain('value="-50"');
    expect(b).toContain('id="st-scl-file-input"');
    expect(b).toContain('value="35"');
    expect(b).toContain('&lt;test&gt;');
    expect(b).not.toContain('id="scl-file-input"');
  });
});
