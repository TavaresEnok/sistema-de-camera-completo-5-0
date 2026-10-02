#!/usr/bin/env python3
"""Read one camera grid using memory-only credentials; decoded arrival timing."""
import argparse
import json
import shlex
import subprocess
from urllib.parse import urlsplit, urlunsplit

p=argparse.ArgumentParser(description=__doc__)
p.add_argument('--installation',choices=['vibe','ib'],default='ib')
p.add_argument('--camera',type=int,default=100002)
p.add_argument('--source',choices=['grid','input'],default='grid')
a=p.parse_args()
prefix=['ssh','-S','/tmp/drac-ib-control-20261002','-o','BatchMode=yes','-p','22003','ibtelecom@177.104.156.25'] if a.installation=='ib' else []
def command(args):return prefix+[shlex.join(args)] if prefix else args
selection=r'''
const {PrismaClient}=require('/app/apps/api/node_modules/@prisma/client');const p=new PrismaClient();
(async()=>{try{const c=await p.camera.findFirst({where:{publicId:Number(process.env.PROBE_CAMERA),enabled:true},select:{id:true}});
if(!c)throw Error('Camera unavailable');
const path='cam_'+c.id.replaceAll('-','')+'_grid';
const h={Authorization:'Basic '+Buffer.from(process.env.MEDIAMTX_API_USER+':'+process.env.MEDIAMTX_API_PASS).toString('base64')};
const configs=await(await fetch('http://mediamtx:9997/v3/config/paths/list',{headers:h})).json();
const paths=new Map(configs.items.map(x=>[x.name,x]));let current=path;const stages=[];const scripts=[];let inputPath=null;
for(let i=0;i<5;i++){const conf=paths.get(current);if(!conf)break;
let u;try{u=new URL(conf.source)}catch{};
const command=conf.runOnDemand||conf.runOnReady||'';
scripts.push(command);
if(!u){const match=command.match(/(?:^| )-i +(?:'([^']+)'|"([^"]+)"|(\S+))/);
try{u=new URL((match?.[1]||match?.[2]||match?.[3]||'').replaceAll('$RTSP_PORT','8554'));}catch{}}
const flags={};for(const flag of ['c:v','g','r','b:v','preset','tune']){const match=command.match(new RegExp('(?:^| )-'+flag+' +([a-zA-Z0-9_.-]{1,24})(?: |$)'));if(match)flags[flag]=match[1];}
stages.push({role:current.endsWith('_grid')?'grid':current.startsWith('cam_')?'camera-source':'upstream',sourceScheme:u?.protocol||conf.source,
sourceHostRole:u?.hostname==='177.104.156.25'?'gateway':u?.hostname==='127.0.0.1'||u?.hostname==='mediamtx'?'internal':u?.hostname?.startsWith('10.')?'private-10-network':'other',
sourcePort:u?.port,onDemand:conf.sourceOnDemand,encoderFlags:flags});
if(!u||!['mediamtx','127.0.0.1','localhost'].includes(u.hostname))break;current=decodeURIComponent(u.pathname.replace(/^\//,''));if(!inputPath)inputPath=current;}
const chosen=process.env.PROBE_SOURCE==='input'&&inputPath?inputPath:path;
process.stdout.write(JSON.stringify({url:'rtsp://'+encodeURIComponent(process.env.MEDIAMTX_API_USER)+':'+encodeURIComponent(process.env.MEDIAMTX_API_PASS)+'@mediamtx:8554/'+chosen,stages,source:process.env.PROBE_SOURCE,inputPath,scripts}));
}finally{await p.$disconnect();}})().catch(()=>process.exit(1));
'''
try:
    cfg=json.loads(subprocess.check_output(command(['docker','exec','-e','PROBE_CAMERA='+str(a.camera),'-e','PROBE_SOURCE='+a.source,'vms-api','node','-e',selection]),timeout=20))
except (subprocess.SubprocessError,ValueError):raise SystemExit('Unable to select capture path (no configuration changed)')
if a.source=='input' and not cfg['inputPath']:
    stack=[(s,0) for s in cfg['scripts']];input_url=None
    while stack:
        script,depth=stack.pop()
        try:tokens=shlex.split(script)
        except ValueError:continue
        for index,token in enumerate(tokens[:-1]):
            if token=='-i':
                try:
                    u=urlsplit(tokens[index+1].replace('$RTSP_PORT','8554'))
                    if u.scheme=='rtsp' and u.hostname in ('127.0.0.1','localhost','mediamtx'):
                        input_url=u;break
                except ValueError:pass
        if input_url:break
        if depth<6:stack.extend((t,depth+1) for t in tokens if ' -i ' in t)
    if not input_url:raise SystemExit('Internal input path unavailable; refusing to open a direct camera URL')
    cfg['url']=urlunsplit(urlsplit(cfg['url'])._replace(path=input_url.path,query=input_url.query))
del cfg['scripts']
code=r'''
import json,sys,time,statistics,os
os.environ['OPENCV_FFMPEG_CAPTURE_OPTIONS']='rtsp_transport;tcp'
import cv2
cv2.setNumThreads(1)
cfg=json.load(sys.stdin)
params=[]
for k,v in [('CAP_PROP_N_THREADS',1),('CAP_PROP_OPEN_TIMEOUT_MSEC',15000),('CAP_PROP_READ_TIMEOUT_MSEC',15000)]:
 if hasattr(cv2,k):params += [getattr(cv2,k),v]
cap=cv2.VideoCapture(cfg['url'],cv2.CAP_FFMPEG,params)
if not cap.isOpened():raise SystemExit(2)
arrivals=[];began=time.monotonic()
try:
 while time.monotonic()-began<25:
  if not cap.grab():raise SystemExit(3)
  if time.monotonic()-began>5:arrivals.append(time.monotonic())
 info={k:cap.get(v) for k,v in [('width',cv2.CAP_PROP_FRAME_WIDTH),('height',cv2.CAP_PROP_FRAME_HEIGHT),('declared_fps',cv2.CAP_PROP_FPS)]}
 n=int(cap.get(cv2.CAP_PROP_FOURCC));info['codec']=''.join(chr((n>>(8*i))&255) for i in range(4))
finally:cap.release()
gaps=sorted((b-a)*1000 for a,b in zip(arrivals,arrivals[1:]));pauses=[x for x in gaps if x>20]
print(json.dumps({'source':cfg['source'],'decoded_frames':len(arrivals),'fps':round((len(arrivals)-1)/(arrivals[-1]-arrivals[0]),3),'gap_p95_ms':round(gaps[int(.95*(len(gaps)-1))],3),'gap_max_ms':round(max(gaps),3),'pauses_over_150ms':sum(x>150 for x in gaps),'pauses_over_400ms':sum(x>400 for x in gaps),'pause_median_ms':round(statistics.median(pauses),3) if pauses else None,'stream':info,'stages':cfg['stages']}))
'''
result=subprocess.run(command(['docker','run','--rm','-i','--network','infra_vms-net','--read-only','--memory','256m','--cpus','1',
                               '--entrypoint','python','drac-pipeline-ai:20261002-deadline','-c',code]),
                      input=json.dumps(cfg),text=True,timeout=70,stderr=subprocess.DEVNULL)
raise SystemExit(result.returncode)
