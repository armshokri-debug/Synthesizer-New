#!/usr/bin/env python3
import argparse,subprocess,json,pathlib,platform
p=argparse.ArgumentParser();p.add_argument('binary');p.add_argument('output');p.add_argument('--coverage',action='store_true');p.add_argument('--seconds',type=float,default=4);a=p.parse_args()
counts=[5] if a.coverage else [1,3,5,8]
rates=[44100,48000,96000] if a.coverage else [48000]
buffers=[64,128,256,512] if a.coverage else [128]
scenes=['idle','playing-idle','chord','dense-cc','drums'] if a.coverage else ['idle','playing-idle','chord','hold','sustain','tails','cc','dense-cc','drums']
result={'method':'Before/after compiled into one process under separate namespaces; callback order alternates AB/BA. Serial engine processing. Two-second warm-up excludes initial graph setup, patch-save timer and startup idle GC. No device, real DAW, GUI or audio driver; mean/budget is not Ableton CPU. Timings are wall time and include OS scheduling noise.','platform':platform.platform(),'rows':[]}
for count in counts:
 for rate in rates:
  for buf in buffers:
   for scene in scenes:
    r=json.loads(subprocess.check_output([a.binary,str(count),str(rate),str(buf),scene,str(a.seconds)],text=True));b,c=r['versions'];r['mean_reduction_percent']=(1-c['mean_us']/b['mean_us'])*100;r['median_reduction_percent']=(1-c['median_us']/b['median_us'])*100;result['rows'].append(r)
    pathlib.Path(a.output).write_text(json.dumps(result,indent=2));print(count,rate,buf,scene,round(b['mean_us'],1),round(c['mean_us'],1),round(r['mean_reduction_percent'],1),flush=True)
