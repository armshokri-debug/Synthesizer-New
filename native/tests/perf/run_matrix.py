#!/usr/bin/env python3
"""Paired serial-engine callback costs; not an Ableton meter or hardware dropout test."""
import argparse,subprocess,json,pathlib,statistics,platform
p=argparse.ArgumentParser();p.add_argument('before');p.add_argument('after');p.add_argument('output');p.add_argument('--full',action='store_true');p.add_argument('--seconds',type=float,default=2);p.add_argument('--repeat',type=int,default=3);a=p.parse_args()
# Full covers 1/3/5/8 instances x 3 rates x 4 buffers x 9 workloads.
rates=[44100,48000,96000] if a.full else [48000]
buffers=[64,128,256,512] if a.full else [128]
scenes=['idle','playing-idle','notes','chord','hold','sustain','tails','drums','cc','dense-cc'] if a.full else ['idle','playing-idle','chord','tails','cc','dense-cc','drums']
rows=[]
for count in [1,3,5,8]:
 for rate in rates:
  for block in buffers:
   for scene in scenes:
    for rep in range(a.repeat):
     pair={}
     # Alternate order to reduce systematic warm-up/load bias.
     for label,exe in ([('before',a.before),('after',a.after)] if rep%2==0 else [('after',a.after),('before',a.before)]):
      pair[label]=json.loads(subprocess.check_output([exe,str(count),str(rate),str(block),scene,str(a.seconds)],text=True))
     pair['repeat']=rep;pair['mean_reduction_percent']=100*(1-pair['after']['mean_us']/pair['before']['mean_us']);rows.append(pair)
    summary=rows[-a.repeat:];print(count,rate,block,scene,'median reduction',round(statistics.median(x['mean_reduction_percent'] for x in summary),1),flush=True)
    pathlib.Path(a.output).write_text(json.dumps({'machine':platform.platform(),'notes':'Unslept sequential aggregate callback costs. QuickJS malloc is NOT included in C++ allocation counts. No actual GUI/device. Warm-up excluded. OS preemption affects wall percentiles.','rows':rows},indent=2))
