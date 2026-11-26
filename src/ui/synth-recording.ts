import { isStudioInstrumentFocusOpen } from "./studio-panel";
import { allNotesOff, getMachine, getSynthPatch, getSynthPresetId, getPitchBend, getModWheel, getSustainPedal, onMachineChange, onParamChange, onPresetChange } from "../engine/synth";
import { getMidiChannel } from "../engine/cc-map";
import { onPerformanceMidi } from "../engine/daw";
import { startDrums, stopDrums, setDrumTempoSource } from "../engine/drums";
import { getTempo } from "../engine/tempo";
import { prepareSynthRecordingTrack } from "../studio/synth-recording";
import type { SY1StudioEngine } from "../studio/studio-engine";
import "./synth-recording.css";

export function initSynthRecording(engine: SY1StudioEngine, options: { ready: Promise<unknown>; openStudio: () => void; autosave: () => void; save: () => Promise<unknown> }) {
  const root = document.createElement("section");
  root.id = "synth-recording";
  root.setAttribute("aria-label", "Performance recording");
  root.innerHTML = `<div class="sr-main">
    <button id="sr-record" type="button" aria-pressed="false">● Record</button>
    <button id="sr-stop" type="button">■ Stop</button>
    <button id="sr-play" type="button" aria-pressed="false">▶ Play</button>
    <label>BPM <input id="sr-bpm" type="number" min="40" max="240" step="1" aria-label="Recording BPM"></label>
    <button id="sr-click" type="button" aria-pressed="false">Click</button>
    <button id="sr-count-in" type="button" aria-pressed="false" title="One bar before recording">1-bar in</button>
    <output id="sr-position" aria-label="Bar and beat">01 : 1</output>
    <span id="sr-status" role="status" aria-live="polite">Ready · MIDI overdub</span>
    <details class="sr-settings"><summary>Options</summary><label>Click volume <input id="sr-click-volume" type="range" min="0" max="1" step="0.01" value="0.25"></label><label id="sr-pattern-option"><input id="sr-auto-pattern" type="checkbox" checked> Start drum pattern with recording</label><small>Click is monitor-only. Record adds notes to the project.</small></details>
  </div>`;
  document.getElementById("sy1-panel")!.before(root);
  let captureTrackId: string | null = null, operation = 0, busy = false, frame = 0, error = "";
  let unsubscribePerformance: (() => void) | null = null;
  let ownsPatternClock = false;
  const releasePatternClock = () => {
    if (!ownsPatternClock) return;
    ownsPatternClock = false;
    stopDrums();
    setDrumTempoSource(getTempo);
  };
  const $ = <T extends HTMLElement = HTMLElement>(id: string) => root.querySelector<T>(`#${id}`)!;
  const update = () => {
    frame = 0;
    root.hidden = engine.isActive()&&!isStudioInstrumentFocusOpen();
    const state = engine.getTransportSnapshot(), settings = engine.getRecordingSettings(), count = engine.getCountInBeat();
    if (ownsPatternClock && ((!state.recording && !busy) || engine.isActive())) releasePatternClock();
    if (captureTrackId && !state.recording && !busy) {
      captureTrackId = null;
      unsubscribePerformance?.(); unsubscribePerformance = null;
    }
    $("sr-pattern-option").hidden = engine.isActive()||getMachine().kind !== "drums";
    $<HTMLInputElement>("sr-auto-pattern").disabled = busy || state.recording;
    $("sr-record").setAttribute("aria-pressed", String(state.recording));
    $("sr-play").setAttribute("aria-pressed", String(state.playing));
    $("sr-click").setAttribute("aria-pressed", String(settings.metronome));
    $("sr-count-in").setAttribute("aria-pressed", String(settings.countIn));
    ($("sr-record") as HTMLButtonElement).disabled = busy;
    if (document.activeElement !== $("sr-bpm")) $("sr-bpm").setAttribute("value", String(state.bpm));
    if (document.activeElement !== $("sr-bpm")) ($<HTMLInputElement>("sr-bpm")).value = String(state.bpm);
    if (document.activeElement !== $("sr-click-volume")) ($<HTMLInputElement>("sr-click-volume")).value = String(settings.clickVolume);
    $("sr-position").textContent = count ? `IN : ${count}` : `${String(state.currentBar).padStart(2,"0")} : ${state.currentBeat}`;
    const modeLabel = settings.mode === "takes" ? "New Take" : settings.mode === "replace" ? "Replace" : "MIDI overdub";
    const status = error || (busy ? "Preparing…" : count ? "Count-in" : state.recording ? `Recording · ${modeLabel}` : state.playing ? `Playing · ${state.projectName}` : `Ready · ${state.projectName} · ${modeLabel}`);
    if ($("sr-status").textContent !== status) $("sr-status").textContent = status;
    root.dataset.state = count ? "count-in" : state.recording ? "recording" : state.playing ? "playing" : "idle";
    if (!root.hidden && state.playing) frame = requestAnimationFrame(update);
  };
  const refresh = () => { if (!frame) update(); };
  const finish = async () => {
    operation++; busy = false; allNotesOff(); releasePatternClock(); stopDrums();
    unsubscribePerformance?.(); unsubscribePerformance = null;
    captureTrackId = null; await engine.stop();
    if (await options.save() === false) error = "Recording kept in memory. Save failed — open Studio to export.";
    refresh();
  };
  root.addEventListener("click", async e => {
    const id = (e.target as HTMLElement).closest("button")?.id;
    if (!id) return;
    error = "";
    try {
      if (id === "sr-record" || id === "sr-play") engine.prepareAudioSync();
      if(engine.isActive()){
        const track=engine.getFocusedTrack();
        if(id==="sr-record"){if(engine.getTransportSnapshot().recording)await engine.pause();else await engine.record({patternTrackId:track.isDrumTrack()?track.id:undefined});}
        else if(id==="sr-stop")await engine.stop();
        else if(id==="sr-play"){if(engine.isPlaying())await engine.pause();else await engine.play();}
        else if(id==="sr-click")engine.setRecordingSettings({metronome:!engine.getRecordingSettings().metronome});
        else if(id==="sr-count-in")engine.setRecordingSettings({countIn:!engine.getRecordingSettings().countIn});
        options.autosave();refresh();return;
      }
      if (id === "sr-record") {
        if (busy || engine.getTransportSnapshot().recording) return;
        const token = ++operation; busy = true; refresh();
        await options.ready;
        if (token !== operation) return;
        engine.setBpm(engine.getBpm());
        const t = prepareSynthRecordingTrack(engine, getMachine().id, {...getSynthPatch()}, getSynthPresetId());
        captureTrackId = t.id;
        unsubscribePerformance?.();
        // Auto-start only for a fresh transport start; preserve existing punch-in behaviour.
        // Stop the old free-running pattern before subscribing to new performance events.
        const autoPattern = getMachine().kind === "drums" && $<HTMLInputElement>("sr-auto-pattern").checked && !engine.isPlaying();
        if (autoPattern) {
          stopDrums();
          ownsPatternClock = true;
          setDrumTempoSource(() => engine.getBpm());
        }
        let seededControllers = false;
        unsubscribePerformance = onPerformanceMidi((bytes,at)=>{
          if(!engine.isActive()&&captureTrackId){
            if(!seededControllers&&engine.canCapturePerformanceAt(at)&&(bytes[0]&0xf0)===0x90&&bytes[2]>0){
              seededControllers=true;
              const bend=Math.max(0,Math.min(16383,Math.round((getPitchBend()+1)*8192)));
              engine.capturePerformanceMidi(captureTrackId,[0xe0,bend&127,bend>>7],at);
              engine.capturePerformanceMidi(captureTrackId,[0xb0,1,Math.round(getModWheel()*127)],at);
              engine.capturePerformanceMidi(captureTrackId,[0xb0,64,getSustainPedal()?127:0],at);
            }
            engine.capturePerformanceMidi(captureTrackId,bytes,at);options.autosave();
          }
        });
        await engine.record({midiOnly:true, onStart: autoPattern ? at => {
          if (token !== operation || !ownsPatternClock || engine.isActive() || getMachine().kind !== "drums") return;
          try { stopDrums(); startDrums(at, 0); }
          catch (err) {
            error = err instanceof Error ? err.message : "Drum pattern could not start.";
            void finish();
          }
        } : undefined});
        if (token !== operation) return;
        busy = false; options.autosave(); refresh();
      } else if (id === "sr-stop") await finish();
      else if (id === "sr-play") { await options.ready; engine.setBpm(engine.getBpm()); await engine.play(); refresh(); }
      else if (id === "sr-click") engine.setRecordingSettings({metronome:!engine.getRecordingSettings().metronome});
      else if (id === "sr-count-in") engine.setRecordingSettings({countIn:!engine.getRecordingSettings().countIn});
      options.autosave();
    } catch (err) { releasePatternClock(); busy = false; captureTrackId = null; unsubscribePerformance?.(); unsubscribePerformance = null; error = err instanceof Error ? err.message : "Recording could not start."; refresh(); }
  });
  root.addEventListener("change",e=>{
    const el=e.target as HTMLInputElement;
    if(el.id==="sr-bpm")engine.setBpm(Number(el.value));
    if(el.id==="sr-click-volume")engine.setRecordingSettings({clickVolume:Number(el.value)});
    options.autosave();
  });
  onParamChange((key,value)=>{
    const track=captureTrackId?engine.getTrack(captureTrackId):null;
    if(!engine.isActive()&&track?.machineId===getMachine().id){track.setParam(key,value);options.autosave();}
  });
  onPresetChange(()=>{
    const track=captureTrackId?engine.getTrack(captureTrackId):null;
    if(!engine.isActive()&&track?.machineId===getMachine().id){track.loadPatchSnapshot({...getSynthPatch()},getSynthPresetId(),"Custom",track.machineId);options.autosave();}
  });
  onMachineChange(()=>{if(captureTrackId&&!engine.isActive()){void finish();}else refresh();});
  engine.onChange(refresh);document.addEventListener("sy1-view-change",refresh);refresh();
  return {
    captureController(cmd:number,d1:number,d2:number,channel:number) {
      const selected=getMidiChannel();
      if(selected!==0&&channel!==selected)return false;
      if(captureTrackId&&!engine.isActive()&&cmd===0xb0&&d1===64)engine.capturePerformanceMidi(captureTrackId,[cmd,d1,d2],engine.nowAudioTime());
      return false;
    }
  };
}
