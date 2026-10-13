#!/usr/bin/env python3
"""Signed API/web-only update; preserve media services and recording choices."""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import time


def command(args, **kwargs):
    return subprocess.run(args, check=True, capture_output=True, **kwargs)


def inspect(name):
    return json.loads(command(['docker', 'inspect', name]).stdout)[0]


def sql(statement):
    return command(['docker', 'exec', '-i', 'vms-postgres', 'sh', '-c',
                    'PGPASSWORD="$POSTGRES_PASSWORD" exec psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -X -v ON_ERROR_STOP=1 -At'],
                   input=statement.encode()).stdout.decode().strip()


def media_state():
    return {name: {'image': inspect(name)['Image'], 'startedAt': inspect(name)['State']['StartedAt']}
            for name in ['vms-ai-service', 'vms-mediamtx', 'vms-rtmp-ingest']}


def verify_signature(signed, public_key):
    body = dict(signed)
    signature = base64.b64decode(body.pop('signature'), validate=True)
    if len(signature) != 64:
        raise ValueError('Invalid manifest signature')
    payload = b'drac-runtime-manifest-v1\n' + json.dumps(body, sort_keys=True, separators=(',', ':')).encode()
    with tempfile.TemporaryDirectory(prefix='drac-viewing-verify-') as directory:
        message, sig = Path(directory) / 'message', Path(directory) / 'signature'
        message.write_bytes(payload)
        sig.write_bytes(signature)
        command(['openssl', 'pkeyutl', '-verify', '-pubin', '-inkey', str(public_key),
                 '-rawin', '-in', str(message), '-sigfile', str(sig)])
    return body


def allow_schema_transition(current_hash, body, approved=False, object_notice_approved=False, sgp_approved=False):
    if current_hash == body.get('databaseSchemaHash'):
        return False
    transition = body.get('reviewedSchemaTransition') or {}
    if (approved and transition.get('from') == current_hash and transition.get('kind') == 'additive'
            and transition.get('migration') == '20261008173000_camera_detector_percentage'):
        return True
    if (object_notice_approved and transition.get('from') == current_hash and transition.get('kind') == 'additive'
            and transition.get('migration') == '20261008210000_camera_object_notice'):
        return True
    if (sgp_approved and transition.get('from') == current_hash and transition.get('kind') == 'additive'
            and transition.get('migration') == '20261010160000_sgp_integration'
            and transition.get('migrationSha256') == 'ad8156582c068dbfb207c2516d5f144149e0e9229ecb9edebb84de7c8e08b2b5'):
        return True
    raise ValueError('Schema change requires the reviewed detector-label migration approval')


def validate_web_only_update(body, api_before, migration_approved):
    if migration_approved or body['images']['api']['imageId'] != api_before['Image']:
        raise ValueError('Web-only updates must keep the API image and database schema unchanged')


def restore_legacy_shutdown(snapshot):
    # Only the OLD API desarms on shutdown. Restore eligible choices BEFORE
    # starting the fixed API. Never override an operator action or expired timer.
    restored = 0
    for camera in snapshot['cameras']:
        if not camera['recordingEnabled'] or not camera['enabled']:
            continue
        identity, mode = camera['id'], camera['recordingMode']
        if not re.fullmatch(r'[a-f0-9-]{36}', identity) or mode not in ['manual', 'continuous', 'motion', 'object']:
            raise ValueError('Unexpected recording snapshot')
        timer = ('AND EXISTS (SELECT 1 FROM "ManualRecordingSession" WHERE "cameraId"=c.id AND "expiresAt">now())'
                 if mode == 'manual' else '')
        result = sql(f'''WITH restored AS (
          UPDATE "Camera" c SET "recordingEnabled"=true
          WHERE c.id='{identity}' AND c.enabled=true AND c."recordingEnabled"=false AND c."recordingMode"='{mode}'
          {timer}
          AND NOT EXISTS (SELECT 1 FROM "AuditLog" a WHERE a."entityId"=c.id
            AND a."createdAt">='{snapshot['at']}'::timestamptz
            AND (a.action LIKE 'recording.%' OR a.action LIKE 'camera.%'))
          RETURNING c.id
        ) SELECT count(*) FROM restored;''')
        restored += int(result)
    return restored


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('root', type=Path)
    parser.add_argument('archive', type=Path)
    parser.add_argument('manifest', type=Path)
    parser.add_argument('--approve-detector-percentage-schema', action='store_true')
    parser.add_argument('--approve-object-notice-schema', action='store_true')
    parser.add_argument('--approve-sgp-schema', action='store_true')
    parser.add_argument('--web-only', action='store_true', help='Keep the running API and media services untouched')
    args = parser.parse_args()
    root = args.root.resolve()
    signed = json.loads(args.manifest.read_text())
    body = dict(signed)
    signature = base64.b64decode(body.pop('signature'), validate=True)
    if (body.get('v') != 1 or body.get('kind') != 'viewing-update-v1' or body.get('protection') != 'standard'
            or not body.get('distributionApproval') or len(signature) != 64
            or not re.fullmatch('[a-f0-9]{40}', body.get('commit', ''))
            or not body.get('issuedAt', 0) - 120 <= time.time() < body.get('expiresAt', 0)
            or set(body.get('images', {})) != {'api', 'web'}):
        raise ValueError('Invalid signed viewing manifest')
    verify_signature(signed, root / 'infra/release-public.pem')
    digest = hashlib.sha256()
    with args.archive.open('rb') as source:
        while data := source.read(1024 * 1024):
            digest.update(data)
    if digest.hexdigest() != body['sha256'] or args.archive.stat().st_size != body['size']:
        raise ValueError('Viewing archive integrity failed')
    state = json.loads((root / '.runtime-release.json').read_text())
    installed_viewing = root / 'infra/viewing-release.json'
    if installed_viewing.exists():
        state = verify_signature(json.loads(installed_viewing.read_text()), root / 'infra/release-public.pem')
    migration_approved = allow_schema_transition(state.get('databaseSchemaHash'), body, args.approve_detector_percentage_schema, args.approve_object_notice_schema, args.approve_sgp_schema)
    media_before, api_before = media_state(), inspect('vms-api')
    if args.web_only:
        validate_web_only_update(body, api_before, migration_approved)
    files = []
    for name in ['vms-api', 'vms-web']:
        for value in inspect(name)['Config']['Labels']['com.docker.compose.project.config_files'].split(','):
            path = Path(value).resolve()
            if path not in files:
                files.append(path)
    if not files or any(not path.is_file() for path in files):
        raise ValueError('Missing original deployment overlays')
    persistent = root / 'infra/docker-compose.runtime-images.json'
    original = persistent.read_bytes()
    configuration = json.loads(original)
    backup = root / 'infra/backups/viewing-updates' / body['commit']
    if backup.exists():
        backup = backup.with_name(backup.name + '-retry-' + str(time.time_ns()))
    backup.mkdir(mode=0o700, parents=True, exist_ok=False)
    (backup / 'runtime-images-before.json').write_bytes(original)
    (backup / 'manifest.json').write_text(json.dumps(signed))
    os.chmod(backup / 'runtime-images-before.json', 0o600)
    os.chmod(backup / 'manifest.json', 0o600)
    with (backup / 'database.dump').open('xb') as output:
        os.chmod(output.name, 0o600)
        subprocess.run(['docker', 'exec', 'vms-postgres', 'sh', '-c',
                        'PGPASSWORD="$POSTGRES_PASSWORD" exec pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc'],
                       stdout=output, check=True)
    with (backup / 'database.dump').open('rb') as source:
        command(['docker', 'exec', '-i', 'vms-postgres', 'pg_restore', '--list'], stdin=source)
    command(['docker', 'load', '-i', str(args.archive)])
    for service, expected in body['images'].items():
        # Saving by immutable ID intentionally does not carry a mutable tag.
        if inspect(expected['imageId'])['Id'] != expected['imageId']:
            raise ValueError('Loaded image differs from signed manifest')
        configuration['services'][service]['image'] = expected['imageId']
    if migration_approved:
        migration = body['reviewedSchemaTransition']['migration']
        statement = command(['docker', 'run', '--rm', '--network', 'none', '--entrypoint', 'cat',
                             body['images']['api']['imageId'], f'/app/apps/api/prisma/migrations/{migration}/migration.sql']).stdout
        expected_sql = '-- Preferência visual. Padrão sem texto no grid; não muda detecção/gravação.\nALTER TABLE "Camera" ADD COLUMN "showDetectorPercentage" BOOLEAN NOT NULL DEFAULT false;\n'.encode()
        if migration == '20261008210000_camera_object_notice':
            expected_sql = '-- Avisos independentes desligados por padrão; preserva gravações e alertas existentes.\nALTER TABLE "Camera" ADD COLUMN "objectNoticeEnabled" BOOLEAN NOT NULL DEFAULT false;\nALTER TABLE "Camera" ADD COLUMN "objectNoticeClasses" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];\n'.encode()
        if migration == '20261010160000_sgp_integration':
            if hashlib.sha256(statement).hexdigest() != 'ad8156582c068dbfb207c2516d5f144149e0e9229ecb9edebb84de7c8e08b2b5':
                raise ValueError('Image does not contain the reviewed SGP migration')
            expected_sql = statement
        if statement != expected_sql:
            raise ValueError('Image does not contain the narrowly reviewed additive migration')
    if not args.web_only:
        configuration['services']['api'].setdefault('environment', {})['DRAC_VERSION'] = body['commit']
    compose = ['docker', 'compose', '--project-name', api_before['Config']['Labels'].get('com.docker.compose.project', 'infra'),
               '--env-file', str(root / 'infra/.env')]
    for path in files:
        compose += ['-f', str(path)]
    if persistent not in files:
        compose += ['-f', str(persistent)]
    up = ['up', '-d', '--no-build', '--pull', 'never', '--no-deps', '--wait', '--wait-timeout', '180']
    up += ['web'] if args.web_only else ['api', 'web']
    snapshot = json.loads(sql('''SELECT json_build_object('at',now(),'cameras',
      COALESCE(json_agg(json_build_object('id',id,'enabled',enabled,'recordingMode',"recordingMode",
      'recordingEnabled',"recordingEnabled")),'[]'::json)) FROM "Camera";'''))
    (backup / 'recording-choices-before.json').write_text(json.dumps(snapshot))
    os.chmod(backup / 'recording-choices-before.json', 0o600)
    try:
        restored = 0
        if not args.web_only:
            command(['docker', 'stop', '--time', '45', 'vms-api'])
            restored = restore_legacy_shutdown(snapshot)
        persistent.write_text(json.dumps(configuration))
        os.chmod(persistent, 0o600)
        command(compose + up)
        if media_state() != media_before:
            raise ValueError('A media service changed unexpectedly')
        if args.web_only:
            api_after = inspect('vms-api')
            if (api_after['Id'], api_after['State']['StartedAt']) != (api_before['Id'], api_before['State']['StartedAt']):
                raise ValueError('Web-only update unexpectedly changed the API container')
        readiness = json.loads(command(['docker', 'exec', 'vms-api', 'node', '-e',
            "fetch('http://127.0.0.1:3000/health/ready').then(r=>r.json()).then(x=>console.log(JSON.stringify(x)))"]).stdout)
        if not readiness.get('ready'):
            raise ValueError('Updated API readiness failed')
        styles = command(['docker', 'exec', 'vms-web', 'find', '/usr/share/nginx/html', '-name', '*.css']).stdout.decode().splitlines()
        credit = b'/*! Feito por by Enok Tavares https://github.com/TavaresEnok/ */'
        responsive = False
        for stylesheet in styles:
            data = command(['docker', 'exec', 'vms-web', 'cat', stylesheet]).stdout
            if not data.startswith(credit):
                raise ValueError('Stylesheet credit absent')
            responsive |= b'investigation-workspace' in data
        if not responsive:
            raise ValueError('Responsive stylesheet absent')
    except Exception:
        persistent.write_bytes(original)
        os.chmod(persistent, 0o600)
        if not args.web_only:
            restore_legacy_shutdown(snapshot)
        command(compose + up)
        raise
    result = {'commit': body['commit'], 'signed': True, 'ready': True, 'mediaServicesUnchanged': True,
              'webOnly': args.web_only, 'apiContainerUnchanged': args.web_only,
              'legacyRecordingChoicesRestored': restored, 'cssFilesVerified': len(styles), 'reviewedAdditiveMigration': migration_approved}
    (backup / 'result.json').write_text(json.dumps(result))
    (root / 'infra/viewing-release.json').write_text(json.dumps(signed))
    os.chmod(root / 'infra/viewing-release.json', 0o600)
    print(json.dumps(result))


if __name__ == '__main__':
    main()
