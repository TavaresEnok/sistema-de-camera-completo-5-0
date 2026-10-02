#!/usr/bin/env python3
"""Opt-in production benchmark: existing ready video, no events/config changes.

Credentials travel only through captured process pipes/stdin, never files or
Docker command-line/environment configuration. Output redacts credential values.
Normal active analyses are excluded, so the benchmark adds distinct cameras.
"""
import argparse
import json
import subprocess
import urllib.parse

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--limit', type=int, required=True)
parser.add_argument('--seconds', type=int, default=20)
args = parser.parse_args()
if not 1 <= args.limit <= 40:
    raise SystemExit('limit must be 1..40')

code = r'''
const {PrismaClient}=require('/app/apps/api/node_modules/@prisma/client');
const p=new PrismaClient();
(async()=>{try {
const headers={Authorization:'Basic '+Buffer.from(process.env.MEDIAMTX_API_USER+':'+process.env.MEDIAMTX_API_PASS).toString('base64')};
const r=await fetch('http://mediamtx:9997/v3/paths/list',{headers,signal:AbortSignal.timeout(5000)});
if(!r.ok)throw new Error('paths unavailable');
const ready=new Set((await r.json()).items.filter(x=>x.ready).map(x=>x.name));
const active=(await (await fetch('http://ai-service:8000/health',{signal:AbortSignal.timeout(5000)})).json()).processors;
const all=await p.camera.findMany({select:{id:true,publicId:true,detectionZones:true},orderBy:{publicId:'asc'}});
const cameras=all.filter(c=>!active[c.id]&&ready.has('cam_'+c.id.replaceAll('-','')+'_grid'));
process.stdout.write(JSON.stringify({BENCH_MEDIA_USER:process.env.MEDIAMTX_API_USER,BENCH_MEDIA_PASS:process.env.MEDIAMTX_API_PASS,BENCH_CAMERAS_JSON:JSON.stringify(cameras)}));
}finally{await p.$disconnect();}})().catch(()=>{process.stderr.write('Unable to select ready cameras');process.exitCode=1;});
'''
config = json.loads(subprocess.check_output(['docker', 'exec', 'vms-api', 'node', '-e', code], timeout=15))
cameras = json.loads(config['BENCH_CAMERAS_JSON'])
if len(cameras) < args.limit:
    raise SystemExit(f'Only {len(cameras)} eligible ready cameras; refusing a mislabeled test')
print(json.dumps({'additional_cameras': args.limit, 'public_ids': [c['publicId'] for c in cameras[:args.limit]]}), flush=True)
bootstrap = 'import os,sys,json;os.environ.update(json.loads(sys.stdin.readline()));sys.argv=["bench"]+sys.argv[1:];exec(compile(open("/app/tests/bench_stream_fleet.py").read(),"bench_stream_fleet.py","exec"))'
command = ['docker', 'run', '--rm', '-i', '--name', 'drac-motion-capacity-probe', '--network', 'infra_vms-net',
           '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
           '-e', 'PYTHONDONTWRITEBYTECODE=1', '-e', 'AI_LOG_LEVEL=ERROR',
           '-v', '/opt/drac-pipeline-20261001/services/ai-service-python:/app:ro',
           '-w', '/app', 'drac-pipeline-ai:20261001-events', 'python', '-c', bootstrap,
           '--label', f'vibe-additional-{args.limit}', '--limit', str(args.limit), '--seconds', str(args.seconds),
           '--startup-seconds', '45', '--rates', '3,5,7,10']
process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
process.stdin.write(json.dumps(config) + '\n')
process.stdin.close()
try:
    for line in process.stdout:
        for value in (config['BENCH_MEDIA_USER'], config['BENCH_MEDIA_PASS']):
            if value:
                line = line.replace(value, '<redacted>').replace(urllib.parse.quote(value, safe=''), '<redacted>')
        print(line, end='', flush=True)
    raise SystemExit(process.wait())
finally:
    if process.poll() is None:
        subprocess.run(['docker', 'stop', '--time', '10', 'drac-motion-capacity-probe'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        process.wait(timeout=20)
