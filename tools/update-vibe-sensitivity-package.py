#!/usr/bin/env python3
"""Reviewed additive migration, signed images, image-only rollback for Vibe."""
import argparse
import hashlib
import importlib.util
import json
import os
import re
from pathlib import Path
import shutil
import subprocess
import tempfile

OLD_SCHEMA = '57b29171f34c557f1bca565bef966f82b6a98ed966ca6ef13d8b04e7c7265295'
MIGRATION = '20261006190000_camera_motion_sensitivity'
ROOT = Path('/opt/drac')
SQL = '''SELECT json_build_object('cameras',(SELECT count(*) FROM "Camera"),'users',(SELECT count(*) FROM "User"),'groups',(SELECT count(*) FROM "CameraGroup"),'cameraConfiguration',(SELECT md5(string_agg(row_to_json(c)::text,'' ORDER BY c.id)) FROM (SELECT id,name,enabled,CASE WHEN "recordingMode" IN ('motion','object') THEN NULL ELSE "recordingEnabled" END AS "recordingEnabled","recordingMode","motionTrigger","detectionZones","recordingObjectClasses","aiSensitivity","aiConfidence","aiObjectClasses","objectMode" FROM "Camera") c),'usersHash',(SELECT md5(string_agg(row_to_json(u)::text,'' ORDER BY u.id)) FROM (SELECT id,username,"passwordHash",role FROM "User") u));'''

def run(command, **kwargs):
    return subprocess.run(command, check=True, capture_output=True, **kwargs)

def database_snapshot():
    result = run(['docker', 'exec', '-i', 'vms-postgres', 'sh', '-c',
                  'PGPASSWORD="$POSTGRES_PASSWORD" exec psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At'], input=SQL.encode())
    return json.loads(result.stdout)

def deploy(args):
    if os.geteuid() != 0:
        raise ValueError('Root required for reviewed package deployment')
    state = json.loads((ROOT / '.runtime-release.json').read_text())
    if state['databaseSchemaHash'] != OLD_SCHEMA:
        raise ValueError('Unexpected prior schema; no changes applied')
    report = json.loads(args.report.read_text())
    if not all(report.get(key) for key in ('freshIsolatedRuntime', 'signatureVerified', 'databaseSchemaVerified', 'sourceFreeAI')):
        raise ValueError('Fresh package validation missing')
    if report.get('cameraSensitivity', {}).get('updatedLevel') != 'alta':
        raise ValueError('Sensitivity endpoint validation missing')
    spec = importlib.util.spec_from_file_location('runtime_bundle', ROOT / 'scripts/security/runtime-bundle.py')
    verifier = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(verifier)
    with tempfile.TemporaryDirectory(prefix='vibe-signed-sensitivity-') as directory:
        stage = Path(directory)
        manifest = verifier.extract_verified(args.bundle, ROOT / 'infra/release-public.pem', stage / 'verified', report['commit'], state['securityVersion'])
        # The final image is checked for exactly the reviewed additive SQL.
        api = manifest['images']['api']
        if args.attempt and not re.fullmatch('[a-zA-Z0-9-]{1,24}',args.attempt):
            raise ValueError('Invalid reviewed attempt name')
        backup = ROOT / 'infra/backups/runtime-updates' / (manifest['commit'] + ('.' + args.attempt if args.attempt else ''))
        backup.mkdir(parents=True, mode=0o700, exist_ok=False)
        before = database_snapshot()
        (backup / 'preservation.before.json').write_text(json.dumps(before))
        for name, source in [('runtime.before.json', ROOT / '.runtime-release.json'),
                             ('images.before.json', ROOT / 'infra/docker-compose.runtime-images.json')]:
            shutil.copyfile(source, backup / name)
        dump = backup / 'database.before.dump'
        with dump.open('xb') as output:
            os.chmod(dump, 0o600)
            subprocess.run(['docker', 'exec', 'vms-postgres', 'sh', '-c',
                'PGPASSWORD="$POSTGRES_PASSWORD" exec pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc'], stdout=output, check=True)
        with dump.open('rb') as source:
            subprocess.run(['docker', 'exec', '-i', 'vms-postgres', 'pg_restore', '--list'], stdin=source, stdout=subprocess.DEVNULL, check=True)
        metadata = json.loads(run(['docker', 'inspect', 'vms-api']).stdout)[0]
        files = metadata['Config']['Labels']['com.docker.compose.project.config_files'].split(',')
        if not files or any(not Path(file).is_file() for file in files):
            raise ValueError('Deployment overlays unavailable')
        command = ['docker', 'compose', '--env-file', str(ROOT / 'infra/.env')]
        for file in files:
            command += ['-f', file]
        rollback_command = list(command)
        media_before = {name: run(['docker', 'inspect', name, '--format', '{{.Id}}']).stdout.decode().strip()
                        for name in ('vms-mediamtx', 'vms-postgres', 'vms-redis', 'vms-rtmp-ingest')}
        # Reuse already-imported immutable images on a reviewed retry. The
        # signed archive is still fully verified before this decision.
        if any(subprocess.run(['docker','image','inspect',image],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode
               for image in manifest['images'].values()):
            run(['docker', 'load', '-i', str(stage / 'verified/images.tar')])
        sql = run(['docker', 'run', '--rm', '--entrypoint', 'cat', api,
                   '/app/apps/api/prisma/migrations/' + MIGRATION + '/migration.sql']).stdout.decode()
        expected = 'ALTER TABLE "Camera" ADD COLUMN "motionSensitivity" TEXT NOT NULL DEFAULT \'media\';'
        if '\n'.join(line for line in sql.splitlines() if not line.startswith('--')).strip() != expected:
            raise ValueError('Unexpected migration; production unchanged')
        persistent = ROOT / 'infra/docker-compose.runtime-images.json'
        override = json.loads(persistent.read_text())
        for service in ('api', 'web', 'ai-service'):
            override['services'][service]['image'] = manifest['images'][service]
        override['services']['api'].setdefault('environment', {}).update({'DRAC_VERSION': manifest['commit']})
        # Keep capacity tuning in a separate deployment overlay: future signed
        # image updates replace runtime-images.json but discover all overlays.
        tuning = ROOT / 'infra/docker-compose.live-vibe.json'
        expected_tuning={'services': {'api': {'environment': {
            'MEDIAMTX_LIGHT_GRID_ENABLED': 'true', 'MEDIAMTX_MAX_TRANSCODE_POINTS': '24'}}}}
        if tuning.exists() and json.loads(tuning.read_text()) != expected_tuning:
            raise ValueError('Existing tuning overlay differs from reviewed configuration')
        if not tuning.exists():
            tuning.write_text(json.dumps(expected_tuning))
        os.chmod(tuning,0o600)
        command += ['-f', str(tuning)]
        persistent.write_text(json.dumps(override))
        os.chmod(persistent, 0o600)
        try:
            run(command + ['up', '-d', '--no-build', '--pull', 'never', '--no-deps', '--wait', '--wait-timeout', '180', 'api', 'web', 'ai-service'])
            after = database_snapshot()
            if before != after:
                raise ValueError('Camera/user/group preservation gate failed')
            for name, identity in media_before.items():
                if run(['docker', 'inspect', name, '--format', '{{.Id}}']).stdout.decode().strip() != identity:
                    raise ValueError('Protected ingest/database service changed')
        except Exception:
            shutil.copyfile(backup / 'images.before.json', persistent)
            run(rollback_command + ['up', '-d', '--no-build', '--pull', 'never', '--no-deps', '--wait', '--wait-timeout', '180', 'api', 'web', 'ai-service'])
            raise ValueError('Previous application images restored; database was NOT rolled back')
        (ROOT / '.runtime-release.json').write_text(json.dumps(manifest))
        os.chmod(ROOT / '.runtime-release.json', 0o600)
        (backup / 'preservation.after.json').write_text(json.dumps(after))
        print(json.dumps({'deployed': True, 'commit': manifest['commit'], 'dataPreserved': before == after,
                          'ingestDatabaseRedisPreserved': True, 'backup': str(backup)}))

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--bundle', type=Path, required=True)
    parser.add_argument('--report', type=Path, required=True)
    parser.add_argument('--attempt', default='')
    deploy(parser.parse_args())
