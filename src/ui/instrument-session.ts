import type { SY1TrackEngine } from "../studio/track-engine";
export interface ProjectInstrumentSession {
  track:SY1TrackEngine;bpm:number;
  chooseMachine(id:string):void;
  choosePreset(id:string,kind:"sound"|"kit"|"style",keepKit?:boolean):void;
}
let readSession:()=>ProjectInstrumentSession|null=()=>null;
export function setInstrumentSessionReader(reader:()=>ProjectInstrumentSession|null):void {readSession=reader;}
export function getProjectInstrumentSession():ProjectInstrumentSession|null{return readSession();}
