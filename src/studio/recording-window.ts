/** Frame-domain intersection of contiguous stereo recorder chunks with [start,end).
 * Uses views, not copies. Missing input frames are explicitly reported, never padded. */
export function trimCaptureWindow(chunks: Float32Array[][], firstFrame:number, startFrame:number, endFrame:number) {
  const output:Float32Array[][]=[[],[]];
  let cursor=firstFrame, frames=0;
  const from=Math.max(firstFrame,startFrame), to=Math.max(from,endFrame);
  for(let i=0;i<chunks[0].length;i++){
    const left=chunks[0][i],right=chunks[1][i];
    const end=cursor+left.length;
    const a=Math.max(cursor,from),b=Math.min(end,to);
    if(b>a){output[0].push(left.subarray(a-cursor,b-cursor));output[1].push(right.subarray(a-cursor,b-cursor));frames+=b-a;}
    cursor=end;
    if(cursor>=to)break;
  }
  return {chunks:output,frames,missingFrames:Math.max(0,endFrame-startFrame-frames)};
}
