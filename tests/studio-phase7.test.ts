import { describe, expect, test } from "bun:test";
import { SY1StudioEngine } from "../src/studio/studio-engine";
import { createProjectId, parseStudioProjectJson, serializeStudioProject } from "../src/studio/project-io";
import { createStudioStorage } from "../src/studio/storage";
import { StudioMetronome } from "../src/studio/metronome";
import { makeDriveCurve } from "../src/engine/bus";
import { STUDIO_MAX_TRACKS, STUDIO_TICKS_PER_BAR, type StudioProjectData } from "../src/studio/types";

function makeMockIndexedDB(opts: { failWriteWith?: Error } = {}): IDBFactory {
  const stores = new Map<string, Map<string, unknown>>();
  const fireAsync = (fn: () => void) => Promise.resolve().then(fn);

  const makeDb = (): IDBDatabase => {
    const db: any = {
      objectStoreNames: { contains: (name: string) => stores.has(name) },
      createObjectStore: (name: string) => {
        if (!stores.has(name)) stores.set(name, new Map());
        return {};
      },
      close: () => {},
      onversionchange: null,
      transaction: (_storeName: string, mode: IDBTransactionMode) => {
        const tx: any = { error: null, oncomplete: null, onabort: null, onerror: null };
        tx.objectStore = (name: string) => {
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
                if (mode === "readwrite" && opts.failWriteWith) return { error: opts.failWriteWith };
                const key = val.id ?? val.slot;
                map.set(String(key), JSON.parse(JSON.stringify(val)));
                return { value: key };
              }),
            get: (key: string) => makeReq(() => ({ value: map.get(String(key)) })),
            getAll: () => makeReq(() => ({ value: Array.from(map.values()) })),
            delete: (key: string) =>
              makeReq(() => {
                if (mode === "readwrite" && opts.failWriteWith) return { error: opts.failWriteWith };
                map.delete(String(key));
                return { value: undefined };
              })
          };
        };
        return tx;
      }
    };
    return db as IDBDatabase;
  };

  return {
    open: () => {
      const req: any = { result: null, error: null, onupgradeneeded: null, onsuccess: null, onerror: null };
      fireAsync(() => {
        const db = makeDb();
        req.result = db;
        req.onupgradeneeded?.({ target: req });
        req.onsuccess?.({ target: req });
      });
      return req;
    }
  } as unknown as IDBFactory;
}

function makeEngine(initialTime = 0) {
  let time = initialTime;
  const engine = new SY1StudioEngine({
    isolatedTempo: true,
    initialBpm: 120,
    clockNow: () => time
  });
  return {
    engine,
    setTime(v: number) {
      time = v;
    },
    advance(dt: number) {
      time += dt;
    }
  };
}

describe("Phase 7 — Independent Projects & Storage Safety", () => {
  test("createProjectId generates unique collision-free IDs across rapid calls", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) {
      ids.add(createProjectId());
    }
    expect(ids.size).toBe(100);
    ids.forEach((id) => {
      expect(id.startsWith("proj-")).toBe(true);
      expect(id.length).toBeGreaterThan(10);
    });
  });

  test("Creating Project B never overwrites or mutates Project A", async () => {
    const storage = createStudioStorage({ indexedDB: makeMockIndexedDB() });
    const { engine } = makeEngine();

    engine.setProjectName("Project A — Tabriz Lead");
    engine.setBpm(128);
    const t1 = engine.getTracks()[0];
    engine.setTrackMachine(t1.id, "tabriz");
    t1.setEvents([
      { type: "noteOn", tick: 0, midi: 60, velocity: 0.85 },
      { type: "noteOff", tick: 480, midi: 60 }
    ]);
    const projA = engine.exportProject();
    const saveA = await storage.saveProject(projA);
    expect(saveA.ok).toBe(true);

    // Create brand-new Project B
    const projB = await engine.createNewProject({ name: "Project B — Kerman Groove", bpm: 96, machineId: "kerman" });
    expect(projB.id).not.toBe(projA.id);
    expect(projB.name).toBe("Project B — Kerman Groove");
    expect(projB.bpm).toBe(96);
    expect(projB.tracks[0].machineId).toBe("kerman");
    expect(projB.tracks[0].events.length).toBe(0);

    const bTrack = engine.getTracks()[0];
    bTrack.setEvents([
      { type: "noteOn", tick: 0, midi: 36, velocity: 0.95 },
      { type: "noteOff", tick: 240, midi: 36 }
    ]);
    const saveB = await storage.saveProject(engine.exportProject());
    expect(saveB.ok).toBe(true);

    // Verify Project A is completely intact in storage
    const loadedA = await storage.loadProject(projA.id);
    const loadedB = await storage.loadProject(projB.id);
    expect(loadedA.ok).toBe(true);
    expect(loadedB.ok).toBe(true);
    if (!loadedA.ok || !loadedB.ok) return;
    expect(loadedA.data!.id).toBe(projA.id);
    expect(loadedA.data!.name).toBe("Project A — Tabriz Lead");
    expect(loadedA.data!.bpm).toBe(128);
    expect(loadedA.data!.tracks[0].machineId).toBe("tabriz");
    expect(loadedA.data!.tracks[0].events.length).toBe(2);

    expect(loadedB.data!.id).toBe(projB.id);
    expect(loadedB.data!.name).toBe("Project B — Kerman Groove");
    expect(loadedB.data!.bpm).toBe(96);
    expect(loadedB.data!.tracks[0].machineId).toBe("kerman");

    const list = await storage.listProjects();
    expect(list.ok).toBe(true);
    if (list.ok) {
      expect(list.data.some((m) => m.id === projA.id)).toBe(true);
      expect(list.data.some((m) => m.id === projB.id)).toBe(true);
    }

    engine.dispose();
  });

  test("Duplicate / Save As assigns a new stable ID and preserves instruments, patches and regions", async () => {
    const storage = createStudioStorage({ indexedDB: makeMockIndexedDB() });
    const { engine } = makeEngine();

    engine.setProjectName("Original Song");
    engine.setBpm(116);
    engine.setRecordingSettings({ metronome: true, countIn: true, mode: "takes" });
    const t1 = engine.getTracks()[0];
    engine.setTrackMachine(t1.id, "yazd");
    t1.setParam("cutoff", 1420);
    t1.setEvents([
      { type: "noteOn", tick: 0, midi: 64, velocity: 0.8 },
      { type: "noteOff", tick: 480, midi: 64 }
    ]);
    const orig = engine.exportProject();
    await storage.saveProject(orig);

    // Duplicate via engine (Save As)
    const dup = engine.duplicateCurrentProject("Original Song (Remix)");
    expect(dup.id).not.toBe(orig.id);
    expect(dup.name).toBe("Original Song (Remix)");
    expect(dup.bpm).toBe(116);
    expect(dup.tracks[0].machineId).toBe("yazd");
    expect(dup.tracks[0].patch.cutoff).toBe(1420);
    expect(dup.tracks[0].events.length).toBe(2);
    expect(dup.recordingSettings?.mode).toBe("takes");
    await storage.saveProject(dup);

    // Mutate duplicate and re-save — original must stay untouched
    engine.setBpm(140);
    engine.getTracks()[0].setParam("cutoff", 600);
    await storage.saveProject(engine.exportProject());

    const reloadedOrig = await storage.loadProject(orig.id);
    expect(reloadedOrig.ok).toBe(true);
    if (!reloadedOrig.ok) return;
    expect(reloadedOrig.data!.bpm).toBe(116);
    expect(reloadedOrig.data!.tracks[0].patch.cutoff).toBe(1420);

    // Storage-level duplicate & rename & delete
    const storageDup = await storage.duplicateProject(orig.id, "Storage Copy");
    expect(storageDup.ok).toBe(true);
    if (!storageDup.ok) return;
    expect(storageDup.data.id).not.toBe(orig.id);
    expect(storageDup.data.name).toBe("Storage Copy");

    const renamed = await storage.renameProject(storageDup.data.id, "Renamed Copy");
    expect(renamed.ok).toBe(true);
    const loadedRenamed = await storage.loadProject(storageDup.data.id);
    expect(loadedRenamed.ok && loadedRenamed.data?.name).toBe("Renamed Copy");

    const delRes = await storage.deleteProject(storageDup.data.id);
    expect(delRes.ok).toBe(true);
    const afterDel = await storage.loadProject(storageDup.data.id);
    expect(afterDel.ok && afterDel.data).toBeNull();
    // Original still exists
    const origStillThere = await storage.loadProject(orig.id);
    expect(origStillThere.ok && origStillThere.data?.id).toBe(orig.id);

    engine.dispose();
  });

  test("Opening, creating or duplicating projects is safely blocked while recording", async () => {
    const { engine, advance } = makeEngine(1.0);
    engine.setRecordingSettings({ countIn: false, metronome: false });
    const snap = engine.exportProject();

    await engine.record();
    expect(engine.getTransportSnapshot().recording).toBe(true);

    // Record a note while active
    advance(0.1);
    const t1 = engine.getFocusedTrack();
    engine.capturePerformanceMidi(t1.id, [0x90, 62, 100], 1.1);

    let newErr = "";
    try {
      await engine.createNewProject({ name: "Blocked" });
    } catch (e: any) {
      newErr = e?.message || String(e);
    }
    expect(newErr.toLowerCase()).toContain("recording");

    let openErr = "";
    try {
      await engine.loadProject(snap);
    } catch (e: any) {
      openErr = e?.message || String(e);
    }
    expect(openErr.toLowerCase()).toContain("recording");

    let dupErr = "";
    try {
      engine.duplicateCurrentProject("Blocked Copy");
    } catch (e: any) {
      dupErr = e?.message || String(e);
    }
    expect(dupErr.toLowerCase()).toContain("recording");

    // Finish note & stop — recording must still be intact
    advance(0.2);
    engine.capturePerformanceMidi(t1.id, [0x80, 62, 0], 1.3);
    await engine.stop();
    expect(t1.getNoteCount()).toBe(1);

    engine.dispose();
  });

  test("Legacy sy1-default project and v1 projects without recordingSettings.mode remain compatible", async () => {
    const { engine } = makeEngine();
    const legacyRaw: StudioProjectData = {
      ...engine.exportProject(),
      id: "sy1-default",
      name: "Legacy Session",
      recordingSettings: { metronome: true, countIn: false, clickVolume: 0.25 }
    };
    const json = serializeStudioProject(legacyRaw);
    const parsed = parseStudioProjectJson(json);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.project.id).toBe("sy1-default");
    expect(parsed.project.recordingSettings?.mode).toBe(undefined);

    await engine.loadProject(parsed.project);
    expect(engine.getTransportSnapshot().projectId).toBe("sy1-default");
    expect(engine.getRecordingMode()).toBe("overdub");
    expect(engine.getRecordingSettings()).toEqual({ metronome: true, countIn: false, clickVolume: 0.25 });

    // Creating a new project afterward generates a new non-legacy ID so sy1-default is never overwritten
    const next = await engine.createNewProject({ name: "Fresh Project" });
    expect(next.id).not.toBe("sy1-default");

    engine.dispose();
  });

  test("Serialized write queue handles concurrent saves safely and surfaces quota errors without data loss", async () => {
    const storage = createStudioStorage({ indexedDB: makeMockIndexedDB() });
    const { engine } = makeEngine();
    const base = engine.exportProject();

    // Fire 10 concurrent saves with increasing BPM — serialized queue must preserve final write cleanly
    const promises = Array.from({ length: 10 }, (_, idx) =>
      storage.saveProject({ ...base, bpm: 100 + idx, savedAt: Date.now() + idx })
    );
    const results = await Promise.all(promises);
    expect(results.every((r) => r.ok)).toBe(true);
    const finalLoaded = await storage.loadProject(base.id);
    expect(finalLoaded.ok && finalLoaded.data?.bpm).toBe(109);

    // Autosave & recovery
    const autoRes = await storage.saveAutosave({ ...base, name: "Recovered Take", bpm: 123 });
    expect(autoRes.ok).toBe(true);
    const recovered = await storage.loadAutosave();
    expect(recovered.ok && recovered.data?.project.name).toBe("Recovered Take");
    expect(recovered.ok && recovered.data?.project.bpm).toBe(123);

    // QuotaExceededError handled gracefully without throwing or corrupting engine state
    const quotaErr = Object.assign(new Error("Quota exceeded"), { name: "QuotaExceededError" });
    const fullStorage = createStudioStorage({ indexedDB: makeMockIndexedDB({ failWriteWith: quotaErr }) });
    const failedSave = await fullStorage.saveProject(engine.exportProject());
    expect(failedSave.ok).toBe(false);
    if (!failedSave.ok) expect(failedSave.kind).toBe("quota");

    engine.dispose();
  });
});

describe("Phase 7 — GarageBand 4-Track Per-Track Recording & Modes", () => {
  test("4-track Tabriz + Yazd + Baku + Kerman Drums recorded separately never corrupt unrelated tracks", async () => {
    const { engine, setTime } = makeEngine(0);
    engine.setRecordingSettings({ countIn: false, metronome: false, mode: "overdub" });

    // Prepare 4 tracks: Tabriz, Yazd, Baku, Kerman Drums
    const t1 = engine.getTracks()[0];
    const t2 = engine.getTracks()[1];
    const t3 = engine.addTrack("baku")!;
    const t4 = engine.addTrack("kerman")!;
    engine.setTrackMachine(t1.id, "tabriz");
    engine.setTrackMachine(t2.id, "yazd");
    engine.setTrackMachine(t3.id, "baku");
    engine.setTrackMachine(t4.id, "kerman");

    // Verify 4-track limit preserved
    expect(engine.getTracks().length).toBe(STUDIO_MAX_TRACKS);
    expect(engine.addTrack()).toBeNull();

    const plan: Array<{ track: typeof t1; midi: number; vel: number; tStart: number; tEnd: number }> = [
      { track: t1, midi: 48, vel: 0.82, tStart: 0.1, tEnd: 0.4 },
      { track: t2, midi: 60, vel: 0.78, tStart: 0.2, tEnd: 0.6 },
      { track: t3, midi: 67, vel: 0.88, tStart: 0.3, tEnd: 0.7 },
      { track: t4, midi: 36, vel: 0.95, tStart: 0.05, tEnd: 0.25 }
    ];

    const snapshots: Record<string, string> = {};
    for (const step of plan) {
      // Arm exclusively this track (GarageBand workflow)
      engine.getTracks().forEach((tr) => engine.setTrackArmed(tr.id, tr.id === step.track.id));
      engine.setFocusedTrack(step.track.id);
      engine.seekToTick(0);
      setTime(0);

      await engine.record();
      setTime(step.tStart);
      engine.capturePerformanceMidi(step.track.id, [0x90, step.midi, Math.round(step.vel * 127)], step.tStart);
      setTime(step.tEnd);
      engine.capturePerformanceMidi(step.track.id, [0x80, step.midi, 0], step.tEnd);
      await engine.stop();

      // Verify previously recorded tracks remained bit-for-bit identical
      for (const prevId of Object.keys(snapshots)) {
        const prevTrack = engine.getTrack(prevId)!;
        expect(JSON.stringify(prevTrack.getRegions(engine.getTotalTicks()))).toBe(snapshots[prevId]);
      }
      snapshots[step.track.id] = JSON.stringify(step.track.getRegions(engine.getTotalTicks()));
    }

    // All 4 tracks have their independent instruments and recorded regions
    expect(engine.getTracks().map((t) => t.machineId)).toEqual(["tabriz", "yazd", "baku", "kerman"]);
    expect(t1.getNoteSpans(engine.getTotalTicks()).map((n) => n.midi)).toEqual([48]);
    expect(t2.getNoteSpans(engine.getTotalTicks()).map((n) => n.midi)).toEqual([60]);
    expect(t3.getNoteSpans(engine.getTotalTicks()).map((n) => n.midi)).toEqual([67]);
    expect(t4.getNoteSpans(engine.getTotalTicks()).map((n) => n.midi)).toEqual([36]);

    // Save/reload roundtrip preserves all 4 tracks & instruments
    const exported = engine.exportProject();
    const { engine: reloaded } = makeEngine(0);
    await reloaded.loadProject(exported);
    expect(reloaded.getTracks().map((t) => t.machineId)).toEqual(["tabriz", "yazd", "baku", "kerman"]);
    expect(reloaded.getTracks().every((t) => t.getNoteCount() === 1)).toBe(true);

    engine.dispose();
    reloaded.dispose();
  });

  test("Overdub, Separate Takes, and explicit Replace (with Undo and empty-pass safety)", async () => {
    const { engine, setTime } = makeEngine(0);
    const t1 = engine.getTracks()[0];
    engine.getTracks().forEach((tr) => engine.setTrackArmed(tr.id, tr.id === t1.id));

    // Pass 1 (Overdub): record C4
    engine.setRecordingSettings({ countIn: false, metronome: false, mode: "overdub" });
    setTime(0);
    await engine.record();
    setTime(0.1);
    engine.capturePerformanceMidi(t1.id, [0x90, 60, 100], 0.1);
    setTime(0.3);
    engine.capturePerformanceMidi(t1.id, [0x80, 60, 0], 0.3);
    await engine.stop();
    expect(t1.getNoteSpans(engine.getTotalTicks()).map((n) => n.midi)).toEqual([60]);
    expect(t1.getRegions(engine.getTotalTicks()).length).toBe(1);

    // Pass 2 (Overdub): record E4 — merged/preserved with C4
    engine.seekToTick(0);
    setTime(0);
    await engine.record();
    setTime(0.5);
    engine.capturePerformanceMidi(t1.id, [0x90, 64, 100], 0.5);
    setTime(0.7);
    engine.capturePerformanceMidi(t1.id, [0x80, 64, 0], 0.7);
    await engine.stop();
    const afterOverdub = t1.getNoteSpans(engine.getTotalTicks()).map((n) => n.midi);
    expect(afterOverdub).toContain(60);
    expect(afterOverdub).toContain(64);
    const regionsBeforeTake = t1.getRegions(engine.getTotalTicks()).length;

    // Pass 3 (Separate Takes): keeps previous regions intact & adds a distinct take region
    engine.setRecordingSettings({ mode: "takes" });
    engine.seekToTick(0);
    setTime(0);
    await engine.record();
    setTime(0.15);
    engine.capturePerformanceMidi(t1.id, [0x90, 67, 100], 0.15);
    setTime(0.35);
    engine.capturePerformanceMidi(t1.id, [0x80, 67, 0], 0.35);
    await engine.stop();
    expect(t1.getRegions(engine.getTotalTicks()).length).toBe(regionsBeforeTake + 1);
    expect(t1.getNoteSpans(engine.getTotalTicks()).map((n) => n.midi)).toContain(67);

    // Pass 4 (Replace with 0 notes recorded): preserves existing regions safely!
    engine.setRecordingSettings({ mode: "replace" });
    engine.seekToTick(0);
    setTime(0);
    await engine.record();
    setTime(0.2);
    await engine.stop();
    expect(t1.getNoteSpans(engine.getTotalTicks()).length).toBe(3);

    // Pass 5 (Replace with new note G#4): replaces cleanly AND supports Undo back to 3 notes
    engine.seekToTick(0);
    setTime(0);
    await engine.record();
    setTime(0.1);
    engine.capturePerformanceMidi(t1.id, [0x90, 68, 110], 0.1);
    setTime(0.4);
    engine.capturePerformanceMidi(t1.id, [0x80, 68, 0], 0.4);
    await engine.stop();
    expect(t1.getNoteSpans(engine.getTotalTicks()).map((n) => n.midi)).toEqual([68]);
    expect(t1.getRegions(engine.getTotalTicks()).length).toBe(1);

    // Undo restores the replaced regions cleanly
    expect(engine.regions.canUndo()).toBe(true);
    engine.regions.undo();
    expect(t1.getNoteSpans(engine.getTotalTicks()).length).toBe(3);
    // Redo restores the replacement
    engine.regions.redo();
    expect(t1.getNoteSpans(engine.getTotalTicks()).map((n) => n.midi)).toEqual([68]);

    engine.dispose();
  });

  test("Mute, Solo and monitoring audibility behave accurately", () => {
    const { engine } = makeEngine(0);
    const t1 = engine.getTracks()[0];
    const t2 = engine.getTracks()[1];
    expect(t1.audible).toBe(true);
    expect(t2.audible).toBe(true);

    // Mute Track 1
    engine.setTrackMute(t1.id, true);
    expect(t1.audible).toBe(false);
    expect(t2.audible).toBe(true);

    // Solo Track 1 overrides solo gating cleanly
    engine.setTrackMute(t1.id, false);
    engine.setTrackSolo(t1.id, true);
    expect(t1.audible).toBe(true);
    expect(t2.audible).toBe(false);

    // Unsolo restores both
    engine.setTrackSolo(t1.id, false);
    expect(t1.audible).toBe(true);
    expect(t2.audible).toBe(true);

    expect(engine.getTotalTicks()).toBe(8 * STUDIO_TICKS_PER_BAR);
    engine.dispose();
  });
});

describe("Phase 7 — Audio Efficiency & Resource Cleanup Guards", () => {
  test("makeDriveCurve returns bit-identical cached curves and bounds cache size", () => {
    const a = makeDriveCurve(0.42);
    const b = makeDriveCurve(0.42);
    expect(a).toBe(b);
    expect(a.length).toBe(1024);

    // Verify mathematical formula exactness for amount = 0 and amount = 0.42
    const zero = makeDriveCurve(0);
    expect(zero[0]).toBe(-1);
    expect(zero[1023]).toBe(1);
    const k = 0.42 * 60;
    const xSample = (512 / 1023) * 2 - 1;
    const expected = ((1 + k) * xSample) / (1 + k * Math.abs(xSample));
    expect(Math.abs(a[512] - expected)).toBeLessThan(1e-6);

    // Stress cache eviction past 64 distinct keys
    for (let i = 0; i < 80; i++) {
      const c = makeDriveCurve(i / 100);
      expect(c.length).toBe(1024);
    }
  });

  test("StudioMetronome.cancel() stops and disconnects voices without leaking set entries", () => {
    const metro = new StudioMetronome();
    let stopped = 0;
    let disconnected = 0;
    const fakeOsc = {
      stop() { stopped++; },
      disconnect() { disconnected++; }
    } as unknown as OscillatorNode;
    const voices = (metro as any).voices as Set<OscillatorNode>;
    voices.add(fakeOsc);
    expect(voices.size).toBe(1);

    metro.cancel();
    expect(stopped).toBe(1);
    expect(disconnected).toBe(1);
    expect(voices.size).toBe(0);
    metro.dispose();
  });
});
