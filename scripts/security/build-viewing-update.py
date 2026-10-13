#!/usr/bin/env python3
"""Vendor-only builder for a small, signed API/web update archive."""
import argparse
import base64
import gzip
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import time

parser = argparse.ArgumentParser()
parser.add_argument('--root', type=Path, required=True)
parser.add_argument('--output', type=Path, required=True)
parser.add_argument('--api', required=True)
parser.add_argument('--web', required=True)
parser.add_argument('--key', type=Path, required=True)
parser.add_argument('--approve-detector-percentage-schema', action='store_true')
parser.add_argument('--approve-object-notice-schema', action='store_true')
parser.add_argument('--approve-sgp-schema', action='store_true')
parser.add_argument('--schema-base-commit')
args = parser.parse_args()
root = args.root.resolve()
git = ['git', '-c', 'safe.directory=' + str(root), '-C', str(root)]
if subprocess.check_output(git + ['status', '--porcelain']).strip():
    raise SystemExit('A clean vendor worktree is required')
commit = subprocess.check_output(git + ['rev-parse', 'HEAD'], text=True).strip()
args.output.mkdir(mode=0o700, parents=True, exist_ok=False)
archive = args.output / 'viewing-images.tar.gz'
images = {}
for name, tag in [('api', args.api), ('web', args.web)]:
    identity = subprocess.check_output(['docker', 'image', 'inspect', tag, '--format', '{{.Id}}'], text=True).strip()
    images[name] = {'image': tag, 'imageId': identity}
with gzip.open(archive, 'wb', compresslevel=3) as destination:
    source = subprocess.Popen(['docker', 'image', 'save', *[item['imageId'] for item in images.values()]], stdout=subprocess.PIPE)
    while chunk := source.stdout.read(1024 * 1024):
        destination.write(chunk)
    if source.wait():
        raise SystemExit('Image export failed')
subprocess.run(['python3', str(root / 'scripts/security/audit-image.py'), str(archive)], check=True)
spec = importlib.util.spec_from_file_location('package', root / 'scripts/security/build-runtime-package.py')
package = importlib.util.module_from_spec(spec)
spec.loader.exec_module(package)
now = int(time.time())
body = {'v': 1, 'kind': 'viewing-update-v1', 'commit': commit, 'protection': 'standard',
        'distributionApproval': 'approved-production-maintenance', 'issuedAt': now, 'expiresAt': now + 30 * 86400,
        'databaseSchemaHash': package.database_schema_hash(root / 'apps/api/prisma'),
        'images': images, 'sha256': package.sha(archive), 'size': archive.stat().st_size}
if args.approve_sgp_schema:
    if args.approve_detector_percentage_schema or args.approve_object_notice_schema or not args.schema_base_commit:
        raise SystemExit('SGP migration requires its explicit schema base commit and no other migration flag')
    migration = '20261010160000_sgp_integration'
    expected_hash = 'ad8156582c068dbfb207c2516d5f144149e0e9229ecb9edebb84de7c8e08b2b5'
    prisma = root / 'apps/api/prisma'
    if package.sha(prisma / 'migrations' / migration / 'migration.sql') != expected_hash:
        raise SystemExit('Reviewed SGP migration changed')
    base = subprocess.check_output(git + ['rev-parse', '--verify', args.schema_base_commit + '^{commit}'], text=True).strip()
    paths = subprocess.check_output(git + ['ls-tree', '-r', '--name-only', base, '--', 'apps/api/prisma'], text=True).splitlines()
    previous = hashlib.sha256()
    for path in sorted(path for path in paths if path == 'apps/api/prisma/schema.prisma' or (path.startswith('apps/api/prisma/migrations/') and path.endswith('.sql'))):
        relative = path.removeprefix('apps/api/prisma/')
        content = subprocess.check_output(git + ['show', base + ':' + path])
        if relative != 'schema.prisma' and (prisma / relative).read_bytes() != content:
            raise SystemExit('An existing migration was changed')
        previous.update(relative.encode()); previous.update(content)
    body['reviewedSchemaTransition'] = {'from': previous.hexdigest(), 'kind': 'additive', 'migration': migration, 'migrationSha256': expected_hash, 'baseCommit': base}
if args.approve_detector_percentage_schema or args.approve_object_notice_schema:
    if args.approve_detector_percentage_schema and args.approve_object_notice_schema:
        raise SystemExit('Approve only one narrowly reviewed migration')
    migration = '20261008210000_camera_object_notice' if args.approve_object_notice_schema else '20261008173000_camera_detector_percentage'
    prisma = root / 'apps/api/prisma'
    expected = '-- Preferência visual. Padrão sem texto no grid; não muda detecção/gravação.\nALTER TABLE "Camera" ADD COLUMN "showDetectorPercentage" BOOLEAN NOT NULL DEFAULT false;\n'
    if args.approve_object_notice_schema:
        expected = '-- Avisos independentes desligados por padrão; preserva gravações e alertas existentes.\nALTER TABLE "Camera" ADD COLUMN "objectNoticeEnabled" BOOLEAN NOT NULL DEFAULT false;\nALTER TABLE "Camera" ADD COLUMN "objectNoticeClasses" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];\n'
    if (prisma / 'migrations' / migration / 'migration.sql').read_text() != expected:
        raise SystemExit('Only the reviewed detector-label migration is allowed')
    previous = hashlib.sha256()
    addition = ('  /// Só altera o texto sobre as caixas no grid, nunca a análise da IA.\n'
                '  showDetectorPercentage Boolean      @default(false)\n').encode()
    if args.approve_object_notice_schema:
        addition = ('  /// Avisos independentes: nunca armam nem alteram a gravação.\n'
                    '  objectNoticeEnabled    Boolean      @default(false)\n'
                    '  objectNoticeClasses    String[]     @default([])\n').encode()
    for path in sorted([prisma / 'schema.prisma', *(prisma / 'migrations').rglob('*.sql')]):
        relative = path.relative_to(prisma).as_posix()
        if relative == f'migrations/{migration}/migration.sql':
            continue
        content = path.read_bytes()
        if relative == 'schema.prisma':
            if content.count(addition) != 1:
                raise SystemExit('Reviewed camera preference missing or duplicated')
            content = content.replace(addition, b'')
        previous.update(relative.encode())
        previous.update(content)
    body['reviewedSchemaTransition'] = {'from': previous.hexdigest(), 'kind': 'additive', 'migration': migration}
payload = b'drac-runtime-manifest-v1\n' + json.dumps(body, sort_keys=True, separators=(',', ':')).encode()
signature = subprocess.check_output(['python3', '/opt/ajustcam-management/runtime-tools/sign-release.py', '--key', str(args.key)], input=payload)
body['signature'] = base64.b64encode(signature).decode()
(args.output / 'manifest.json').write_text(json.dumps(body, indent=2))
(args.output / 'full-package-images.json').write_text(json.dumps({name: item['imageId'] for name, item in images.items()}))
print(json.dumps({'commit': commit, 'sha256': body['sha256'], 'size': body['size'], 'images': images}))
