#!/usr/bin/env python3
"""Migrate an existing, empty-camera pilot without changing media services.

Run as root after transferring an approved package and its separately trusted
public key. Cleanup is a separate phase after the operator validates the pilot.
Never restore the license database during image rollback.
"""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time

HERE=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('runtime_bundle',HERE/'runtime-bundle.py')
verifier=importlib.util.module_from_spec(spec);spec.loader.exec_module(verifier)

def command(args,**kwargs):
    return subprocess.run(args,check=True,**kwargs)

def inspect(name):return json.loads(command(['docker','inspect',name],capture_output=True,text=True).stdout)[0]

def apply(args):
    root=args.root.resolve()
    if root!=Path('/opt/drac') or root.is_symlink():raise ValueError('This pilot supports only the verified /opt/drac installation')
    if os.geteuid()!=0:raise ValueError('Root required to preserve protected deployment configuration')
    if (root/'.runtime-release.json').exists():raise ValueError('Already migrated; use the signed updater')
    containers={name:inspect(name) for name in ['vms-api','vms-web','vms-ai-service']}
    api=containers['vms-api'];project=api['Config']['Labels']['com.docker.compose.project']
    # Preserve the UNION: AI capacity overlays were absent from the API labels.
    files=[]
    for container in containers.values():
        for file in container['Config']['Labels']['com.docker.compose.project.config_files'].split(','):
            if file not in files:files.append(file)
    if any(not Path(file).is_file() or not Path(file).resolve().is_relative_to(root/'infra') for file in files):
        raise ValueError('Unexpected or unavailable installation overlays')
    compose=['docker','compose','--project-name',project,'--env-file',str(root/'infra/.env')]
    original=compose[:]
    for file in files:original+=['-f',file]
    raw=json.loads(command(original+['config','--no-interpolate','--format','json'],capture_output=True,text=True).stdout)
    count=command(['docker','exec','vms-api','node','-e',
        'const {PrismaClient}=require("/app/apps/api/node_modules/@prisma/client");const p=new PrismaClient();p.camera.count().then(n=>{console.log(n);return p.$disconnect()})'],capture_output=True,text=True).stdout.strip()
    if count!='0':raise ValueError('Pilot now has cameras; schedule a reviewed active-camera migration instead')
    with tempfile.TemporaryDirectory(prefix='drac-pilot-verified-') as directory:
        verified=Path(directory)/'verified'
        manifest=verifier.extract_verified(args.bundle,args.public_key,verified,args.commit)
        if not manifest.get('databaseSchemaHash') or not all(name in manifest.get('images',{}) for name in ['api','web','ai-service']):raise ValueError('Incomplete pilot package')
        existing_schema=command(['docker','exec','vms-api','node','-e',
            'const fs=require("fs"),path=require("path"),crypto=require("crypto");const root="/app/apps/api/prisma";let files=[];function walk(d){for(const x of fs.readdirSync(d)){const p=path.join(d,x);if(fs.statSync(p).isDirectory())walk(p);else if(x==="schema.prisma"||x.endsWith(".sql"))files.push(p)}}walk(root);const h=crypto.createHash("sha256");for(const p of files.sort()){h.update(path.relative(root,p));h.update(fs.readFileSync(p))}console.log(h.digest("hex"))'],capture_output=True,text=True).stdout.strip()
        if existing_schema!=manifest['databaseSchemaHash']:raise ValueError('Database schema differs; explicit migration approval required')
        backup=root/'infra/backups'/('package-migration-'+time.strftime('%Y%m%dT%H%M%SZ',time.gmtime()))
        backup.mkdir(mode=0o700,parents=True)
        dump=backup/'database.dump'
        with dump.open('xb') as output:
            os.chmod(dump,0o600)
            command(['docker','exec','vms-postgres','sh','-c','PGPASSWORD="$POSTGRES_PASSWORD" exec pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc'],stdout=output)
        with dump.open('rb') as source:command(['docker','exec','-i','vms-postgres','pg_restore','--list'],stdin=source,stdout=subprocess.DEVNULL)
        base=root/'infra/docker-compose.yml';env=root/'infra/.env'
        shutil.copyfile(base,backup/'compose.before.yml');shutil.copyfile(env,backup/'environment.before');os.chmod(backup/'environment.before',0o600)
        (backup/'images.before.json').write_text(json.dumps({k:v['Image'] for k,v in containers.items()}))
        (backup/'compose-files.before.json').write_text(json.dumps(files))
        # Import only after signature, checksums, schema and backup validation.
        command(['docker','load','-i',str(verified/'images.tar')],stdout=subprocess.DEVNULL)
        for name in list(raw['services']):
            service=raw['services'][name]
            if service.get('profiles'):del raw['services'][name];continue
            service.pop('build',None)
            service['image']=manifest['images'][name]
        base.write_text(json.dumps(raw,indent=2));os.chmod(base,0o644)
        lines=env.read_text().splitlines();updates={'DRAC_WEBRTC_HOST_NAT':'true','DRAC_VERSION':manifest['commit'],'MOTION_DETECTION_FPS':'7.0'}
        lines=[line for line in lines if line.split('=',1)[0] not in updates]
        env.write_text('\n'.join(lines+[key+'='+value for key,value in updates.items()])+'\n');os.chmod(env,0o600)
        runtime_images=root/'infra/docker-compose.runtime-images.json'
        services={name:{'image':manifest['images'][name]} for name in ['api','web','ai-service']}
        services['api']['environment']={'DRAC_VERSION':manifest['commit']}
        runtime_images.write_text(json.dumps({'services':services}));os.chmod(runtime_images,0o600)
        deployment=original+['-f',str(runtime_images)]
        try:
            command(deployment+['up','-d','--no-build','--pull','never','--no-deps','--wait','--wait-timeout','180','api','web','ai-service'])
        except Exception:
            shutil.copyfile(backup/'compose.before.yml',base);shutil.copyfile(backup/'environment.before',env)
            command(original+['up','-d','--no-build','--pull','never','--no-deps','--wait','--wait-timeout','180','api','web','ai-service'])
            raise ValueError('Pilot failed; original application images restored; database retained')
        # Operational glue, not business source. Preserve host nginx, TURN,
        # identity, storage, backups, camera settings and capacity overrides.
        for source in (verified/'runtime/scripts').rglob('*'):
            if source.is_file():
                target=root/'scripts'/source.relative_to(verified/'runtime/scripts');target.parent.mkdir(parents=True,exist_ok=True)
                shutil.copyfile(source,target);os.chmod(target,0o755 if target.suffix=='.sh' else 0o644)
        for source in (verified/'runtime/infra').rglob('*'):
            if source.is_file() and source.name!='docker-compose.yml':
                target=root/'infra'/source.relative_to(verified/'runtime/infra')
                if not target.exists():target.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(source,target)
        shutil.copyfile(args.public_key,root/'infra/release-public.pem')
        (root/'.runtime-release.json').write_text(json.dumps(manifest));os.chmod(root/'.runtime-release.json',0o600)
        print(json.dumps({'migrated':True,'commit':manifest['commit'],'signatureVerified':True,'databaseBackupVerified':True,'mediaServicesRecreated':False,'cleanupPerformed':False}))

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--root',type=Path,default=Path('/opt/drac'))
    parser.add_argument('--bundle',type=Path,required=True);parser.add_argument('--public-key',type=Path,required=True);parser.add_argument('--commit',required=True)
    try:apply(parser.parse_args())
    except Exception as error:raise SystemExit('Pilot migration refused: '+str(error))
