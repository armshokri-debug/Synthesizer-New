/** UI-only layout acceptance; run against a real Vite build/server.
 * SY1_URL=http://127.0.0.1:3000/ SY1_CHROME_BIN=/path/to/chromium node scripts/studio-phase7-5-layout-verify.mjs
 */
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { CdpClient, sleep, waitForCdp } from './studio-cdp.mjs';
const port = Number(process.env.SY1_CDP_PORT || 9255);
const chrome = spawn(process.env.SY1_CHROME_BIN || '/usr/bin/chromium', ['--headless','--no-sandbox','--disable-gpu',`--remote-debugging-port=${port}`,'about:blank'], {stdio:'ignore'});
let cdp;
const sizes = [[1440,900],[1024,768],[820,1180],[390,844],[844,390]];
const errors = [];
const select = sel => cdp.evaluate(`document.querySelector(${JSON.stringify(sel)}).click()`);
const resize = async (width,height) => {
  await cdp.send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});
  await cdp.send('Emulation.setTouchEmulationEnabled',{enabled:width<1100,maxTouchPoints:5});
  await sleep(80);
};
try {
  cdp = new CdpClient(await waitForCdp(port)); await cdp.connect();
  await cdp.send('Runtime.enable'); await cdp.send('Page.enable');
  cdp.on('Runtime.exceptionThrown',e=>errors.push(e.exceptionDetails.text));
  await cdp.send('Page.navigate',{url:process.env.SY1_URL || 'http://127.0.0.1:3000/'});
  for(let i=0;i<120;i++){if(await cdp.evaluate('!!window.SY1 && !!window.SY1_STUDIO'))break; await sleep(50);}
  await cdp.evaluate('window.SY1_STUDIO.ready');
  const machines = await cdp.evaluate('SY1.machines().map(m=>m.id)');
  let count=0;
  for(const [w,h] of sizes){
    await resize(w,h);
    for(const machine of machines){
      await cdp.evaluate(`SY1.setMachine(${JSON.stringify(machine)})`);
      await select('#sy1-panel [data-page="all"]');
      const bad=await cdp.evaluate(`(()=>{const g=document.querySelector('#sy1-panel .synth-sections'),cards=[...g.children];const r=e=>e.getBoundingClientRect();const overlap=(a,b)=>Math.min(a.right,b.right)-Math.max(a.left,b.left)>2&&Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top)>2;const bad=[];if(!g.clientHeight||document.documentElement.scrollWidth>innerWidth+1)bad.push('viewport');for(let i=0;i<cards.length;i++){const c=cards[i];if(c.scrollHeight>c.clientHeight+4||c.scrollWidth>c.clientWidth+4)bad.push('overflow '+i);for(let j=i+1;j<cards.length;j++)if(overlap(r(c),r(cards[j])))bad.push('cards '+i+'/'+j);const controls=[...c.querySelectorAll('.sk,.synth-choice-btn,.drum-step,.drum-slot,.drum-voice-btn')].filter(e=>r(e).width&&r(e).height);for(let k=0;k<controls.length;k++)for(let l=k+1;l<controls.length;l++)if(overlap(r(controls[k]),r(controls[l])))bad.push('controls '+i+':'+k+'/'+l);}g.scrollTop=g.scrollHeight;if(g.scrollHeight>g.clientHeight+1&&g.scrollTop===0)bad.push('scroll');return bad})()`);
      assert.deepEqual(bad,[],`${machine} ${w}x${h}`);count++;
    }
  }
  console.log(`ALL: ${count} machine/viewport cases passed`);
  await cdp.evaluate('SY1.setMachine("sy1")');await select('#open-studio-btn');
  const audit = selector=>cdp.evaluate(`(()=>{const p=document.querySelector(${JSON.stringify(selector)}),pr=p.getBoundingClientRect(),els=[...p.querySelectorAll('button,input:not([type=hidden]),select')].filter(e=>e.getClientRects().length&&!e.closest('[hidden]')&&getComputedStyle(e).visibility!=='hidden'),bad=[];const rect=e=>e.getBoundingClientRect(),name=e=>e.id||e.getAttribute('aria-label')||e.textContent;for(let i=0;i<els.length;i++){const a=rect(els[i]);if(!a.width||!a.height)continue;if(a.left<pr.left-2||a.right>pr.right+2||a.top<pr.top-2||a.bottom>pr.bottom+2)bad.push('outside '+name(els[i]));for(let j=i+1;j<els.length;j++){const b=rect(els[j]);if(Math.min(a.right,b.right)-Math.max(a.left,b.left)>2&&Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top)>2)bad.push('overlap '+name(els[i])+'/'+name(els[j]));}}return bad})()`);
  for(const [w,h] of sizes){
    await resize(w,h);
    for(const selector of ['.st-topbar','.st-arr-toolbar','.st-dock-head']) assert.deepEqual(await audit(selector),[],`${selector} ${w}x${h}`);
    for(const btn of ['#st-settings-btn','#st-export-menu-btn']){
      await select(btn);
      assert(await cdp.evaluate(`(()=>{const e=document.querySelector('#st-export-menu'),r=e.getBoundingClientRect();return !e.hidden&&r.left>=-1&&r.right<=innerWidth+1&&r.bottom<=innerHeight+1})()`),`menu ${w}x${h}`);
      await select(btn);
    }
    await select('#st-tab-pianoroll');
    for(const selector of ['.st-dock-head','.st-pr-toolbar']) assert.deepEqual(await audit(selector),[],`${selector} ${w}x${h}`);
    assert(await cdp.evaluate('document.querySelector(".st-pr-main").clientHeight>=20'),`note grid ${w}x${h}`);
    await select('#st-dock-collapse');
  }
  assert.deepEqual(errors,[]);console.log('Studio: 5 viewport layout/menu/editor cases passed');
} finally {cdp?.close();chrome.kill();}
