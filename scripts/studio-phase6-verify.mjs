/** Disposable Chromium CDP session for Phase 6 on the local Vite server. */
import { spawn } from "node:child_process";
import fs from "node:fs";
import { CdpClient, sleep, waitForCdp } from "./studio-cdp.mjs";

const binary = process.env.SY1_CHROME_BIN;
if (!binary || !fs.existsSync(binary)) throw new Error("Set SY1_CHROME_BIN to Chromium headless shell");
const out = process.env.SY1_EVIDENCE_DIR ?? "/tmp/sy1-p6-after";
fs.mkdirSync(out, { recursive: true });
const chrome = spawn(binary, ["--headless", "--no-sandbox", "--disable-gpu",
  "--autoplay-policy=no-user-gesture-required", "--remote-debugging-port=9226", "about:blank"], { stdio: "ignore" });
const cases = [];
const errors = [];
let cdp;
function assert(name, pass, details) {
  cases.push({ name, pass: Boolean(pass), details });
  if (!pass) throw new Error(name + " " + JSON.stringify(details));
}
try {
  cdp = new CdpClient(await waitForCdp(9226));
  await cdp.connect();
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");
  cdp.on("Runtime.exceptionThrown", event => errors.push(event.exceptionDetails.exception?.description || event.exceptionDetails.text));
  const evaluate = expression => cdp.evaluate(expression);
  const viewport = (width, height) => cdp.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
  const wait = async expression => {
    for (let i = 0; i < 150; i++) {
      if (await evaluate(expression)) return;
      await sleep(50);
    }
    throw new Error("Timed out waiting for " + expression);
  };
  const screenshot = async name => {
    const {data} = await cdp.send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(`${out}/${name}.png`, Buffer.from(data, "base64"));
  };
  const point = (selector, fraction = .5) => evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) throw new Error('Missing: ' + ${JSON.stringify(selector)});
    el.scrollIntoView({block:'nearest',inline:'nearest'});
    const r = el.getBoundingClientRect(); return {x:r.left+r.width*${fraction},y:r.top+r.height/2};
  })()`);
  async function mouse(type, p, button = "left", clickCount = 1, modifiers = 0) {
    await cdp.send("Input.dispatchMouseEvent", {type, ...p, button, clickCount, modifiers,
      buttons: type === "mouseReleased" ? 0 : button === "right" ? 2 : 1});
  }
  const click = async (selector, options = {}) => {
    const p = await point(selector, options.fraction);
    await mouse("mousePressed",p,options.button,options.count,options.modifiers);
    await mouse("mouseReleased",p,options.button,options.count,options.modifiers);
  };
  const drag = async (selector, dx) => {
    const start = await point(selector);
    const end = {x:start.x+dx,y:start.y};
    await mouse("mousePressed",start);
    await mouse("mouseMoved",end);
    await mouse("mouseReleased",end);
    await sleep(380);
  };
  const shortcut = async (key, code, modifiers) => {
    await cdp.send("Input.dispatchKeyEvent", {type:"keyDown",key,code,modifiers});
    await cdp.send("Input.dispatchKeyEvent", {type:"keyUp",key,code,modifiers});
  };
  const regions = () => evaluate("(()=>{const e=window.SY1_STUDIO.engine;return e.getTracks().map(t=>e.regions.regions(t.id));})()");
  const region = ".st-midi-region";
  const chosen = region + ".is-selected";
  await viewport(1440,900);
  await cdp.send("Page.navigate", {url:process.env.SY1_URL ?? "http://127.0.0.1:3000"});
  await wait("!!window.SY1_STUDIO");
  await evaluate(`(async()=>{
    const a=window.SY1_STUDIO,e=a.engine;await a.ready;a.open();
    e.replaceTrackNotes(e.getFocusedTrack().id,[
      {midi:60,startTick:0,endTick:720,velocity:.8},{midi:67,startTick:960,endTick:1500,velocity:.7}
    ]);
  })()`);
  await wait("document.querySelectorAll('.st-midi-region').length===1");
  const parity=await evaluate(`(async()=>{
    const e=window.SY1_STUDIO.engine,t=e.getFocusedTrack();
    t.setParam('revMix',0); t.setParam('delayMix',0);
    const project=e.exportProject();
    const legacy=structuredClone(project);
    for(const track of legacy.tracks) delete track.regions;
    const render=async snapshot=>{
      await e.loadProject(snapshot);
      const stem=(await e.bounceTrackStemsWav({bars:1,sampleRate:48000}))[0];
      return new Uint8Array(await stem.wav.arrayBuffer());
    };
    const a=await render(legacy),b=await render(project);
    let differences=0;
    for(let i=0;i<a.length;i++) if(a[i]!==b[i]) differences++;
    return {bytes:a.length,differences,matchingLength:a.length===b.length};
  })()`);
  assert("Unedited migrated region and legacy project render byte-identical audio",
    parity.matchingLength && parity.differences===0,parity);
  await sleep(100);
  await click(region);
  await wait("!!document.querySelector('.st-midi-region.is-selected')");
  const before = (await regions())[0][0];
  await shortcut("d","KeyD",2);
  await wait("document.querySelectorAll('.st-midi-region').length===2");
  assert("Desktop duplicate shortcut creates a second region", (await regions())[0][1].startTick===before.length);
  await drag(chosen+" .st-clip-body",100);
  const moved = (await regions())[0][1];
  assert("Pointer move updates musical time on the snap grid",moved.startTick>before.length && moved.startTick%120===0,moved.startTick);
  await drag(chosen+" [data-region-edge=right]",-30);
  const trimmed = (await regions())[0][1];
  assert("Right-edge trim preserves hidden source MIDI",trimmed.length<moved.length && JSON.stringify(trimmed.events)===JSON.stringify(moved.events),trimmed.length);
  await shortcut("z","KeyZ",2);
  assert("Undo restores the trim boundary",(await regions())[0][1].length===moved.length);
  await drag(chosen+" [data-region-edge=loop]",110);
  const looped = (await regions())[0][1];
  assert("Loop handle extends source repetitions",looped.loop && looped.length>looped.sourceLength);
  await screenshot("desktop-regions");
  await click(chosen+" .st-clip-body");
  await click(chosen+" .st-clip-body",{count:2});
  await wait("!!document.querySelector('#st-piano-roll[data-pr-origin]')");
  assert("Desktop double-click opens the selected Piano Roll",
    await evaluate("Number(document.querySelector('#st-piano-roll').dataset.prOrigin)==="+looped.startTick));
  await screenshot("desktop-region-piano-roll");

  await click(chosen+" .st-region-more");
  await wait("!document.querySelector('.st-region-menu').hidden");
  await screenshot("desktop-context-menu");
  assert("Context action menu offers copy, loop, split and history", await evaluate(`['Copy','Split at playhead','Repeat to arrangement end','Undo'].every(s=>document.querySelector('.st-region-menu').textContent.includes(s))`));
  await shortcut("Escape","Escape",0);
  await evaluate(`(()=>{
    const e=window.SY1_STUDIO.engine;
    e.regions.clearSelection();
    while(e.getTracks().length<4)e.addTrack();
    const ids=['tabriz','yazd','baku','kerman'];
    e.getTracks().forEach((track,i)=>{
      e.setTrackMachinePreset(track.id,ids[i],'init');
      if(i) e.replaceTrackNotes(track.id,[{midi:i===3?36:64+i,startTick:120,endTick:500,velocity:.8}]);
      track.setParam('revMix',0);
      track.setParam('delayMix',0);
    });
  })()`);
  const exports = await evaluate(`(async()=>{
    const e=window.SY1_STUDIO.engine, options={bars:4,sampleRate:48000};
    const stems=await e.bounceTrackStemsWav(options);
    const mix=await e.bounceArrangementWav(options);
    const inspect=async take=>{const u=new Uint8Array(await take.wav.arrayBuffer());const d=new DataView(u.buffer);
      return {bits:d.getUint16(34,true),frames:take.frames,signal:u.subarray(44).some(x=>x!==0)};};
    return {stems:await Promise.all(stems.map(inspect)),mix:await inspect(mix),
      midi:String.fromCharCode(...e.exportMidiBytes().slice(0,4))};
  })()`);
  assert("Mixed Tabriz/Yazd/Baku/Kerman renders non-silent 24-bit Mix and four Stems",
    exports.stems.length===4 && [...exports.stems,exports.mix].every(s=>s.bits===24&&s.frames===exports.mix.frames&&s.signal),exports);
  assert("Mixed regional arrangement exports Standard MIDI",exports.midi==="MThd");
  await evaluate("window.SY1_STUDIO.saveProject()");
  const saved=await regions();
  const loaded=cdp.once("Page.loadEventFired");
  await cdp.send("Page.reload"); await loaded; await wait("!!window.SY1_STUDIO");
  await evaluate("window.SY1_STUDIO.ready");
  assert("Save → Refresh → Restore preserves IDs, trims, loops and event sources",JSON.stringify(await regions())===JSON.stringify(saved));

  await viewport(1024,768);
  await cdp.send("Emulation.setTouchEmulationEnabled",{enabled:true,maxTouchPoints:5});
  await evaluate("window.SY1_STUDIO.open()");
  const drum = "[data-track-id='track-4'][data-st-lane] .st-midi-region";
  const touch = async (type,p) => cdp.send("Input.dispatchTouchEvent",{type,touchPoints:p?[p]:[]});
  const drumPoint=await point(drum);
  await touch("touchStart",drumPoint); await touch("touchEnd");
  await wait(`!!document.querySelector(${JSON.stringify(drum+".is-selected")})`);
  await touch("touchStart",await point(drum)); await sleep(580); await touch("touchEnd");
  await wait("!document.querySelector('.st-region-menu').hidden");
  await screenshot("ipad-touch-context");
  const bounds=await evaluate(`(()=>{const r=document.querySelector('.st-region-menu').getBoundingClientRect();return r.top>=0&&r.left>=0&&r.bottom<=innerHeight&&r.right<=innerWidth})()`);
  assert("iPad landscape touch long-press opens a viewport-contained context menu",bounds);
  const menuPoint=await point(".st-region-menu button:nth-child(2)");
  await touch("touchStart",menuPoint); await touch("touchEnd");
  await wait("document.querySelector('#st-piano-roll[data-pr-mode=drums][data-pr-origin]')");
  assert("Kerman region opens its Drum Grid from a touch action",true);
  await screenshot("ipad-drum-grid");
  const handle=await point(drum+" [data-region-edge=right]");
  const old=(await regions())[3][0].length;
  await evaluate(`window.__touchTrace=[];
    for(const type of ['pointerdown','pointermove','pointerup','pointercancel'])
      document.addEventListener(type,event=>{
        if(event.pointerType==='touch')window.__touchTrace.push([type,event.clientX,event.clientY,event.target.className]);
      },true)`);
  await touch("touchStart",handle);
  await touch("touchMove",{x:handle.x+18,y:handle.y});
  await sleep(45);
  await touch("touchMove",{x:handle.x+35,y:handle.y});
  await touch("touchEnd");
  await sleep(350);
  const newLength=(await regions())[3][0].length;
  assert("Touch drag handle resizes drum region",newLength>old,{old,newLength,handle,trace:await evaluate("window.__touchTrace")});
  // Phase 6.1: Verify Clear Track uses accessible in-app confirmation dialog (never window.confirm)
  // and preserves unrelated Undo/Redo history, plus touch-only Undo/Redo when all regions are cleared.
  await evaluate(`(()=>{
    window.__confirmCalls = 0;
    window.confirm = () => { window.__confirmCalls++; throw new Error('window.confirm must not be called'); };
  })()`);

  // Record a prior edit on Track 4 (resize already pushed history), then test Clear Track on Track 2
  const track2ClearBtn = `button[data-st-action="clear-track"][data-track-id="track-2"]`;
  await viewport(1440, 900);
  await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: false });
  await sleep(80);
  const track2BeforeClear = (await regions())[1].length;
  const track4BeforeClear = (await regions())[3][0].length;
  await click(track2ClearBtn);
  await wait("!!document.querySelector('#st-clear-dialog')");
  const dialogCheck = await evaluate(`(()=>{
    const d = document.querySelector('#st-clear-dialog');
    return {
      role: d?.getAttribute('role'),
      modal: d?.getAttribute('aria-modal'),
      focusedId: document.activeElement?.id,
      confirmCalls: window.__confirmCalls
    };
  })()`);
  assert("Clear Track opens accessible alertdialog without calling window.confirm",
    dialogCheck.role === "alertdialog" && dialogCheck.modal === "true" && dialogCheck.focusedId === "st-clear-cancel-btn" && dialogCheck.confirmCalls === 0,
    dialogCheck);

  // Escape dismisses without clearing and returns focus to Clear button
  await shortcut("Escape", "Escape", 0);
  await wait("!document.querySelector('#st-clear-dialog')");
  const afterEscape = await evaluate(`({
    track2Regions: window.SY1_STUDIO.engine.regions.regions('track-2').length,
    focusedAction: document.activeElement?.getAttribute('data-st-action')
  })`);
  assert("Escape cancels Clear Track dialog without clearing and restores focus",
    afterEscape.track2Regions === track2BeforeClear && afterEscape.focusedAction === "clear-track",
    afterEscape);

  // Re-open and click Cancel button
  await click(track2ClearBtn);
  await wait("!!document.querySelector('#st-clear-dialog')");
  await click("#st-clear-cancel-btn");
  await wait("!document.querySelector('#st-clear-dialog')");
  assert("Cancel button preserves Track 2 regions", (await regions())[1].length === track2BeforeClear);

  // Re-open and confirm Clear Track -> Track 2 clears, Undo restores Track 2, second Undo restores Track 4's earlier resize!
  await click(track2ClearBtn);
  await wait("!!document.querySelector('#st-clear-dialog')");
  await screenshot("desktop-clear-dialog");
  await click("#st-clear-confirm-btn");
  await wait("!document.querySelector('#st-clear-dialog') && window.SY1_STUDIO.engine.regions.regions('track-2').length === 0");
  assert("Confirming Clear Track clears Track 2 and keeps Undo enabled without calling window.confirm",
    await evaluate("window.__confirmCalls === 0 && !document.querySelector('#st-undo-btn').disabled"));

  // Undo #1 via toolbar button restores Track 2
  await click("#st-undo-btn");
  await wait("window.SY1_STUDIO.engine.regions.regions('track-2').length > 0");
  assert("Toolbar Undo restores cleared Track 2", (await regions())[1].length === track2BeforeClear);

  // Undo #2 via keyboard Cmd/Ctrl+Z reaches prior unrelated Track 4 resize (history NOT destroyed!)
  await shortcut("z", "KeyZ", 2);
  await sleep(100);
  const track4AfterPriorUndo = (await regions())[3][0].length;
  assert("Prior unrelated Undo history survives Clear Track and keyboard Cmd/Ctrl+Z still works",
    track4AfterPriorUndo === old && track4AfterPriorUndo < track4BeforeClear,
    { old, track4BeforeClear, track4AfterPriorUndo });

  // Redo via toolbar button restores Track 4 resize
  await click("#st-redo-btn");
  await sleep(100);
  assert("Toolbar Redo re-applies prior edit", (await regions())[3][0].length === track4BeforeClear);

  // Touch-only Undo/Redo when ALL regions on every track are removed (0 regions left on canvas)
  await viewport(1024, 768);
  await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  await sleep(80);
  await evaluate(`(()=>{
    const e = window.SY1_STUDIO.engine;
    for (const t of e.getTracks()) e.clearTrackClip(t.id);
  })()`);
  await wait("document.querySelectorAll('.st-midi-region').length === 0");
  assert("Toolbar Undo stays visible and enabled when all regions have been deleted",
    await evaluate(`(()=>{
      const u = document.querySelector('#st-undo-btn');
      const r = u?.getBoundingClientRect();
      return !!u && !u.disabled && r.width > 0 && r.height > 0 && r.right <= innerWidth;
    })()`));
  const undoTouchPt = await point("#st-undo-btn");
  await touch("touchStart", undoTouchPt); await touch("touchEnd");
  await wait("document.querySelectorAll('.st-midi-region').length > 0");
  const restoredByTouchCount = await evaluate("document.querySelectorAll('.st-midi-region').length");
  assert("Touch-only tap on Undo restores regions when canvas had zero regions", restoredByTouchCount > 0, restoredByTouchCount);

  const redoTouchPt = await point("#st-redo-btn");
  await touch("touchStart", redoTouchPt); await touch("touchEnd");
  await wait("document.querySelectorAll('.st-midi-region').length === 0");
  assert("Touch-only tap on Redo re-applies clear", true);

  // Restore all 4 tracks via 4 touch taps on Undo so subsequent viewport assertions see regions
  for (let i = 0; i < 4; i++) {
    const pt = await point("#st-undo-btn");
    await touch("touchStart", pt); await touch("touchEnd");
    await sleep(80);
  }
  await wait("document.querySelectorAll('.st-midi-region').length >= 4");
  await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: false });

  await viewport(768,1024);
  await screenshot("ipad-portrait");
  for (const [w,h] of [[1440,900],[1280,800],[1024,768],[768,1024],[390,844]]) {
    await viewport(w,h); await sleep(80);
    assert(`${w}×${h} arrangement viewport`,await evaluate(`(()=>{
      const u = document.querySelector('#st-undo-btn');
      const r = document.querySelector('#st-redo-btn');
      const ur = u?.getBoundingClientRect(), rr = r?.getBoundingClientRect();
      return document.documentElement.scrollWidth<=innerWidth
        && !!document.querySelector('.st-midi-region')
        && !!ur && !!rr && ur.left>=0 && rr.right<=innerWidth;
    })()`));
  }
  assert("No uncaught browser errors",errors.length===0,errors);
} finally {
  const result={environment:"Linux Chromium viewport and touch emulation",cases,errors};
  fs.writeFileSync(`${out}/report.json`,JSON.stringify(result,null,2));
  console.log(JSON.stringify(result,null,2));
  cdp?.close(); chrome.kill("SIGKILL");
}
