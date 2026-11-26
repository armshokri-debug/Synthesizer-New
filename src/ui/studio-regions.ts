import { regionPlayback, type MidiRegion } from "../studio/midi-regions";
import { previewMoveRegions, previewResizeRegion } from "../studio/region-editor";
import { extractNoteSpans } from "../studio/midi-io";
import { studioEngine } from "../studio/studio-engine";
import { STUDIO_PPQ, STUDIO_TICKS_PER_BAR } from "../studio/types";
import type { SY1TrackEngine } from "../studio/track-engine";
import { escapeHtml } from "../engine/params";

function formatGuideTick(tick: number): string {
  const safe = Math.max(0, Math.round(tick));
  const bar = Math.floor(safe / STUDIO_TICKS_PER_BAR) + 1;
  const remBar = safe % STUDIO_TICKS_PER_BAR;
  const beat = Math.floor(remBar / STUDIO_PPQ) + 1;
  const sub = remBar % STUDIO_PPQ;
  return sub > 0 ? `${bar}.${beat}.${sub}` : `${bar}.${beat}`;
}

export function renderRegions(track: SY1TrackEngine, total: number, color: string, isFocused = true): string {
  const regions = studioEngine.regions.regions(track.id);
  if (!regions.length) return isFocused ? '<div class="st-lane-empty">Record or double-click to add notes</div>' : "";
  return regions.filter(region => region.startTick < total).map(region => {
    const selected = studioEngine.regions.has(region.id);
    const width = Math.min(region.length, total - region.startTick) / total * 100;
    const preview = { ...region, length: Math.min(region.length, total - region.startTick) };
    const spans = extractNoteSpans(regionPlayback(preview), preview.length).slice(0, 240);
    const low = spans.reduce((min, span) => Math.min(min, span.midi), 60);
    const high = spans.reduce((max, span) => Math.max(max, span.midi), low + 12);
    const notes = spans.map(note => {
      const left = Math.max(0, note.startTick / region.length * 100);
      const width = Math.min(100 - left, (note.endTick - note.startTick) / region.length * 100);
      const top = 88 - (note.midi - low) / (high - low) * 74;
      return `<span class="st-note-bar" style="left:${left}%;width:${width}%;top:${top}%"></span>`;
    }).join("");
    const name = escapeHtml(track.presetName);
    return `<div class="st-clip st-midi-region${selected ? " is-selected" : ""}" tabindex="0" role="button"
        aria-pressed="${selected}" aria-label="${name} MIDI region${region.loop ? ", looped" : ""}" data-region-id="${escapeHtml(region.id)}"
        style="left:${region.startTick / total * 100}%;width:${width}%;--clip-color:${color}">
      <div class="st-clip-head">${region.loop ? "↻ " : ""}${name}</div>
      <div class="st-clip-body">${notes}</div>
      <span class="st-region-edge is-left" data-region-edge="left" title="Trim start"></span>
      <span class="st-region-edge is-right" data-region-edge="right" title="Trim end"></span>
      <span class="st-region-edge is-loop" data-region-edge="loop" title="Drag to loop">↻</span>
      <button type="button" class="st-region-more" aria-label="Region actions" title="Region actions">···</button>
    </div>`;
  }).join("");
}

interface RegionControls {
  render(): void;
  openEditor(): void;
  error(message: string): void;
}

export function bindRegionControls(container: HTMLElement, controls: RegionControls): void {
  const editor = studioEngine.regions;
  const menu = document.createElement("div");
  menu.className = "st-region-menu";
  menu.hidden = true;
  menu.setAttribute("role", "dialog");
  menu.setAttribute("aria-label", "Region actions");
  document.body.append(menu);

  let snapGuideEl: HTMLElement | null = null;
  function ensureSnapGuide(canvas: HTMLElement): HTMLElement {
    if (!snapGuideEl || snapGuideEl.parentElement !== canvas) {
      snapGuideEl?.remove();
      snapGuideEl = document.createElement("div");
      snapGuideEl.className = "st-snap-guide";
      snapGuideEl.id = "st-snap-guide";
      const badge = document.createElement("span");
      badge.className = "st-snap-badge";
      snapGuideEl.append(badge);
      canvas.append(snapGuideEl);
    }
    return snapGuideEl;
  }

  function showSnapGuide(laneEl: HTMLElement, guideTick: number, totalTicks: number, grid: number): void {
    const canvas = laneEl.closest<HTMLElement>(".st-arr-canvas");
    if (!canvas) return;
    const laneRect = laneEl.getBoundingClientRect();
    const canvasRect = canvas.getBoundingClientRect();
    if (laneRect.width <= 0 || totalTicks <= 0) return;
    const guide = ensureSnapGuide(canvas);
    const ratio = Math.max(0, Math.min(1, guideTick / totalTicks));
    const leftPx = laneRect.left - canvasRect.left + ratio * laneRect.width;
    guide.style.left = `${leftPx.toFixed(1)}px`;
    guide.classList.toggle("is-snapped", grid > 0);
    guide.dataset.guideTick = String(Math.round(guideTick));
    guide.hidden = false;
    const badge = guide.firstElementChild as HTMLElement | null;
    if (badge) {
      badge.textContent = formatGuideTick(guideTick);
    }
  }

  function hideSnapGuide(): void {
    if (snapGuideEl) {
      snapGuideEl.remove();
      snapGuideEl = null;
    }
  }

  let multiSelect = false;
  function run(action: () => void) {
    const restoreFocus = document.activeElement instanceof HTMLElement &&
      !!document.activeElement.closest("[data-region-id], .st-region-menu");
    try {
      action();
    } catch (error) {
      controls.error(error instanceof Error ? error.message : String(error));
    }
    controls.render();
    if (restoreFocus) {
      const primary = editor.selection().at(-1);
      if (primary) Array.from(container.querySelectorAll<HTMLElement>("[data-region-id]"))
        .find(el => el.dataset.regionId === primary)?.focus({ preventScroll: true });
    }
  }

  function closeMenu() { menu.hidden = true; }

  function openMenu(x: number, y: number, trackId: string, tick: number) {
    const count = editor.selection().length;
    type Action = {name:string;enabled:boolean;run:()=>void;shortcut?:string};
    const edit = !studioEngine.getTransportSnapshot().recording;
    const actions: Action[] = [
      {name:"Open Piano Roll / Drum Grid",enabled:count>0,run:controls.openEditor,shortcut:"↵"},
      {name:"Copy",enabled:count>0,run:()=>editor.copy(),shortcut:"⌘ C"},
      {name:"Cut",enabled:count>0&&edit,run:()=>editor.cut(),shortcut:"⌘ X"},
      {name:"Paste here",enabled:editor.canPaste()&&edit,run:()=>editor.paste(trackId,tick),shortcut:"⌘ V"},
      {name:"Paste in place",enabled:editor.canPaste()&&edit,run:()=>editor.pasteInPlace(trackId),shortcut:"⇧ ⌘ V"},
      {name:"Duplicate",enabled:count>0&&edit,run:()=>editor.duplicate(),shortcut:"⌘ D"},
      {name:"New region here",enabled:edit,run:()=>editor.create(trackId,tick)},
      {name:"Delete",enabled:count>0&&edit,run:()=>editor.remove(),shortcut:"⌫"}
    ];
    const more: Action[] = [
      {name:multiSelect?"Finish multi-select":"Select multiple regions",enabled:true,run:()=>{multiSelect=!multiSelect;}},
      {name:"Select all regions",enabled:true,run:()=>editor.selectAll(),shortcut:"⌘ A"},
      {name:"Select regions on this track",enabled:true,run:()=>editor.selectAll(trackId)},
      {name:"Split at playhead",enabled:count>0&&edit,run:()=>editor.split(studioEngine.getCurrentTick())},
      {name:"Merge regions",enabled:count>1&&edit,run:()=>editor.merge()},
      {name:"Repeat to arrangement end",enabled:count>0&&edit,run:()=>editor.repeatToEnd()},
      {name:"Undo",enabled:editor.canUndo()&&edit,run:()=>editor.undo()},
      {name:"Redo",enabled:editor.canRedo()&&edit,run:()=>editor.redo()}
    ];
    menu.replaceChildren();
    const appendAction=(root:HTMLElement,action:Action)=>{
      const button=document.createElement("button");
      button.type="button";button.textContent=action.name;button.disabled=!action.enabled;
      if(action.shortcut){const k=document.createElement("span");k.className="st-menu-shortcut";k.textContent=action.shortcut;button.append(k);}
      button.addEventListener("click",()=>{closeMenu();run(action.run);});root.append(button);
    };
    actions.filter(action=>action.enabled).forEach(action=>appendAction(menu,action));
    const details=document.createElement("details"),summary=document.createElement("summary");
    summary.textContent="More…";details.append(summary);
    more.forEach(action=>appendAction(details,action));menu.append(details);
    menu.hidden = false;
    menu.style.left = `${Math.max(8, Math.min(x, innerWidth - menu.offsetWidth - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(y, innerHeight - menu.offsetHeight - 8))}px`;
    menu.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus({ preventScroll: true });
  }

  function locate(target: HTMLElement, x: number) {
    const lane = target.closest<HTMLElement>("[data-st-lane]");
    if (!lane?.dataset.trackId) return null;
    const rect = lane.getBoundingClientRect();
    const total = studioEngine.getTotalTicks();
    const tick = Math.max(0, Math.min(total - 1, Math.round((x - rect.left) / rect.width * total)));
    return { lane, trackId: lane.dataset.trackId, tick, ticksPerPx: total / rect.width };
  }

  let drag: {
    element: HTMLElement;
    laneEl: HTMLElement;
    id: string;
    edge: "left" | "right" | "loop" | null;
    start: number;
    startY: number;
    trackDelta: number;
    copy: boolean;
    end: number;
    pointer: number;
    tickScale: number;
    totalTicks: number;
    moved: boolean;
    timer: number;
    origRegion: MidiRegion;
    origLeftCss: string;
    origWidthCss: string;
    movingRegions: MidiRegion[];
    movingElements: HTMLElement[];
  } | null = null;
  let suppressClickUntil = 0;
  // Empty-space drag selects whole MIDI regions, never modifies their contents.
  let box: {pointer:number;startX:number;startY:number;active:boolean;timer:number;frame:HTMLElement;initial:string[];hits:string[];touch:boolean}|null=null;
  const hitIds=(x1:number,y1:number,x2:number,y2:number)=>{
    const left=Math.min(x1,x2),right=Math.max(x1,x2),top=Math.min(y1,y2),bottom=Math.max(y1,y2);
    return [...container.querySelectorAll<HTMLElement>("[data-region-id]")].filter(el=>{
      const r=el.getBoundingClientRect();
      return r.right>left&&r.left<right&&r.bottom>top&&r.top<bottom;
    }).map(el=>el.dataset.regionId!);
  };
  function drawSelection(ids:readonly string[]){
    const set=new Set(ids);
    container.querySelectorAll<HTMLElement>("[data-region-id]").forEach(el=>{
      const selected=set.has(el.dataset.regionId!);
      el.classList.toggle("is-selected",selected);el.setAttribute("aria-pressed",String(selected));
    });
  }
  function activateBox(){
    if(!box||box.active)return;
    box.active=true;clearTimeout(box.timer);
    box.frame.hidden=false;
    box.frame.style.left=box.startX+"px";box.frame.style.top=box.startY+"px";
    try{container.setPointerCapture(box.pointer);}catch{}
  }
  function updateBox(x:number,y:number){
    if(!box||!box.active)return;
    const left=Math.min(x,box.startX),top=Math.min(y,box.startY);
    Object.assign(box.frame.style,{left:left+"px",top:top+"px",width:Math.abs(x-box.startX)+"px",height:Math.abs(y-box.startY)+"px"});
    box.hits=hitIds(box.startX,box.startY,x,y);
    drawSelection([...box.initial,...box.hits]);
  }
  function endBox(commit:boolean,x?:number,y?:number){
    if(!box)return;
    if(commit&&box.active&&x!==undefined&&y!==undefined)updateBox(x,y);
    const b=box;box=null;clearTimeout(b.timer);b.frame.remove();
    if(!b.active)return;
    suppressClickUntil=performance.now()+350;
    if(commit){editor.selectMany([...b.initial,...b.hits]);controls.render();}
    else drawSelection(editor.selection());
  }
  // Resolve the destination lane using its actual vertical bounds, even under pointer capture.
  function laneShift(d:NonNullable<typeof drag>,y:number):number{
    const lanes=[...container.querySelectorAll<HTMLElement>("[data-st-lane]")];
    const source=lanes.indexOf(d.laneEl),dest=lanes.findIndex(el=>{const r=el.getBoundingClientRect();return y>=r.top&&y<r.bottom;});
    if(source<0||dest<0)return 0;
    const ids=studioEngine.getTracks().map(t=>t.id);
    const shift=dest-source;
    return d.movingRegions.every(r=>!!ids[ids.indexOf(r.trackId)+shift])?shift:0;
  }
  let lastTap: { id: string; at: number; x: number; y: number } | null = null;

  function resetDragVisuals(activeDrag: NonNullable<typeof drag>) {
    hideSnapGuide();
    activeDrag.element.style.left = activeDrag.origLeftCss;
    activeDrag.element.style.width = activeDrag.origWidthCss;
    activeDrag.element.style.transform = "";
    activeDrag.element.classList.remove("is-dragging");
    for (const el of activeDrag.movingElements) {
      el.style.transform = "";
      el.classList.remove("is-dragging");
    }
  }

  container.addEventListener("pointerdown", event => {
    const target = event.target as HTMLElement;
    const element = target.closest<HTMLElement>("[data-region-id]");
    if (event.button !== 0 || target.closest(".st-region-more")) return;
    const position = locate(target, event.clientX);
    if(!position)return;
    if(!element){
      if(box)endBox(false);
      const frame=document.createElement("div");frame.className="st-arr-marquee";frame.hidden=true;document.body.append(frame);
      const touch=event.pointerType==="touch";
      box={pointer:event.pointerId,startX:event.clientX,startY:event.clientY,active:false,timer:0,frame,initial:event.shiftKey||event.metaKey||event.ctrlKey||multiSelect?editor.selection():[],hits:[],touch};
      if(touch)box.timer=window.setTimeout(activateBox,320);
      return;
    }
    const id = element.dataset.regionId!;
    const region = position && editor.regions(position.trackId).find(item => item.id === id);
    if (!position || !region) return;
    const edge = target.closest<HTMLElement>("[data-region-edge]")?.dataset.regionEdge as "left" | "right" | "loop" | undefined;
    const movingRegions = !edge && editor.has(id) && editor.selectedRegions().length > 0
      ? editor.selectedRegions()
      : [region];
    const movingIdSet = new Set(movingRegions.map(r => r.id));
    const movingElements = Array.from(container.querySelectorAll<HTMLElement>("[data-region-id]"))
      .filter(el => movingIdSet.has(el.dataset.regionId || ""));
    drag = {
      element,
      laneEl: position.lane,
      id,
      edge: edge ?? null,
      start: event.clientX,
      startY:event.clientY,trackDelta:0,copy:event.altKey,
      end: event.clientX,
      pointer: event.pointerId,
      tickScale: position.ticksPerPx,
      totalTicks: studioEngine.getTotalTicks(),
      moved: false,
      timer: 0,
      origRegion: region,
      origLeftCss: element.style.left,
      origWidthCss: element.style.width,
      movingRegions,
      movingElements
    };
    if (event.pointerType === "touch" && !edge) drag.timer = window.setTimeout(() => {
      if (!drag || drag.moved) return;
      drag = null;
      suppressClickUntil = performance.now() + 500;
      if (!editor.has(id)) editor.select(id);
      controls.render();
      openMenu(event.clientX, event.clientY, position.trackId, position.tick);
    }, 480);
  }, true);

  container.addEventListener("pointermove", event => {
    if(box&&box.pointer===event.pointerId){
      const dist=Math.hypot(event.clientX-box.startX,event.clientY-box.startY);
      if(!box.active&&dist>5){if(box.touch){endBox(false);return;}activateBox();}
      if(box?.active){event.preventDefault();updateBox(event.clientX,event.clientY);}
      return;
    }
    if (!drag || drag.pointer !== event.pointerId) return;
    drag.end = event.clientX;
    const dx = drag.end - drag.start;
    if (!drag.moved && Math.hypot(dx,event.clientY-drag.startY) < 5) return;
    if (!drag.moved) {
      drag.moved = true;
      clearTimeout(drag.timer);
      try { container.setPointerCapture(event.pointerId); } catch {}
    }
    const deltaTicks = dx * drag.tickScale;
    const total = drag.totalTicks;
    if (drag.edge) {
      const baseEdgeTick = drag.edge === "left"
        ? drag.origRegion.startTick
        : drag.origRegion.startTick + drag.origRegion.length;
      const preview = previewResizeRegion(drag.origRegion, drag.edge, baseEdgeTick + deltaTicks, editor.grid, total);
      const widthPct = Math.min(preview.length, total - preview.startTick) / total * 100;
      drag.element.style.left = `${(preview.startTick / total * 100).toFixed(4)}%`;
      drag.element.style.width = `${widthPct.toFixed(4)}%`;
      drag.element.classList.add("is-dragging");
      showSnapGuide(drag.laneEl, preview.guideTick, total, editor.grid);
    } else {
      const preview = previewMoveRegions(drag.movingRegions, deltaTicks, editor.grid, total);
      const shiftPx = preview ? preview.shift / drag.tickScale : dx;
      drag.trackDelta=laneShift(drag,event.clientY);drag.copy=event.altKey;
      const lanes=[...container.querySelectorAll<HTMLElement>("[data-st-lane]")];
      for (const el of drag.movingElements) {
        const source=el.closest<HTMLElement>("[data-st-lane]");
        const dest=source?lanes[lanes.indexOf(source)+drag.trackDelta]:null;
        const dy=source&&dest?dest.getBoundingClientRect().top-source.getBoundingClientRect().top:0;
        el.style.transform = `translate(${shiftPx.toFixed(1)}px,${dy.toFixed(1)}px)`;
        el.classList.add("is-dragging");
      }
      if (preview) {
        showSnapGuide(drag.laneEl, preview.guideTick, total, editor.grid);
      }
    }
  }, true);

  function finish(event: PointerEvent, commit: boolean) {
    if(box&&box.pointer===event.pointerId){endBox(commit,event.clientX,event.clientY);return;}
    if (!drag || drag.pointer !== event.pointerId) return;
    const change = drag;
    drag = null;
    clearTimeout(change.timer);
    resetDragVisuals(change);
    if (!change.moved || !commit) return;
    suppressClickUntil = performance.now() + 300;
    const delta = (event.clientX - change.start) * change.tickScale;
    const lane = change.element.closest<HTMLElement>("[data-st-lane]");
    const region = lane?.dataset.trackId && editor.regions(lane.dataset.trackId).find(item => item.id === change.id);
    if (!region) return;
    run(() => {
      if (!editor.has(region.id)) editor.select(region.id);
      if (change.edge) editor.resize(region.id, change.edge, (change.edge === "left" ? region.startTick : region.startTick + region.length) + delta);
      else editor.move(delta,laneShift(change,event.clientY),event.altKey);
    });
  }
  container.addEventListener("pointerup", event => finish(event, true), true);
  container.addEventListener("pointercancel", event => finish(event, false), true);
  window.addEventListener("blur", () => {
    endBox(false);
    if (drag) {
      clearTimeout(drag.timer);
      resetDragVisuals(drag);
      drag = null;
    }
  });

  container.addEventListener("click", event => {
    const target = event.target as HTMLElement;
    const element = target.closest<HTMLElement>("[data-region-id]");
    if (suppressClickUntil > performance.now() && (target.closest("[data-st-lane]") || event.target === container)) {
      event.stopImmediatePropagation(); return;
    }
    if (!element) {
      if (target.closest("[data-st-lane], [data-st-action='focus-track']") && editor.selection().length) {
        editor.clearSelection();
        if (target.closest("[data-st-action='focus-track']")) setTimeout(controls.render, 0);
      }
      return;
    }
    event.stopImmediatePropagation();
    const id = element.dataset.regionId!;
    const more = target.closest(".st-region-more");
    const additive = !more && (multiSelect || event.shiftKey || event.metaKey || event.ctrlKey);
    const selectionChanged = !editor.has(id) || additive || (!more && editor.selection().length > 1);
    if (selectionChanged) editor.select(id, additive);
    if (!additive && !more) {
      const now = performance.now();
      if (lastTap?.id === id && now - lastTap.at < 350 &&
          Math.hypot(event.clientX - lastTap.x, event.clientY - lastTap.y) < 12) {
        lastTap = null;
        controls.openEditor();
        return;
      }
      lastTap = { id, at: now, x: event.clientX, y: event.clientY };
    }
    if (more) {
      const position = locate(target, event.clientX);
      if (position) openMenu(event.clientX, event.clientY, position.trackId, position.tick);
    } else if (selectionChanged) {
      controls.render();
      Array.from(container.querySelectorAll<HTMLElement>("[data-region-id]"))
        .find(el => el.dataset.regionId === id)?.focus({ preventScroll: true });
    }
  }, true);

  container.addEventListener("dblclick", event => {
    const target=event.target as HTMLElement;
    const region=target.closest<HTMLElement>("[data-region-id]");
    if(multiSelect)return;
    const position=locate(target,event.clientX);
    if(!position)return;
    event.stopImmediatePropagation();
    if(region)editor.select(region.dataset.regionId!);
    else {if(studioEngine.getTransportSnapshot().recording)return;run(()=>editor.create(position.trackId,position.tick));}
    controls.openEditor();
  }, true);

  container.addEventListener("contextmenu", event => {
    const target = event.target as HTMLElement;
    const position = locate(target, event.clientX);
    if (!position) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const id = target.closest<HTMLElement>("[data-region-id]")?.dataset.regionId;
    if (id && !editor.has(id)) editor.select(id);
    if(!id){editor.clearSelection();studioEngine.setFocusedTrack(position.trackId);}
    controls.render();
    openMenu(event.clientX, event.clientY, position.trackId, position.tick);
  }, true);

  document.addEventListener("pointerdown", event => {
    if (!menu.hidden && !menu.contains(event.target as Node) && !(event.target as HTMLElement).closest?.(".st-region-more")) closeMenu();
  });
  document.addEventListener("keydown", event => {
    if (container.hidden) { closeMenu(); return; }
    if (!(event.target instanceof HTMLElement)) return;
    const target = event.target;
    if(event.key==="Escape"&&box){endBox(false);event.preventDefault();return;}
    if (event.key === "Escape" && (!menu.hidden || multiSelect)) { closeMenu(); multiSelect = false; event.preventDefault(); return; }
    if (target.closest("input, select, textarea, [contenteditable]")) return;
    const modifier = event.metaKey || event.ctrlKey;
    const key = event.key.toLowerCase();
    const noteEditor = target.closest("#st-piano-roll");
    const selected = editor.selection().length > 0;
    const focusedId = target.closest<HTMLElement>("[data-region-id]")?.dataset.regionId;
    let action: (() => void) | undefined;
    if (modifier && key === "z") action = event.shiftKey ? () => editor.redo() : () => editor.undo();
    else if (modifier && key === "y") action = () => editor.redo();
    else if(!noteEditor&&modifier&&key==="a")action=()=>editor.selectAll();
    else if(!noteEditor&&key==="escape"&&selected)action=()=>editor.clearSelection();
    else if (!noteEditor && modifier && key === "v" && editor.canPaste()) action = () => event.shiftKey ? editor.pasteInPlace(studioEngine.getFocusedTrack().id) : editor.paste(studioEngine.getFocusedTrack().id, studioEngine.getCurrentTick());
    else if (!noteEditor && selected) {
      if (modifier && key === "c") action = () => editor.copy();
      if (modifier && key === "x") action = () => editor.cut();
      if (modifier && key === "d") action = () => editor.duplicate();
      if (modifier && key === "t") action = () => editor.split(studioEngine.getCurrentTick());
      if (key === "delete" || key === "backspace") action = () => editor.remove();
      if (focusedId && (key === "arrowleft" || key === "arrowright")) action = () => editor.move((key === "arrowleft" ? -1 : 1) * (editor.grid || 1));
    }
    if (focusedId && (key === "enter" || key === "contextmenu" || (event.shiftKey && key === "f10"))) {
      action = () => {
        const rect = target.getBoundingClientRect();
        const position = locate(target, rect.left);
        if (!editor.has(focusedId)) editor.select(focusedId, event.shiftKey);
        if (key === "enter") controls.openEditor();
        else if (position) openMenu(rect.left, rect.bottom, position.trackId, position.tick);
      };
    }
    if (!action) return;
    event.stopImmediatePropagation(); event.preventDefault();
    run(action);
  }, true);
}
