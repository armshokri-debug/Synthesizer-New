import { describe, expect, test } from "bun:test";
import { SY1StudioEngine } from "../src/studio/studio-engine";
import { flattenRegions, regionPlayback } from "../src/studio/midi-regions";
import { parseStudioMidi } from "../src/studio/midi-io";
import { prepareSynthRecordingTrack } from "../src/studio/synth-recording";
import { buildMachinePresetPatch } from "../src/studio/track-engine";
import { parseStudioProjectJson } from "../src/studio/project-io";
import { STUDIO_TICKS_PER_BAR, type StudioMidiEvent } from "../src/studio/types";

const bar = STUDIO_TICKS_PER_BAR;
const phrase: StudioMidiEvent[] = [
  { type: "cc", tick: 0, cc: 64, value: 127 },
  { type: "noteOn", tick: 120, midi: 60, velocity: 0.7 },
  { type: "cc", tick: 240, cc: 1, value: 70 },
  { type: "pitchBend", tick: 360, value: 0.25 },
  { type: "noteOff", tick: 720, midi: 60 },
  { type: "cc", tick: 840, cc: 64, value: 0 },
  { type: "noteOn", tick: 1080, midi: 66, velocity: 0.4 },
  { type: "noteOff", tick: 1440, midi: 66 }
];

function setup() {
  let time = 0;
  const engine = new SY1StudioEngine({ isolatedTempo: true, initialBpm: 120, clockNow: () => time });
  const track = engine.getFocusedTrack();
  track.setEvents(phrase);
  const editor = engine.regions;
  const legacy = track.getRegions(engine.getTotalTicks())[0];
  editor.select(legacy.id);
  return { engine, track, editor, legacy, setTime: (value: number) => { time = value; } };
}

describe("Phase 6 MIDI regions", () => {
  test("Legacy v1 events migrate on access and preserve exported MIDI controller ticks and velocities", async () => {
    const { engine, track } = setup();
    const v1 = engine.exportProject();
    delete v1.tracks[0].regions;
    v1.tracks[0].events = phrase;
    await engine.loadProject(v1);
    const region = engine.regions.regions(track.id)[0];
    expect(region.trackId).toBe(track.id);
    expect(region.events).toEqual(phrase);
    expect(engine.getTrack(track.id)?.events).toEqual(phrase);
    const midi = parseStudioMidi(engine.exportMidiBytes());
    expect(JSON.stringify(midi)).toContain('"cc":64');
    expect(JSON.stringify(midi)).toContain('"cc":1');
    expect(JSON.stringify(midi)).toContain('pitchBend');
    engine.dispose();
  });

  test("Snap, trim both edges, restore hidden notes and undo/redo as a single edit per gesture", () => {
    const { engine, track, editor, legacy } = setup();
    editor.move(1935);
    expect(editor.current(track.id)?.startTick).toBe(bar);
    editor.resize(legacy.id, "left", bar + 480);
    editor.resize(legacy.id, "right", bar + 960);
    const trimmed = editor.current(track.id)!;
    expect(trimmed.offset).toBe(480);
    expect(trimmed.length).toBe(480);
    expect(trimmed.events).toEqual(phrase);
    expect(regionPlayback(trimmed).some(e => e.type === "noteOn" && e.tick === 0 && e.midi === 60)).toBe(true);
    expect(regionPlayback(trimmed).some(e => e.type === "cc" && e.tick === 0 && e.cc === 1 && e.value === 70)).toBe(true);
    editor.resize(legacy.id, "right", bar * 2);
    editor.resize(legacy.id, "left", bar);
    expect(track.events).toEqual(phrase.map(e => ({ ...e, tick: e.tick + bar })));
    editor.undo();
    expect(editor.current(track.id)?.offset).toBe(480);
    editor.redo();
    expect(editor.current(track.id)?.offset).toBe(0);
    engine.dispose();
  });

  test("Split crossing notes, rejoin exact source, duplicate, merge, loop and undo/redo", () => {
    const { engine, track, editor, legacy } = setup();
    editor.split(480);
    const slices = editor.selectedRegions();
    expect(slices.length).toBe(2);
    expect(slices[1].offset).toBe(480);
    expect(slices[1].events).toEqual(phrase);
    expect(regionPlayback(slices[1]).some(e => e.type === "noteOn" && e.tick === 0)).toBe(true);
    editor.merge();
    expect(track.events).toEqual(phrase);
    editor.duplicate();
    const duplicated = editor.selectedRegions()[0];
    expect(duplicated.id).not.toBe(legacy.id);
    expect(duplicated.startTick).toBe(bar);
    editor.select(legacy.id, true);
    editor.merge();
    expect(editor.regions(track.id).length).toBe(1);
    expect(track.events.length).toBe(phrase.length * 2);
    const merged = editor.selectedRegions()[0];
    editor.resize(merged.id, "loop", bar * 5);
    expect(editor.selectedRegions()[0].sourceLength).toBe(bar * 2);
    expect(track.getNoteSpans(engine.getTotalTicks()).length).toBe(10);
    editor.repeatToEnd();
    expect(editor.selectedRegions()[0].length).toBe(engine.getTotalTicks());
    editor.undo(); editor.undo(); editor.undo();
    expect(editor.regions(track.id).length).toBe(2);
    editor.redo(); editor.redo(); editor.redo();
    expect(editor.current(track.id)?.loop).toBe(true);
    engine.dispose();
  });

  test("Copy, cut, paste and delete preserve independent MIDI ownership across instruments", () => {
    const { engine, track, editor, legacy } = setup();
    const target = engine.getTracks()[1];
    editor.copy();
    editor.paste(target.id, bar * 2);
    expect(editor.current(target.id)?.trackId).toBe(target.id);
    expect(editor.current(target.id)?.events).toEqual(phrase);
    editor.cut();
    expect(target.events.length).toBe(0);
    editor.undo();
    expect(target.events.length).toBe(phrase.length);
    editor.redo();
    expect(target.events.length).toBe(0);
    engine.setTrackMachinePreset(target.id, "kerman", "init");
    const targetPatch=JSON.stringify(target.patch);
    editor.pasteInPlace(target.id);
    expect(editor.current(target.id)?.events).toEqual(phrase);
    expect(editor.current(target.id)?.id).not.toBe(legacy.id);
    expect(editor.current(target.id)?.startTick).toBe(legacy.startTick);
    expect(target.machineId).toBe("kerman");
    expect(JSON.stringify(target.patch)).toBe(targetPatch);
    expect(track.events).toEqual(phrase);
    editor.undo();expect(target.events.length).toBe(0);
    editor.redo();expect(target.events).toEqual(phrase);
    editor.select(legacy.id);
    editor.remove();
    expect(track.events.length).toBe(0);
    editor.undo();
    expect(track.events).toEqual(phrase);
    engine.dispose();
  });

  test("Paste in place preserves unsnapped timing, trim, loop and independent note edits",()=>{
    const {engine,track,editor,legacy}=setup();
    editor.grid=0;editor.move(137);editor.resize(legacy.id,"left",257);editor.resize(legacy.id,"loop",bar*2);
    const original=editor.current(track.id)!;editor.copy();
    const target=engine.getTracks()[1];engine.setTrackMachine(target.id,"yazd");editor.grid=480;editor.pasteInPlace(target.id);
    const pasted=editor.current(target.id)!;
    expect({...pasted,id:original.id,trackId:original.trackId}).toEqual(original);
    expect(pasted.id).not.toBe(original.id);expect(target.machineId).toBe("yazd");
    editor.editNotes(target.id,[]);expect(editor.regions(track.id)[0]).toEqual(original);
    editor.undo();expect(editor.current(target.id)?.events).toEqual(original.events);engine.dispose();
  });

  test("Piano Roll only edits the chosen source and preserves hidden notes and controllers", () => {
    const { engine, track, editor, legacy } = setup();
    editor.duplicate();
    const duplicate = editor.current(track.id)!;
    editor.resize(duplicate.id, "right", bar + 840);
    const visible = editor.editorNotes(track.id);
    expect(visible.length).toBe(1);
    engine.replaceTrackNotes(track.id, [{ ...visible[0], velocity: 0.5 }]);
    editor.resize(duplicate.id, "right", bar * 2);
    const edited = editor.current(track.id)!;
    expect(edited.events.some(e => e.type === "noteOn" && e.midi === 66 && e.velocity === 0.4)).toBe(true);
    expect(edited.events.some(e => e.type === "noteOn" && e.midi === 60 && e.velocity === 0.5)).toBe(true);
    expect(edited.events.filter(e => e.type === "cc" || e.type === "pitchBend")).toEqual(phrase.filter(e => e.type === "cc" || e.type === "pitchBend"));
    expect(editor.regions(track.id).find(r => r.id === legacy.id)?.events).toEqual(phrase);
    engine.dispose();
  });

  test("Recording with overlapped material keeps the original source, supports overdub and is undoable", async () => {
    const { engine, track, editor, legacy, setTime } = setup();
    editor.resize(legacy.id, "right", bar / 2);
    await engine.record({ midiOnly: true });
    setTime(0.125);
    engine.capturePerformanceMidi(track.id, [0x90, 71, 100], 0.125);
    setTime(0.25);
    engine.capturePerformanceMidi(track.id, [0x80, 71, 0], 0.25);
    await engine.stop();
    expect(editor.regions(track.id).length).toBe(2);
    expect(editor.regions(track.id)[0].events).toEqual(phrase);
    const take = editor.regions(track.id)[1];
    expect(take.events.some(e => e.type === "noteOn" && e.midi === 71)).toBe(true);
    editor.undo();
    expect(editor.regions(track.id).length).toBe(1);
    editor.redo();
    expect(editor.regions(track.id)[1].id).toBe(take.id);
    const parsed = parseStudioProjectJson(engine.exportProjectJson());
    expect(parsed.ok).toBe(true);
    const restored = new SY1StudioEngine({ isolatedTempo: true });
    await restored.loadProject(engine.exportProject());
    expect(restored.regions.regions(track.id)).toEqual(editor.regions(track.id));
    expect(restored.getTrack(track.id)?.events).toEqual(flattenRegions(editor.regions(track.id)));
    engine.dispose(); restored.dispose();
  });

  test("Loop recording keeps actual input ticks on both sides of a lookahead seam", async () => {
    const { engine, track, editor, setTime } = setup();
    engine.setLoopRange(1, 1);
    await engine.record({ midiOnly: true });
    for (let i = 1; i <= 38; i++) { setTime(i / 20); engine.stepScheduler(i / 20); }
    setTime(1.95); engine.stepScheduler(1.95); engine.liveNoteOn(72, 0.68);
    setTime(2.10); engine.liveNoteOff(72);
    setTime(2.2); await engine.stop();
    const notes = track.getNoteSpans(engine.getTotalTicks()).filter(note => note.midi === 72);
    expect(notes.map(note => [note.startTick, note.endTick])).toEqual([[0, 96], [1872, 1920]]);
    expect(notes.every(note => note.velocity === 0.68)).toBe(true);
    expect(editor.regions(track.id)[0].events.some(event => event.type === "noteOn" && event.midi === 66)).toBe(true);
    engine.dispose();
  });

  test("Editing during playback resets lookahead to the current position before dispatching moved notes", async () => {
    const { engine, track, editor, setTime } = setup();
    const dispatched: number[] = [];
    engine.setDispatchObserver(rec => { if (rec.event.type === "noteOn") dispatched.push(rec.event.tick); });
    setTime(0);
    await engine.play();
    editor.move(bar);
    expect(engine.isPlaying()).toBe(true);
    for (let step = 1; step <= 41; step++) { setTime(step / 20); engine.stepScheduler(step / 20); }
    expect(dispatched).toEqual([bar + 120]);
    editor.undo();
    expect(engine.isPlaying()).toBe(true);
    expect(track.events).toEqual(phrase);
    await engine.stop();
    engine.dispose();
  });

  test("Synth recording cannot repurpose a track whose trimmed source contains hidden MIDI", () => {
    const { engine, track, editor, legacy } = setup();
    editor.resize(legacy.id, "left", 1800);
    expect(track.events.length).toBeGreaterThan(0); // Controller state is chased in the silent trim.
    const source = editor.regions(track.id)[0];
    track.setRegions([{ ...source, events: source.events.filter(event => event.type === "noteOn" || event.type === "noteOff") }]);
    expect(track.events.length).toBe(0);
    const preset = buildMachinePresetPatch("tabriz", "init");
    const destination = prepareSynthRecordingTrack(engine, "tabriz", preset.patch, preset.presetId);
    expect(destination.id).not.toBe(track.id);
    expect(track.machineId).toBe("sy1");
    expect(editor.regions(track.id)[0].events.length).toBe(4);
    engine.dispose();
  });

  test("Invalid region ownership, duplicate IDs and excessive loop expansion are rejected before restore", () => {
    const { engine } = setup();
    const project = engine.exportProject();
    const first = project.tracks[0].regions![0];
    project.tracks[0].regions!.push({ ...first });
    expect(parseStudioProjectJson(JSON.stringify(project)).ok).toBe(false);
    project.tracks[0].regions!.pop();
    first.trackId = "not-the-track";
    expect(parseStudioProjectJson(JSON.stringify(project)).ok).toBe(false);
    first.trackId = project.tracks[0].id;
    first.loop = true; first.length = 999_999_999;
    expect(parseStudioProjectJson(JSON.stringify(project)).ok).toBe(false);
    engine.dispose();
  });

  test("Phase 6.1: clearTrackClip uses undoable region history without destroying unrelated edits or selections", async () => {
    const { engine, track, editor, legacy } = setup();
    const track2 = engine.getTracks()[1];

    // Step 1: perform an unrelated edit on Track 2 and keep Track 2's region selected
    editor.copy();
    editor.paste(track2.id, bar);
    const track2Region = editor.regions(track2.id)[0];
    expect(track2Region).toBeDefined();
    expect(editor.selection()).toEqual([track2Region.id]);

    // Step 2: clear Track 1 via clearTrackClip()
    engine.clearTrackClip(track.id);
    expect(editor.regions(track.id).length).toBe(0);
    expect(track.events.length).toBe(0);
    // Unrelated Track 2 regions and selection stay intact
    expect(editor.regions(track2.id).length).toBe(1);
    expect(editor.selection()).toEqual([track2Region.id]);

    // Step 3: calling clearTrackClip() on an already-empty track is a no-op (does not push empty history)
    engine.clearTrackClip(track.id);

    // Step 4: First undo restores Track 1 cleanly
    expect(editor.canUndo()).toBe(true);
    editor.undo();
    expect(editor.regions(track.id).length).toBe(1);
    expect(editor.regions(track.id)[0].id).toBe(legacy.id);
    expect(track.events).toEqual(phrase);
    expect(editor.regions(track2.id).length).toBe(1);

    // Step 5: Second undo still reaches the earlier unrelated Track 2 paste!
    expect(editor.canUndo()).toBe(true);
    editor.undo();
    expect(editor.regions(track2.id).length).toBe(0);
    expect(editor.regions(track.id).length).toBe(1);

    // Step 6: Redo twice replays paste then clearTrackClip
    expect(editor.canRedo()).toBe(true);
    editor.redo();
    expect(editor.regions(track2.id).length).toBe(1);
    editor.redo();
    expect(editor.regions(track.id).length).toBe(0);
    expect(editor.regions(track2.id).length).toBe(1);

    // Step 7: Clearing a populated track while recording is rejected without mutating state
    await engine.record({ midiOnly: true });
    let blocked = false;
    try { engine.clearTrackClip(track2.id); } catch { blocked = true; }
    expect(blocked).toBe(true);
    expect(editor.regions(track2.id).length).toBe(1);
    await engine.stop();
    engine.dispose();
  });

  test("Phase 6.1: deleting or clearing the last remaining region keeps Undo available to restore", () => {
    const { engine, track, editor, legacy } = setup();
    editor.select(legacy.id);
    editor.remove();
    expect(editor.regions(track.id).length).toBe(0);
    expect(editor.canUndo()).toBe(true);
    expect(editor.canRedo()).toBe(false);

    editor.undo();
    expect(editor.regions(track.id).length).toBe(1);
    expect(track.events).toEqual(phrase);
    expect(editor.canRedo()).toBe(true);

    editor.redo();
    expect(editor.regions(track.id).length).toBe(0);
    engine.dispose();
  });
});

