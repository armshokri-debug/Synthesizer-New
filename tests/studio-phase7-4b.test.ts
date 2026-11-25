import { describe, expect, it } from "bun:test";
import { previewMoveRegions, previewResizeRegion } from "../src/studio/region-editor";
import { SY1StudioEngine } from "../src/studio/studio-engine";
import {
  STUDIO_PPQ,
  STUDIO_QUANTIZE_OPTIONS,
  STUDIO_REGION_SNAP_OPTIONS,
  STUDIO_SNAP_OPTIONS,
  STUDIO_TICKS_PER_BAR,
  type StudioMidiEvent,
  type StudioNoteSpan
} from "../src/studio/types";
import {
  applyNumericVelocity,
  applyRelativeVelocityDelta,
  boundedNoteMove,
  remapEditedSelection,
  computeQuantizedSelectionRemap,
  findNotesInMarquee,
  getPianoRollState,
  midiToVelocity,
  setPianoRollQuantize,
  setPianoRollSnap,
  velocityToMidi
} from "../src/ui/studio-piano-roll";

describe("Phase 7.4B — Region Snap, Independent Quantize, Marquee Selection & Velocity Range", () => {
  it("supports Off, Bar, 1/4, 1/8, 1/16, 1/32 region snap independently from Piano Roll Snap", () => {
    expect(STUDIO_REGION_SNAP_OPTIONS.map((o) => [o.label, o.ticks])).toEqual([
      ["Off", 0],
      ["Bar", STUDIO_TICKS_PER_BAR],
      ["1/4", STUDIO_PPQ],
      ["1/8", STUDIO_PPQ / 2],
      ["1/16", STUDIO_PPQ / 4],
      ["1/32", STUDIO_PPQ / 8]
    ]);

    const engine = new SY1StudioEngine();
    const track = engine.getTracks()[0];
    // Create a region starting at bar 1 (0) with off-grid internal note timing (ticks 73..291)
    engine.replaceTrackNotes(track.id, [
      { midi: 60, startTick: 73, endTick: 291, velocity: midiToVelocity(82) },
      { midi: 64, startTick: 511, endTick: 740, velocity: midiToVelocity(104) }
    ]);
    const r1 = engine.regions.regions(track.id)[0];
    expect(r1).toBeTruthy();

    // Set arrangement snap to Bar (1920) while Piano Roll snap stays 1/16 (120) and Quantize is 1/8T (160)
    engine.regions.grid = STUDIO_TICKS_PER_BAR;
    setPianoRollSnap(120);
    setPianoRollQuantize(160);
    expect(engine.regions.grid).toBe(1920);
    expect(getPianoRollState().snapTicks).toBe(120);
    expect(getPianoRollState().quantizeTicks).toBe(160);

    // Move near bar 2 -> live preview & committed move snap to exact bar 1920 while internal timing stays 73 / 511
    engine.regions.select(r1.id);
    const preview = previewMoveRegions([r1], 1650, engine.regions.grid, engine.getTotalTicks());
    expect(preview).toEqual({ shift: 1920, guideTick: 1920 });
    engine.regions.move(1650);
    const moved = engine.regions.regions(track.id)[0];
    expect(moved.startTick).toBe(1920);
    expect(moved.events.filter((e) => e.type === "noteOn").map((e) => e.tick)).toEqual([73, 511]);

    // Resize right edge with 1/4 snap -> guideTick & length snap cleanly to 480-tick boundary
    engine.regions.grid = STUDIO_PPQ;
    const resizePrev = previewResizeRegion(moved, "right", moved.startTick + 1500, engine.regions.grid, engine.getTotalTicks());
    expect(resizePrev.length).toBe(1440);
    expect(resizePrev.guideTick).toBe(moved.startTick + 1440);
    engine.regions.resize(moved.id, "right", moved.startTick + 1500);
    expect(engine.regions.regions(track.id)[0].length).toBe(1440);

    // Copy & multi-region relative paste with Bar snap preserves internal region spacing
    engine.regions.create(track.id, 3840);
    const created = engine.regions.regions(track.id).find((r) => r.startTick === 3840)!;
    engine.regions.select(moved.id, false);
    engine.regions.select(created.id, true);
    engine.regions.copy();
    engine.regions.grid = STUDIO_TICKS_PER_BAR;
    engine.regions.paste(track.id, 6100); // snaps anchor to bar 4 (5760), spacing = 3840 - 1920 = 1920 -> 5760 & 7680
    const afterPaste = engine.regions.regions(track.id).map((r) => r.startTick).sort((a, b) => a - b);
    expect(afterPaste).toEqual([1920, 3840, 5760, 7680]);

    // Snap Off moves freely to exact tick
    engine.regions.grid = 0;
    const freeRegion = engine.regions.regions(track.id).find((r) => r.startTick === 7680)!;
    engine.regions.select(freeRegion.id);
    engine.regions.move(-37);
    expect(engine.regions.regions(track.id).some((r) => r.startTick === 7643)).toBe(true);
    engine.dispose();
  });

  it("quantizes independently with triplets, selected vs all, edge clamping, controller preservation, and Undo/Redo", () => {
    expect(STUDIO_QUANTIZE_OPTIONS.map((o) => [o.label, o.ticks])).toEqual([
      ["1/4", 480],
      ["1/4T", 320],
      ["1/8", 240],
      ["1/8T", 160],
      ["1/16", 120],
      ["1/16T", 80],
      ["1/32", 60],
      ["1/32T", 40]
    ]);
    // Piano Roll Snap remains independent from Quantize subdivisions
    expect(STUDIO_SNAP_OPTIONS.map((o) => o.label)).toEqual(["Off", "1/4", "1/8", "1/16", "1/32"]);

    const engine = new SY1StudioEngine();
    const track = engine.getTracks()[0];
    const events: StudioMidiEvent[] = [
      { type: "cc", tick: 15, cc: 64, value: 127 },
      { type: "pitchBend", tick: 90, value: -0.25 },
      { type: "noteOn", tick: 151, midi: 60, velocity: midiToVelocity(37) },
      { type: "noteOff", tick: 271, midi: 60 }, // dur 120
      { type: "noteOn", tick: 333, midi: 64, velocity: midiToVelocity(119) },
      { type: "noteOff", tick: 453, midi: 64 }, // dur 120
      { type: "noteOn", tick: 1910, midi: 67, velocity: midiToVelocity(92) },
      { type: "noteOff", tick: 1920, midi: 67 } // near 1-bar end edge
    ];
    track.setEvents(events);
    const r = engine.regions.regions(track.id)[0];
    engine.regions.select(r.id);

    // Quantize ONLY note 0 to 1/8T (160 ticks); note 1 and note 2 remain untouched
    const prevSpans = engine.regions.editorNotes(track.id);
    const changedSel = engine.quantizeTrackNotes(track.id, 160, [0]);
    expect(changedSel).toBe(1);
    const afterSel = engine.regions.editorNotes(track.id);
    expect(afterSel[0].startTick).toBe(160);
    expect(afterSel[0].endTick).toBe(280); // duration 120 preserved
    expect(velocityToMidi(afterSel[0].velocity)).toBe(37);
    expect(afterSel[1].startTick).toBe(333);
    expect(afterSel[2].startTick).toBe(1910);

    // Remap keeps selected index on quantized note
    const remapped = computeQuantizedSelectionRemap(prevSpans, new Set([0]), afterSel, 160, 1920);
    expect([...remapped]).toEqual([0]);

    // Explicitly quantize ALL notes to 1/8T (160 ticks); note at 1910 clamps to grid tick 1760 (11 * 160), not 1919
    const changedAll = engine.quantizeTrackNotes(track.id, 160);
    expect(changedAll).toBe(2);
    const afterAll = engine.regions.editorNotes(track.id);
    expect(afterAll.map((n) => n.startTick)).toEqual([160, 320, 1760]);
    expect(afterAll.map((n) => n.endTick - n.startTick)).toEqual([120, 120, 10]);
    expect(afterAll.map((n) => velocityToMidi(n.velocity))).toEqual([37, 119, 92]);

    // Controllers untouched
    const currentEvents = engine.regions.regions(track.id)[0].events;
    expect(currentEvents.filter((e) => e.type === "cc")).toEqual([{ type: "cc", tick: 15, cc: 64, value: 127 }]);
    expect(currentEvents.filter((e) => e.type === "pitchBend")).toEqual([{ type: "pitchBend", tick: 90, value: -0.25 }]);

    // Undo / Redo works cleanly
    engine.regions.undo();
    expect(engine.regions.editorNotes(track.id).map((n) => n.startTick)).toEqual([160, 333, 1910]);
    engine.regions.undo();
    expect(engine.regions.editorNotes(track.id).map((n) => n.startTick)).toEqual([151, 333, 1910]);
    engine.regions.redo();
    engine.regions.redo();
    expect(engine.regions.editorNotes(track.id).map((n) => n.startTick)).toEqual([160, 320, 1760]);
    engine.dispose();
  });

  it("computes rectangular marquee hit-testing and contextual relative velocity slider edits", () => {
    const spans: StudioNoteSpan[] = [
      { midi: 60, startTick: 0, endTick: 240, velocity: midiToVelocity(30) },
      { midi: 64, startTick: 480, endTick: 720, velocity: midiToVelocity(70) },
      { midi: 72, startTick: 960, endTick: 1200, velocity: midiToVelocity(110) }
    ];
    const midiToRow = new Map<number, number>([
      [72, 0],
      [64, 4],
      [60, 8]
    ]);
    // GridWidth 640 across 1920 ticks, rowHeight 20 -> note 0: x 0..80 y 162..178; note 1: x 160..240 y 82..98; note 2: x 320..400 y 2..18
    const hits = findNotesInMarquee(spans, midiToRow, 1920, 640, 20, {
      left: 10,
      top: 70,
      right: 200,
      bottom: 175
    });
    expect([...hits]).toEqual([0, 1]);

    // Contextual relative velocity slider shift preserves exact spread across boundary clamps
    const origMidis = new Map<number, number>([
      [0, 30],
      [1, 70]
    ]);
    const shifted = applyRelativeVelocityDelta(spans, hits, origMidis, 25);
    expect(shifted.map((s) => velocityToMidi(s.velocity))).toEqual([55, 95, 110]);
    const numeric = applyNumericVelocity(spans, hits, 90);
    expect(numeric.map((s) => velocityToMidi(s.velocity))).toEqual([70, 110, 110]);
  });
  it("moves notes freely with snap Off and clamps the entire group without changing lengths or intervals", () => {
    const spans: StudioNoteSpan[] = [
      { midi: 60, startTick: 101, endTick: 143, velocity: 0.5 },
      { midi: 64, startTick: 281, endTick: 370, velocity: 0.8 },
      { midi: 67, startTick: 395, endTick: 430, velocity: 0.9 }
    ];
    const rows = new Map([[0, 5], [1, 2]]);
    expect(boundedNoteMove(spans, [0, 1], 0, rows, 12, 17, 0, 0, 480)).toEqual({ tickShift: 17, rowShift: 0 });
    expect(boundedNoteMove(spans, [0, 1], 0, rows, 12, 500, -8, 0, 480)).toEqual({ tickShift: 110, rowShift: -2 });
    expect(boundedNoteMove(spans, [0, 1], 1, rows, 12, -500, 20, 0, 480)).toEqual({ tickShift: -101, rowShift: 6 });
    const edited = spans.map((n, i) => i < 2 ? { ...n, startTick: n.startTick + 110, endTick: n.endTick + 110 } : n);
    const actual = [...edited].sort((a, b) => b.startTick - a.startTick);
    expect([...remapEditedSelection(edited, new Set([0, 1]), actual)]).toEqual([2, 1]);
    expect(edited[0].endTick - edited[0].startTick).toBe(42);
    expect(edited[1].endTick - edited[1].startTick).toBe(89);
  });

});
