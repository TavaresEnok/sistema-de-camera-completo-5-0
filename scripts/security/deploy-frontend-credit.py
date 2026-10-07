#!/usr/bin/env python3
"""Apply a signed interface-only credit build; never restart camera services."""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile


def command(args, **kwargs):
    return subprocess.run(args, check=True, capture_output=True, **kwargs)


def inspect(name):
    return json.loads(command(['docker', 'inspect', name]).stdout)[0]


def camera_services():
    return {name: {'image': inspect(name)['Image'], 'startedAt': inspect(name)['State']['StartedAt']}
            for name in ['vms-api', 'vms-ai-service', 'vms-mediamtx', 'vms-rtmp-ingest']}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('root', type=Path)
    parser.add_argument('archive', type=Path)
    parser.add_argument('manifest', type=Path)
    args = parser.parse_args()
    root = args.root.resolve()
    signed = json.loads(args.manifest.read_text())
    body = dict(signed)
    signature = base64.b64decode(body.pop('signature'), validate=True)
    if (body.get('v') != 1 or body.get('kind') != 'frontend-credit-v1'
            or body.get('protection') != 'standard' or not body.get('distributionApproval')
            or len(signature) != 64):
        raise ValueError('Invalid signed frontend manifest')
    payload = b'drac-runtime-manifest-v1\n' + json.dumps(body, sort_keys=True, separators=(',', ':')).encode()
    with tempfile.TemporaryDirectory(prefix='drac-credit-verify-') as directory:
        message = Path(directory) / 'message'
        sig = Path(directory) / 'signature'
        message.write_bytes(payload)
        sig.write_bytes(signature)
        command(['openssl', 'pkeyutl', '-verify', '-pubin', '-inkey', str(root / 'infra/release-public.pem'),
                 '-rawin', '-in', str(message), '-sigfile', str(sig)])
    digest = hashlib.sha256()
    with args.archive.open('rb') as source:
        while data := source.read(1024 * 1024):
            digest.update(data)
    if digest.hexdigest() != body['sha256'] or args.archive.stat().st_size != body['size']:
        raise ValueError('Frontend archive integrity failed')
    before = camera_services()
    web = inspect('vms-web')
    labels = web['Config']['Labels']
    files = [Path(value).resolve() for value in labels['com.docker.compose.project.config_files'].split(',') if value]
    if not files or any(not file.is_file() for file in files):
        raise ValueError('Missing original deployment overlays')
    persistent = root / 'infra/docker-compose.runtime-images.json'
    if not persistent.is_file():
        raise ValueError('Existing signed runtime image overlay required')
    original = persistent.read_bytes()
    configuration = json.loads(original)
    if 'web' not in configuration.get('services', {}):
        raise ValueError('Existing web service image required')
    backup = root / 'infra/backups/frontend-credit' / body['commit']
    backup.mkdir(mode=0o700, parents=True, exist_ok=False)
    (backup / 'runtime-images-before.json').write_bytes(original)
    (backup / 'manifest.json').write_text(json.dumps(signed))
    os.chmod(backup / 'runtime-images-before.json', 0o600)
    os.chmod(backup / 'manifest.json', 0o600)
    command(['docker', 'load', '-i', str(args.archive)])
    if inspect(body['image'])['Id'] != body['imageId']:
        raise ValueError('Loaded image identity differs from signed manifest')
    configuration['services']['web']['image'] = body['imageId']
    compose = ['docker', 'compose', '--project-name', labels.get('com.docker.compose.project', 'infra'),
               '--env-file', str(root / 'infra/.env')]
    for file in files:
        compose += ['-f', str(file)]
    if persistent not in files:
        compose += ['-f', str(persistent)]
    up = ['up', '-d', '--no-build', '--pull', 'never', '--no-deps', '--wait', '--wait-timeout', '120', 'web']
    try:
        persistent.write_text(json.dumps(configuration))
        os.chmod(persistent, 0o600)
        command(compose + up)
        html = command(['docker', 'exec', 'vms-web', 'head', '-c', '250', '/usr/share/nginx/html/index.html']).stdout
        credit = b'Feito por by Enok Tavares https://github.com/TavaresEnok/'
        if b'<!-- ' + credit + b' -->' not in html:
            raise ValueError('HTML credit absent')
        styles = command(['docker', 'exec', 'vms-web', 'find', '/usr/share/nginx/html', '-type', 'f', '-name', '*.css']).stdout.decode().splitlines()
        if not styles:
            raise ValueError('No stylesheets found')
        for stylesheet in styles:
            first = command(['docker', 'exec', 'vms-web', 'head', '-c', '100', stylesheet]).stdout
            if not first.startswith(b'/*! ' + credit + b' */'):
                raise ValueError('Stylesheet credit absent: ' + stylesheet)
        if camera_services() != before:
            raise ValueError('Camera service changed during frontend-only publication')
    except Exception:
        persistent.write_bytes(original)
        command(compose + up)
        raise
    result = {'commit': body['commit'], 'signed': True, 'cssFilesVerified': len(styles),
              'cameraServicesUnchanged': True, 'imageId': body['imageId']}
    (backup / 'result.json').write_text(json.dumps(result))
    (root / 'infra/frontend-credit-release.json').write_text(json.dumps(signed))
    os.chmod(root / 'infra/frontend-credit-release.json', 0o600)
    print(json.dumps(result))


if __name__ == '__main__':
    main()
