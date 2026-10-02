#!/usr/bin/env python3
"""Actual production UI, bounded navigation; temporary auth only via memory pipes.

Uses an existing active administrator without changing the account or creating
refresh sessions. Only the browser's auth refresh response is supplied by CDP;
all other requests use the production app/API. No config/save clicks are made.
"""
import json
import argparse
import os
from pathlib import Path
import subprocess

parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--soak',type=int,default=0,help='Keep four actual grid players for bounded seconds')
parser.add_argument('--output',help='Exclusive counters-only log, mode 0600')
args=parser.parse_args()
if args.soak and not 60<=args.soak<=7200:parser.error('Soak must be between 60 and 7200 seconds')

selection = r'''
const {PrismaClient}=require('/app/apps/api/node_modules/@prisma/client');
const {JwtService}=require('/app/apps/api/node_modules/@nestjs/jwt');const p=new PrismaClient();
(async()=>{try{
const u=await p.user.findFirst({where:{isActive:true,role:'SUPER_ADMIN'},select:{id:true,name:true,username:true,email:true,role:true,authVersion:true}});
if(!u)throw new Error('No existing administrator');
const accessToken=new JwtService({secret:process.env.JWT_SECRET}).sign({sub:u.id,username:u.username,email:u.email,role:u.role,ver:u.authVersion,type:'access'},{expiresIn:Number(process.env.PROBE_AUTH_SECONDS)||1200});
const active=await (await fetch('http://ai-service:8000/health')).json();
const cams=await p.camera.findMany({where:{enabled:true},select:{id:true,recordingMode:true},orderBy:{publicId:'asc'}});
const grid=cams.filter(c=>active.processors[c.id]).slice(0,3);
const manual=cams.find(c=>c.recordingMode==='manual');
if(!manual||!grid.length)throw new Error('No eligible cameras');
if(!grid.some(c=>c.id===manual.id))grid.push(manual);
delete u.authVersion;
process.stdout.write(JSON.stringify({origin:'https://vibe.s2cam.com.br',auth:{accessToken,user:u},cameraIds:grid.map(c=>c.id),manualId:manual.id}));
}finally{await p.$disconnect();}})().catch(()=>{process.stderr.write('UI selection failed');process.exitCode=1});
'''
config=json.loads(subprocess.check_output(['docker','exec','-e','PROBE_AUTH_SECONDS='+str(max(1200,args.soak+300)),'vms-api','node','-e',selection],timeout=20))
config['soakSeconds']=args.soak
code=Path(__file__).with_suffix('.cjs').read_text()
output=open(args.output,'x',buffering=1) if args.output else None
if args.output:os.chmod(args.output,0o600)
try:
    result=subprocess.run(['docker','exec','-i','drac-operational-browser','node','-e',code],input=json.dumps(config),text=True,
                          timeout=max(900,args.soak+180),stdout=output,stderr=output)
finally:
    if output:output.close()
raise SystemExit(result.returncode)
