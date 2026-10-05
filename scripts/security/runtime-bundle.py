#!/usr/bin/env python3
"""Verify a signed runtime package before extracting any executable content.

The trusted release public key comes from the authenticated/pinned bootstrap,
NEVER from the archive being checked. Only deployment glue and compiled images
are distributed, not the Central, a checkout or build context.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import subprocess
import tarfile
import tempfile
import time

MAX_BYTES = 12 * 1024 ** 3
MAX_FILES = 1024
DOMAIN = b'drac-runtime-manifest-v1\n'


def check_name(name):
    path = PurePosixPath(name)
    if not name or len(name) > 240 or path.is_absolute() or '..' in path.parts or '\\' in name or str(path) != name:
        raise ValueError('Unsafe archive path')
    if name == 'images.tar':
        return
    if len(path.parts) < 3 or path.parts[:2] not in [('runtime', 'infra'), ('runtime', 'scripts')]:
        raise ValueError('Unexpected package content')
    if '.git' in path.parts or path.name == '.env' or path.name.endswith(('.pem', '.key', '.ts', '.map', '.c')):
        raise ValueError('Source or secret forbidden in runtime package')


def read_limited(archive, entry, limit):
    if not entry.isfile() or entry.size > limit:
        raise ValueError('Invalid manifest entry')
    with archive.extractfile(entry) as stream:
        data = stream.read(limit + 1)
    if len(data) > limit:
        raise ValueError('Oversized manifest')
    return data


def extract_verified(bundle, trusted_key, destination, expected_commit=None, min_security=1):
    if bundle.stat().st_size > MAX_BYTES:
        raise ValueError('Oversized runtime package')
    if destination.is_symlink() or (destination.exists() and any(destination.iterdir())):
        raise ValueError('Extraction destination must be empty and not a symlink')
    with tarfile.open(bundle, 'r:gz') as archive:
        entries = {}
        total = 0
        for entry in archive:
            if entry.name in entries or not entry.isfile() or len(entries) >= MAX_FILES:
                raise ValueError('Duplicate, special or excessive archive entries')
            total += entry.size
            if total > MAX_BYTES:
                raise ValueError('Oversized extracted package')
            entries[entry.name] = entry
        if 'manifest.json' not in entries or 'manifest.sig' not in entries:
            raise ValueError('Signed manifest required')
        raw = read_limited(archive, entries['manifest.json'], 256 * 1024)
        signature = read_limited(archive, entries['manifest.sig'], 64)
        if len(signature) != 64:
            raise ValueError('Invalid release signature')
        with tempfile.TemporaryDirectory(prefix='drac-release-signature-') as temporary:
            data_path = Path(temporary) / 'message'
            sig_path = Path(temporary) / 'signature'
            data_path.write_bytes(DOMAIN + raw)
            sig_path.write_bytes(signature)
            result = subprocess.run(['openssl', 'pkeyutl', '-verify', '-pubin', '-inkey', str(trusted_key), '-rawin', '-in', str(data_path), '-sigfile', str(sig_path)], capture_output=True)
            if result.returncode:
                raise ValueError('Release signature rejected')
        manifest = json.loads(raw)
        if manifest.get('v') != 1 or manifest.get('protection') != 'standard':
            raise ValueError('Unsupported runtime profile')
        commit = manifest.get('commit', '')
        if len(commit) != 40 or any(c not in 'abcdef0123456789' for c in commit) or (expected_commit and commit != expected_commit):
            raise ValueError('Release commit mismatch')
        version = manifest.get('securityVersion')
        if type(version) is not int or version < min_security:
            raise ValueError('Security downgrade refused')
        now = int(time.time())
        issued, expires = manifest.get('issuedAt'), manifest.get('expiresAt')
        if type(issued) is not int or type(expires) is not int or not issued - 120 <= now < expires or not 0 < expires - issued <= 30 * 86400:
            raise ValueError('Expired release manifest')
        files = manifest.get('files')
        if not isinstance(files, dict) or set(files) != set(entries) - {'manifest.json', 'manifest.sig'}:
            raise ValueError('Manifest does not cover every archive file')
        for name, expected in files.items():
            check_name(name)
            if not isinstance(expected, dict) or expected.get('size') != entries[name].size:
                raise ValueError('File size mismatch')
            digest = hashlib.sha256()
            with archive.extractfile(entries[name]) as stream:
                while chunk := stream.read(1024 * 1024):
                    digest.update(chunk)
            if digest.hexdigest() != expected.get('sha256'):
                raise ValueError('File checksum mismatch')
        # All hashes and the signature passed before the first payload write.
        destination.mkdir(mode=0o700, parents=True, exist_ok=True)
        for name in files:
            output = destination / name
            output.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            with archive.extractfile(entries[name]) as source, output.open('xb') as target:
                shutil.copyfileobj(source, target, 1024 * 1024)
            os.chmod(output, 0o700 if name.endswith('.sh') else 0o600)
        (destination / 'verified-manifest.json').write_bytes(raw)
        os.chmod(destination / 'verified-manifest.json', 0o600)
        return manifest


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('bundle', type=Path)
    parser.add_argument('trusted_public_key', type=Path)
    parser.add_argument('destination', type=Path)
    parser.add_argument('--commit', required=True)
    parser.add_argument('--min-security', type=int, default=1)
    args = parser.parse_args()
    try:
        manifest = extract_verified(args.bundle, args.trusted_public_key, args.destination, args.commit, args.min_security)
        print(json.dumps({'verified': True, 'commit': manifest['commit'], 'securityVersion': manifest['securityVersion']}))
    except Exception as error:
        raise SystemExit('Runtime package refused: ' + str(error))
