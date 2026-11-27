/** Maximum hit count in a half-open sliding window of a sorted score.
 * For repeated scores, include crossing the seam without expanding the song. */
export function maxDrumWindowHits(hits:readonly number[],span:number,period=0):number {
  if(!hits.length||!(span>0))return 0;
  const n=hits.length;
  if(!period){
    let first=0,max=0;
    for(let last=0;last<n;last++){
      while(first<last&&hits[last]-hits[first]>=span)first++;
      max=Math.max(max,last-first+1);
    }
    return max;
  }
  const cycles=Math.floor(span/period),remainder=span-cycles*period;
  if(remainder<=0)return cycles*n;
  let end=0,max=0;
  for(let start=0;start<n;start++){
    end=Math.max(start,end);
    while(end<start+n&&hits[end%n]+Math.floor(end/n)*period-hits[start]<remainder)end++;
    max=Math.max(max,end-start);
  }
  return cycles*n+max;
}
