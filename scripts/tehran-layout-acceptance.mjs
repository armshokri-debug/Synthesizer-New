import { chromium } from "playwright-core";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
const browser=await chromium.launch({executablePath:process.env.CHROME_BIN,args:["--no-sandbox","--disable-dev-shm-usage","--autoplay-policy=no-user-gesture-required"]});
await mkdir("qa-screenshots",{recursive:true});
const errors=[];
const dimensions=[[1024,768],[1080,810],[1180,820],[1366,1024],[1024,650]];
const measure=()=>{const p=document.querySelector("#sy1-panel .synth-panel"),g=p.querySelector(".synth-sections"),k=document.querySelector(".kb-main"),kr=k.getBoundingClientRect(),gr=g.getBoundingClientRect();const vis=e=>!!e.getClientRects().length&&getComputedStyle(e).visibility!=="hidden";const rect=e=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height,bottom:r.bottom,right:r.right}};return {page:p.dataset.page,view:p.dataset.tehranView,keyboard:rect(k),panel:rect(p),grid:rect(g),gridScroll:[g.scrollWidth,g.clientWidth,g.scrollHeight,g.clientHeight],body:[document.documentElement.scrollWidth,document.documentElement.scrollHeight,innerWidth,innerHeight],sections:[...g.querySelectorAll(".synth-sec")].filter(vis).map(s=>({name:s.querySelector("h4").textContent,box:rect(s),scroll:[s.scrollWidth,s.clientWidth,s.scrollHeight,s.clientHeight]})),knobs:[...g.querySelectorAll(".sk[role=slider]")].map(e=>({id:e.dataset.param||e.dataset.stParam,visible:vis(e),box:rect(e),dial:rect(e.querySelector(".sk-dial"))})),overflow:[...g.querySelectorAll(".synth-sec")].filter(vis).flatMap(s=>{const r=s.getBoundingClientRect();return [...s.querySelectorAll(".sk-dial,.sk-label,.sk-val,.synth-choice-btn,.sk-caption,h4")].filter(vis).filter(e=>{const q=e.getBoundingClientRect();return q.x<r.x-2||q.right>r.right+2||q.y<r.y-2||q.bottom>r.bottom+2}).map(e=>({section:s.querySelector("h4").textContent,label:e.textContent,box:rect(e),sectionBox:rect(s)}))})}};
function sameKeys(a,b,label){assert(Math.abs(a.h-b.h)<=1,label+" keyboard height changed: "+JSON.stringify([a,b]));assert(Math.abs(a.y-b.y)<=2,label+" keyboard position changed: "+JSON.stringify([a,b]));assert(Math.abs(a.w-b.w)<=1,label+" keyboard width changed")}
function fit(m,label){assert(m.gridScroll[0]<=m.gridScroll[1]+2&&m.gridScroll[2]<=m.gridScroll[3]+2,label+" sections overflow "+JSON.stringify(m.gridScroll));assert(m.overflow.length===0,label+" controls outside sections: "+JSON.stringify(m.overflow));assert(m.body[0]<=m.body[2]+2&&m.body[1]<=m.body[3]+2,label+" page overflow "+JSON.stringify(m.body));assert(m.keyboard.bottom<=m.body[3]+2,label+" keyboard outside viewport")}
try {
for(const [w,h] of dimensions){
 const ctx=await browser.newContext({viewport:{width:w,height:h},deviceScaleFactor:1,hasTouch:true,isMobile:true,serviceWorkers:"block"});
 const p=await ctx.newPage();p.on("pageerror",e=>errors.push(String(e)));
 await p.goto("http://127.0.0.1:4177/qa-baseline.html");await p.waitForFunction(()=>window.SY1&&window.SY1_STUDIO);
 await p.evaluate(()=>{window.SY1.setMachine("sy1")});await p.locator('[data-action="synth-page"][data-page="all"]').evaluate(e=>e.click());
 const baseline=await p.evaluate(measure);
 await p.goto("http://127.0.0.1:4177/");await p.waitForFunction(()=>window.SY1&&window.SY1_STUDIO);
 await p.evaluate(()=>window.SY1.setMachine("sy1"));
 const home=await p.evaluate(measure);assert.equal(home.view,"main");assert.equal(home.knobs.filter(x=>x.visible).length,0);
 sameKeys(baseline.keyboard,home.keyboard,w+"x"+h+" home");
 await p.screenshot({path:"qa-screenshots/"+w+"x"+h+"-main.png"});
 await p.locator('[data-tehran-action="sound"]').tap();await p.waitForSelector('[data-tehran-view="sound"]');
 const all=await p.evaluate(measure);console.log("ALL",w,h,JSON.stringify(all));
 assert.equal(all.page,"all");assert.deepEqual(all.knobs.map(x=>x.id).sort(),baseline.knobs.map(x=>x.id).sort());
 assert(all.knobs.every(x=>x.visible&&x.dial.w>0), "Missing knobs in All");assert.equal(all.sections.length,baseline.sections.length);
 sameKeys(home.keyboard,all.keyboard,w+"x"+h+" All");fit(all,w+"x"+h+" All");
 await p.screenshot({path:"qa-screenshots/"+w+"x"+h+"-all.png"});
 for(const page of ["osc","filter","amp","fx"]){
  await p.locator('[data-action="synth-page"][data-page="'+page+'"]').tap();const m=await p.evaluate(measure);
  assert.equal(m.page,page);sameKeys(home.keyboard,m.keyboard,page);fit(m,w+"x"+h+" "+page);
  assert(m.knobs.filter(x=>x.visible).length>0);if(page==="osc")assert(m.knobs.filter(x=>x.visible)[0].dial.w>all.knobs[0].dial.w,"Individual controls not larger");
  if(w===1080)await p.screenshot({path:"qa-screenshots/"+w+"x"+h+"-"+page+".png"});
 }
 // Original live parameter path still works in Sound view.
 await p.locator('[data-action="synth-page"][data-page="filter"]').tap();
 const cutoff=p.locator('.synth-sec.is-on-page .sk[data-param="cutoff"]');
 const previous=await p.evaluate(()=>window.SY1.getPatch().cutoff);
 await cutoff.focus();await p.keyboard.press("ArrowUp");assert.notEqual(await p.evaluate(()=>window.SY1.getPatch().cutoff),previous);
 await p.locator('[data-tehran-action="sound"]').tap();assert.equal((await p.evaluate(measure)).view,"main");
 await p.locator('[data-tehran-action="midi"]').tap();await p.waitForSelector('.tehran-midi #st-piano-roll',{timeout:15000});
 const midi=await p.evaluate(measure);sameKeys(home.keyboard,midi.keyboard,"MIDI");
 assert(await p.evaluate(()=>window.SY1_STUDIO.isInstrumentFocusOpen()&&window.SY1_STUDIO.engine.getFocusedTrack().machineId==="sy1"));
 await p.screenshot({path:"qa-screenshots/"+w+"x"+h+"-midi.png"});
 const before=await p.evaluate(()=>window.SY1_STUDIO.engine.getFocusedTrack().getNoteCount());
 const point=await p.evaluate(()=>{const g=document.querySelector("#st-pr-grid").getBoundingClientRect(),s=document.querySelector("#st-pr-scroll").getBoundingClientRect();return{x:Math.max(g.left+8,s.left+65),y:Math.max(s.top+55,g.top+8)}});
 await p.mouse.click(point.x,point.y);
 await p.waitForFunction(n=>window.SY1_STUDIO.engine.getFocusedTrack().getNoteCount()>n,before,{timeout:5000});
 await p.locator('[data-tehran-action="midi"]').tap();assert.equal((await p.evaluate(measure)).view,"main");
 assert.equal(await p.locator('#st-piano-roll').count(),0);
 await p.locator('[data-tehran-action="sound"]').tap();await p.waitForSelector('[data-tehran-view="sound"]');
 assert(await p.locator('.st-inst-knob[data-st-param="cutoff"]').count()>0);fit(await p.evaluate(measure),"Studio sound All");
 await p.locator('[data-tehran-action="sound"]').tap();await p.locator('#st-inst-back-btn').tap();
 assert(await p.locator('#sy1-studio').isVisible());assert.equal(await p.evaluate(()=>window.SY1_STUDIO.engine.getFocusedTrack().getNoteCount()),before+1);
 await ctx.close();console.log("PASS",w,h);
}
assert.deepEqual(errors,[]);console.log("PASS TEHRAN PERFORMANCE ACCEPTANCE",dimensions);
}finally{await browser.close()}
