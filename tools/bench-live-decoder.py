#!/usr/bin/env python3
"""Bounded CPU/cadence A/B of the relayed IB input; no media is saved.

Credentials are retrieved in memory only to resolve the existing private path.
The decoder uses the same trusted loopback RTSP input as the production FFmpeg.
Output is hashed by FFmpeg but hashes/images are discarded, never logged.
"""
import argparse
import json
import re
import shlex
import subprocess
import threading
import time
import uuid

p=argparse.ArgumentParser(description=__doc__)
p.add_argument('--compare-buffering',action='store_true',help='Also test retaining startup probe packets')
options=p.parse_args()
PREFIX = ['ssh', '-S', '/tmp/drac-ib-control-20261002', '-o', 'BatchMode=yes',
          '-p', '22003', 'ibtelecom@177.104.156.25']

def remote(args, **kwargs):
    return subprocess.run(PREFIX + [shlex.join(args)], **kwargs)

selection = r'''
const {PrismaClient}=require('/app/apps/api/node_modules/@prisma/client'); const db=new PrismaClient();
(async()=>{try{const c=await db.camera.findFirst({where:{publicId:100002,enabled:true},select:{id:true}});
if(!c)throw Error(); const name='cam_'+c.id.replaceAll('-','')+'_grid';
const h={Authorization:'Basic '+Buffer.from(process.env.MEDIAMTX_API_USER+':'+process.env.MEDIAMTX_API_PASS).toString('base64')};
const r=await fetch('http://mediamtx:9997/v3/config/paths/get/'+name,{headers:h});if(!r.ok)throw Error();
const conf=await r.json();const s=conf.runOnDemand||'';
const m=s.match(/rtsp:\/\/127\.0\.0\.1:(?:\$RTSP_PORT|8554)\/([a-zA-Z0-9_-]+)/);
if(!m)throw Error();process.stdout.write(JSON.stringify({path:m[1],
 url:'rtsp://'+encodeURIComponent(process.env.MEDIAMTX_API_USER)+':'+encodeURIComponent(process.env.MEDIAMTX_API_PASS)+'@127.0.0.1:8554/'+m[1]}));
}finally{await db.$disconnect();}})().catch(()=>process.exit(1));
'''
result=remote(['docker','exec','vms-api','node','-e',selection],capture_output=True,text=True,timeout=20)
try:cfg=json.loads(result.stdout)
except ValueError:raise SystemExit('Unable to resolve internal input')
path=cfg['path']
if result.returncode or not path or not all(c.isalnum() or c in '_-' for c in path):
    raise SystemExit('Unable to resolve existing internal input; no direct camera connection attempted')

variants=((0,False),(2,True),(2,False),(0,True)) if options.compare_buffering else ((0,False),(2,False))
for threads, buffered in variants:
    owner=str(uuid.uuid4()); name='drac-decoder-validation-'+owner[:8]
    args=['docker','run','--rm','-i','--name',name,'--label','org.ajustcam.validation='+owner,
          '--network','container:vms-mediamtx','--read-only','--cpus','2','--memory','512m',
          '--cap-drop','ALL','--entrypoint','ffmpeg','bluenviron/mediamtx:1-ffmpeg',
          '-nostdin','-hide_banner','-loglevel','info','-nostats','-benchmark','-flags','low_delay']
    if threads:args+=['-threads',str(threads)]
    args+=['-protocol_whitelist','file,pipe,tcp,udp,rtp,rtsp','-f','concat','-safe','0','-i','pipe:0',
           '-t','25','-map','0:v:0','-an',
           '-threads','2','-c:v','libx264','-preset','veryfast','-tune','zerolatency',
           '-g','30','-bf','0','-vf','fps=20','-flush_packets','1','-f','framemd5','pipe:1']
    start=time.monotonic();arrivals=[];worker_threads=None;threads_sampled=False
    process=subprocess.Popen(PREFIX+[shlex.join(args)],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
    def remove_owned_container():
        label=remote(['docker','inspect','--format','{{index .Config.Labels "org.ajustcam.validation"}}',name],
                     capture_output=True,text=True,timeout=10)
        if label.returncode==0 and label.stdout.strip()==owner:
            remote(['docker','rm','-f',name],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=20)
    deadline=threading.Timer(65,remove_owned_container)
    deadline.daemon=True;deadline.start()
    # The authenticated URL travels solely over stdin, like secret-url-process
    # in the application. Stderr is kept in memory and never printed verbatim.
    escaped=cfg['url'].replace("'", "'\\''")
    flags='+genpts+discardcorrupt' + ('' if buffered else '+nobuffer')
    document=("ffconcat version 1.0\nfile '"+escaped+"'\noption rtsp_transport tcp\n"
              "option fflags "+flags+"\noption analyzeduration 1000000\n"
              "option probesize 1000000\noption rw_timeout 15000000\n")
    process.stdin.write(document);process.stdin.close()
    try:
        for line in process.stdout:
            now=time.monotonic()
            if now-start>65:raise RuntimeError('Decoder exceeded bounded deadline')
            if line and not line.startswith('#') and ',' in line:
                arrivals.append(now)
                if not threads_sampled:
                    threads_sampled=True
                    top=remote(['docker','top',name,'-eo','pid,comm,nlwp'],capture_output=True,text=True,timeout=10)
                    for row in top.stdout.splitlines():
                        fields=row.split()
                        if len(fields)==3 and fields[1].endswith('ffmpeg'):worker_threads=int(fields[2])
        process.wait(timeout=10)
        stderr=process.stderr.read()
        if process.returncode or len(arrivals)<20:raise RuntimeError('Decoder produced insufficient frames')
        # Skip first 5 seconds of output: source start/probe and initial keyframe
        # waits must not be mislabeled as steady-state pauses.
        settled=[t for t in arrivals if t>=arrivals[0]+5]
        gaps=sorted((b-a)*1000 for a,b in zip(settled,settled[1:]))
        usage=re.search(r'utime=([0-9.]+)s stime=([0-9.]+)s rtime=([0-9.]+)s',stderr)
        print(json.dumps({'decoder_threads':threads or 'auto','elapsed_s':round(time.monotonic()-start,3),
          'input_buffering':buffered,'worker_threads':worker_threads,
          'cpu_seconds':round(float(usage[1])+float(usage[2]),3) if usage else None,
          'startup_to_first_packet_s':round(arrivals[0]-start,3),'frames':len(arrivals),
          'effective_fps':round((len(settled)-1)/(settled[-1]-settled[0]),3),
          'gap_p95_ms':round(gaps[int(.95*(len(gaps)-1))],3),'gap_max_ms':round(max(gaps),3),
          'pauses_over_150ms':sum(g>150 for g in gaps),'pauses_over_400ms':sum(g>400 for g in gaps)}),flush=True)
    finally:
        deadline.cancel()
        remove_owned_container()
        if process.poll() is None:process.terminate();process.wait(timeout=10)
