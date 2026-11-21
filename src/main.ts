/**
 * SY-1 Main Entry Point
 */

import "./index.css";
import { getAnalogState } from "./engine/analog";
import "./ui/skins.css";
import "./ui/keyboard.css";
import "./ui/studio.css";
import { installAudioUnlock } from "./engine/bus";
import { applySkin } from "./ui/skins";
import { getEngine, getHQState } from "./engine/hq";
import { requestMidi, setMidiInputInterceptor } from "./engine/midi";
import { SYNTH_PARAMS } from "./engine/params";
import {
  allNotesOff,
  applySynthPreset,
  getMachine,
  getMachines,
  getSynthPatch,
  initMachine,
  noteOff,
  noteOn,
  onMachineChange,
  prepareAudio,
  setMachine,
  setModWheel,
  setPitchBend,
  setSustainPedal,
  setSynthParam
} from "./engine/synth";
import { getTempo, setTempo } from "./engine/tempo";
import { initKeyboardInteractions, renderKeyboard, setKeyboardTarget, syncKeyboardHighlights, syncOriental } from "./ui/keyboard";
import { initKnobInteractions } from "./ui/knob";
import { fitPanel, initPanelInteractions, renderPanel, selectDrumVoiceForNote, setStudioOpenHandler } from "./ui/panel";
import { startSynthScope } from "./ui/scope";
import { initArpPanel } from "./ui/arp-panel";
import { initOrientalPanel } from "./ui/oriental-panel";
import { initLibrary } from "./ui/library";
import { initMachineBrowser } from "./ui/machine-browser";
import { initDawPanel } from "./ui/daw-panel";
import { setMirrorSink } from "./engine/mirror";
import { applyEngineCall } from "./engine/calls";
import { getParamMacro, paramNorm } from "./engine/cc-map";
import { batchPluginVisuals } from "./ui/plugin-visuals";
import { studioEngine } from "./studio/studio-engine";
import { runOfflineBounceProbe, runOfflineIsolationProbe, runOfflineParityProbe } from "./studio/parity-probe";
import { hideStudioPanel, initStudioPanel, showStudioPanel } from "./ui/studio-panel";

function initApp(): void {
  // Inside the AU/VST3 plugin: the plugin's engine makes the sound; this window mirrors
  // every engine call to it, and applies the calls the plugin sends back (DAW MIDI, tempo).
  const plugin = (window as any).__SY1_PLUGIN__;
  if (plugin) {
    document.documentElement.classList.add("is-plugin");
    plugin.onCall = (name: string, args: unknown[]) => applyEngineCall(name, args);
    plugin.onCalls = (calls: { name: string; args: string }[]) => batchPluginVisuals(() => {
      for (const c of calls) {
        try { applyEngineCall(c.name, JSON.parse(c.args)); } catch (e) {}
      }
    });
    // the DAW's tempo and Play state come with every update too: the window shows the real tempo
    // even when it opened (or reloaded) after the plugin last sent them
    let hostBpm = 0, hostPlaying = false;
    plugin.onHost = (h: { bpm?: number; playing?: boolean }) => {
      const bpm = Number(h && h.bpm) || 0;
      if (bpm > 0 && bpm !== hostBpm) { hostBpm = bpm; applyEngineCall("setHostTempo", [bpm]); }
      const playing = !!(h && h.playing);
      if (playing !== hostPlaying) { hostPlaying = playing; applyEngineCall("hostTransport", [playing]); }
    };
    // mirror only what the player does from now on (the start-up calls below run in the plugin's engine already)
    setTimeout(() => setMirrorSink((name, args) => {
      plugin.send(name, args);
      // Only a direct player edit is reported. Incoming DAW calls and nested preset
      // changes are unmirrored, preventing automation feedback and preset jumps.
      if (name === "setSynthParam") {
        const key = String(args[0]);
        const macro = getParamMacro(key);
        if (macro !== undefined) plugin.send("macroValue", [macro, paramNorm(key, args[1])]);
      }
    }), 0);
  }
  // skin and keyboard follow the machine
  onMachineChange((m) => {
    applySkin(m.skin);
    renderKeyboard();
    syncOriental();
  });
  initPanelInteractions();
  initArpPanel();
  initOrientalPanel();
  initLibrary();
  initMachineBrowser();
  initDawPanel();
  initMachine();          // loads the remembered machine and its patch
  applySkin(getMachine().skin);
  renderPanel();
  renderKeyboard();

  installAudioUnlock(prepareAudio);

  initKnobInteractions();
  initKeyboardInteractions();
  startSynthScope();

  // tapping a drum pad also selects that drum for editing
  const kb = document.getElementById("kb");
  if (kb) {
    kb.addEventListener("pointerdown", (e) => {
      const pad = (e.target as HTMLElement).closest(".pad") as HTMLElement | null;
      if (pad) selectDrumVoiceForNote(Number(pad.dataset.midi));
    });
  }

  // Web-only SY-1 Studio initialization (strictly disabled inside AU/VST3 plugin)
  if (!plugin) {
    const enterStudioMode = () => {
      allNotesOff();
      studioEngine.setActive(true);
      studioEngine.setKeyHighlightListener(syncKeyboardHighlights);
      setKeyboardTarget({
        noteOn: (m, v) => studioEngine.liveNoteOn(m, v),
        noteOff: (m) => studioEngine.liveNoteOff(m),
        setPitchBend: (n) => studioEngine.livePitchBend(n),
        setModWheel: (n) => studioEngine.liveModWheel(n),
        prepareAudio: () => { studioEngine.prepareAudioSync(); },
        isNoteSounding: (m) => studioEngine.isFocusedNoteSounding(m),
        releasePhysical: () => studioEngine.allNotesOff(),
        getHold: () => studioEngine.getFocusedTrack().patch.hold === "on",
        toggleHold: () => {
          const ft = studioEngine.getFocusedTrack();
          ft.setParam("hold", ft.patch.hold === "on" ? "off" : "on");
        },
        getBadge: () => {
          const ft = studioEngine.getFocusedTrack();
          return { machine: "sy1", name: "SY-1 Studio", role: `${ft.name} · ${ft.presetName}` };
        }
      });
      setMidiInputInterceptor((cmd, d1, d2, ch) => {
        if (cmd === 0x90) {
          if (d2 > 0) studioEngine.liveNoteOn(d1, d2 / 127, ch);
          else studioEngine.liveNoteOff(d1, ch);
          return true;
        }
        if (cmd === 0x80) {
          studioEngine.liveNoteOff(d1, ch);
          return true;
        }
        if (cmd === 0xe0) {
          const val14 = (d2 << 7) | d1;
          studioEngine.livePitchBend((val14 - 8192) / 8192, ch);
          return true;
        }
        if (cmd === 0xb0 && (d1 === 64 || d1 === 1)) {
          studioEngine.liveCC(d1, d2, ch);
          return true;
        }
        return false;
      });
      showStudioPanel();
    };

    const exitStudioMode = () => {
      studioEngine.setActive(false);
      studioEngine.setKeyHighlightListener(null);
      setMidiInputInterceptor(null);
      setKeyboardTarget(null);
      hideStudioPanel();
      fitPanel();
    };

    initStudioPanel({ onClose: exitStudioMode });
    setStudioOpenHandler(enterStudioMode);
    studioEngine.onChange(() => {
      if (studioEngine.isActive()) {
        const ft = studioEngine.getFocusedTrack();
        const roleEl = document.getElementById("kb-machine-role");
        if (roleEl) roleEl.textContent = `${ft.name} · ${ft.presetName}`;
      }
    });

    (window as any).SY1_STUDIO = {
      engine: studioEngine,
      open: enterStudioMode,
      close: exitStudioMode,
      isOpen: () => studioEngine.isActive(),
      diagnostics: {
        runOfflineParityProbe,
        runOfflineIsolationProbe,
        runOfflineBounceProbe
      }
    };
  }

  // Public window API for embedding or external control
  (window as any).SY1 = {
    noteOn,
    noteOff,
    allNotesOff,
    setParam: setSynthParam,
    applyPreset: applySynthPreset,
    setMachine,
    getMachine: () => getMachine().id,
    machines: () => getMachines().map((m) => ({ id: m.id, name: m.name, role: m.role, presets: m.presets.length })),
    machineData: () => getMachines(),
    setPitchBend,
    setModWheel,
    setSustainPedal,
    setTempo,
    getTempo,
    requestMidi,
    getPatch: () => ({ ...getSynthPatch() }),
    getEngine: () => ({ engine: getEngine(), hq: getHQState(), analog: getAnalogState() }),
    PARAMS: SYNTH_PARAMS
  };
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initApp);
} else {
  initApp();
}

// PWA: offline support. Only in the production build (the dev server must not cache anything).
if (import.meta.env.PROD && "serviceWorker" in navigator && !(window as any).__SY1_PLUGIN__) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  });
}
