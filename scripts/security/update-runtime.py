#!/usr/bin/env python3
"""Authenticated, signed updates without Git/build tools on a tenant.

Only same-schema application updates are automatic. Schema-changing releases
need a separately approved database migration; rollback never restores stale
license settings or deletes camera recordings.
"""
import argparse
import hashlib
import importlib.util
import json
import os
import shutil
from pathlib import Path
import subprocess
import tempfile
import urllib.parse
import urllib.request


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,req,fp,code,msg,headers,newurl):return None


def run(args):
    root=args.root.resolve();state=json.loads((root/'.runtime-release.json').read_text())
    settings={}
    for line in (root/'infra/.env').read_text().splitlines():
        if '=' in line and not line.lstrip().startswith('#'):
            key,value=line.split('=',1);settings[key]=value.strip().strip('"\'')
    central=settings.get('CLOUD_API_URL','').rstrip('/')
    address=urllib.parse.urlsplit(central)
    if address.scheme!='https' or address.username or address.password or address.query or address.fragment:raise ValueError('HTTPS required')
    identity=settings.get('CLOUD_INSTALLATION_ID','');key=settings.get('CLOUD_LICENSE_KEY','')
    if not identity or not key or '\n' in identity+key:raise ValueError('Missing installation credentials')
    headers={'X-DRAC-Installation-Id':identity,'X-DRAC-License-Key':key}
    opener=urllib.request.build_opener(NoRedirect)
    with opener.open(urllib.request.Request(central+'/api/agent/status',headers=headers),timeout=30) as response:
        release=json.loads(response.read(1024*1024)).get('release') or {}
    commit=release.get('commit')
    if args.commit and commit!=args.commit:raise ValueError('Queued release differs from approved release')
    if not commit or commit==state.get('commit'):
        print('Runtime já está na versão aprovada.');return
    if args.conferir:
        print('Há uma atualização por pacote disponível.');return
    if not release.get('runtimeBundle'):raise ValueError('Approved release has no signed runtime package')
    request=urllib.request.Request(central+'/api/agent/artifacts/claim',data=b'{}',headers={**headers,'Content-Type':'application/json'},method='POST')
    with opener.open(request,timeout=30) as response:grant=json.loads(response.read(8192))
    if grant.get('commit')!=commit or type(grant.get('size')) is not int or not 0<grant['size']<=12*1024**3:raise ValueError('Invalid runtime grant')
    with tempfile.TemporaryDirectory(prefix='drac-runtime-update-') as temporary:
        stage=Path(temporary);bundle=stage/'runtime.tar.gz';digest=hashlib.sha256();received=0
        token=grant.get('token','')
        if not isinstance(token,str) or len(token)!=43 or not all(c.isascii() and (c.isalnum() or c in '_-') for c in token):raise ValueError('Invalid artifact token')
        request=urllib.request.Request(central+'/api/agent/artifacts/download',headers={**headers,'X-DRAC-Artifact-Grant':token})
        with opener.open(request,timeout=30) as response,bundle.open('xb') as output:
            while chunk:=response.read(1024*1024):
                received+=len(chunk)
                if received>grant['size']:raise ValueError('Oversized download')
                digest.update(chunk);output.write(chunk)
        if received!=grant['size'] or digest.hexdigest()!=grant.get('sha256'):raise ValueError('Download checksum mismatch')
        spec=importlib.util.spec_from_file_location('runtime_bundle',root/'scripts/security/runtime-bundle.py');loader=importlib.util.module_from_spec(spec);spec.loader.exec_module(loader)
        manifest=loader.extract_verified(bundle,root/'infra/release-public.pem',stage/'verified',commit,state.get('securityVersion',1))
        if not state.get('databaseSchemaHash') or manifest.get('databaseSchemaHash')!=state['databaseSchemaHash']:
            raise ValueError('Schema change requires an approved database migration')
        metadata=json.loads(subprocess.run(['docker','inspect','vms-api'],check=True,capture_output=True,text=True).stdout)[0]
        configured=metadata['Config']['Labels'].get('com.docker.compose.project.config_files','')
        compose_files=[Path(value).resolve() for value in configured.split(',') if value]
        if not compose_files or any(not value.is_file() for value in compose_files):raise ValueError('Cannot preserve deployment overlays')
        command=['docker','compose','--env-file',str(root/'infra/.env')]
        for file in compose_files:command+=['-f',str(file)]
        services=['api','web','ai-service']
        before={}
        for service in services:
            container={'api':'vms-api','web':'vms-web','ai-service':'vms-ai-service'}[service]
            before[service]=subprocess.run(['docker','inspect',container,'--format','{{.Image}}'],check=True,capture_output=True,text=True).stdout.strip()
        # Backup before importing/running code. Password is resolved INSIDE
        # Postgres, not placed in argv, a script, the manifest or a log.
        backup_dir=root/'infra/backups/runtime-updates';backup_dir.mkdir(mode=0o700,parents=True,exist_ok=True)
        backup=backup_dir/(commit+'.dump')
        if backup.exists():raise ValueError('Existing update backup preserved; choose a new attempt')
        with backup.open('xb') as output:
            os.chmod(backup,0o600)
            subprocess.run(['docker','exec','vms-postgres','sh','-c','PGPASSWORD="$POSTGRES_PASSWORD" exec pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc'],stdout=output,check=True)
        with backup.open('rb') as source:subprocess.run(['docker','exec','-i','vms-postgres','pg_restore','--list'],stdin=source,stdout=subprocess.DEVNULL,check=True)
        subprocess.run(['docker','load','-i',str(stage/'verified/images.tar')],stdout=subprocess.DEVNULL,check=True)
        images=manifest.get('images') or {}
        if any(service not in images for service in services):raise ValueError('Incomplete application images')
        persistent=root/'infra/docker-compose.runtime-images.json'
        service_config={service:{'image':images[service]} for service in services}
        service_config['api']['environment']={'DRAC_VERSION':commit}
        persistent.write_text(json.dumps({'services':service_config}));os.chmod(persistent,0o600)
        changed=command if persistent in compose_files else command+['-f',str(persistent)]
        try:
            subprocess.run(changed+['up','-d','--no-build','--pull','never','--no-deps','--wait','--wait-timeout','180',*services],check=True)
        except Exception:
            rollback_config={service:{'image':before[service]} for service in services}
            old_env=metadata['Config'].get('Env') or []
            previous_version=next((x.split('=',1)[1] for x in old_env if x.startswith('DRAC_VERSION=')),state.get('commit','local'))
            rollback_config['api']['environment']={'DRAC_VERSION':previous_version}
            persistent.write_text(json.dumps({'services':rollback_config}))
            subprocess.run(changed+['up','-d','--no-build','--pull','never','--no-deps','--wait','--wait-timeout','180',*services],check=True)
            raise ValueError('Update rejected; previous application images restored, license state retained')
        for source in (stage/'verified/runtime/scripts').rglob('*'):
            if source.is_file():
                target=root/'scripts'/source.relative_to(stage/'verified/runtime/scripts')
                target.parent.mkdir(parents=True,exist_ok=True)
                temporary_target=target.with_name(target.name+'.signed-update')
                shutil.copyfile(source,temporary_target)
                os.chmod(temporary_target,0o755 if target.suffix=='.sh' else 0o644)
                os.replace(temporary_target,target)
        (root/'.runtime-release.json').write_text(json.dumps(manifest));os.chmod(root/'.runtime-release.json',0o600)
        print('Atualização assinada concluída; dados, credenciais e configuração de vídeo preservados.')


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('root',type=Path)
    parser.add_argument('--commit');parser.add_argument('--conferir',action='store_true')
    # Accepted legacy option, but unsafe suppression of rollback is not honored.
    parser.add_argument('--sem-volta',action='store_true')
    try:run(parser.parse_args())
    except Exception as error:raise SystemExit('Atualização recusada: '+str(error))
