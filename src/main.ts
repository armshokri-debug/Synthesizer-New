import { renderMasterKnob as projectMasterKnob } from "./ui/daw-panel";
import { setLibraryOpen as closeProjectLibrary } from "./ui/library";
import { setMachineBrowserOpen as closeProjectMachineBrowser } from "./ui/machine-browser";
import { exportDrumMidi as exportProjectDrumMidi } from "./ui/drum-export";
/**
 * SY-1 Main Entry Point
 */

import "./index.css";
import { getAnalogState } from "./engine/analog";
import "./ui/skins.css";
import "./ui/keyboard.css";
import "./ui/studio.css";
import "./ui/yazd-design.css";
import { installAudioUnlock } from "./engine/bus";
import { DRUM_NOTES, DRUM_VOICES, stopDrums } from "./engine/drums";
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
import { initArpPanel, closeArpPanel, syncArpButton } from "./ui/arp-panel";
import { initOrientalPanel, setOrientalOpen } from "./ui/oriental-panel";
import { initLibrary } from "./ui/library";
import { initMachineBrowser } from "./ui/machine-browser";
import { initDawPanel } from "./ui/daw-panel";
import { initSynthRecording } from "./ui/synth-recording";
import { setMirrorSink } from "./engine/mirror";
import { applyEngineCall } from "./engine/calls";
import { getParamMacro, paramNorm } from "./engine/cc-map";
import { batchPluginVisuals } from "./ui/plugin-visuals";
import { studioEngine } from "./studio/studio-engine";
import { studioStorage } from "./studio/storage";
import { getDrumLabelsForTrack, getStudioMachineDef } from "./studio/track-engine";
import {
  runOffline4TrackStressProbe,
  runOfflineBounceProbe,
  runOfflineIsolationProbe,
  runOfflineParityProbe,
  runOfflineStemsProbe,
  runPostRestoreParityProbe
} from "./studio/parity-probe";
import { getStudioSelectedDrumVoice, setStudioSelectedDrumVoice } from "./ui/studio-instrument";
import {
  hideStudioPanel,
  hydrateStudioFromStorage,
  importStudioProjectJson,
  initStudioPanel,
  isStudioInstrumentFocusOpen,
  isStudioPlayheadLoopActive,
  renderStudioPanel,
  saveStudioProjectNow,
  scheduleAutosave,
  showStudioPanel
} from "./ui/studio-panel";

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

  // tapping a drum pad also selects that drum for editing (isolated per Studio track when Studio is active)
  const kb = document.getElementById("kb");
  if (kb) {
    kb.addEventListener("pointerdown", (e) => {
      const pad = (e.target as HTMLElement).closest(".pad") as HTMLElement | null;
      if (!pad) return;
      const midi = Number(pad.dataset.midi);
      if (studioEngine.isActive()) {
        const ft = studioEngine.getFocusedTrack();
        if (ft.isDrumTrack()) {
          const voice = DRUM_VOICES.find((v) => DRUM_NOTES[v] === midi);
          if (voice && getStudioSelectedDrumVoice(ft.id) !== voice) {
            setStudioSelectedDrumVoice(ft.id, voice);
            renderStudioPanel();
          }
        }
        return;
      }
      selectDrumVoiceForNote(midi);
    });
  }

  // Web-only SY-1 Studio initialization (strictly disabled inside AU/VST3 plugin)
  if (!plugin) {
    let synthRecording: ReturnType<typeof initSynthRecording>;
    let lastStudioKbSig = "";
    const studioKeyboardSig = () => {
      const ft = studioEngine.getFocusedTrack();
      return `${ft.id}|${ft.machineId}|${ft.presetId}|${ft.presetName}|${ft.isDrumTrack() ? 1 : 0}|${ft.patch.hold === "on" ? 1 : 0}|${ft.patch.oriental}|${ft.patch.tuning}|${ft.patch.tuneRoot}|${ft.patch.scaleAlt}|${ft.patch.microTone}|${ft.patch.tuning === "custom" ? ft.getTrackCustomTuning().join(",") : ""}`;
    };

    const enterStudioMode = () => {
      // Standalone drum playback must not continue alongside the project.
      stopDrums();
      allNotesOff();
      closeArpPanel();
      setOrientalOpen(false);
      studioEngine.setActive(true);
      studioEngine.setKeyHighlightListener(syncKeyboardHighlights);
      lastStudioKbSig = studioKeyboardSig();
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
          const m = getStudioMachineDef(ft.machineId);
          return { machine: ft.machineId, name: m.name, role: `${ft.name} · ${ft.presetName}` };
        },
        isDrums: () => studioEngine.getFocusedTrack().isDrumTrack(),
        getTuning: () => { const ft = studioEngine.getFocusedTrack(); return { patch: ft.patch, offsets: ft.getTrackCustomTuning() }; },
        getDrumLabel: (v) => {
          const ft = studioEngine.getFocusedTrack();
          return getDrumLabelsForTrack(ft.machineId, ft.patch, ft.presetId)[v];
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
      lastStudioKbSig = "";
      setMidiInputInterceptor((cmd,d1,d2,ch)=>synthRecording.captureController(cmd,d1,d2,ch));
      setKeyboardTarget(null);
      hideStudioPanel();
      applySkin(getMachine().skin);
      renderPanel();
      syncArpButton();
      fitPanel();
    };

    initStudioPanel({onClose:exitStudioMode,instrumentHeader:()=>({output:projectMasterKnob(),connections:""}),closeInstrumentMenus:()=>{closeProjectLibrary(false);closeProjectMachineBrowser(false);},exportInstrumentPattern:()=>exportProjectDrumMidi(false)});
    setStudioOpenHandler(enterStudioMode);
    const readyHydrate = hydrateStudioFromStorage();
    synthRecording = initSynthRecording(studioEngine, { ready: readyHydrate, openStudio: enterStudioMode, autosave: scheduleAutosave, save: saveStudioProjectNow });
    setMidiInputInterceptor((cmd,d1,d2,ch)=>synthRecording.captureController(cmd,d1,d2,ch));
    studioEngine.onChange(() => {
      if (studioEngine.isActive()) {
        const sig = studioKeyboardSig();
        if (sig !== lastStudioKbSig) {
          lastStudioKbSig = sig;
          renderKeyboard();
        }
      }
    });

    (window as any).SY1_STUDIO = {
      engine: studioEngine,
      storage: studioStorage,
      ready: readyHydrate,
      saveProject: saveStudioProjectNow,
      importProjectJson: importStudioProjectJson,
      open: enterStudioMode,
      close: exitStudioMode,
      isOpen: () => studioEngine.isActive(),
      isInstrumentFocusOpen: isStudioInstrumentFocusOpen,
      diagnostics: {
        runOfflineParityProbe,
        runOfflineIsolationProbe,
        runOfflineBounceProbe,
        runOfflineStemsProbe,
        runPostRestoreParityProbe,
        runOffline4TrackStressProbe,
        isPlayheadLoopActive: isStudioPlayheadLoopActive
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
