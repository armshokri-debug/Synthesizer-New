import { regionPlayback } from "../studio/midi-regions";
import { extractNoteSpans } from "../studio/midi-io";
import { studioEngine } from "../studio/studio-engine";
import { STUDIO_SNAP_OPTIONS } from "../studio/types";
import type { SY1TrackEngine } from "../studio/track-engine";
import { escapeHtml } from "../engine/params";

export function renderRegions(track: SY1TrackEngine, total: number, color: string): string {
  const regions = studioEngine.regions.regions(track.id);
  if (!regions.length) return '<div class="st-lane-empty">Arm to record or add notes in Piano Roll</div>';
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
    const actions: { name: string; enabled: boolean; run: () => void }[] = [
      { name: multiSelect ? "Finish multi-select" : "Select multiple regions", enabled: true, run: () => { multiSelect = !multiSelect; } },
      { name: "Open Piano Roll / Drum Grid", enabled: count > 0, run: controls.openEditor },
      { name: "Copy", enabled: count > 0, run: () => editor.copy() },
      { name: "Cut", enabled: count > 0, run: () => editor.cut() },
      { name: "New region here", enabled: true, run: () => editor.create(trackId, tick) },
      { name: "Paste here", enabled: editor.canPaste(), run: () => editor.paste(trackId, tick) },
      { name: "Duplicate", enabled: count > 0, run: () => editor.duplicate() },
      { name: "Split at playhead", enabled: count > 0, run: () => editor.split(studioEngine.getCurrentTick()) },
      { name: "Merge regions", enabled: count > 1, run: () => editor.merge() },
      { name: "Repeat to arrangement end", enabled: count > 0, run: () => editor.repeatToEnd() },
      { name: "Undo", enabled: editor.canUndo(), run: () => editor.undo() },
      { name: "Redo", enabled: editor.canRedo(), run: () => editor.redo() },
      { name: "Delete chosen regions", enabled: count > 0, run: () => editor.remove() },
    ];
    menu.replaceChildren();
    for (const action of actions) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = action.name;
      button.disabled = !action.enabled;
      button.addEventListener("click", () => { closeMenu(); run(action.run); });
      menu.append(button);
    }
    const label = document.createElement("label");
    label.textContent = "Region grid";
    const select = document.createElement("select");
    select.setAttribute("aria-label", "Region snap grid");
    for (const option of STUDIO_SNAP_OPTIONS) select.add(new Option(option.label, String(option.ticks), false, editor.grid === option.ticks));
    select.addEventListener("change", () => { editor.grid = Number(select.value); });
    label.append(select);
    menu.append(label);
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
    return { trackId: lane.dataset.trackId, tick, ticksPerPx: total / rect.width };
  }

  let drag: { element: HTMLElement; id: string; edge: "left" | "right" | "loop" | null;
    start: number; end: number; pointer: number; tickScale: number; moved: boolean; timer: number } | null = null;
  let suppressClickUntil = 0;
  let lastTap: { id: string; at: number; x: number; y: number } | null = null;

  container.addEventListener("pointerdown", event => {
    const target = event.target as HTMLElement;
    const element = target.closest<HTMLElement>("[data-region-id]");
    if (!element || event.button !== 0 || target.closest(".st-region-more")) return;
    const position = locate(target, event.clientX);
    const id = element.dataset.regionId!;
    const region = position && editor.regions(position.trackId).find(item => item.id === id);
    if (!position || !region) return;
    const edge = target.closest<HTMLElement>("[data-region-edge]")?.dataset.regionEdge as "left" | "right" | "loop" | undefined;
    drag = { element, id, edge: edge ?? null, start: event.clientX, end: event.clientX,
      pointer: event.pointerId, tickScale: position.ticksPerPx, moved: false, timer: 0 };
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
    if (!drag || drag.pointer !== event.pointerId) return;
    drag.end = event.clientX;
    const dx = drag.end - drag.start;
    if (!drag.moved && Math.abs(dx) < 5) return;
    if (!drag.moved) {
      drag.moved = true;
      clearTimeout(drag.timer);
      try { container.setPointerCapture(event.pointerId); } catch {}
    }
    drag.element.style.transform = drag.edge ? "" : `translateX(${dx}px)`;
    drag.element.classList.add("is-dragging");
  }, true);

  function finish(event: PointerEvent, commit: boolean) {
    if (!drag || drag.pointer !== event.pointerId) return;
    const change = drag;
    drag = null;
    clearTimeout(change.timer);
    change.element.style.transform = "";
    change.element.classList.remove("is-dragging");
    if (!change.moved || !commit) return;
    suppressClickUntil = performance.now() + 300;
    const delta = (event.clientX - change.start) * change.tickScale;
    const lane = change.element.closest<HTMLElement>("[data-st-lane]");
    const region = lane?.dataset.trackId && editor.regions(lane.dataset.trackId).find(item => item.id === change.id);
    if (!region) return;
    run(() => {
      if (!editor.has(region.id)) editor.select(region.id);
      if (change.edge) editor.resize(region.id, change.edge, (change.edge === "left" ? region.startTick : region.startTick + region.length) + delta);
      else editor.move(delta);
    });
  }
  container.addEventListener("pointerup", event => finish(event, true), true);
  container.addEventListener("pointercancel", event => finish(event, false), true);
  window.addEventListener("blur", () => {
    if (drag) {
      clearTimeout(drag.timer);
      drag.element.style.transform = "";
      drag.element.classList.remove("is-dragging");
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
    const region = (event.target as HTMLElement).closest<HTMLElement>("[data-region-id]");
    if (!region || multiSelect) return;
    event.stopImmediatePropagation();
    editor.select(region.dataset.regionId!);
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
    else if (!noteEditor && modifier && key === "v") action = () => editor.paste(studioEngine.getFocusedTrack().id, studioEngine.getCurrentTick());
    else if (!noteEditor && selected) {
      if (modifier && key === "c") action = () => editor.copy();
      if (modifier && key === "x") action = () => editor.cut();
      if (modifier && key === "d") action = () => editor.duplicate();
      if (modifier && key === "t") action = () => editor.split(studioEngine.getCurrentTick());
      if (key === "delete" || key === "backspace") action = () => editor.remove();
      if (focusedId && (key === "arrowleft" || key === "arrowright")) action = () => editor.move((key === "arrowleft" ? -1 : 1) * (editor.grid || 1));
    }
    if (focusedId && (key === "enter" || key === " " || key === "contextmenu" || (event.shiftKey && key === "f10"))) {
      action = () => {
        const rect = target.getBoundingClientRect();
        const position = locate(target, rect.left);
        if (!editor.has(focusedId)) editor.select(focusedId, event.shiftKey);
        if (key === "enter") controls.openEditor();
        else if (key !== " " && position) openMenu(rect.left, rect.bottom, position.trackId, position.tick);
      };
    }
    if (!action) return;
    event.stopImmediatePropagation(); event.preventDefault();
    run(action);
  }, true);
}
