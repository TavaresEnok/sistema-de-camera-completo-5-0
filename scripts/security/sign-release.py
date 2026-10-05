#!/usr/bin/env python3
"""Vendor-only signing service. The private key NEVER leaves Management.

Input is a bounded, domain-separated manifest; output is only a signature or
the public trust anchor. Authenticate the transport separately (SSH here).
"""
import argparse
import json
from pathlib import Path
import subprocess
import sys
import tempfile

parser=argparse.ArgumentParser()
parser.add_argument('--key',type=Path,required=True)
parser.add_argument('--public',action='store_true')
args=parser.parse_args()
if not args.key.is_file() or args.key.is_symlink() or args.key.stat().st_mode & 0o077:
    raise SystemExit('Protected vendor signing key required')
if args.public:
    result=subprocess.run(['openssl','pkey','-in',str(args.key),'-pubout'],check=True,capture_output=True)
else:
    message=sys.stdin.buffer.read(256*1024+1)
    domain=b'drac-runtime-manifest-v1\n'
    if len(message)>256*1024 or not message.startswith(domain):raise SystemExit('Signing message rejected')
    manifest=json.loads(message[len(domain):])
    if manifest.get('v')!=1 or manifest.get('protection')!='standard' or not manifest.get('distributionApproval'):
        raise SystemExit('Signing manifest rejected')
    with tempfile.TemporaryDirectory(prefix='drac-vendor-sign-') as directory:
        data=Path(directory)/'manifest';data.write_bytes(message);data.chmod(0o600)
        result=subprocess.run(['openssl','pkeyutl','-sign','-inkey',str(args.key),'-rawin','-in',str(data)],check=True,capture_output=True)
sys.stdout.buffer.write(result.stdout)
