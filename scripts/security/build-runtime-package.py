#!/usr/bin/env python3
"""Vendor-side packaging. Requires a separate protected release-signing key.

Never run this with a Central private key on a customer's machine. Legal
distribution approval and a clean-install gate remain release prerequisites.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import shlex
import subprocess
import tarfile
import tempfile
import time
import yaml

GLUE=['install-drac.sh','install-ai-models.sh','runtime-watchdog.sh','drac-ops-agent.sh','production-readiness.sh',
      'atualizar-instalacao.sh','security/provision-license.sh','security/runtime-bundle.py','security/update-runtime.py']
CONFIG=['docker-compose.prod.yml','docker-compose.gateway.yml','docker-compose.license.yml','.env.example',
        'systemd/drac-ops-agent.service','systemd/drac-ops-agent.timer',
        'model-bundles/yolo26n-int8-20261004.tar.gz']


def sha(file):
    value=hashlib.sha256()
    with file.open('rb') as stream:
        while chunk:=stream.read(1024*1024):value.update(chunk)
    return value.hexdigest()


def database_schema_hash(prisma, previous_motion_schema=False, previous_notice_schema=False):
    # Match exactly what the API image ships: schema + applied migrations.
    # Optional SQL tools (e.g. rls/) are not runtime schema or migrations.
    digest=hashlib.sha256()
    files=[prisma/'schema.prisma',*(prisma/'migrations').rglob('*.sql')]
    for file in sorted(files):
        if previous_motion_schema and file.relative_to(prisma).as_posix() == 'migrations/20261006190000_camera_motion_sensitivity/migration.sql':continue
        if previous_notice_schema and file.relative_to(prisma).as_posix() == 'migrations/20261006220000_camera_motion_notice/migration.sql':continue
        digest.update(file.relative_to(prisma).as_posix().encode())
        content=file.read_bytes()
        if previous_motion_schema and file.name=='schema.prisma':
            content=content.replace(b'  motionSensitivity      String       @default("media")\n',b'')
        if previous_notice_schema and file.name=='schema.prisma':
            content=content.replace(b'  motionNoticeEnabled    Boolean      @default(false)\n',b'')
        digest.update(content)
    return digest.hexdigest()


def build(args):
    root=args.root.resolve()
    if not re.fullmatch('[a-f0-9]{40}',args.commit):raise ValueError('Immutable commit required')
    if args.signing_key and args.signing_key.stat().st_mode & 0o077:raise ValueError('Release key must be private')
    if not args.distribution_approval.strip():raise ValueError('Distribution licensing approval reference required')
    if args.output.exists():raise ValueError('Output must not exist')
    overrides=json.loads(args.images.read_text())
    if not all(k in overrides for k in ['api','web','ai-service']):raise ValueError('Validated application images required')
    signer=shlex.split(args.signer_command) if args.signer_command else None
    public=subprocess.run(signer+['--public'] if signer else ['openssl','pkey','-in',str(args.signing_key),'-pubout'],check=True,capture_output=True).stdout.decode()
    with tempfile.TemporaryDirectory(prefix='drac-package-build-') as temporary:
        stage=Path(temporary);runtime=stage/'runtime';(runtime/'infra').mkdir(parents=True);(runtime/'scripts').mkdir()
        def copy(relative):
            source=root/relative
            if not source.is_file() or source.is_symlink():raise ValueError('Missing runtime file: '+relative)
            destination=runtime/relative;destination.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(source,destination)
        for name in GLUE:copy('scripts/'+name)
        for name in CONFIG:copy('infra/'+name)
        shutil.copyfile(args.license_keys,runtime/'infra/trusted-license-keys.json')
        compose=yaml.safe_load((root/'infra/docker-compose.yml').read_text())
        services=compose['services'];images=set();image_ids={}
        for name in list(services):
            service=services[name]
            if service.get('profiles'):
                del services[name];continue
            reference=overrides.get(name,service.get('image'))
            if not reference:raise ValueError('No prebuilt image for '+name)
            identity=subprocess.run(['docker','image','inspect',reference,'--format','{{.Id}}'],check=True,capture_output=True,text=True).stdout.strip()
            if not re.fullmatch('sha256:[a-f0-9]{64}',identity):raise ValueError('Image not immutable')
            service.pop('build',None);service['image']=identity;images.add(identity);image_ids[name]=identity
            for volume in service.get('volumes',[]):
                if isinstance(volume,str) and volume.startswith('./'):
                    relative=volume.split(':',1)[0][2:]
                    if (root/'infra'/relative).is_file():copy('infra/'+relative)
        (runtime/'infra/docker-compose.yml').write_text(yaml.safe_dump(compose,sort_keys=False))
        subprocess.run(['docker','image','save','-o',str(stage/'images.tar'),*sorted(images)],check=True)
        subprocess.run(['python3',str(root/'scripts/security/audit-image.py'),str(stage/'images.tar')],check=True)
        files={}
        for file in sorted(stage.rglob('*')):
            if file.is_file():files[file.relative_to(stage).as_posix()]={'size':file.stat().st_size,'sha256':sha(file)}
        now=int(time.time())
        manifest={'v':1,'commit':args.commit,'securityVersion':1,'protection':'standard','issuedAt':now,'expiresAt':now+30*86400,
                  'databaseSchemaHash':database_schema_hash(root/'apps/api/prisma'),'distributionApproval':args.distribution_approval,'images':image_ids,'files':files}
        if args.reviewed_motion_schema:
            migration=root/'apps/api/prisma/migrations/20261006190000_camera_motion_sensitivity/migration.sql'
            statement='\n'.join(line for line in migration.read_text().splitlines() if not line.strip().startswith('--')).strip()
            if statement != 'ALTER TABLE "Camera" ADD COLUMN "motionSensitivity" TEXT NOT NULL DEFAULT \'media\';':
                raise ValueError('Reviewed additive migration changed')
            manifest['reviewedSchemaTransition']={'from':database_schema_hash(root/'apps/api/prisma',True),
                'migration':'20261006190000_camera_motion_sensitivity','kind':'additive'}
        if getattr(args,'reviewed_motion_notice_schema',False):
            if args.reviewed_motion_schema:raise ValueError('Only one reviewed transition may be approved')
            migration=root/'apps/api/prisma/migrations/20261006220000_camera_motion_notice/migration.sql'
            if migration.read_text().strip() != 'ALTER TABLE "Camera" ADD COLUMN "motionNoticeEnabled" BOOLEAN NOT NULL DEFAULT false;':
                raise ValueError('Reviewed motion notice migration changed')
            manifest['reviewedSchemaTransition']={'from':database_schema_hash(root/'apps/api/prisma',previous_notice_schema=True),
                'migration':'20261006220000_camera_motion_notice','kind':'additive'}
        raw=json.dumps(manifest,sort_keys=True,separators=(',',':')).encode()
        (stage/'manifest.json').write_bytes(raw)
        message=stage/'message';message.write_bytes(b'drac-runtime-manifest-v1\n'+raw)
        sig=subprocess.run(signer if signer else ['openssl','pkeyutl','-sign','-inkey',str(args.signing_key),'-rawin','-in',str(message)],
            input=message.read_bytes() if signer else None,check=True,capture_output=True).stdout
        if len(sig)!=64:raise ValueError('Invalid external release signature')
        message.unlink();(stage/'manifest.sig').write_bytes(sig)
        args.output.mkdir(mode=0o700,parents=True)
        archive=args.output/(args.commit+'.tar.gz')
        with tarfile.open(archive,'w:gz',compresslevel=3) as target:
            for file in sorted(stage.rglob('*')):
                if file.is_file():target.add(file,arcname=file.relative_to(stage).as_posix(),recursive=False)
        verifier=(root/'scripts/security/runtime-bundle.py').read_text().split("\nif __name__ == '__main__':")[0]
        bootstrap=(root/'scripts/security/bootstrap-runtime.py').read_text()
        script="#!/usr/bin/env bash\nset +x\nset -Eeuo pipefail\npython3 - <<'DRAC_SIGNED_RUNTIME_BOOTSTRAP'\n"+verifier+'\nPUBLIC_RELEASE_KEY='+repr(public)+'\n'+bootstrap+'\nDRAC_SIGNED_RUNTIME_BOOTSTRAP\n'
        installer=args.output/(args.commit+'.bootstrap.sh');installer.write_text(script);os.chmod(installer,0o700)
        metadata={'commit':args.commit,'installerSha256':sha(installer),'runtimeBundle':{'sha256':sha(archive),'size':archive.stat().st_size,'securityVersion':1}}
        (args.output/(args.commit+'.metadata.json')).write_text(json.dumps(metadata,indent=2))
        print(json.dumps(metadata))

if __name__=='__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('--root',type=Path,required=True);parser.add_argument('--output',type=Path,required=True)
    parser.add_argument('--commit',required=True)
    signing=parser.add_mutually_exclusive_group(required=True)
    signing.add_argument('--signing-key',type=Path);signing.add_argument('--signer-command')
    parser.add_argument('--license-keys',type=Path,required=True);parser.add_argument('--images',type=Path,required=True)
    parser.add_argument('--distribution-approval',required=True)
    parser.add_argument('--reviewed-motion-schema',action='store_true')
    parser.add_argument('--reviewed-motion-notice-schema',action='store_true')
    build(parser.parse_args())
