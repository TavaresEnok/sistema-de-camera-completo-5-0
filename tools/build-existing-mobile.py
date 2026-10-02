#!/usr/bin/env python3
"""Use the existing authenticated builder; token stays only in process memory.

Run on management as the operator. Builds only existing clients, from an exact
reviewed commit; the configured builder publishes signed artifacts normally.
"""
import argparse
import json
from pathlib import Path
import re
import subprocess
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--slug')
parser.add_argument('--commit')
parser.add_argument('--status')
args = parser.parse_args()
pid = subprocess.check_output(['systemctl','show','s2cam-mobile-build-agent.service','-p','MainPID','--value'],text=True).strip()
if not pid.isdigit() or pid=='0':
    raise SystemExit('Existing builder is not running')
env = dict(item.split(b'=',1) for item in Path('/proc/'+pid+'/environ').read_bytes().split(b'\0') if b'=' in item)
token = env.get(b'BUILD_AGENT_TOKEN',b'').decode()
if not token:
    raise SystemExit('Existing builder authentication unavailable')
host = env.get(b'BUILD_AGENT_HOST',b'127.0.0.1').decode()
if host in ('0.0.0.0','::'):
    host = '127.0.0.1'
base = 'http://'+host+':'+env.get(b'BUILD_AGENT_PORT',b'8780').decode()
if args.status:
    if not re.fullmatch(r'[A-Za-z0-9-]{1,100}',args.status):
        raise SystemExit('Invalid job id')
    request = Request(base+'/builds/'+args.status,headers={'x-build-token':token})
else:
    if not re.fullmatch(r'[a-z0-9][a-z0-9-]{1,38}',args.slug or '') or not re.fullmatch(r'[a-f0-9]{40}',args.commit or ''):
        raise SystemExit('Existing client slug and exact reviewed commit required')
    request = Request(base+'/builds',data=json.dumps({'slug':args.slug,'sourceCommit':args.commit}).encode(),
                      headers={'x-build-token':token,'Content-Type':'application/json'},method='POST')
try:
    with urlopen(request,timeout=20) as response:
        data = json.load(response)
except HTTPError as error:
    raise SystemExit('Existing builder returned HTTP '+str(error.code))
except URLError:
    raise SystemExit('Existing builder could not be reached at its configured address')
job = data.get('job',data)
print(json.dumps({key:job.get(key) for key in ['jobId','id','slug','status','sourceCommit','startedAt','finishedAt'] if key in job}))
if args.status:
    log = str(job.get('log',''))
    print(json.dumps({'logBytes':len(log),'progress':re.findall(r'^> Task [A-Za-z0-9:_-]+',log,re.M)[-5:],
                      'buildSuccessful':'BUILD SUCCESSFUL' in log,'buildFailed':'BUILD FAILED' in log}))
