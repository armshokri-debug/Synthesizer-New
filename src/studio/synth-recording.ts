import type { SynthPatch } from "../engine/params";
import { getStudioMachineDef } from "./track-engine";
import type { SY1StudioEngine } from "./studio-engine";

/** Never repurpose a populated track with a different instrument or sound. */
export function prepareSynthRecordingTrack(engine: SY1StudioEngine, machineId: string, patch: SynthPatch, presetId: string) {
  const machine = getStudioMachineDef(machineId);
  const tracks = [engine.getFocusedTrack(), ...engine.getTracks().filter(t => t.id !== engine.getFocusedTrack().id)];
  const signature = JSON.stringify(Object.entries(patch).sort(([a],[b]) => a.localeCompare(b)));
  let track = tracks.find(t => t.machineId === machine.id && JSON.stringify(Object.entries(t.patch).sort(([a],[b])=>a.localeCompare(b))) === signature);
  const hasSourceMidi = (candidate: typeof tracks[number]) =>
    candidate.getRegions(engine.getTotalTicks()).some(region => region.events.length > 0);
  track ||= tracks.find(candidate => !hasSourceMidi(candidate));
  track ||= engine.addTrack() || undefined;
  if (!track) throw new Error("All four tracks contain performances. Open Studio to choose a track; nothing was overwritten.");
  track.loadPatchSnapshot({...patch}, presetId, machine.presets.find(p=>p.id===presetId)?.name || "Custom", machine.id);
  if (!hasSourceMidi(track)) track.name = machine.name;
  for (const t of engine.getTracks()) t.armed = t.id === track.id;
  engine.setFocusedTrack(track.id);
  return track;
}
