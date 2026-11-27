/**
 * Audio-clock-owned finite note score. Experimental HQ transport primitive.
 * Packed immutable rows: absolute sample frame, type (1 on/2 off), negative
 * voice ID, MIDI pitch, cents, velocity. No UI timer or per-block allocations.
 * One score per node, explicit cancel before replacing an active score.
 * Negative IDs isolate score voices from the legacy positive-ID live path.
 */
export const SCORE_STRIDE = 6;
export const MAX_SCORE_EVENTS = 131072;
export type ScoreDispatch = (type:number,id:number,midi:number,cents:number,vel:number,offset:number)=>void;
export class AudioScore {
  private data: Float64Array | null = null;
  private cursor = 0;
  private generation = 0;
  private missed = 0;
  private armed = false;
  load(generation:number, data:Float64Array, nowFrame:number, armed=true): boolean {
    if(this.data || !Number.isSafeInteger(generation) || generation<=this.generation ||
      !(data instanceof Float64Array) || !data.length || data.length%SCORE_STRIDE ||
      data.length/SCORE_STRIDE>MAX_SCORE_EVENTS) return false;
    let prev=nowFrame;
    const held=new Set<number>();
    for(let i=0;i<data.length;i+=SCORE_STRIDE){
      const frame=data[i], type=data[i+1], id=data[i+2], midi=data[i+3], cents=data[i+4], vel=data[i+5];
      if(!Number.isSafeInteger(frame)||frame<prev||!Number.isInteger(id)||id>=0||id< -2147483647||
        (type!==1&&type!==2)||!Number.isInteger(midi)||midi<0||midi>127||
        !Number.isFinite(cents)||Math.abs(cents)>1200||!Number.isFinite(vel)||vel<0||vel>1) return false;
      if(type===1){if(held.has(id))return false;held.add(id);}
      else {if(!held.delete(id))return false;}
      prev=frame;
    }
    if(held.size)return false;
    this.data=data;this.cursor=0;this.generation=generation;this.missed=0;this.armed=armed;
    return true;
  }
  arm(generation:number):boolean {
    if(!this.data||generation!==this.generation)return false;
    this.armed=true;return true;
  }
  cancel(generation:number):boolean {
    if(generation!==this.generation)return false;
    this.data=null;this.cursor=0;return true;
  }
  clear():void {this.data=null;this.cursor=0;}
  drain(frame:number,n:number,dispatch:ScoreDispatch):void {
    const data=this.data;
    if(!data||!this.armed)return;
    const end=frame+n;
    let i=this.cursor;
    while(i<data.length&&data[i]<end){
      const offset=data[i]-frame;
      if(offset<0&&data[i+1]===1)this.missed++;
      else dispatch(data[i+1],data[i+2],data[i+3],data[i+4],data[i+5],Math.max(0,offset));
      i+=SCORE_STRIDE;
    }
    this.cursor=i;
    // Keep generation ownership until explicit cancel, including release tails.
  }
  get missedAttacks():number{return this.missed;}
}
