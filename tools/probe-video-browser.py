#!/usr/bin/env python3
"""Read one ready camera through authenticated TURN; output counters only."""
import base64
import argparse
import hashlib
import hmac
import json
from pathlib import Path
import subprocess
import time

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--seconds', type=int, default=20)
parser.add_argument('--transport', choices=['udp','tcp','tls'])
parser.add_argument('--readers', type=int, default=1)
parser.add_argument('--installation', choices=['vibe','ib'], default='vibe')
parser.add_argument('--ssh-control-path', default='/tmp/drac-ib-control-20261002')
args = parser.parse_args()
if not 5 <= args.seconds <= 1800:
    raise SystemExit('seconds must be between 5 and 1800')
if not 1 <= args.readers <= 4:
    raise SystemExit('readers must be between 1 and 4')

values = dict(line.split('=', 1) for line in Path('/opt/drac/infra/.env').read_text().splitlines()
              if '=' in line and not line.startswith('#'))
secret = values['MEDIAMTX_TURN_SECRET'].strip().strip('"\'')
username = str(int(time.time()) + args.seconds + 120) + ':video-probe'
credential = base64.b64encode(hmac.new(secret.encode(), username.encode(), hashlib.sha1).digest()).decode()
selection = r'''
const h={Authorization:'Basic '+Buffer.from(process.env.MEDIAMTX_API_USER+':'+process.env.MEDIAMTX_API_PASS).toString('base64')};
(async()=>{const r=await fetch('http://mediamtx:9997/v3/paths/list',{headers:h});
if(!r.ok)throw new Error('paths unavailable');const d=await r.json();
let p=d.items.find(x=>x.ready&&x.name.endsWith('_grid'));
if(!p)p=d.items.find(x=>x.ready&&x.name.startsWith('cam_'));
if(!p){const {PrismaClient}=require('/app/apps/api/node_modules/@prisma/client');const db=new PrismaClient();
try{const c=await db.camera.findFirst({where:{publicId:100002,enabled:true},select:{id:true}});
if(c)p={name:'cam_'+c.id.replaceAll('-','')+'_grid'};}finally{await db.$disconnect();}}
if(!p)throw new Error('No eligible grid');
process.stdout.write(JSON.stringify({whep:process.env.MEDIAMTX_PUBLIC_WEBRTC_URL.replace(/\/$/,'')+'/'+p.name+'/whep',authorization:h.Authorization}));
})().catch(e=>{process.stderr.write(String(e.message)+'\n');process.exit(1)});
'''
command=['docker','exec','vms-api','node','-e',selection]
if args.installation=='ib':
    import shlex
    command=['ssh','-S',args.ssh_control_path,'-o','BatchMode=yes','-p','22003',
             'ibtelecom@177.104.156.25',shlex.join(command)]
config = json.loads(subprocess.check_output(command,timeout=20))
config.update(username=username, credential=credential, urls=[
    'turn:turn.s2cam.com.br:3478?transport=udp',
    'turn:turn.s2cam.com.br:3478?transport=tcp',
    'turns:turn.s2cam.com.br:5349?transport=tcp'])
config['seconds'] = args.seconds
if args.transport:
    config['urls'] = [config['urls'][['udp','tcp','tls'].index(args.transport)]]
config['urls'] *= args.readers
code = Path(__file__).with_name('browser-validation-runtime.cjs').read_text() + '\n' + Path(__file__).with_suffix('.cjs').read_text()
result = subprocess.run(['docker','exec','-i','drac-operational-browser','/usr/local/bin/drac-validation-init','-s','--','node','-e',code],
                        input=json.dumps(config),text=True,timeout=len(config['urls'])*(args.seconds+40)+20)
raise SystemExit(result.returncode)
