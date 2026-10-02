#!/usr/bin/env python3
"""Provision the existing shared TURN key into the protected installation env.

Requires an already authenticated SSH control socket. Never prints the key or
puts it in command arguments. The operator must authorize protected storage.
"""
import argparse
import hmac
import os
from pathlib import Path
import re
import shlex
import stat
import subprocess

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--control-socket', required=True)
parser.add_argument('--env-file', default='/opt/drac/infra/.env')
args = parser.parse_args()
env_path = Path(args.env_file)
if stat.S_IMODE(env_path.stat().st_mode) & 0o077:
    raise SystemExit('Refusing to write a secret into a group/world-accessible file')
code = 'from pathlib import Path; lines=Path("/opt/ajustcam-gateway/coturn/turnserver.conf").read_text().splitlines(); print(next(x.split("=",1)[1] for x in lines if x.startswith("static-auth-secret=")))'
result = subprocess.run(['ssh', '-S', args.control_socket, '-p', '22001', 'gatewey@177.104.156.25',
                         'sudo -n python3 -c ' + shlex.quote(code)], capture_output=True, text=True, timeout=10)
if result.returncode:
    raise SystemExit('Unable to retrieve TURN configuration over the authenticated channel')
secret = result.stdout.strip()
if not re.fullmatch(r'[A-Za-z0-9_+/=.-]{24,256}', secret):
    raise SystemExit('Unsupported TURN key format; no files changed')
contents = env_path.read_text()
values = dict(line.split('=', 1) for line in contents.splitlines() if '=' in line and not line.startswith('#'))
if 'MEDIAMTX_TURN_SECRET' in values:
    if not hmac.compare_digest(values['MEDIAMTX_TURN_SECRET'].strip().strip('"\''), secret):
        raise SystemExit('Existing TURN key differs; refusing to overwrite')
    print('TURN key already configured; unchanged')
else:
    additions = ['MEDIAMTX_TURN_SECRET=' + secret]
    if not values.get('MEDIAMTX_TURN_URL'):
        additions.insert(0, 'MEDIAMTX_TURN_URL=turn:turn.s2cam.com.br:3478?transport=udp')
    last_line = contents.splitlines()[-1]
    patch = '*** Begin Patch\n*** Update File: ' + str(env_path) + '\n@@\n ' + last_line + '\n' + ''.join('+' + line + '\n' for line in additions) + '*** End Patch\n'
    changed = subprocess.run(['apply_patch'], input=patch, capture_output=True, text=True)
    if changed.returncode:
        raise SystemExit('Protected configuration update failed; output suppressed to protect secrets')
    if stat.S_IMODE(env_path.stat().st_mode) & 0o077:
        os.chmod(env_path, 0o600)
    print('TURN configured in protected installation environment; key not logged')
