/**
 * SY-1 UI — Knob Component & Drag/Wheel/Keyboard/MIDI-Learn Interaction
 */

import {
  getLearnTargetParam,
  getParamMappedCc,
  isLearnMode,
  isParamMapped,
  removeParamMapping,
  selectLearnParam
} from "../engine/midi";
import { SYNTH_PARAMS, synthDenorm, synthNorm } from "../engine/params";
import { getSynthPatch, prepareAudio, setSynthParam } from "../engine/synth";
import { getParamMacro, mappingLabel } from "../engine/cc-map";
import { renderInstrumentKnob, type InstrumentControlContext } from "./instrument-controls";
export { BIPOLAR_SCALE_SVG, UNIPOLAR_SCALE_SVG } from "./instrument-controls";

function gesture(key: string, phase: "begin" | "end"): void {
  const i = getParamMacro(key);
  const plugin = (globalThis as any).__SY1_PLUGIN__;
  if (i !== undefined && plugin) plugin.send("macroGesture", [i, phase]);
}

export function standaloneControlContext(): InstrumentControlContext {
  return {
    kind: "standalone",
    patch: getSynthPatch(),
    decoration: (key) => ({
      mapped: isParamMapped(key),
      learning: isLearnMode() && getLearnTargetParam() === key,
      knobTitle: `Mapped to ${mappingLabel(key)} (right-click, or long-press in LEARN, to unmap)`,
      choiceTitle: `Mapped to CC${getParamMappedCc(key)} (right-click to unmap)`
    })
  };
}

export function renderSynthKnob(key: string, label: string): string {
  return renderInstrumentKnob(standaloneControlContext(), key, label);
}

export function updateSynthControlDOM(key: string): void {
  const patch = getSynthPatch();
  const v = patch[key];
  const def = SYNTH_PARAMS[key];
  if (!def) return;

  if (def.type) {
    document.querySelectorAll(`.synth-choice-btn[data-param="${key}"][data-value]`).forEach((b) => {
      b.classList.toggle("active", b.getAttribute("data-value") === String(v));
    });
    document.querySelectorAll(`.synth-toggle-btn[data-param="${key}"]`).forEach((b) => {
      const on = b.getAttribute("data-on") === String(v);
      b.classList.toggle("active", on);
      b.setAttribute("aria-pressed", on ? "true" : "false");
    });
    document.querySelectorAll<HTMLSelectElement>(`select.synth-param-select[data-param="${key}"]`).forEach((sel) => {
      sel.value = String(v);
    });
    return;
  }

  document.querySelectorAll(`.sk[data-param="${key}"]`).forEach((el) => {
    const dial = el.querySelector(".sk-dial") as HTMLElement | null;
    if (dial) dial.style.setProperty("--n", synthNorm(key, v).toFixed(4));
    const val = el.querySelector(".sk-val");
    const fmtVal = def.fmt ? def.fmt(v) : String(v);
    if (val) val.textContent = fmtVal;
    el.setAttribute("aria-valuetext", fmtVal);
  });

  document.querySelectorAll(`.vec-axis-pill[data-param="${key}"] b`).forEach((el) => {
    el.textContent = def.fmt ? def.fmt(v) : String(v);
  });
}

export function updateMidiLearnDOM(): void {
  const learningKey = isLearnMode() ? getLearnTargetParam() : null;

  document.querySelectorAll(".sk[data-param], .synth-choice[data-param], .vec-axis-pill[data-param]").forEach((el) => {
    const key = el.getAttribute("data-param");
    if (!key) return;
    const mapped = isParamMapped(key);
    const cc = getParamMappedCc(key);
    el.classList.toggle("is-mapped", mapped);
    el.classList.toggle("is-learning", learningKey === key);
    if (mapped) {
      el.setAttribute("title", `Mapped to ${mappingLabel(key)} (right-click, or long-press in LEARN, to unmap)`);
    } else {
      el.removeAttribute("title");
    }
  });
}

let synthDrag: {
  key: string;
  startY: number;
  startX: number;
  startN: number;
  id: number;
  el: HTMLElement;
} | null = null;

// Touch long-press removes a MIDI mapping, but only while LEARN mode is on.
// In LEARN mode a short tap selects the control for mapping; holding it still unmaps it.
let longPressTimer: ReturnType<typeof setTimeout> | null = null;
let longPressStart: { x: number; y: number; id: number; key: string } | null = null;
let lastPointerType = "mouse";

function clearLongPress(): void {
  if (longPressTimer) {
    clearTimeout(longPressTimer);
    longPressTimer = null;
  }
  longPressStart = null;
}

function learnPointerDown(e: PointerEvent, key: string): void {
  e.preventDefault();
  clearLongPress();
  if (e.pointerType === "touch" && isParamMapped(key)) {
    longPressStart = { x: e.clientX, y: e.clientY, id: e.pointerId, key };
    longPressTimer = setTimeout(() => {
      removeParamMapping(key);
      clearLongPress();
    }, 500);
    return;
  }
  selectLearnParam(key);
}

export function initKnobInteractions(): void {
  // Right-click removes a MIDI mapping. A touch long-press also fires contextmenu on
  // some phones: outside LEARN mode that must never unmap, so only block the menu.
  document.addEventListener("contextmenu", (e) => {
    const target = (e.target as HTMLElement)?.closest?.(".sk[data-param], .synth-choice[data-param], .vec-axis-pill[data-param]") as HTMLElement | null;
    if (!target || target.closest("#sy1-studio, #sy1-panel[data-studio-instrument]")) return;
    const key = target.getAttribute("data-param");
    if (!key || !isParamMapped(key)) return;
    e.preventDefault();
    if (lastPointerType === "touch" && !isLearnMode()) return;
    clearLongPress();
    removeParamMapping(key);
  });

  document.addEventListener("pointerdown", (e) => {
    lastPointerType = e.pointerType;
    // Allow right-click to be handled by contextmenu
    if (e.button === 2) return;

    const choiceEl = (e.target as HTMLElement)?.closest?.(".synth-choice[data-param], .vec-axis-pill[data-param]") as HTMLElement | null;
    if (choiceEl && !choiceEl.closest("#sy1-studio, #sy1-panel[data-studio-instrument]") && isLearnMode()) {
      const cKey = choiceEl.getAttribute("data-param");
      if (cKey) {
        learnPointerDown(e, cKey);
        return;
      }
    }

    const knob = (e.target as HTMLElement)?.closest?.(".sk") as HTMLElement | null;
    if (!knob || knob.closest("#sy1-studio, #sy1-panel[data-studio-instrument]")) return;
    e.preventDefault();
    prepareAudio();
    const key = knob.getAttribute("data-param");
    if (!key) return;

    // In MIDI Learn mode, tapping a knob selects it for mapping
    if (isLearnMode()) {
      learnPointerDown(e, key);
      return;
    }

    gesture(key, "begin");
    synthDrag = {
      key,
      startY: e.clientY,
      startX: e.clientX,
      startN: synthNorm(key, getSynthPatch()[key]),
      id: e.pointerId,
      el: knob
    };
    knob.classList.add("dragging");
    try {
      knob.setPointerCapture(e.pointerId);
    } catch (err) {}
  });

  document.addEventListener("pointermove", (e) => {
    if (longPressStart && e.pointerId === longPressStart.id) {
      const dist = Math.hypot(e.clientX - longPressStart.x, e.clientY - longPressStart.y);
      if (dist > 5) clearLongPress();
    }
    if (!synthDrag || e.pointerId !== synthDrag.id) return;
    e.preventDefault();
    const dy = synthDrag.startY - e.clientY;
    const dx = e.clientX - synthDrag.startX;
    const sens = e.shiftKey ? 700 : 220;
    setSynthParam(synthDrag.key, synthDenorm(synthDrag.key, synthDrag.startN + (dy + dx * 0.5) / sens));
  });

  const endSynthDrag = (e?: PointerEvent) => {
    if (longPressStart && (!e || e.pointerId === longPressStart.id)) {
      // A short tap in LEARN mode (timer still pending) selects the control
      if (e && e.type === "pointerup" && longPressTimer) {
        selectLearnParam(longPressStart.key);
      }
      clearLongPress();
    }
    if (!synthDrag || (e && e.pointerId !== synthDrag.id)) return;
    synthDrag.el.classList.remove("dragging");
    gesture(synthDrag.key, "end");
    synthDrag = null;
  };

  document.addEventListener("pointerup", endSynthDrag);
  document.addEventListener("pointercancel", endSynthDrag);
  window.addEventListener("blur", () => endSynthDrag());

  document.addEventListener("dblclick", (e) => {
    const knob = (e.target as HTMLElement)?.closest?.(".sk") as HTMLElement | null;
    if (!knob || knob.closest("#sy1-studio, #sy1-panel[data-studio-instrument]")) return;
    const key = knob.getAttribute("data-param");
    if (key && SYNTH_PARAMS[key]) {
      setSynthParam(key, SYNTH_PARAMS[key].def);
    }
  });

  document.addEventListener(
    "wheel",
    (e) => {
      const knob = (e.target as HTMLElement)?.closest?.(".sk") as HTMLElement | null;
      if (!knob || knob.closest("#sy1-studio, #sy1-panel[data-studio-instrument]")) return;
      e.preventDefault();
      const key = knob.getAttribute("data-param");
      if (!key) return;
      const currentNorm = synthNorm(key, getSynthPatch()[key]);
      setSynthParam(key, synthDenorm(key, currentNorm - Math.sign(e.deltaY) * 0.03));
    },
    { passive: false }
  );

  document.addEventListener(
    "keydown",
    (e) => {
      const knob = (e.target as HTMLElement)?.closest?.(".sk") as HTMLElement | null;
      if (!knob || knob.closest("#sy1-studio, #sy1-panel[data-studio-instrument]")) return;
      const dirMap: Record<string, number> = {
        ArrowUp: 1,
        ArrowRight: 1,
        ArrowDown: -1,
        ArrowLeft: -1
      };
      const dir = dirMap[e.key];
      if (!dir) return;
      e.preventDefault();
      e.stopPropagation();
      const key = knob.getAttribute("data-param");
      if (!key) return;
      const d = SYNTH_PARAMS[key];
      if (!d) return;
      const patch = getSynthPatch();
      const next = d.step
        ? patch[key] + dir * d.step
        : synthDenorm(key, synthNorm(key, patch[key]) + dir * 0.02);
      setSynthParam(key, next);
    },
    true
  );
}
