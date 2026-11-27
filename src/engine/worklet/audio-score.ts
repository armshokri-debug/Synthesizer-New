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
  private repeatOrigin=0;
  private repeatPeriod=0;
  private repeatCycle=0;
  private repeatStride=0;
  private repeatMaxId=0;
  private repeatBase=0;
  // Separate from the signed 32-bit finite-score and positive live IDs.
  private repeatNextId=-2147483648;
  private attacksPerCycle=0;
  load(generation:number, data:Float64Array, nowFrame:number, armed=true, repeat?:{origin:number;period:number}): boolean {
    if(this.data || !Number.isSafeInteger(generation) || generation<=this.generation ||
      !(data instanceof Float64Array) || !data.length || data.length%SCORE_STRIDE ||
      data.length/SCORE_STRIDE>MAX_SCORE_EVENTS) return false;
    if(repeat&&(!Number.isSafeInteger(repeat.origin)||repeat.origin<nowFrame||!Number.isFinite(repeat.period)||repeat.period<128))return false;
    let prev=nowFrame,minId=0,maxId=-2147483647,attacks=0;
    const held=new Set<number>();
    for(let i=0;i<data.length;i+=SCORE_STRIDE){
      const frame=data[i], type=data[i+1], id=data[i+2], midi=data[i+3], cents=data[i+4], vel=data[i+5];
      if(!Number.isSafeInteger(frame)||frame<prev||!Number.isInteger(id)||id>=0||id< -2147483647||
        (type!==1&&type!==2)||!Number.isInteger(midi)||midi<0||midi>127||
        !Number.isFinite(cents)||Math.abs(cents)>1200||!Number.isFinite(vel)||vel<0||vel>1) return false;
      if(repeat&&(frame<repeat.origin||frame>repeat.origin+Math.round(repeat.period)))return false;
      if(type===1){if(held.has(id))return false;held.add(id);attacks++;minId=Math.min(minId,id);maxId=Math.max(maxId,id);}
      else {if(!held.delete(id))return false;}
      prev=frame;
    }
    if(held.size||!attacks||(repeat&&maxId-minId+1>MAX_SCORE_EVENTS))return false;
    this.repeatOrigin=repeat?.origin??0;
    this.repeatPeriod=repeat?.period??0;
    this.repeatCycle=0;this.repeatStride=maxId-minId+1;this.repeatMaxId=maxId;this.attacksPerCycle=attacks;
    if(repeat){this.repeatBase=this.repeatNextId;this.repeatNextId-=this.repeatStride;}
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
    while(i<data.length){
      let at=data[i],id=data[i+2];
      if(this.repeatPeriod){
        const relative=at-this.repeatOrigin;
        // Seam releases share the exact rounded frame of the next downbeat.
        at=this.repeatOrigin+(relative===Math.round(this.repeatPeriod)
          ?Math.round((this.repeatCycle+1)*this.repeatPeriod)
          :Math.round(this.repeatCycle*this.repeatPeriod+relative));
        id=this.repeatBase+(id-this.repeatMaxId);
      }
      if(at>=end)break;
      const offset=at-frame;
      if(offset<0&&data[i+1]===1)this.missed++;
      else dispatch(data[i+1],id,data[i+3],data[i+4],data[i+5],Math.max(0,offset));
      i+=SCORE_STRIDE;
      if(i===data.length&&this.repeatPeriod){
        const target=Math.max(this.repeatCycle+1,Math.floor((frame-this.repeatOrigin)/this.repeatPeriod));
        const skipped=target-this.repeatCycle-1;
        this.missed+=skipped*this.attacksPerCycle;
        this.repeatCycle=target;
        this.repeatNextId-=skipped*this.repeatStride;
        this.repeatBase=this.repeatNextId;this.repeatNextId-=this.repeatStride;
        i=0;
      }
    }
    this.cursor=i;
    // Keep generation ownership until explicit cancel, including release tails.
  }
  get missedAttacks():number{return this.missed;}
}
