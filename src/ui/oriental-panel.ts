/**
 * SY-1 UI — Oriental scales panel
 *
 * One ORIENTAL button above the keys opens this panel. It holds the on/off
 * switch, the tonic (12 notes), the scale (Persian dastgah & avaz, Arabic
 * maqam, Custom), variable degrees, intonation (24-TET −50¢ or practice
 * ≈ −35¢) and, for Custom, 12 per-note cent offsets or a Scala (.scl) file.
 * Every scale is one template transposed to the chosen tonic (scales.ts).
 */

import { getCustomTuning, parseScalaScl, setCustomTuning } from "../engine/params";
import { renderOrientalPanelHtml } from "./oriental-view";
import { getMachine, getSynthPatch, onParamChange, setSynthParam, updateCustomTuningOffsets } from "../engine/synth";
import { setPanelRenderHook } from "./panel";
import { renderKeyboard, syncOriental } from "./keyboard";

let open = false;
let sclStatusMsg = "";
let sclStatusIsError = false;


function render(): void {
  const prev = document.querySelector("#sy1-panel .oriental-pop");
  const scroll = prev ? prev.scrollTop : 0;
  document.querySelectorAll("#sy1-panel .oriental-pop").forEach((el) => el.remove());
  const panel = document.querySelector("#sy1-panel .synth-panel");
  if (open && panel && getMachine().kind !== "drums") {
    panel.insertAdjacentHTML("beforeend", renderOrientalPanelHtml(getSynthPatch(), getCustomTuning(getMachine().id), sclStatusMsg, sclStatusIsError));
    const pop = document.querySelector("#sy1-panel .oriental-pop");
    if (pop) pop.scrollTop = scroll;
    bindPanelEvents();
  }
  if (document.documentElement.classList.contains("is-studio")) return;
  const btn = document.getElementById("kb-oriental");
  if (btn) btn.setAttribute("aria-expanded", open ? "true" : "false");
  btn?.classList.toggle("is-open", open);
  syncOriental();
}

function applyCustom(offsets: number[]): void {
  setCustomTuning(getMachine().id, offsets);
  if (getSynthPatch().tuning !== "custom") setSynthParam("tuning", "custom");
  updateCustomTuningOffsets();
  renderKeyboard();
}

function bindPanelEvents(): void {
  const pop = document.querySelector<HTMLElement>("#sy1-panel .oriental-pop");
  if (!pop) return;

  pop.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    const scale = t.closest<HTMLElement>("[data-or-scale]");
    if (scale) {
      const id = scale.dataset.orScale || "shur";
      if (getSynthPatch().tuning !== id) {
        setSynthParam("scaleAlt", 0);
        setSynthParam("tuning", id);
      }
      // picking a scale means you want to hear it
      if (getSynthPatch().oriental !== "on") setSynthParam("oriental", "on");
      render();
      return;
    }
    const rootBtn = t.closest<HTMLElement>("[data-or-root]");
    if (rootBtn) {
      setSynthParam("tuneRoot", Number(rootBtn.dataset.orRoot || 0));
      if (getSynthPatch().oriental !== "on") setSynthParam("oriental", "on");
      render();
      return;
    }
    const altBtn = t.closest<HTMLElement>("[data-or-alt]");
    if (altBtn) {
      const bit = 1 << Number(altBtn.dataset.orAlt || 0);
      setSynthParam("scaleAlt", (Number(getSynthPatch().scaleAlt) || 0) ^ bit);
      render();
      return;
    }
    const microBtn = t.closest<HTMLElement>("[data-or-micro]");
    if (microBtn) {
      setSynthParam("microTone", microBtn.dataset.orMicro || "24tet");
      render();
      return;
    }
    const action = t.closest<HTMLElement>("[data-or-action]")?.dataset.orAction;
    if (action === "toggle") {
      setSynthParam("oriental", getSynthPatch().oriental === "on" ? "off" : "on");
      render();
    } else if (action === "import") {
      pop.querySelector<HTMLInputElement>("#scl-file-input")?.click();
    } else if (action === "reset") {
      sclStatusMsg = "";
      applyCustom(new Array(12).fill(0));
      render();
    }
  });

  pop.querySelectorAll<HTMLInputElement>(".or-cent-input").forEach((inp) => {
    inp.addEventListener("change", () => {
      const deg = parseInt(inp.dataset.deg || "0", 10);
      let val = parseFloat(inp.value);
      if (!isFinite(val)) val = 0;
      val = Math.max(-100, Math.min(100, val));
      const current = getCustomTuning(getMachine().id).slice();
      current[deg] = val;
      applyCustom(current);
      render();
    });
  });

  const sclInput = pop.querySelector<HTMLInputElement>("#scl-file-input");
  if (sclInput) {
    sclInput.addEventListener("change", () => {
      const file = sclInput.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (e) => {
        const res = parseScalaScl(String(e.target?.result || ""));
        if (res.ok) {
          applyCustom(res.offsets);
          sclStatusMsg = `Loaded: ${res.description || file.name}`;
          sclStatusIsError = false;
        } else {
          sclStatusMsg = res.error;
          sclStatusIsError = true;
        }
        render();
      };
      reader.readAsText(file);
    });
  }
}

export function setOrientalOpen(v: boolean): void {
  if (v && document.documentElement.classList.contains("is-studio")) return;
  open = v;
  if (!v) {
    sclStatusMsg = "";
    sclStatusIsError = false;
  }
  render();
}

export function initOrientalPanel(): void {
  setPanelRenderHook(render);

  // ORIENTAL: one button; it opens the panel (the on/off switch lives inside)
  document.getElementById("kb-oriental")?.addEventListener("click", () => { if (!document.documentElement.classList.contains("is-studio")) setOrientalOpen(!open); });

  document.addEventListener("click", (e) => {
    if ((e.target as HTMLElement).closest("#sy1-panel [data-oriental-close]")) setOrientalOpen(false);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && open) setOrientalOpen(false);
  });

  onParamChange((k) => {
    if (k === "oriental" || k === "tuning" || k === "tuneRoot" || k === "scaleAlt" || k === "microTone") {
      if (open) render();
      else syncOriental();
    }
  });

  syncOriental();
}
