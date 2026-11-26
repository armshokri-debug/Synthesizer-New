/**
 * SY-1 UI — Arpeggiator panel for every synth machine.
 *
 * The ARP button beside the keys opens this panel over the controls (never
 * over the keyboard), so the main layout never grows or scrolls. The button
 * lights up while the arpeggiator is on.
 */

import { getMachine, getSynthPatch, onParamChange } from "../engine/synth";
import { getTempo } from "../engine/tempo";
import { renderArpPanelHtml } from "./arp-view";
import { renderControl, setPanelRenderHook, updateSyncDOM } from "./panel";

let open = false;

function html(): string {
  return renderArpPanelHtml(getSynthPatch(), getTempo(), renderControl);
}

export function syncArpButton(): void {
  const btn = document.getElementById("kb-arp");
  if (!btn || document.documentElement.classList.contains("is-studio")) return;
  btn.classList.toggle("active", getSynthPatch().arpOn === "on");
  btn.classList.toggle("is-open", open);
  btn.setAttribute("aria-expanded", open ? "true" : "false");
}

function render(): void {
  // Never mutate the track-owned instrument overlay from standalone listeners.
  if (document.getElementById("sy1-panel")?.dataset.studioInstrument) return;
  document.querySelectorAll("#sy1-panel .arp-pop").forEach((el) => el.remove());
  const panel = document.querySelector("#sy1-panel .synth-panel");
  if (open && panel && getMachine().kind === "synth") panel.insertAdjacentHTML("beforeend", html());
  if (!document.documentElement.classList.contains("is-studio")) { updateSyncDOM(); syncArpButton(); }
}

function setOpen(v: boolean): void {
  if (v && document.documentElement.classList.contains("is-studio")) return;
  open = v;
  render();
}

export function closeArpPanel(): void {
  if (!open) return;
  open = false;
  render();
}

export function initArpPanel(): void {
  setPanelRenderHook(render); // the panel is rebuilt on machine change
  const btn = document.getElementById("kb-arp");
  if (btn) {
    const toggleArp = () => setOpen(!open);
    btn.addEventListener("pointerdown", (e) => {
      if (document.documentElement.classList.contains("is-studio")) return;
      if (e.pointerType === "mouse" && e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      toggleArp();
    });
    btn.addEventListener("keydown", (e) => {
      if (document.documentElement.classList.contains("is-studio")) return;
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        toggleArp();
      }
    });
  }
  document.addEventListener("click", (e) => {
    if ((e.target as HTMLElement).closest("[data-arp-close]")) setOpen(false);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && open) setOpen(false);
  });
  onParamChange((k) => { if (k === "arpOn") syncArpButton(); });
  syncArpButton();
}
