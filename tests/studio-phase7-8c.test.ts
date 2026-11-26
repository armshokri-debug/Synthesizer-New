import { describe, expect, test } from "bun:test";
import { patternFrom } from "../src/engine/drums";
import { STUDIO_TICKS_PER_BAR as BAR } from "../src/studio/types";
import { SY1StudioEngine, type ScheduledDispatchRecord } from "../src/studio/studio-engine";
import { createTrackDrumBank } from "../src/studio/track-drum-patterns";
import { renderStudioInstrumentHtml, setTrackDrumPreviewView } from "../src/ui/studio-instrument";

function setup() {
  let now = 10;
  const engine = new SY1StudioEngine({ isolatedTempo: true, initialBpm: 120, clockNow: () => now });
  const track = engine.getFocusedTrack();
  engine.setTrackMachine(track.id, "kerman");
  const bank = createTrackDrumBank();
  bank.patterns[0] = patternFrom(16, {kick: "x...X"});
  track.setTrackDrumBank(bank);
  track.setParam("drumSwing", 0);
  const dispatch: ScheduledDispatchRecord[] = [];
  engine.setDispatchObserver(hit => dispatch.push(hit));
  function advance(end: number) {
    for (; now + 0.025 < end; engine.stepScheduler(now)) now += 0.025;
    now = end;
    engine.stepScheduler(now);
  }
  return { engine, track, dispatch, advance };
}

describe("Phase 7.8C drum preview and safe MIDI insertion", () => {
  test("preview on an occupied track leaves the arrangement and playhead untouched", () => {
    const {engine, track, dispatch, advance} = setup();
    engine.insertDrumPattern(track.id, 0);
    engine.seekToTick(960);
    const regions = engine.regions.regions(track.id);
    engine.startDrumPreview(track.id);
    advance(12.6);
    expect(dispatch.map(hit => hit.event.tick)).toEqual([0, 480, 1920, 2400]);
    expect(dispatch.every(hit => hit.source === "drum-preview")).toBe(true);
    expect(engine.getCurrentTick()).toBe(960);
    expect(engine.regions.regions(track.id)).toEqual(regions);
    expect(engine.getTransportSnapshot().playing).toBe(false);
    engine.dispose();
  });

  test("tempo changes retain the preview position and move the next unscheduled hit", () => {
    const {engine, track, dispatch, advance} = setup();
    engine.startDrumPreview(track.id);
    advance(10.2);
    engine.setBpm(60);
    advance(11.1);
    expect(dispatch.map(hit => hit.event.tick)).toEqual([0, 480]);
    expect(dispatch[1].audioTime).toBeCloseTo(10.8, 6);
    engine.dispose();
  });

  test("Play stops preview and only the MIDI region dispatches", async () => {
    const {engine, track, dispatch, advance} = setup();
    engine.insertDrumPattern(track.id, 0);
    engine.startDrumPreview(track.id);
    dispatch.length = 0;
    await engine.play();
    advance(10.6);
    expect(engine.isDrumPreviewEnabled(track.id)).toBe(false);
    expect(dispatch.filter(hit => hit.event.type === "noteOn").map(hit => [hit.event.tick, hit.source])).toEqual([[0, undefined], [480, undefined]]);
    let blocked = false;
    try { engine.startDrumPreview(track.id); } catch { blocked = true; }
    expect(blocked).toBe(true);
    engine.dispose();
  });

  test("Record stops preview and cannot capture preview hits", async () => {
    const {engine, track, advance} = setup();
    engine.startDrumPreview(track.id);
    await engine.record({midiOnly: true});
    advance(10.8);
    await engine.stop();
    expect(engine.isDrumPreviewEnabled(track.id)).toBe(false);
    expect(engine.regions.regions(track.id)).toEqual([]);
    engine.dispose();
  });

  test("focus changes and audio interruptions stop the preview", () => {
    const {engine, track, dispatch, advance} = setup();
    engine.startDrumPreview(track.id);
    engine.handleAudioContextStateChange("suspended");
    advance(10.8);
    expect(dispatch.length).toBe(1);
    engine.startDrumPreview(track.id);
    engine.setFocusedTrack(engine.getTracks()[1].id);
    expect(engine.isDrumPreviewEnabled(track.id)).toBe(false);
    engine.dispose();
  });

  test("+ MIDI finds the next snapped gap and preserves occupied and empty regions", () => {
    const {engine, track} = setup();
    engine.regions.create(track.id, BAR);
    const empty = engine.regions.regions(track.id)[0];
    expect(engine.insertDrumPattern(track.id, 0)).toBe(0);
    const previous = engine.regions.regions(track.id);
    expect(engine.insertDrumPattern(track.id, 0)).toBe(BAR * 2);
    expect(engine.regions.regions(track.id).slice(0, 2)).toEqual(previous);
    expect(engine.regions.regions(track.id)[0]).toEqual(empty);
    engine.regions.undo();
    expect(engine.regions.regions(track.id)).toEqual(previous);
    engine.regions.redo();
    expect(engine.regions.regions(track.id).length).toBe(3);
    engine.dispose();
  });

  test("a full arrangement rejects insertion without modifying regions or preview", () => {
    const {engine, track} = setup();
    engine.setBars(1);
    engine.insertDrumPattern(track.id, 0);
    engine.startDrumPreview(track.id);
    const saved = engine.regions.regions(track.id);
    let rejected = false;
    try { engine.insertDrumPattern(track.id, 0); } catch { rejected = true; }
    expect(rejected).toBe(true);
    expect(engine.regions.regions(track.id)).toEqual(saved);
    expect(engine.isDrumPreviewEnabled(track.id)).toBe(true);
    engine.dispose();
  });

  test("insert disarms Live after success and the toolbar keeps both features", () => {
    const {engine, track} = setup();
    engine.setLiveDrumEnabled(track.id, true);
    engine.insertDrumPattern(track.id, 0);
    expect(engine.isLiveDrumEnabled(track.id)).toBe(false);
    setTrackDrumPreviewView(track, true);
    const html = renderStudioInstrumentHtml(track, "steps", true);
    expect(html).toContain('data-st-action="track-drum-preview" aria-pressed="true"');
    expect(html).toContain('data-st-action="track-drum-live"');
    expect(html).toContain('data-st-action="track-drum-insert"');
    engine.dispose();
  });
});
