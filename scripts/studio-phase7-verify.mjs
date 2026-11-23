import { spawn } from "node:child_process";
import fs from "node:fs";
import { CdpClient, waitForCdp, sleep } from "./studio-cdp.mjs";

const bin = process.env.SY1_CHROME_BIN || "/ms-playwright/chrome-headless-shell-linux64/chrome-headless-shell";
const out = process.env.SY1_EVIDENCE_DIR || "/tmp/sy1-phase7-verify";
const url = process.env.SY1_URL || "http://127.0.0.1:3000";
if (!fs.existsSync(bin)) throw Error("Missing Chromium binary: " + bin);
fs.mkdirSync(out, { recursive: true });

const chrome = spawn(
  bin,
  [
    "--headless",
    "--no-sandbox",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    "--autoplay-policy=no-user-gesture-required",
    "--remote-debugging-port=9227",
    "about:blank"
  ],
  { stdio: "ignore" }
);

let c;
const errors = [];
const checks = [];
const assert = (name, value, detail) => {
  checks.push({ name, pass: !!value, detail });
  if (!value) throw Error(name + ": " + JSON.stringify(detail));
};

try {
  c = new CdpClient(await waitForCdp(9227));
  await c.connect();
  await c.send("Page.enable");
  await c.send("Runtime.enable");
  c.on("Runtime.exceptionThrown", (e) =>
    errors.push(e.exceptionDetails.exception?.description || e.exceptionDetails.text)
  );
  await c.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `
      window.__nativeDialogs = [];
      window.confirm = (m) => { window.__nativeDialogs.push(['confirm', m]); return false; };
      window.alert = (m) => { window.__nativeDialogs.push(['alert', m]); };
      window.prompt = (m) => { window.__nativeDialogs.push(['prompt', m]); return null; };
    `
  });

  const viewport = async (w, h) =>
    c.send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: false });
  const wait = async (expr) => {
    for (let i = 0; i < 200; i++) {
      if (await c.evaluate(expr)) return;
      await sleep(50);
    }
    throw Error("Timeout waiting for: " + expr);
  };
  const click = async (selector) => {
    const p = await c.evaluate(`(()=>{
      const e = document.querySelector(${JSON.stringify(selector)});
      if (!e) throw Error('Missing element: ' + ${JSON.stringify(selector)});
      e.scrollIntoView({ block: 'nearest' });
      const r = e.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    })()`);
    await c.send("Input.dispatchMouseEvent", { type: "mousePressed", ...p, button: "left", clickCount: 1 });
    await c.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...p, button: "left", clickCount: 1 });
  };
  const shot = async (name) => {
    const { data } = await c.send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(`${out}/${name}.png`, Buffer.from(data, "base64"));
  };

  await viewport(1440, 900);
  await c.send("Page.navigate", { url });
  await wait("!!window.SY1_STUDIO");
  await c.evaluate("window.SY1_STUDIO.ready");

  // Open Studio
  await click("#sr-edit");
  await wait("window.SY1_STUDIO.isOpen()");
  await sleep(100);

  // 1. Independent Projects — Save Project A, create Project B, verify A untouched
  const projAId = await c.evaluate(`(async()=>{
    const e = window.SY1_STUDIO.engine;
    e.setProjectName("Project A — Tabriz");
    e.setBpm(124);
    const t1 = e.getTracks()[0];
    e.setTrackMachine(t1.id, "tabriz");
    t1.setEvents([{type:"noteOn",tick:0,midi:60,velocity:0.85},{type:"noteOff",tick:480,midi:60}]);
    return e.getTransportSnapshot().projectId;
  })()`);
  await sleep(60);
  await click("#st-save-btn");
  await wait("document.getElementById('st-save-state')?.textContent === 'Saved'");
  await shot("p7-project-a-saved");

  // Open Projects drawer & verify local-only notice
  await click("#st-open-btn");
  await wait("!!document.getElementById('st-open-drawer') && !document.getElementById('st-open-drawer').hidden");
  const drawerNotice = await c.evaluate("document.getElementById('st-open-drawer').textContent");
  assert(
    "Projects drawer shows local-only browser storage notice",
    drawerNotice.includes("locally in this browser") && !/cloud\s*sync\s*(enabled|active|connected)/i.test(drawerNotice),
    drawerNotice.slice(0, 220)
  );
  await shot("p7-projects-drawer");

  // Create New Project B via Projects drawer + accessible #st-project-name-dialog
  await click('[data-st-action="new-project"]');
  await wait("!!document.getElementById('st-project-name-dialog')");
  await c.evaluate(`(()=>{const inp=document.getElementById('st-project-name-modal-input');inp.value='Project B — Kerman';inp.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await click("#st-project-name-confirm-btn");
  await wait(`window.SY1_STUDIO.engine.getTransportSnapshot().projectId !== ${JSON.stringify(projAId)}`);
  const projBId = await c.evaluate(`(async()=>{
    const e = window.SY1_STUDIO.engine;
    e.setBpm(98);
    const t1 = e.getTracks()[0];
    e.setTrackMachine(t1.id, "kerman");
    t1.setEvents([{type:"noteOn",tick:0,midi:36,velocity:0.95},{type:"noteOff",tick:240,midi:36}]);
    return e.getTransportSnapshot().projectId;
  })()`);
  assert("Project B has a distinct stable ID from Project A", projBId !== projAId, { projAId, projBId });
  await sleep(60);
  await click("#st-save-btn");
  await wait("document.getElementById('st-save-state')?.textContent === 'Saved'");

  const ensureDrawerOpen = async () => {
    const isOpen = await c.evaluate("!!document.getElementById('st-open-drawer')");
    if (!isOpen) {
      await click("#st-open-btn");
      await wait("!!document.getElementById('st-open-drawer')");
    }
  };

  // Unsaved-changes guard modal test: dirty Project B, click New Project, verify #st-unsaved-dialog appears
  await c.evaluate("window.SY1_STUDIO.engine.setBpm(102)");
  await wait("document.getElementById('st-save-state')?.textContent === 'Unsaved'");
  await ensureDrawerOpen();
  await click('[data-st-action="new-project"]');
  await wait("!!document.getElementById('st-unsaved-dialog')");
  await shot("p7-unsaved-dialog");
  await click("#st-unsaved-cancel-btn");
  await wait("!document.getElementById('st-unsaved-dialog')");
  assert(
    "Unsaved dialog Cancel preserves active Project B",
    await c.evaluate(`window.SY1_STUDIO.engine.getTransportSnapshot().projectId === ${JSON.stringify(projBId)} && window.SY1_STUDIO.engine.getBpm() === 102`)
  );

  // Open Project A with Save & Continue so neither Project A nor Project B is lost
  await ensureDrawerOpen();
  await click(`[data-st-action="open-saved-project"][data-project-id="${projAId}"]`);
  await wait("!!document.getElementById('st-unsaved-dialog')");
  await click("#st-unsaved-save-btn");
  await wait(`window.SY1_STUDIO.engine.getTransportSnapshot().projectId === ${JSON.stringify(projAId)}`);
  const checkA = await c.evaluate("(()=>{const e=window.SY1_STUDIO.engine;return {name:e.getProjectName(),bpm:e.getBpm(),machine:e.getTracks()[0].machineId,notes:e.getTracks()[0].getNoteCount()};})()");
  assert("Reopening Project A restores untouched Tabriz track & BPM", checkA.name === "Project A — Tabriz" && checkA.bpm === 124 && checkA.machine === "tabriz" && checkA.notes === 1, checkA);

  // Duplicate / Save As via in-app modal (#st-project-name-dialog)
  await ensureDrawerOpen();
  await click('[data-st-action="duplicate-current-project"]');
  await wait("!!document.getElementById('st-project-name-dialog')");
  await c.evaluate(`(()=>{const inp=document.getElementById('st-project-name-modal-input');inp.value='Project A Remix';inp.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await click("#st-project-name-confirm-btn");
  await wait("!document.getElementById('st-project-name-dialog')");
  const dupState = await c.evaluate("(()=>{const t=window.SY1_STUDIO.engine.getTransportSnapshot();return {id:t.projectId,name:t.projectName};})()");
  assert("Save As / Duplicate creates new project with distinct ID", dupState.id !== projAId && dupState.id !== projBId && dupState.name === "Project A Remix", dupState);

  // Delete duplicate with accessible in-app confirmation modal (#st-delete-project-dialog)
  await ensureDrawerOpen();
  await wait(`!!document.querySelector('[data-st-action="delete-saved-project"][data-project-id="${dupState.id}"]')`);
  await click(`[data-st-action="delete-saved-project"][data-project-id="${dupState.id}"]`);
  await wait("!!document.getElementById('st-delete-project-dialog')");
  await shot("p7-delete-dialog");
  await click("#st-delete-project-confirm-btn");
  await wait("!document.getElementById('st-delete-project-dialog')");
  await wait(`!document.querySelector('[data-st-action="delete-saved-project"][data-project-id="${dupState.id}"]')`);

  // Verify Project A & Project B both survive a full page reload
  const loaded = c.once("Page.loadEventFired");
  await c.send("Page.reload");
  await loaded;
  await wait("!!window.SY1_STUDIO");
  await c.evaluate("window.SY1_STUDIO.ready");
  const persistedIds = await c.evaluate(`(async()=>{const r=await window.SY1_STUDIO.storage.listProjects();return r.ok?r.data.map(p=>p.id):[];})()`);
  assert("Both Project A and Project B survive reload independently", persistedIds.includes(projAId) && persistedIds.includes(projBId) && !persistedIds.includes(dupState.id), persistedIds);

  // 2. GarageBand 4-Track Workflow (Tabriz + Yazd + Baku + Kerman Drums) + Live Recording Zero-Rebuild + Modes
  await click("#sr-edit");
  await wait("window.SY1_STUDIO.isOpen()");
  const workflow4 = await c.evaluate(`(async()=>{
    const e = window.SY1_STUDIO.engine;
    await e.createNewProject({ name: "4-Track GarageBand Test", bpm: 120, bars: 4, machineId: "tabriz" });
    e.setRecordingSettings({ countIn: false, metronome: false, mode: "overdub" });
    const t1 = e.getTracks()[0];
    const t2 = e.getTracks()[1];
    e.setTrackMachine(t2.id, "yazd");
    const t3 = e.addTrack();
    e.setTrackMachine(t3.id, "baku");
    const t4 = e.addTrack();
    e.setTrackMachine(t4.id, "kerman");
    const tracks = [
      { tr: t1, midi: 48 },
      { tr: t2, midi: 60 },
      { tr: t3, midi: 67 },
      { tr: t4, midi: 36 }
    ];
    const snaps = {};
    for (const item of tracks) {
      e.getTracks().forEach(x => e.setTrackArmed(x.id, x.id === item.tr.id));
      e.setFocusedTrack(item.tr.id);
      e.seekToTick(0);
      await e.record({ midiOnly: true });
      const ctxNow = e.getTracks()[0].ctx ? e.getTracks()[0].ctx.currentTime : performance.now()/1000;
      e.capturePerformanceMidi(item.tr.id, [0x90, item.midi, 108], ctxNow + 0.04);
      await new Promise(r => setTimeout(r, 80));
      const ctxEnd = e.getTracks()[0].ctx ? e.getTracks()[0].ctx.currentTime : performance.now()/1000;
      e.capturePerformanceMidi(item.tr.id, [0x80, item.midi, 0], ctxEnd + 0.02);
      await e.stop();
      for (const prevId of Object.keys(snaps)) {
        if (JSON.stringify(e.getTrack(prevId).getRegions(e.getTotalTicks())) !== snaps[prevId]) {
          return { ok: false, reason: "Unrelated track mutated: " + prevId };
        }
      }
      snaps[item.tr.id] = JSON.stringify(item.tr.getRegions(e.getTotalTicks()));
    }
    // Check live recording zero DOM rebuilds during 60 real MIDI events
    e.getTracks().forEach(x => e.setTrackArmed(x.id, x.id === t1.id));
    e.setFocusedTrack(t1.id);
    e.setRecordingSettings({ mode: "takes" });
    await e.record({ midiOnly: true });
    await new Promise(r => setTimeout(r, 40)); // let initial recording render settle
    const studioRoot = document.getElementById("sy1-studio");
    let domRebuildsDuringMidi = 0;
    const obs = new MutationObserver((muts) => {
      for (const m of muts) {
        if (m.type === "childList" && m.target === studioRoot && m.addedNodes.length > 0) domRebuildsDuringMidi++;
      }
    });
    obs.observe(studioRoot, { childList: true });
    for (let i = 0; i < 60; i++) {
      const now = e.getTracks()[0].ctx.currentTime;
      if (i % 3 === 0) e.capturePerformanceMidi(t1.id, [0x90, 50 + (i % 12), 96], now);
      else if (i % 3 === 1) e.capturePerformanceMidi(t1.id, [0xb0, 1, (i * 2) & 127], now);
      else e.capturePerformanceMidi(t1.id, [0x80, 50 + ((i - 2) % 12), 0], now);
      await new Promise(r => requestAnimationFrame(r));
    }
    obs.disconnect();
    // Verify switching projects is blocked while recording
    let blockedDuringRec = false;
    try { await e.createNewProject({ name: "Should Block" }); } catch { blockedDuringRec = true; }
    await e.stop();
    const takeRegionCount = t1.getRegions(e.getTotalTicks()).length;

    // Check drum FX bus is NOT torn down when another track is edited during playback
    await e.play();
    await new Promise(r => setTimeout(r, 60));
    const drumBusBefore = t4.bus;
    const r0 = e.regions.regions(t1.id)[0];
    if (r0) e.regions.move(t1.id, r0.id, r0.startTick + 120);
    await new Promise(r => setTimeout(r, 60));
    const drumBusPreserved = t4.bus === drumBusBefore;
    await e.stop();

    // Verify WAV mix + 4 stems + MIDI export
    const wav = await e.bounceArrangementWav({ bars: 1, sampleRate: 48000 });
    const stems = await e.bounceTrackStemsWav({ bars: 1, sampleRate: 48000 });
    const midiHdr = String.fromCharCode(...e.exportMidiBytes().slice(0, 4));
    return {
      ok: true,
      machines: e.getTracks().map(t => t.machineId),
      noteCounts: e.getTracks().map(t => t.getNoteCount()),
      domRebuildsDuringMidi,
      blockedDuringRec,
      takeRegionCount,
      drumBusPreserved,
      wavBytes: wav.wav.size,
      stemCount: stems.length,
      midiHdr
    };
  })()`);
  assert(
    "4-track Tabriz/Yazd/Baku/Kerman recording, Takes, zero DOM rebuilds, drum bus preservation & exports",
    workflow4.ok &&
      JSON.stringify(workflow4.machines) === JSON.stringify(["tabriz", "yazd", "baku", "kerman"]) &&
      workflow4.noteCounts.every((n) => n > 0) &&
      workflow4.domRebuildsDuringMidi === 0 &&
      workflow4.blockedDuringRec &&
      workflow4.takeRegionCount >= 2 &&
      workflow4.drumBusPreserved &&
      workflow4.wavBytes > 44 &&
      workflow4.stemCount === 4 &&
      workflow4.midiHdr === "MThd",
    workflow4
  );

  // 3. Real Chromium Audio/CPU Benchmarks & Bit-Exact Sound Parity
  const bench = await c.evaluate(`(async()=>{
    const diag = await import('/src/studio/parity-probe.ts');
    const parity = await diag.runOfflineParityProbe("softKeys", 48000, 0.5);
    const stress4 = await diag.runOffline4TrackStressProbe(48000, 2.0);
    return { parity, stress4 };
  })()`);
  assert("Sound parity chainMaxAbsDiff === 0", bench.parity.chainMaxAbsDiff === 0, bench.parity);
  assert(
    "4-track HQ stress probe finite, RTF < 1.0, 0 leaked voices",
    bench.stress4.nonFiniteSamples === 0 && bench.stress4.realtimeFactor < 1.0 && bench.stress4.activeVoicesAfterDispose === 0,
    bench.stress4
  );

  // 4. Responsive Viewport Audit across Desktop, iPad Landscape, iPad Portrait & Mobile
  for (const [w, h] of [
    [1440, 900],
    [1280, 800],
    [1024, 768],
    [768, 1024],
    [390, 844]
  ]) {
    await viewport(w, h);
    await sleep(80);
    await shot(`p7-${w}x${h}-studio`);
    const metrics = await c.evaluate(`(()=>{
      const overflow = document.documentElement.scrollWidth > window.innerWidth;
      const topbar = document.querySelector('.st-topbar')?.getBoundingClientRect();
      return { overflow, topbarOk: !!topbar && topbar.right <= window.innerWidth + 1 };
    })()`);
    assert(`${w}x${h} Studio fits without horizontal overflow`, !metrics.overflow && metrics.topbarOk, metrics);

    // Check More menu fits inside viewport
    await click("#st-export-menu-btn");
    await sleep(40);
    const menu = await c.evaluate(`(()=>{
      const el = document.getElementById('st-export-menu');
      const r = el.getBoundingClientRect();
      return { visible: !el.hidden, left: r.left, top: r.top, right: r.right, bottom: r.bottom, w: innerWidth, h: innerHeight };
    })()`);
    assert(
      `${w}x${h} More menu fits cleanly inside viewport`,
      menu.visible && menu.left >= 0 && menu.top >= 0 && menu.right <= menu.w + 1 && menu.bottom <= menu.h + 1,
      menu
    );
    await click("#st-export-menu-btn");
  }

  // Zero native browser confirm/alert/prompt calls
  const nativeDialogs = await c.evaluate("window.__nativeDialogs");
  assert("Zero native window.confirm/alert/prompt dialogs invoked", nativeDialogs.length === 0, nativeDialogs);
  assert("Zero uncaught browser errors", errors.length === 0, errors);

  fs.writeFileSync(
    `${out}/report.json`,
    JSON.stringify(
      {
        environment: "Linux Headless Chromium; viewport emulation, not physical macOS/iPadOS devices",
        bench,
        workflow4,
        checks,
        errors
      },
      null,
      2
    )
  );
  console.log(JSON.stringify({ passed: checks.filter((x) => x.pass).length, total: checks.length, workflow4, bench, errors }, null, 2));
} finally {
  c?.close();
  chrome.kill("SIGKILL");
}
