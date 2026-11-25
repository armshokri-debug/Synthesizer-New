/**
 * SY-1 Studio — Phase 7.1 Focused Chromium Verification
 *
 * Verifies in real headless Chromium (Desktop 1440x900 + iPad Touch 1024x768):
 * 1. Per-track instrument selection & editing across Track 1 (Tabriz), Track 2 (Yazd),
 *    Track 3 (Baku), Track 4 (Kerman) — changing instrument/preset focuses that track,
 *    Instrument editor always reflects focused track, knob edits affect ONLY that track.
 * 2. MIDI Velocity editing (1–127):
 *    - Logic Pro iPad-style Velocity Mode toggle & vertical mouse drag on multi-selected
 *      notes preserving relative velocity differences without changing pitch/timing.
 *    - Precise numeric velocity input (1..127 bounds + relative multi-note edit).
 *    - Velocity Lane drag down to MIDI 1.
 *    - Real CDP Touch drag (Input.dispatchTouchEvent) in Velocity Mode & Velocity Lane
 *      at iPad viewport (1024x768).
 * 3. Save + full Page.reload() verifying edited velocities and all 4 tracks' instruments,
 *    custom knob patches, and MIDI notes survive identically.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const BASE_URL = process.env.SY1_URL || "http://localhost:3000/";
const CHROME_BIN =
  process.env.SY1_CHROME_BIN ||
  "/ms-playwright/chrome-headless-shell-linux64/chrome-headless-shell";
const PORT = Number(process.env.SY1_CDP_PORT || 9241);
const EVIDENCE_DIR = process.env.SY1_EVIDENCE_DIR || "/tmp/sy1-p71-verify";

fs.mkdirSync(EVIDENCE_DIR, { recursive: true });

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

async function waitForChrome(timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const targets = await fetchJson(`http://127.0.0.1:${PORT}/json/list`);
      const page = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch {}
    await wait(200);
  }
  throw new Error("Timed out waiting for headless Chromium CDP target");
}

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.events = [];
    this.consoleErrors = [];
    this.pageErrors = [];
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        else resolve(msg.result);
      } else if (msg.method) {
        if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") {
          const text = msg.params.args.map((a) => a.value ?? a.description ?? "").join(" ");
          if (!/WebSocket|HMR/i.test(text)) this.consoleErrors.push(text);
        } else if (msg.method === "Runtime.exceptionThrown") {
          const desc = msg.params.exceptionDetails?.exception?.description || msg.params.exceptionDetails?.text || "Unknown exception";
          this.pageErrors.push(desc);
        }
      }
    });
  }
  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expression) {
    const res = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true
    });
    if (res.exceptionDetails) {
      throw new Error(`Eval exception: ${res.exceptionDetails.exception?.description || res.exceptionDetails.text}`);
    }
    return res.result?.value;
  }
  async mouseDrag(x1, y1, x2, y2, steps = 8) {
    await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: x1, y: y1, buttons: 0 });
    await this.send("Input.dispatchMouseEvent", { type: "mousePressed", x: x1, y: y1, button: "left", buttons: 1, clickCount: 1 });
    for (let i = 1; i <= steps; i++) {
      const x = x1 + ((x2 - x1) * i) / steps;
      const y = y1 + ((y2 - y1) * i) / steps;
      await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "left", buttons: 1 });
      await wait(16);
    }
    await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: x2, y: y2, button: "left", buttons: 0, clickCount: 1 });
    await wait(80);
  }
  async mouseClick(x, y, modifiers = 0) {
    await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, modifiers, buttons: 0 });
    await this.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, modifiers, clickCount: 1 });
    await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, modifiers, clickCount: 1 });
    await wait(70);
  }
  async touchDrag(x1, y1, x2, y2, steps = 8) {
    await this.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: Math.round(x1), y: Math.round(y1), radiusX: 12, radiusY: 12, force: 1, id: 1 }]
    });
    for (let i = 1; i <= steps; i++) {
      const x = x1 + ((x2 - x1) * i) / steps;
      const y = y1 + ((y2 - y1) * i) / steps;
      await this.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x: Math.round(x), y: Math.round(y), radiusX: 12, radiusY: 12, force: 1, id: 1 }]
      });
      await wait(18);
    }
    await this.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: []
    });
    await wait(90);
  }
}

async function run() {
  const userDataDir = path.join(EVIDENCE_DIR, `profile-${Date.now()}`);
  const chrome = spawn(
    CHROME_BIN,
    [
      "--headless=new",
      "--no-sandbox",
      "--disable-gpu",
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${userDataDir}`,
      "--window-size=1440,900",
      "about:blank"
    ],
    { stdio: "ignore" }
  );

  try {
    const target = await waitForChrome();
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve, { once: true });
      ws.addEventListener("error", reject, { once: true });
    });

    const cdp = new CDP(ws);
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 1440,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false
    });

    await cdp.send("Page.navigate", { url: BASE_URL });
    await wait(1200);
    await cdp.eval(`window.SY1_STUDIO?.ready`);

    // Open Studio workspace
    await cdp.eval(`document.getElementById('sr-edit')?.click()`);
    await wait(450);

    const studioVisible = await cdp.eval(`(() => {
      const el = document.getElementById('sy1-studio');
      return !!el && !el.hidden;
    })()`);
    assert(studioVisible, "Studio view should be open and visible");

    // ---------------------------------------------------------
    // PART 1: Per-Track Instrument Isolation (Tabriz, Yazd, Baku, Kerman)
    // ---------------------------------------------------------
    // Ensure 4 tracks exist
    await cdp.eval(`(() => {
      for (let i = 0; i < 4; i++) {
        if (document.querySelectorAll('.st-track').length >= 4) break;
        document.querySelector('[data-st-action="add-track"]')?.click();
      }
    })()`);
    await wait(250);

    const trackCount = await cdp.eval(`document.querySelectorAll('.st-track').length`);
    assert(trackCount === 4, `Expected 4 tracks, got ${trackCount}`);

    // Switch bottom dock to Instrument tab
    await cdp.eval(`document.getElementById('st-tab-instrument')?.click()`);
    await wait(150);

    // Set Track 1=sy1 (Tabriz), Track 2=yazd, Track 3=baku, Track 4=kerman via track dropdowns
    const setTrackMachine = async (trackId, machineId) => {
      await cdp.eval(`(() => {
        const sel = document.querySelector('select[data-st-select="machine"][data-track-id="${trackId}"]');
        if (!sel) throw new Error("Missing machine select for ${trackId}");
        sel.value = "${machineId}";
        sel.dispatchEvent(new Event('change', { bubbles: true }));
      })()`);
      await wait(160);
    };

    await setTrackMachine("track-1", "tabriz");
    await setTrackMachine("track-2", "yazd");
    const afterT2 = await cdp.eval(`(() => {
      const root = document.querySelector('.st-embedded-synth');
      return { trackId: root?.dataset.trackId, machine: root?.dataset.machine };
    })()`);
    assert(afterT2.trackId === "track-2" && afterT2.machine === "yazd",
      `Changing Track 2 machine must focus Track 2 and show Yazd in Instrument editor, got ${JSON.stringify(afterT2)}`);

    await setTrackMachine("track-3", "baku");
    await setTrackMachine("track-4", "kerman");
    const afterT4 = await cdp.eval(`(() => {
      const root = document.querySelector('.st-embedded-synth');
      return { trackId: root?.dataset.trackId, machine: root?.dataset.machine };
    })()`);
    assert(afterT4.trackId === "track-4" && afterT4.machine === "kerman",
      `Changing Track 4 machine must focus Track 4 and show Kerman in Instrument editor, got ${JSON.stringify(afterT4)}`);

    // Drag a knob on Track 4 (Kerman -> kickTune), then Track 1 (Tabriz -> cutoff), then Track 2 (Yazd -> cutoff), then Track 3 (Baku -> res)
    const dragKnobOnTrack = async (trackId, expectedMachine, paramKey, deltaY) => {
      await cdp.eval(`(() => {
        const btn = document.querySelector('.st-track[data-track-id="${trackId}"] [data-st-action="open-track-instrument"]');
        if (!btn) throw new Error("Missing Edit button for ${trackId}");
        btn.click();
      })()`);
      await wait(160);
      const info = await cdp.eval(`(() => {
        const root = document.querySelector('.st-embedded-synth');
        const knob = root?.querySelector('.st-inst-knob[data-st-param="${paramKey}"]');
        if (!knob) return { error: 'missing knob ${paramKey}', trackId: root?.dataset.trackId, machine: root?.dataset.machine };
        knob.scrollIntoView({ block: 'center', inline: 'center' });
        const r = knob.getBoundingClientRect();
        return {
          trackId: root?.dataset.trackId,
          machine: root?.dataset.machine,
          x: r.left + r.width / 2,
          y: r.top + r.height / 2,
          before: knob.querySelector('.sk-val')?.textContent || ''
        };
      })()`);
      assert(!info.error, `Knob lookup failed for ${trackId}/${paramKey}: ${JSON.stringify(info)}`);
      assert(info.trackId === trackId && info.machine === expectedMachine,
        `Instrument editor mismatch on ${trackId}: expected ${expectedMachine}, got ${JSON.stringify(info)}`);
      await cdp.mouseDrag(info.x, info.y, info.x, info.y + deltaY, 8);
      await wait(120);
      const after = await cdp.eval(`document.querySelector('.st-embedded-synth[data-track-id="${trackId}"] .st-inst-knob[data-st-param="${paramKey}"] .sk-val')?.textContent || ''`);
      assert(after !== info.before, `Dragging ${paramKey} on ${trackId} should change value (was "${info.before}", still "${after}")`);
      await cdp.eval(`document.getElementById('st-inst-back-btn')?.click()`);
      await wait(120);
      return { before: info.before, after };
    };

    const kermanEdit = await dragKnobOnTrack("track-4", "kerman", "kickTune", -48);
    const tabrizEdit = await dragKnobOnTrack("track-1", "tabriz", "cutoff", -60);
    const yazdEdit = await dragKnobOnTrack("track-2", "yazd", "cutoff", 55);
    const bakuEdit = await dragKnobOnTrack("track-3", "baku", "res", -55);

    // Verify clicking Track 1 header re-shows Tabriz with its exact edited cutoff (unchanged by Yazd/Baku/Kerman edits!)
    await cdp.eval(`document.querySelector('.st-track[data-track-id="track-1"] [data-st-action="focus-track"]')?.click()`);
    await wait(140);
    const t1Check = await cdp.eval(`({
      trackId: document.querySelector('.st-embedded-synth')?.dataset.trackId,
      machine: document.querySelector('.st-embedded-synth')?.dataset.machine,
      cutoff: document.querySelector('.st-embedded-synth .st-inst-knob[data-st-param="cutoff"] .sk-val')?.textContent
    })`);
    assert(t1Check.trackId === "track-1" && t1Check.machine === "tabriz" && t1Check.cutoff === tabrizEdit.after,
      `Track 1 Tabriz patch must stay isolated: expected "${tabrizEdit.after}", got ${JSON.stringify(t1Check)}`);

    // Verify Track 2 Yazd cutoff is also intact
    await cdp.eval(`document.querySelector('.st-track[data-track-id="track-2"] [data-st-action="focus-track"]')?.click()`);
    await wait(140);
    const t2Check = await cdp.eval(`({
      trackId: document.querySelector('.st-embedded-synth')?.dataset.trackId,
      machine: document.querySelector('.st-embedded-synth')?.dataset.machine,
      cutoff: document.querySelector('.st-embedded-synth .st-inst-knob[data-st-param="cutoff"] .sk-val')?.textContent
    })`);
    assert(t2Check.trackId === "track-2" && t2Check.machine === "yazd" && t2Check.cutoff === yazdEdit.after,
      `Track 2 Yazd patch must stay isolated: expected "${yazdEdit.after}", got ${JSON.stringify(t2Check)}`);

    // ---------------------------------------------------------
    // PART 2: MIDI Velocity Editing (Desktop Mouse + Numeric + Multi-Select + Lane)
    // ---------------------------------------------------------
    // Focus Track 1 (Tabriz) and switch to Piano Roll
    await cdp.eval(`document.querySelector('.st-track[data-track-id="track-1"] [data-st-action="focus-track"]')?.click()`);
    await wait(100);
    await cdp.eval(`document.getElementById('st-tab-pianoroll')?.click()`);
    await wait(180);

    // Paint 3 notes on Track 1 by clicking distinct visible grid positions inside #st-pr-scroll
    const gridRect = await cdp.eval(`(() => {
      const s = document.getElementById('st-pr-scroll');
      const g = document.getElementById('st-pr-grid');
      const sr = s.getBoundingClientRect();
      const gr = g.getBoundingClientRect();
      const visLeft = Math.max(sr.left + 64, gr.left + 12);
      const visTop = Math.max(sr.top + 32, gr.top + 12);
      return { left: visLeft, top: visTop, right: sr.right - 16, bottom: sr.bottom - 16 };
    })()`);
    await cdp.mouseClick(gridRect.left + 32, gridRect.top + 36);
    await cdp.mouseClick(gridRect.left + 112, gridRect.top + 56);
    await cdp.mouseClick(gridRect.left + 192, gridRect.top + 76);
    await wait(140);

    const paintedCount = await cdp.eval(`document.querySelectorAll('#st-pr-notes .st-pr-note').length`);
    assert(paintedCount === 3, `Expected 3 painted notes, got ${paintedCount}`);

    // Helper to read notes state (midi, left, width, velMidi)
    const readNotes = () => cdp.eval(`Array.from(document.querySelectorAll('#st-pr-notes .st-pr-note')).map(el => ({
      idx: Number(el.dataset.prNoteIdx),
      midi: Number(el.dataset.prMidi),
      vel: Number(el.dataset.prVelMidi),
      left: el.style.left,
      width: el.style.width,
      selected: el.classList.contains('is-selected')
    }))`);

    const setVelInput = async (val) => {
      await cdp.eval(`(() => {
        const inp = document.getElementById('st-pr-vel-input');
        inp.focus();
        inp.value = String(${val});
        inp.dispatchEvent(new Event('change', { bubbles: true }));
        inp.blur();
      })()`);
      await wait(120);
    };

    const clickNote = async (idx, shift = false) => {
      const pt = await cdp.eval(`(() => {
        const el = document.querySelector('#st-pr-notes .st-pr-note[data-pr-note-idx="${idx}"]');
        const r = el.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      })()`);
      // CDP modifier bit 8 = Shift
      await cdp.mouseClick(pt.x, pt.y, shift ? 8 : 0);
      await wait(80);
    };

    // Set individual velocities: note 0 -> 1 (test min bound), then 127 (test max bound), then [40, 80, 110]
    await clickNote(0, false);
    await setVelInput(1);
    let notes = await readNotes();
    assert(notes[0].vel === 1, `Expected note 0 velocity 1, got ${notes[0].vel}`);

    await setVelInput(127);
    notes = await readNotes();
    assert(notes[0].vel === 127, `Expected note 0 velocity 127, got ${notes[0].vel}`);

    await setVelInput(40);
    await clickNote(1, false);
    await setVelInput(80);
    await clickNote(2, false);
    await setVelInput(110);
    notes = await readNotes();
    assert(JSON.stringify(notes.map((n) => n.vel)) === "[40,80,110]", `Expected [40,80,110], got ${JSON.stringify(notes.map((n) => n.vel))}`);
    const origGeom = notes.map((n) => ({ midi: n.midi, left: n.left, width: n.width }));

    // Multi-select all 3 notes (click 0, Shift+click 1, Shift+click 2)
    await clickNote(0, false);
    await clickNote(1, true);
    await clickNote(2, true);
    const rangeText = await cdp.eval(`document.getElementById('st-pr-vel-readout')?.textContent?.trim()`);
    assert(rangeText === "40–110", `Expected multi-select readout "40–110", got "${rangeText}"`);

    // Enable Logic Pro iPad-style Velocity Mode
    await cdp.eval(`document.getElementById('st-pr-vel-mode')?.click()`);
    await wait(120);
    const velModeOn = await cdp.eval(`document.getElementById('st-piano-roll')?.classList.contains('is-vel-mode')`);
    assert(velModeOn, "Velocity Mode class .is-vel-mode must be active");

    // Drag vertically UP by 18px on Note 1 (selected) in Velocity Mode -> deltaMidi = +12 -> [52, 92, 122]
    const n1Pt = await cdp.eval(`(() => {
      const el = document.querySelector('#st-pr-notes .st-pr-note[data-pr-note-idx="1"]');
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`);
    await cdp.mouseDrag(n1Pt.x, n1Pt.y, n1Pt.x, n1Pt.y - 18, 6);
    await wait(120);

    notes = await readNotes();
    const velsAfterDrag = notes.map((n) => n.vel);
    assert(velsAfterDrag[0] > 40 && velsAfterDrag[1] > 80 && velsAfterDrag[2] > 110,
      `Velocity Mode drag UP should raise all 3 selected notes, got ${JSON.stringify(velsAfterDrag)}`);
    assert(velsAfterDrag[1] - velsAfterDrag[0] === 40 && velsAfterDrag[2] - velsAfterDrag[1] === 30,
      `Relative velocity differences (40, 30) must be preserved, got ${JSON.stringify(velsAfterDrag)}`);
    // Pitch & timing must be untouched
    assert(JSON.stringify(notes.map((n) => ({ midi: n.midi, left: n.left, width: n.width }))) === JSON.stringify(origGeom),
      `Velocity Mode drag must NOT change note pitch or timing`);

    // Numeric edit on multi-selected notes: target mean -10 -> preserves (40, 30) differences
    const curAvg = Math.round((velsAfterDrag[0] + velsAfterDrag[1] + velsAfterDrag[2]) / 3);
    await setVelInput(curAvg - 10);
    notes = await readNotes();
    const velsAfterNumeric = notes.map((n) => n.vel);
    assert(velsAfterNumeric[1] - velsAfterNumeric[0] === 40 && velsAfterNumeric[2] - velsAfterNumeric[1] === 30,
      `Numeric velocity edit must preserve relative differences, got ${JSON.stringify(velsAfterNumeric)}`);

    // ---------------------------------------------------------
    // PART 3: iPad Touch Emulation (1024x768) — Velocity Mode Touch Drag & Velocity Lane Touch Drag
    // ---------------------------------------------------------
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 1024,
      height: 768,
      deviceScaleFactor: 2,
      mobile: true
    });
    await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
    await wait(250);

    const overflowIpad = await cdp.eval(`document.documentElement.scrollWidth > window.innerWidth + 2`);
    assert(!overflowIpad, "iPad 1024x768 viewport must have zero horizontal overflow");

    // Touch-drag Note 0 vertically UP in Velocity Mode (single note select + drag)
    const t0Pt = await cdp.eval(`(() => {
      const el = document.querySelector('#st-pr-notes .st-pr-note[data-pr-note-idx="0"]');
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, vel: Number(el.dataset.prVelMidi) };
    })()`);
    // First deselect multi-select by tapping empty visible grid (in velMode it clears selection without adding a note!)
    const emptyPt = await cdp.eval(`(() => {
      const s = document.getElementById('st-pr-scroll');
      const sr = s.getBoundingClientRect();
      return { x: sr.right - 40, y: sr.top + 40 };
    })()`);
    await cdp.mouseClick(emptyPt.x, emptyPt.y);
    await wait(90);
    const countAfterEmptyTap = await cdp.eval(`document.querySelectorAll('#st-pr-notes .st-pr-note').length`);
    assert(countAfterEmptyTap === 3, `Tapping empty grid in Velocity Mode must NOT create stray notes, got ${countAfterEmptyTap}`);

    // Touch-drag Note 0 down to lower velocity cleanly
    await cdp.touchDrag(t0Pt.x, t0Pt.y, t0Pt.x, t0Pt.y + 30, 6);
    await wait(120);
    notes = await readNotes();
    assert(notes[0].vel < t0Pt.vel, `iPad touch drag DOWN in Velocity Mode should lower note 0 velocity (was ${t0Pt.vel}, got ${notes[0].vel})`);

    // Touch-drag Velocity Lane stem 0 to the bottom edge -> must reach exact MIDI 1!
    const stem0Pt = await cdp.eval(`(() => {
      const stem = document.querySelector('#st-pr-vel-lane [data-pr-vel-idx="0"]');
      const lane = document.getElementById('st-pr-vel-lane');
      const sr = stem.getBoundingClientRect();
      const lr = lane.getBoundingClientRect();
      return { x: sr.left + sr.width / 2, y: lr.top + lr.height * 0.5, bottomY: lr.bottom - 1, topY: lr.top + 1 };
    })()`);
    await cdp.touchDrag(stem0Pt.x, stem0Pt.y, stem0Pt.x, stem0Pt.bottomY, 6);
    await wait(120);
    notes = await readNotes();
    assert(notes[0].vel === 1, `Touch-dragging Velocity Lane stem to bottom must reach MIDI 1, got ${notes[0].vel}`);

    // Touch-drag Velocity Lane stem 2 to the top edge -> must reach exact MIDI 127!
    const stem2Pt = await cdp.eval(`(() => {
      const stem = document.querySelector('#st-pr-vel-lane [data-pr-vel-idx="2"]');
      const lane = document.getElementById('st-pr-vel-lane');
      const sr = stem.getBoundingClientRect();
      const lr = lane.getBoundingClientRect();
      return { x: sr.left + sr.width / 2, y: lr.top + lr.height * 0.5, topY: lr.top + 1 };
    })()`);
    await cdp.touchDrag(stem2Pt.x, stem2Pt.y, stem2Pt.x, stem2Pt.topY, 6);
    await wait(120);
    notes = await readNotes();
    assert(notes[2].vel === 127, `Touch-dragging Velocity Lane stem to top must reach MIDI 127, got ${notes[2].vel}`);

    const preSaveVels = notes.map((n) => n.vel);
    const preSaveGeom = notes.map((n) => ({ midi: n.midi, left: n.left, width: n.width }));

    // ---------------------------------------------------------
    // PART 4: Save + Full Page Reload Persistence Check
    // ---------------------------------------------------------
    await cdp.eval(`document.getElementById('st-save-btn')?.click()`);
    await wait(600);
    const saveStateText = await cdp.eval(`document.getElementById('st-save-state')?.textContent?.trim()`);
    assert(saveStateText === "Saved", `Expected save state "Saved", got "${saveStateText}"`);

    // Full page reload
    await cdp.send("Page.reload", { ignoreCache: true });
    await wait(1400);
    await cdp.eval(`window.SY1_STUDIO?.ready`);

    // Re-open Studio
    await cdp.eval(`document.getElementById('sr-edit')?.click()`);
    await wait(650);

    // Verify all 4 tracks' machines survived reload
    const reloadedMachines = await cdp.eval(`Array.from(document.querySelectorAll('select[data-st-select="machine"]')).map(s => s.value)`);
    assert(JSON.stringify(reloadedMachines) === JSON.stringify(["tabriz", "yazd", "baku", "kerman"]),
      `Reloaded 4-track machines mismatch: ${JSON.stringify(reloadedMachines)}`);

    // Verify Track 1 edited velocities (including 1 and 127) and note geometry survived reload
    await cdp.eval(`document.querySelector('.st-track[data-track-id="track-1"] [data-st-action="focus-track"]')?.click()`);
    await wait(120);
    await cdp.eval(`document.getElementById('st-tab-pianoroll')?.click()`);
    await wait(180);
    const postReloadNotes = await readNotes();
    assert(JSON.stringify(postReloadNotes.map((n) => n.vel)) === JSON.stringify(preSaveVels),
      `Velocities did not survive reload: before=${JSON.stringify(preSaveVels)}, after=${JSON.stringify(postReloadNotes.map((n) => n.vel))}`);
    assert(JSON.stringify(postReloadNotes.map((n) => ({ midi: n.midi, left: n.left, width: n.width }))) === JSON.stringify(preSaveGeom),
      `Note geometry changed across reload`);

    // Verify Track 1..4 custom knob values survived reload
    await cdp.eval(`document.querySelector('.st-track[data-track-id="track-1"] [data-st-action="open-track-instrument"]')?.click()`);
    await wait(150);
    const reloadT1Cutoff = await cdp.eval(`document.querySelector('.st-embedded-synth[data-track-id="track-1"] .st-inst-knob[data-st-param="cutoff"] .sk-val')?.textContent`);
    assert(reloadT1Cutoff === tabrizEdit.after, `Track 1 cutoff did not survive reload: expected ${tabrizEdit.after}, got ${reloadT1Cutoff}`);

    await cdp.eval(`document.querySelector('.st-track[data-track-id="track-2"] [data-st-action="open-track-instrument"]')?.click()`);
    await wait(150);
    const reloadT2Cutoff = await cdp.eval(`document.querySelector('.st-embedded-synth[data-track-id="track-2"] .st-inst-knob[data-st-param="cutoff"] .sk-val')?.textContent`);
    assert(reloadT2Cutoff === yazdEdit.after, `Track 2 cutoff did not survive reload: expected ${yazdEdit.after}, got ${reloadT2Cutoff}`);

    await cdp.eval(`document.querySelector('.st-track[data-track-id="track-3"] [data-st-action="open-track-instrument"]')?.click()`);
    await wait(150);
    const reloadT3Res = await cdp.eval(`document.querySelector('.st-embedded-synth[data-track-id="track-3"] .st-inst-knob[data-st-param="res"] .sk-val')?.textContent`);
    assert(reloadT3Res === bakuEdit.after, `Track 3 res did not survive reload: expected ${bakuEdit.after}, got ${reloadT3Res}`);

    await cdp.eval(`document.querySelector('.st-track[data-track-id="track-4"] [data-st-action="open-track-instrument"]')?.click()`);
    await wait(150);
    const reloadT4Kick = await cdp.eval(`document.querySelector('.st-embedded-synth[data-track-id="track-4"] .st-inst-knob[data-st-param="kickTune"] .sk-val')?.textContent`);
    assert(reloadT4Kick === kermanEdit.after, `Track 4 kickTune did not survive reload: expected ${kermanEdit.after}, got ${reloadT4Kick}`);

    assert(cdp.consoleErrors.length === 0, `Console errors detected: ${JSON.stringify(cdp.consoleErrors)}`);
    assert(cdp.pageErrors.length === 0, `Page errors detected: ${JSON.stringify(cdp.pageErrors)}`);

    console.log(
      JSON.stringify(
        {
          ok: true,
          tracks: reloadedMachines,
          perTrackEdits: {
            tabrizCutoff: reloadT1Cutoff,
            yazdCutoff: reloadT2Cutoff,
            bakuRes: reloadT3Res,
            kermanKickTune: reloadT4Kick
          },
          velocityChecks: {
            multiSelectDragVels: velsAfterDrag,
            multiSelectNumericVels: velsAfterNumeric,
            savedAndReloadedVels: postReloadNotes.map((n) => n.vel),
            ipadTouchOverflow: overflowIpad
          },
          consoleErrors: cdp.consoleErrors.length,
          pageErrors: cdp.pageErrors.length
        },
        null,
        2
      )
    );
  } finally {
    chrome.kill("SIGKILL");
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
