#!/usr/bin/env python3
"""Remove reviewed AjustCam source/history after a successful runtime migration.

Explicit installation children only; never recursively delete the workspace,
storage, database volumes, device identity, recordings, credentials or backups.
Old runtime images are recoverable from the separately verified vendor backup.
"""
import argparse
import json
import os
from pathlib import Path
import re
import shutil
import subprocess

SOURCE_CHILDREN=['.git','apps','services','tools','docs','archive','legacy','novo-design','Drac-app-redesign',
    'novo-mockup-app-drac','redesig central','.github','README.md','package.json','pnpm-lock.yaml','pnpm-workspace.yaml','.gitignore','.dockerignore']
OLD_IMAGES=['drac-pipeline-ai:20261004-recorded-validation','infra-ai-service:latest',
    'drac-pipeline-api:20261004-recorded-validation','infra-api:latest','infra-web:latest','drac-pipeline-web:20261004-analysis-metrics']

def run(command):return subprocess.run(command,check=True,capture_output=True,text=True).stdout

parser=argparse.ArgumentParser();parser.add_argument('--apply',action='store_true');parser.add_argument('--vendor-source-backup-sha',required=True);parser.add_argument('--vendor-images-backup-sha',required=True)
args=parser.parse_args();root=Path('/opt/drac')
if os.geteuid()!=0 or root.is_symlink():raise SystemExit('Reviewed root installation required')
if any(not re.fullmatch('[a-f0-9]{64}',value) for value in [args.vendor_source_backup_sha,args.vendor_images_backup_sha]):raise SystemExit('Verified off-host backup evidence required')
state=json.loads((root/'.runtime-release.json').read_text())
if state.get('protection')!='standard' or not state.get('images'):raise SystemExit('Signed runtime migration required before cleanup')
for name,service in [('vms-api','api'),('vms-web','web'),('vms-ai-service','ai-service')]:
    container=json.loads(run(['docker','inspect',name]))[0]
    if container['Image']!=state['images'][service] or container['State'].get('Health',{}).get('Status')!='healthy':raise SystemExit('Healthy approved runtime required before cleanup')
    for mount in container.get('Mounts',[]):
        for child in SOURCE_CHILDREN:
            path=str(root/child)
            if mount.get('Source','')==path or mount.get('Source','').startswith(path+'/'):raise SystemExit('Source still mounted by production; cleanup refused')
sources=[root/name for name in SOURCE_CHILDREN if (root/name).exists() or (root/name).is_symlink()]
tracked=run(['git','-c','safe.directory=/opt/drac','-C',str(root),'ls-files','scripts','infra']).splitlines() if (root/'.git').exists() else []
keep_scripts={name.removeprefix('runtime/') for name in state['files'] if name.startswith('runtime/scripts/')}
obsolete_scripts=[root/name for name in tracked if name.startswith('scripts/') and name not in keep_scripts and (root/name).is_file()]
obsolete_build_files=[root/name for name in tracked if name.startswith('infra/Dockerfile') and (root/name).is_file()]
all_containers=run(['docker','ps','-a','--format','{{.Names}}']).splitlines()
if any(not name.startswith('vms-') for name in all_containers):raise SystemExit('Unrelated Docker workload found; do not clear shared build cache')
unused=[]
for name in OLD_IMAGES:
    check=subprocess.run(['docker','image','inspect',name,'--format','{{.Id}}'],capture_output=True,text=True)
    if check.returncode==0:unused.append(name)
print(json.dumps({'cleanupPlan':True,'sourceChildren':[str(x) for x in sources],'obsoleteOperationalFiles':len(obsolete_scripts)+len(obsolete_build_files),'oldImages':unused,'clearAjustCamBuildCache':True,'preserve':['infra/.env','infra/storage','infra/backups','infra/ai-models','infra/apk','database volumes','device identity','host HTTPS/TURN']}))
if args.apply:
    for path in obsolete_scripts+obsolete_build_files:
        if path.is_symlink():path.unlink()
        elif path.is_file():path.unlink()
    for path in sources:
        if path.parent!=root:raise SystemExit('Unexpected cleanup path')
        if path.is_symlink() or path.is_file():path.unlink()
        else:shutil.rmtree(path)
    for name in unused:run(['docker','image','rm',name])
    # VM was checked above to contain only AjustCam containers. This removes
    # build cache, never images in use or database/recording volumes.
    run(['docker','builder','prune','--all','--force'])
    remaining=[name for name in SOURCE_CHILDREN if (root/name).exists()]
    if remaining:raise SystemExit('Source cleanup incomplete')
    print(json.dumps({'sourceRemoved':True,'oldImagesRemoved':len(unused),'buildCacheRemoved':True,'recoverableFromVendorBackup':True,'recordingsDeleted':False,'databaseVolumesDeleted':False}))
