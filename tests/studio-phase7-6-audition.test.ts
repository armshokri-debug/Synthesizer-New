import { describe, expect, test } from "bun:test";
import { SY1TrackEngine } from "../src/studio/track-engine";

/** Mock only the private voice allocator/clock; exercise the real track note paths. */
function fixture() {
  const track = new SY1TrackEngine({ id: "test", name: "Test", machineId: "sy1" });
  const internals = track as any;
  const voices: Array<{ midi: number; vel: number; start: number; end: number | null; fast: number | undefined; killed: boolean }> = [];
  internals.ctx = { currentTime: 10 };
  internals.bus = {};
  internals.startVoice = (midi: number, vel: number, start: number) => {
    const entry = { midi, vel, start, end: null as number | null, fast: undefined as number | undefined, killed: false };
    voices.push(entry);
    return {
      freq: 440, isReleased: () => entry.end !== null,
      release: (at: number, fast?: number) => { entry.end = at; entry.fast = fast; },
      kill: () => { entry.killed = true; }, retune: () => {}, update: () => {}
    };
  };
  return { track, voices, internals };
}

describe("editor audition voice ownership", () => {
  test("audition ends on audio clock despite HOLD and CC64", () => {
    const { track, voices, internals } = fixture();
    track.patch.hold = "on";
    internals.sustainPedal = true;
    track.auditionNote(60, 0.25, 160);
    expect(voices.length).toBe(1);
    expect(Math.round((voices[0].end! - voices[0].start) * 1000)).toBe(160);
    expect(voices[0].vel).toBe(0.25);
    expect(track.isNoteSounding(60)).toBe(false);
    expect(internals.sustainPedal).toBe(true);
    expect(track.patch.hold).toBe("on");
  });
  test("previewing the same MIDI pitch cannot release a real held note", () => {
    const { track, voices } = fixture();
    track.noteOn(60, 0.8);
    track.auditionNote(60, 0.4, 220);
    track.auditionNote(60, 0.6, 120);
    expect(voices.length).toBe(3);
    expect(voices[0].end).toBe(null);
    expect(track.isNoteSounding(60)).toBe(true);
    expect(Math.round((voices[1].end! - voices[1].start) * 1000)).toBe(220);
    expect(Math.round((voices[2].end! - voices[2].start) * 1000)).toBe(120);
    track.noteOff(60);
    expect(voices[0].end).toBe(10);
  });
  test("monophonic audition does not touch performance stack and clamps duration", () => {
    const { track, voices, internals } = fixture();
    track.patch.polyMode = "mono";
    track.noteOn(48, 0.8);
    track.auditionNote(67, 1, 100000);
    expect(track.isNoteSounding(48)).toBe(true);
    expect(internals.monoStack.join(",")).toBe("48");
    expect(voices[0].end).toBe(null);
    expect(Math.round((voices[1].end! - voices[1].start) * 1000)).toBe(800);
  });
  test("unattached audio is a no-op", () => {
    const track = new SY1TrackEngine({ id: "test", name: "Test" });
    track.auditionNote(60, 0.8);
    expect(track.isNoteSounding(60)).toBe(false);
  });
});
