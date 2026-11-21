import { describe, expect, test } from "bun:test";
import { RECORDER_MAX_SECONDS } from "../src/engine/daw";
import { SY1 } from "../src/machines/sy1";
import {
  parseStudioProjectJson,
  projectFilename,
  serializeStudioProject,
  STUDIO_MAX_IMPORT_BYTES,
  summarizeProjectMeta,
  validateStudioProject
} from "../src/studio/project-io";
import { classifyStorageError, createStudioStorage } from "../src/studio/storage";
import {
  createStudioEngine,
  getLiveRecordingRamBudgetBytes,
  ScheduledDispatchRecord,
  STUDIO_LIVE_BYTES_PER_FRAME,
  STUDIO_LIVE_RAM_BUDGET_DESKTOP,
  STUDIO_LIVE_RAM_BUDGET_MOBILE
} from "../src/studio/studio-engine";
import { STUDIO_PPQ, STUDIO_PROJECT_FORMAT, STUDIO_PROJECT_VERSION, StudioMidiEvent, StudioProjectData } from "../src/studio/types";

// ---------------------------------------------------------------------------
// Minimal deterministic in-memory IDBFactory mock for storage & error testing
// ---------------------------------------------------------------------------
function makeMockIndexedDB(opts: {
  failOpenWith?: Error;
  failWriteWith?: Error;
  corruptRawRead?: Record<string, unknown>;
} = {}): IDBFactory {
  const stores = new Map<string, Map<string, unknown>>();

  const fireAsync = (fn: () => void) => {
    Promise.resolve().then(fn);
  };

  const makeDb = (): IDBDatabase => {
    const db: any = {
      objectStoreNames: {
        contains: (name: string) => stores.has(name)
      },
      createObjectStore: (name: string) => {
        if (!stores.has(name)) stores.set(name, new Map());
        return {};
      },
      close: () => {},
      onversionchange: null,
      transaction: (storeName: string, mode: IDBTransactionMode) => {
        const tx: any = {
          error: null,
          oncomplete: null,
          onabort: null,
          onerror: null,
          objectStore: (name: string) => {
            if (!stores.has(name)) stores.set(name, new Map());
            const map = stores.get(name)!;
            const makeReq = (runner: () => { value?: unknown; error?: Error }) => {
              const req: any = { result: undefined, error: null, onsuccess: null, onerror: null };
              fireAsync(() => {
                const res = runner();
                if (res.error) {
                  req.error = res.error;
                  tx.error = res.error;
                  req.onerror?.();
                  tx.onerror?.();
                } else {
                  req.result = res.value;
                  req.onsuccess?.();
                  tx.oncomplete?.();
                }
              });
              return req;
            };
            return {
              put: (val: any) =>
                makeReq(() => {
                  if (mode === "readwrite" && opts.failWriteWith) {
                    return { error: opts.failWriteWith };
                  }
                  const key = val.id ?? val.slot;
                  map.set(String(key), JSON.parse(JSON.stringify(val)));
                  return { value: key };
                }),
              get: (key: string) =>
                makeReq(() => {
                  if (opts.corruptRawRead && key in opts.corruptRawRead) {
                    return { value: opts.corruptRawRead[key] };
                  }
                  return { value: map.get(String(key)) };
                }),
              getAll: () =>
                makeReq(() => ({
                  value: Array.from(map.values())
                })),
              delete: (key: string) =>
                makeReq(() => {
                  map.delete(String(key));
                  return { value: undefined };
                })
            };
          }
        };
        return tx;
      }
    };
    return db as IDBDatabase;
  };

  return {
    open: () => {
      const req: any = {
        result: null,
        error: null,
        onupgradeneeded: null,
        onsuccess: null,
        onerror: null,
        onblocked: null
      };
      fireAsync(() => {
        if (opts.failOpenWith) {
          req.error = opts.failOpenWith;
          req.onerror?.();
          return;
        }
        const db = makeDb();
        req.result = db;
        req.onupgradeneeded?.();
        req.onsuccess?.();
      });
      return req;
    }
  } as unknown as IDBFactory;
}

describe("Phase 2 — Project Serialization, Export/Import & Full State Restoration", () => {
  test("Round-trips all tracks, presets, custom patch params, mixer states, timeline, loop & MIDI events", async () => {
    const src = createStudioEngine({ isolatedTempo: true, initialBpm: 128 });
    src.setProjectName("Tehran Night Session");
    src.setBars(16);
    src.setLoopEnabled(true);
    src.setLoopRange(3, 12);

    const t3 = src.addTrack("superSaw");
    const t4 = src.addTrack("pluck");
    expect(t3).not.toBeNull();
    expect(t4).not.toBeNull();

    const tracks = src.getTracks();
    expect(tracks.length).toBe(4);

    // Track 1: custom patch + MIDI + mixer
    tracks[0].applyPreset("acidBass");
    tracks[0].setParam("cutoff", 520);
    tracks[0].setParam("res", 11.5);
    tracks[0].setParam("osc1Wave", "square");
    tracks[0].setParam("hold", "on"); // must sanitize back to "off" on restore
    src.setTrackVolume(tracks[0].id, 0.72);
    src.setTrackPan(tracks[0].id, -0.45);
    src.setTrackMute(tracks[0].id, false);
    src.setTrackSolo(tracks[0].id, true);
    src.setTrackArmed(tracks[0].id, true);
    src.setTrackMidiChannel(tracks[0].id, 2);
    const t1Events: StudioMidiEvent[] = [
      { type: "noteOn", tick: 0, midi: 36, velocity: 0.92 },
      { type: "cc", tick: 120, cc: 1, value: 84 },
      { type: "pitchBend", tick: 240, value: 0.35 },
      { type: "cc", tick: 360, cc: 64, value: 127 },
      { type: "noteOff", tick: 480, midi: 36 },
      { type: "cc", tick: 520, cc: 64, value: 0 }
    ];
    tracks[0].setEvents(t1Events);

    // Track 2: muted pad
    tracks[1].applyPreset("warmPad");
    tracks[1].setParam("cutoff", 2850);
    tracks[1].setParam("revMix", 0.55);
    src.setTrackVolume(tracks[1].id, 0.61);
    src.setTrackPan(tracks[1].id, 0.3);
    src.setTrackMute(tracks[1].id, true);
    src.setTrackArmed(tracks[1].id, false);
    tracks[1].setEvents([
      { type: "noteOn", tick: 960, midi: 60, velocity: 0.75 },
      { type: "noteOff", tick: 1920, midi: 60 }
    ]);

    // Track 3 & 4
    tracks[2].setParam("osc2Detune", 18);
    src.setTrackPan(tracks[2].id, -0.8);
    tracks[3].setParam("delayMix", 0.42);
    src.setFocusedTrack(tracks[2].id);

    const exportedProject = src.exportProject();
    expect(exportedProject.format).toBe(STUDIO_PROJECT_FORMAT);
    expect(exportedProject.version).toBe(STUDIO_PROJECT_VERSION);
    expect(projectFilename(exportedProject)).toBe("tehran-night-session.sy1studio");

    const meta = summarizeProjectMeta(exportedProject);
    expect(meta.trackCount).toBe(4);
    expect(meta.noteCount).toBe(2);
    expect(meta.bpm).toBe(128);
    expect(meta.bars).toBe(16);

    const json = src.exportProjectJson();
    const parsed = parseStudioProjectJson(json);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    // Restore into a fresh engine with completely different defaults
    const dst = createStudioEngine({ isolatedTempo: true, initialBpm: 88 });
    const res = await dst.loadProject(parsed.project);
    expect(res.format).toBe(STUDIO_PROJECT_FORMAT);
    expect(res.name).toBe("Tehran Night Session");

    const snap = dst.getTransportSnapshot();
    expect(snap.projectName).toBe("Tehran Night Session");
    expect(snap.projectId).toBe(src.getProjectId());
    expect(snap.bpm).toBe(128);
    expect(snap.bars).toBe(16);
    expect(snap.loopEnabled).toBe(true);
    expect(snap.loopStartBar).toBe(3);
    expect(snap.loopEndBar).toBe(12);
    expect(snap.focusedTrackId).toBe(tracks[2].id);

    const restoredTracks = dst.getTracks();
    expect(restoredTracks.length).toBe(4);

    // Track 1 exact check (edited acidBass -> custom presetId with exact custom params)
    expect(restoredTracks[0].presetId).toBe("custom");
    expect(restoredTracks[0].patch.cutoff).toBe(520);
    expect(restoredTracks[0].patch.res).toBe(11.5);
    expect(restoredTracks[0].patch.osc1Wave).toBe("square");
    expect(restoredTracks[0].patch.hold).toBe("off"); // never latch keyboard hold on load
    expect(restoredTracks[0].volume).toBeCloseTo(0.72, 4);
    expect(restoredTracks[0].pan).toBeCloseTo(-0.45, 4);
    expect(restoredTracks[0].mute).toBe(false);
    expect(restoredTracks[0].solo).toBe(true);
    expect(restoredTracks[0].armed).toBe(true);
    expect(restoredTracks[0].midiChannel).toBe(2);
    expect(restoredTracks[0].events).toEqual(t1Events);

    // Track 2 exact check (edited warmPad -> custom presetId with exact cutoff & revMix)
    expect(restoredTracks[1].presetId).toBe("custom");
    expect(restoredTracks[1].patch.cutoff).toBe(2850);
    expect(restoredTracks[1].patch.revMix).toBeCloseTo(0.55, 4);
    expect(restoredTracks[1].mute).toBe(true);
    expect(restoredTracks[1].armed).toBe(false);
    expect(restoredTracks[1].getNoteCount()).toBe(1);

    // Track 3 & 4 exact check
    expect(restoredTracks[2].patch.osc2Detune).toBe(18);
    expect(restoredTracks[2].pan).toBeCloseTo(-0.8, 4);
    expect(restoredTracks[3].patch.delayMix).toBeCloseTo(0.42, 4);

    // Verify re-serializing restored project matches structurally (modulo savedAt)
    const reExport = dst.exportProject();
    expect(reExport.tracks).toEqual(parsed.project.tracks);

    src.dispose();
    dst.dispose();
  });

  test("Post-restore MIDI timing accuracy across 60, 110, and 140 BPM", async () => {
    for (const bpm of [60, 110, 140]) {
      const src = createStudioEngine({ isolatedTempo: true, initialBpm: bpm });
      src.setBars(4);
      src.setLoopEnabled(false);
      const [t1, t2] = src.getTracks();
      t1.setEvents([
        { type: "noteOn", tick: 0, midi: 60, velocity: 0.8 },
        { type: "noteOff", tick: STUDIO_PPQ, midi: 60 },
        { type: "noteOn", tick: STUDIO_PPQ * 2, midi: 64, velocity: 0.8 },
        { type: "noteOff", tick: STUDIO_PPQ * 3, midi: 64 }
      ]);
      t2.setEvents([
        { type: "noteOn", tick: STUDIO_PPQ, midi: 48, velocity: 0.9 },
        { type: "noteOff", tick: STUDIO_PPQ * 2, midi: 48 }
      ]);

      const json = src.exportProjectJson();
      src.dispose();

      // Restore into a new engine and drive deterministic scheduler clock
      let clockSec = 10.0;
      const dst = createStudioEngine({
        isolatedTempo: true,
        initialBpm: 95,
        clockNow: () => clockSec
      });
      const loaded = await dst.loadProject(JSON.parse(json));
      expect(loaded.bpm).toBe(bpm);
      expect(dst.getBpm()).toBe(bpm);

      const dispatched: ScheduledDispatchRecord[] = [];
      dst.setDispatchObserver((r) => dispatched.push(r));

      await dst.play();
      const beatSec = 60 / bpm;

      for (let t = 0; t <= beatSec * 6; t += 0.025) {
        clockSec = 10.0 + t;
        dst.stepScheduler(clockSec);
      }
      await dst.stop();

      const t1On0 = dispatched.find((d) => d.trackId === "track-1" && d.event.type === "noteOn" && d.event.midi === 60);
      const t2On1 = dispatched.find((d) => d.trackId === "track-2" && d.event.type === "noteOn" && d.event.midi === 48);
      const t1On2 = dispatched.find((d) => d.trackId === "track-1" && d.event.type === "noteOn" && d.event.midi === 64);
      expect(t1On0).toBeDefined();
      expect(t2On1).toBeDefined();
      expect(t1On2).toBeDefined();
      expect(Math.abs(t2On1!.audioTime - t1On0!.audioTime - beatSec)).toBeLessThan(1e-6);
      expect(Math.abs(t1On2!.audioTime - t1On0!.audioTime - beatSec * 2)).toBeLessThan(1e-6);

      dst.dispose();
    }
  });
});

describe("Phase 2 — Invalid & Corrupted .sy1studio Import Handling", () => {
  function makeValidBase(): StudioProjectData {
    const eng = createStudioEngine({ isolatedTempo: true, initialBpm: 118 });
    const data = eng.exportProject();
    eng.dispose();
    return data;
  }

  test("Rejects malformed JSON, wrong format, future version, invalid tracks/events, and oversized payloads", () => {
    expect(parseStudioProjectJson("").ok).toBe(false);
    expect(parseStudioProjectJson("   ").ok).toBe(false);
    expect(parseStudioProjectJson("{not valid json").ok).toBe(false);
    expect(parseStudioProjectJson("[]").ok).toBe(false);

    const base = makeValidBase();

    // Wrong format
    expect(validateStudioProject({ ...base, format: "other-daw" }).ok).toBe(false);
    // Future version
    expect(validateStudioProject({ ...base, version: STUDIO_PROJECT_VERSION + 1 }).ok).toBe(false);
    // Invalid version 0
    expect(validateStudioProject({ ...base, version: 0 }).ok).toBe(false);
    // BPM out of bounds
    expect(validateStudioProject({ ...base, bpm: 10 }).ok).toBe(false);
    expect(validateStudioProject({ ...base, bpm: 999 }).ok).toBe(false);
    // Bars out of bounds
    expect(validateStudioProject({ ...base, bars: 0 }).ok).toBe(false);
    expect(validateStudioProject({ ...base, bars: 9999 }).ok).toBe(false);
    // 0 tracks or 5 tracks
    expect(validateStudioProject({ ...base, tracks: [] }).ok).toBe(false);
    expect(
      validateStudioProject({
        ...base,
        tracks: [0, 1, 2, 3, 4].map((i) => ({ ...base.tracks[0], id: `t-${i}` }))
      }).ok
    ).toBe(false);
    // Duplicate track IDs
    expect(
      validateStudioProject({
        ...base,
        tracks: [base.tracks[0], { ...base.tracks[1], id: base.tracks[0].id }]
      }).ok
    ).toBe(false);
    // Missing patch
    expect(
      validateStudioProject({
        ...base,
        tracks: [{ ...base.tracks[0], patch: null }]
      }).ok
    ).toBe(false);
    // Invalid MIDI event pitch / negative tick / unknown type
    expect(
      validateStudioProject({
        ...base,
        tracks: [{ ...base.tracks[0], events: [{ type: "noteOn", tick: -5, midi: 60, velocity: 0.8 }] }]
      }).ok
    ).toBe(false);
    expect(
      validateStudioProject({
        ...base,
        tracks: [{ ...base.tracks[0], events: [{ type: "noteOn", tick: 0, midi: 140, velocity: 0.8 }] }]
      }).ok
    ).toBe(false);
    expect(
      validateStudioProject({
        ...base,
        tracks: [{ ...base.tracks[0], events: [{ type: "sysexBomb", tick: 0 }] }]
      }).ok
    ).toBe(false);

    // Oversized import rejected before JSON.parse
    const huge = "x".repeat(STUDIO_MAX_IMPORT_BYTES + 64);
    const hugeRes = parseStudioProjectJson(huge);
    expect(hugeRes.ok).toBe(false);
  });

  test("Atomically preserves live engine state when loadProject rejects corrupted input", async () => {
    const eng = createStudioEngine({ isolatedTempo: true, initialBpm: 124 });
    eng.setProjectName("Safe Active Project");
    eng.setBars(12);
    const [t1] = eng.getTracks();
    t1.applyPreset("moogBass");
    t1.setParam("cutoff", 777);
    t1.setEvents([
      { type: "noteOn", tick: 0, midi: 48, velocity: 0.9 },
      { type: "noteOff", tick: 480, midi: 48 }
    ]);

    let rejectedMessage = "";
    try {
      await eng.loadProject({ format: "broken", version: 99, tracks: [] });
    } catch (err) {
      rejectedMessage = err instanceof Error ? err.message : String(err);
    }
    expect(rejectedMessage).toContain("Unrecognized project format");

    // Confirm zero mutation occurred
    expect(eng.getProjectName()).toBe("Safe Active Project");
    expect(eng.getBpm()).toBe(124);
    expect(eng.getTransportSnapshot().bars).toBe(12);
    expect(eng.getTracks()[0].presetId).toBe("custom");
    expect(eng.getTracks()[0].patch.cutoff).toBe(777);
    expect(eng.getTracks()[0].getNoteCount()).toBe(1);

    eng.dispose();
  });

  test("Sanitizes out-of-range synth params with warnings while keeping valid tracks intact", () => {
    const base = makeValidBase();
    const tweaked = {
      ...base,
      tracks: [
        {
          ...base.tracks[0],
          patch: {
            ...base.tracks[0].patch,
            cutoff: 999999,
            osc1Wave: "nonexistentWave",
            hold: "on"
          }
        },
        base.tracks[1]
      ]
    };
    const res = validateStudioProject(tweaked);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.project.tracks[0].patch.cutoff).toBeLessThanOrEqual(20000);
    expect(res.project.tracks[0].patch.osc1Wave).toBe(SY1.base.osc1Wave ?? "sawtooth");
    expect(res.project.tracks[0].patch.hold).toBe("off");
    expect(res.warnings.length).toBeGreaterThanOrEqual(1);
  });
});

describe("Phase 2 — IndexedDB Storage Adapter, Quota & Error Handling", () => {
  function sampleProject(id: string, name: string): StudioProjectData {
    const eng = createStudioEngine({ isolatedTempo: true, initialBpm: 120 });
    eng.setProjectName(name);
    const p = { ...eng.exportProject(), id };
    eng.dispose();
    return p;
  }

  test("Saves, lists, loads, deletes projects and manages autosave recovery slot", async () => {
    const storage = createStudioStorage({ indexedDB: makeMockIndexedDB() });
    expect(storage.isAvailable()).toBe(true);

    const p1 = sampleProject("proj-a", "Alpha");
    const p2 = sampleProject("proj-b", "Beta");

    const s1 = await storage.saveProject(p1);
    expect(s1.ok).toBe(true);
    const s2 = await storage.saveProject(p2);
    expect(s2.ok).toBe(true);

    const list = await storage.listProjects();
    expect(list.ok).toBe(true);
    if (list.ok) {
      expect(list.data.length).toBe(2);
    }

    const loaded = await storage.loadProject("proj-a");
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      expect(loaded.data?.name).toBe("Alpha");
    }

    const autoSave = await storage.saveAutosave(p2);
    expect(autoSave.ok).toBe(true);
    const autoLoad = await storage.loadAutosave();
    expect(autoLoad.ok).toBe(true);
    if (autoLoad.ok) {
      expect(autoLoad.data?.project.name).toBe("Beta");
    }

    const del = await storage.deleteProject("proj-a");
    expect(del.ok).toBe(true);
    const afterDel = await storage.loadProject("proj-a");
    expect(afterDel.ok).toBe(true);
    if (afterDel.ok) {
      expect(afterDel.data).toBeNull();
    }
  });

  test("Classifies and gracefully handles QuotaExceededError without throwing", async () => {
    const quotaErr = Object.assign(new Error("The quota has been exceeded."), {
      name: "QuotaExceededError"
    });
    expect(classifyStorageError(quotaErr).kind).toBe("quota");
    expect(classifyStorageError({ name: "NS_ERROR_DOM_QUOTA_REACHED" }).kind).toBe("quota");
    expect(classifyStorageError({ code: 22 }).kind).toBe("quota");

    const storage = createStudioStorage({ indexedDB: makeMockIndexedDB({ failWriteWith: quotaErr }) });
    const p = sampleProject("proj-q", "Quota Test");

    const saveRes = await storage.saveProject(p);
    expect(saveRes.ok).toBe(false);
    if (!saveRes.ok) {
      expect(saveRes.kind).toBe("quota");
      expect(saveRes.message.toLowerCase()).toContain("quota");
    }

    const autoRes = await storage.saveAutosave(p);
    expect(autoRes.ok).toBe(false);
    if (!autoRes.ok) {
      expect(autoRes.kind).toBe("quota");
    }
  });

  test("Handles unavailable IndexedDB (private/restricted context) & corrupted stored records", async () => {
    const unavailable = createStudioStorage({ indexedDB: null });
    expect(unavailable.isAvailable()).toBe(false);
    const res = await unavailable.listProjects();
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.kind).toBe("unavailable");
    }

    const secErr = Object.assign(new Error("IndexedDB disabled"), { name: "SecurityError" });
    const blocked = createStudioStorage({ indexedDB: makeMockIndexedDB({ failOpenWith: secErr }) });
    const blockedRes = await blocked.loadAutosave();
    expect(blockedRes.ok).toBe(false);
    if (!blockedRes.ok) {
      expect(blockedRes.kind).toBe("unavailable");
    }

    const corruptStorage = createStudioStorage({
      indexedDB: makeMockIndexedDB({
        corruptRawRead: {
          latest: { slot: "latest", updatedAt: Date.now(), project: { format: "corrupt", version: 99 } },
          "bad-id": { format: "corrupt", version: 99 }
        }
      })
    });
    const badProj = await corruptStorage.loadProject("bad-id");
    expect(badProj.ok).toBe(false);
    if (!badProj.ok) expect(badProj.kind).toBe("corrupt");

    const badAuto = await corruptStorage.loadAutosave();
    expect(badAuto.ok).toBe(false);
    if (!badAuto.ok) expect(badAuto.kind).toBe("corrupt");
  });
});

describe("Phase 2 — Recording Safety Guardrails", () => {
  test("Preserves 30-minute cap and enforces explicit desktop/mobile RAM ceilings", () => {
    expect(RECORDER_MAX_SECONDS).toBe(1800);
    expect(STUDIO_LIVE_BYTES_PER_FRAME).toBe(14);
    expect(STUDIO_LIVE_RAM_BUDGET_DESKTOP).toBe(256 * 1024 * 1024);
    expect(STUDIO_LIVE_RAM_BUDGET_MOBILE).toBe(128 * 1024 * 1024);
    expect(getLiveRecordingRamBudgetBytes()).toBe(STUDIO_LIVE_RAM_BUDGET_DESKTOP);

    const eng = createStudioEngine({ isolatedTempo: true, initialBpm: 120 });
    const snap = eng.getTransportSnapshot();
    expect(snap.liveRecBytes).toBe(0);
    expect(snap.maxLiveBytes).toBe(STUDIO_LIVE_RAM_BUDGET_DESKTOP);
    expect(snap.liveRecWarning).toBe("");

    // Ensure serialization helper produces valid JSON
    const json = serializeStudioProject(eng.exportProject());
    expect(parseStudioProjectJson(json).ok).toBe(true);
    eng.dispose();
  });
});
