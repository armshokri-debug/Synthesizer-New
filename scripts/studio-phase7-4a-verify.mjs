/**
 * SY-1 Studio — Phase 7.4A Ultra-Minimal GarageBand-Style Redesign Verification
 *
 * Verifies in headless Chromium:
 * 1. Fresh open: Browser hidden by default, Dock/Piano Roll minimized by default, clean Top Bar.
 * 2. Track lanes contain ONLY icon cue, instrument name/select, M/S/R, compact volume, Edit button.
 * 3. Selecting tracks highlights the focused lane cleanly and keeps non-focused empty lanes calm.
 * 4. Browser opens/filters/picks presets on click and closes cleanly.
 * 5. Bottom panels (Piano Roll / Mixer / Instrument) show strictly one tool at a time.
 * 6. Edit opens full-size per-track editor (.is-inst-focus) and Back preserves selection & state.
 * 7. More menu (with Bars + Keys + Export), Projects drawer, Save, Play/Stop/Record work without errors.
 * 8. Responsive checks at 1440x900, 1280x800, 1024x768, 768x1024, and 390x844 (zero horizontal overflow).
 * 9. Saves after screenshots to /tmp/sy1-p74a-after-*.png for visual inspection.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import { CdpClient, sleep, waitForCdp } from "./studio-cdp.mjs";

const CHROME_BIN =
  process.env.SY1_CHROME_BIN ||
  "/ms-playwright/chrome-headless-shell-linux64/chrome-headless-shell";
const BASE_URL = process.env.SY1_URL || "http://127.0.0.1:3000/";
const PORT = Number(process.env.SY1_CDP_PORT || 9238);

if (!fs.existsSync(CHROME_BIN)) {
  throw new Error(`Chromium binary not found: ${CHROME_BIN}`);
}

const cases = [];
const errors = [];
function assert(name, pass, details) {
  cases.push({ name, pass: Boolean(pass), details });
  if (!pass) throw new Error(`FAILED: ${name} -> ${JSON.stringify(details)}`);
}

async function saveShot(cdp, path) {
  const { data } = await cdp.send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(path, Buffer.from(data, "base64"));
  return fs.statSync(path).size;
}

const chrome = spawn(
  CHROME_BIN,
  [
    "--headless",
    "--no-sandbox",
    "--disable-gpu",
    "--window-size=1440,900",
    "--autoplay-policy=no-user-gesture-required",
    `--remote-debugging-port=${PORT}`,
    "about:blank"
  ],
  { stdio: "ignore" }
);

let cdp;
try {
  cdp = new CdpClient(await waitForCdp(PORT));
  await cdp.connect();
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false
  });
  cdp.on("Runtime.exceptionThrown", (ev) => {
    errors.push(ev.exceptionDetails.exception?.description || ev.exceptionDetails.text);
  });

  await cdp.send("Page.navigate", { url: BASE_URL });
  for (let i = 0; i < 120; i++) {
    if (await cdp.evaluate("!!window.SY1_STUDIO && !!window.SY1")) break;
    await sleep(50);
  }
  await cdp.evaluate("window.SY1_STUDIO.ready");

  // 1. Fresh open & default minimal layout checks (2 tracks created cleanly)
  await cdp.evaluate(`(async () => {
    const api = window.SY1_STUDIO;
    const engine = api.engine;
    api.open();
    await engine.createNewProject({ name: "Morning Sketch" });
    while (engine.getTracks().length < 2) engine.addTrack();
    engine.setTrackMachinePreset(engine.getTracks()[1].id, "kerman", "kit:studio");
    document.querySelector('.st-track[data-track-id="' + engine.getTracks()[0].id + '"] [data-st-action="focus-track"]')?.click();
  })()`);
  await sleep(80);

  const initialMetrics = await cdp.evaluate(`(() => {
    const browser = document.getElementById("st-browser");
    const daw = document.querySelector(".st-daw");
    const dockBody = document.getElementById("st-dock-body");
    const exportMenu = document.getElementById("st-export-menu");
    const topbarVisibleBtns = Array.from(document.querySelectorAll(".st-topbar button, .st-topbar input"))
      .filter((el) => el.offsetParent !== null && !el.closest(".st-export-menu")).length;
    const topbarHeight = Math.round(document.querySelector(".st-topbar")?.getBoundingClientRect().height || 0);
    const trackCtlEls = Array.from(document.querySelectorAll(".st-track-ctl"));
    const trackHeights = Array.from(document.querySelectorAll(".st-track")).map((el) => Math.round(el.getBoundingClientRect().height));
    const clutterSelectors = [".st-preset-sel", ".st-pan-wrap", ".st-hdr-meter", ".st-track-stats", ".st-ch-select", '[data-st-action="clear-track"]'];
    const clutterInTrackCtl = clutterSelectors.reduce(
      (sum, sel) => sum + document.querySelectorAll(".st-track-ctl " + sel).length,
      0
    );
    const emptyPrompts = document.querySelectorAll(".st-lane-empty").length;
    const brandVisible = !!document.querySelector(".st-brand");
    const focusedTracks = document.querySelectorAll(".st-track.is-focused").length;
    return {
      browserHidden: browser ? browser.hasAttribute("hidden") && getComputedStyle(browser).display === "none" : false,
      dockCollapsed: daw?.classList.contains("is-dock-collapsed") && dockBody?.hasAttribute("hidden"),
      moreMenuHidden: exportMenu ? exportMenu.hasAttribute("hidden") : false,
      barsInsideMore: document.querySelectorAll("#st-export-menu [data-st-action='set-bars']").length,
      topbarVisibleBtns,
      topbarHeight,
      trackCount: trackCtlEls.length,
      trackHeights,
      clutterInTrackCtl,
      emptyPrompts,
      brandVisible,
      focusedTracks
    };
  })()`);

  assert(
    "Fresh Studio opens with hidden Browser, collapsed Dock, single-row Top Bar, and clean track lanes",
    initialMetrics.browserHidden &&
      initialMetrics.dockCollapsed &&
      initialMetrics.moreMenuHidden &&
      initialMetrics.barsInsideMore >= 4 &&
      initialMetrics.topbarHeight <= 50 &&
      initialMetrics.topbarVisibleBtns <= 16 &&
      initialMetrics.clutterInTrackCtl === 0 &&
      initialMetrics.emptyPrompts === 1 &&
      !initialMetrics.brandVisible &&
      initialMetrics.focusedTracks === 1 &&
      initialMetrics.trackHeights.every((h) => h <= 86),
    initialMetrics
  );

  const afterStudioBytes = await saveShot(cdp, "/tmp/sy1-p74a-after-studio.png");

  // 2. Open Browser, filter Drums, pick preset, close
  const browserFlow = await cdp.evaluate(`(async () => {
    const waitFrame = () => new Promise((r) => setTimeout(r, 40));
    document.getElementById("st-browser-toggle")?.click();
    await waitFrame();
    const browser = document.getElementById("st-browser");
    const isOpen = browser ? !browser.hasAttribute("hidden") && getComputedStyle(browser).display !== "none" : false;
    const width = Math.round(browser?.getBoundingClientRect().width || 0);
    document.querySelector('[data-st-action="browser-machine"][data-st-machine="synths"]')?.click();
    await waitFrame();
    const firstPreset = document.querySelector('.st-br-preset-btn');
    const chosenMachine = firstPreset?.getAttribute("data-st-machine");
    const chosenPreset = firstPreset?.getAttribute("data-st-preset");
    firstPreset?.click();
    await waitFrame();
    return {
      isOpen,
      width,
      chosenMachine,
      chosenPreset,
      focusedMachine: window.SY1_STUDIO.engine.getFocusedTrack().machineId,
      focusedPreset: window.SY1_STUDIO.engine.getFocusedTrack().presetId
    };
  })()`);

  assert(
    "Browser opens on click, narrows cleanly, and loads selected preset onto focused track",
    browserFlow.isOpen &&
      browserFlow.width <= 236 &&
      browserFlow.focusedMachine === browserFlow.chosenMachine &&
      browserFlow.focusedPreset === browserFlow.chosenPreset,
    browserFlow
  );

  const afterBrowserBytes = await saveShot(cdp, "/tmp/sy1-p74a-after-browser.png");

  await cdp.evaluate(`(() => { document.getElementById("st-browser-toggle")?.click(); })()`);
  await sleep(40);

  // 3. Track selection & focus transfer
  const selectFlow = await cdp.evaluate(`(async () => {
    const waitFrame = () => new Promise((r) => setTimeout(r, 40));
    const t2 = window.SY1_STUDIO.engine.getTracks()[1];
    document.querySelector('.st-track[data-track-id="' + t2.id + '"] [data-st-action="focus-track"]')?.click();
    await waitFrame();
    const focused = window.SY1_STUDIO.engine.getFocusedTrack();
    const t2HasFocusClass = document.querySelector('.st-track[data-track-id="' + t2.id + '"]')?.classList.contains("is-focused");
    const dockTrackLabel = document.querySelector(".st-dock-track-name")?.textContent?.trim();
    return { focusedId: focused.id, t2Id: t2.id, t2HasFocusClass, dockTrackLabel };
  })()`);

  assert(
    "Clicking Track 2 focuses that track and updates dock context",
    selectFlow.focusedId === selectFlow.t2Id && selectFlow.t2HasFocusClass,
    selectFlow
  );

  // 4. Bottom Dock: strictly one tool at a time (Piano Roll -> Mixer -> Instrument -> Close)
  const dockFlow = await cdp.evaluate(`(async () => {
    const waitFrame = () => new Promise((r) => setTimeout(r, 50));

    document.getElementById("st-tab-pianoroll")?.click();
    await waitFrame();
    const prOpen = !!document.getElementById("st-piano-roll") && !document.getElementById("st-mixer") && !document.querySelector(".st-inst-wrap");

    document.getElementById("st-tab-mixer")?.click();
    await waitFrame();
    const mixerEl = document.getElementById("st-mixer");
    const stripW = Math.round(document.querySelector(".st-mix-strip")?.getBoundingClientRect().width || 0);
    const mixerOpenOnly = !!mixerEl && !document.getElementById("st-piano-roll") && !document.querySelector(".st-inst-wrap");

    return { prOpen, mixerOpenOnly, stripW };
  })()`);

  const afterMixerBytes = await saveShot(cdp, "/tmp/sy1-p74a-after-mixer.png");

  const dockFlowPart2 = await cdp.evaluate(`(async () => {
    const waitFrame = () => new Promise((r) => setTimeout(r, 50));
    document.getElementById("st-tab-instrument")?.click();
    await waitFrame();
    const instOnly = !!document.querySelector(".st-inst-wrap") && !document.getElementById("st-piano-roll") && !document.getElementById("st-mixer");

    document.getElementById("st-dock-collapse")?.click();
    await waitFrame();
    const collapsedAgain = document.querySelector(".st-daw")?.classList.contains("is-dock-collapsed") &&
      document.getElementById("st-dock-body")?.hasAttribute("hidden");

    return { instOnly, collapsedAgain };
  })()`);

  assert(
    "Bottom dock shows strictly one tool at a time and collapses cleanly",
    dockFlow.prOpen &&
      dockFlow.mixerOpenOnly &&
      dockFlow.stripW <= 120 &&
      dockFlowPart2.instOnly &&
      dockFlowPart2.collapsedAgain,
    { dockFlow, dockFlowPart2 }
  );

  // 5. Edit button -> full-size instrument focus -> Back to Studio
  const t1Id = await cdp.evaluate("window.SY1_STUDIO.engine.getTracks()[0].id");
  await cdp.evaluate(`(async () => {
    document.querySelector('.st-track[data-track-id="${t1Id}"] [data-st-action="open-track-instrument"]')?.click();
  })()`);
  await sleep(60);

  const editState = await cdp.evaluate(`(() => {
    const daw = document.querySelector(".st-daw");
    const synth = document.querySelector(".st-embedded-synth");
    const backBtn = document.getElementById("st-inst-back-btn");
    return {
      isFocus: daw?.classList.contains("is-inst-focus") && window.SY1_STUDIO.isInstrumentFocusOpen(),
      trackId: synth?.getAttribute("data-track-id"),
      hasBack: !!backBtn
    };
  })()`);

  const afterEditBytes = await saveShot(cdp, "/tmp/sy1-p74a-after-edit.png");

  await cdp.evaluate(`(() => { document.getElementById("st-inst-back-btn")?.click(); })()`);
  await sleep(50);

  const backState = await cdp.evaluate(`(() => ({
    closedFocus: !window.SY1_STUDIO.isInstrumentFocusOpen(),
    focusedId: window.SY1_STUDIO.engine.getFocusedTrack().id
  }))()`);

  assert(
    "Edit opens full-size per-track editor and Back returns with track selected",
    editState.isFocus && editState.trackId === t1Id && editState.hasBack && backState.closedFocus && backState.focusedId === t1Id,
    { editState, backState }
  );

  // 6. Save, Projects drawer, More menu, and Transport Play / Stop / Record
  const controlsFlow = await cdp.evaluate(`(async () => {
    const waitFrame = () => new Promise((r) => setTimeout(r, 40));

    document.getElementById("st-export-menu-btn")?.click();
    await waitFrame();
    const moreOpen = !document.getElementById("st-export-menu")?.hasAttribute("hidden");
    document.getElementById("st-export-menu-btn")?.click();
    await waitFrame();

    document.getElementById("st-open-btn")?.click();
    await waitFrame();
    const projectsOpen = !!document.getElementById("st-open-drawer");
    document.getElementById("st-open-btn")?.click();
    await waitFrame();

    document.getElementById("st-save-btn")?.click();
    await waitFrame();
    const saveText = document.getElementById("st-save-state")?.textContent?.trim();

    document.getElementById("st-play-btn")?.click();
    await new Promise((r) => setTimeout(r, 90));
    const wasPlaying = window.SY1_STUDIO.engine.getTransportSnapshot().playing;

    document.getElementById("st-stop-btn")?.click();
    await waitFrame();
    const stopped = !window.SY1_STUDIO.engine.getTransportSnapshot().playing;

    document.getElementById("st-rec-btn")?.click();
    await waitFrame();
    const recTriggered = document.getElementById("st-rec-btn")?.classList.contains("is-active");
    document.getElementById("st-stop-btn")?.click();
    await waitFrame();

    return { moreOpen, projectsOpen, saveText, wasPlaying, stopped, recTriggered };
  })()`);

  assert(
    "More menu, Projects drawer, Save, Play, Stop, and Record all function cleanly",
    controlsFlow.moreOpen &&
      controlsFlow.projectsOpen &&
      controlsFlow.saveText === "Saved" &&
      controlsFlow.wasPlaying &&
      controlsFlow.stopped &&
      controlsFlow.recTriggered,
    controlsFlow
  );

  // 7. Responsive overflow audit across Desktop & iPad/Mobile widths
  const viewports = [
    { width: 1440, height: 900, mobile: false },
    { width: 1280, height: 800, mobile: false },
    { width: 1024, height: 768, mobile: false },
    { width: 768, height: 1024, mobile: true },
    { width: 390, height: 844, mobile: true }
  ];
  const vpResults = [];
  for (const vp of viewports) {
    await cdp.send("Emulation.setDeviceMetricsOverride", { ...vp, deviceScaleFactor: 1 });
    await sleep(40);
    const res = await cdp.evaluate(`(() => {
      const ids = ["st-play-btn", "st-stop-btn", "st-rec-btn", "st-bpm-val"];
      const coreVisible = ids.every((id) => {
        const el = document.getElementById(id);
        return el && el.offsetParent !== null && el.getBoundingClientRect().right <= window.innerWidth + 1;
      });
      const moreMobileCount = document.querySelectorAll("#st-export-menu .st-menu-mobile-group button").length;
      const moreVisibleItems = document.getElementById("st-export-menu") ? getComputedStyle(document.querySelector(".st-menu-mobile-group")).display !== "none" : false;
      return {
        innerWidth: window.innerWidth,
        docScrollWidth: document.documentElement.scrollWidth,
        studioOverflowX: document.getElementById("sy1-studio").scrollWidth > window.innerWidth,
        topbarHeight: Math.round(document.querySelector(".st-topbar")?.getBoundingClientRect().height || 0),
        coreVisible,
        moreMobileCount,
        moreVisibleItems
      };
    })()`);
    vpResults.push({ ...vp, ...res });
  }

  assert(
    "Zero horizontal overflow & compact 2-row mobile topbar across Desktop & iPad/Phone viewports",
    vpResults.every(
      (v) =>
        v.docScrollWidth <= v.innerWidth &&
        !v.studioOverflowX &&
        v.coreVisible &&
        v.topbarHeight <= 92 &&
        (v.innerWidth > 768 || (v.moreVisibleItems && v.moreMobileCount >= 4))
    ),
    vpResults
  );

  assert("Zero runtime exceptions", errors.length === 0, { errors });

  console.log(
    JSON.stringify(
      {
        ok: true,
        passed: cases.length,
        total: cases.length,
        screenshots: {
          afterStudioBytes,
          afterBrowserBytes,
          afterMixerBytes,
          afterEditBytes
        },
        cases
      },
      null,
      2
    )
  );
} catch (err) {
  console.error(JSON.stringify({ ok: false, error: String(err), cases, errors }, null, 2));
  process.exitCode = 1;
} finally {
  if (cdp) cdp.close();
  chrome.kill("SIGKILL");
}
