#!/usr/bin/env python3
"""Fetch the installation-scoped approved package over HTTPS, without secrets in argv/logs."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import urllib.request
import urllib.parse

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,req,fp,code,msg,headers,newurl):return None

parser=argparse.ArgumentParser();parser.add_argument('--environment',type=Path,required=True);parser.add_argument('--output',type=Path,required=True);parser.add_argument('--commit',required=True)
args=parser.parse_args();settings={}
for line in args.environment.read_text().splitlines():
    if '=' in line and not line.startswith('#'):
        key,value=line.split('=',1);settings[key]=value.strip().strip('"\'')
central=settings['CLOUD_API_URL'].rstrip('/');url=urllib.parse.urlsplit(central)
if url.scheme!='https' or url.username or url.password:raise SystemExit('Central HTTPS origin required')
headers={'X-DRAC-Installation-Id':settings['CLOUD_INSTALLATION_ID'],'X-DRAC-License-Key':settings['CLOUD_LICENSE_KEY']}
opener=urllib.request.build_opener(NoRedirect)
request=urllib.request.Request(central+'/api/agent/artifacts/claim',data=b'{}',headers={**headers,'Content-Type':'application/json'},method='POST')
with opener.open(request,timeout=30) as response:grant=json.loads(response.read(8192))
if grant.get('commit')!=args.commit or type(grant.get('size')) is not int or not 0<grant['size']<=12*1024**3:raise SystemExit('Unexpected approved runtime')
if args.output.exists():raise SystemExit('Existing file preserved; choose another download target')
token=grant.get('token','')
if not isinstance(token,str) or len(token)!=43 or not all(c.isascii() and (c.isalnum() or c in '_-') for c in token):raise SystemExit('Temporary grant rejected')
received=0;digest=hashlib.sha256()
try:
    with opener.open(urllib.request.Request(central+'/api/agent/artifacts/download',headers={**headers,'X-DRAC-Artifact-Grant':token}),timeout=60) as response,args.output.open('xb') as output:
        os.chmod(args.output,0o600)
        while chunk:=response.read(1024*1024):
            received+=len(chunk)
            if received>grant['size']:raise ValueError('Oversized runtime')
            digest.update(chunk);output.write(chunk)
    if received!=grant['size'] or digest.hexdigest()!=grant['sha256']:raise ValueError('Download checksum mismatch')
    print(json.dumps({'downloaded':True,'commit':grant['commit'],'sha256Verified':True,'bytes':received}))
except Exception:
    # Exact file created by this attempt only; incomplete payload is never executed.
    args.output.unlink(missing_ok=True)
    raise SystemExit('Runtime download failed; incomplete file removed')
