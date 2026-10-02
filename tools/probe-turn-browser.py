#!/usr/bin/env python3
"""Verify real browser relay allocation over UDP/TCP/TLS without exposing secrets."""
import base64
import hashlib
import hmac
import json
from pathlib import Path
import subprocess
import time

values = dict(line.split('=', 1) for line in Path('/opt/drac/infra/.env').read_text().splitlines()
              if '=' in line and not line.startswith('#'))
secret = values['MEDIAMTX_TURN_SECRET'].strip().strip('"\'')
username = str(int(time.time()) + 300) + ':rollout-probe'
credential = base64.b64encode(hmac.new(secret.encode(), username.encode(), hashlib.sha1).digest()).decode()
config = {'username': username, 'credential': credential, 'urls': [
    'turn:turn.s2cam.com.br:3478?transport=udp',
    'turn:turn.s2cam.com.br:3478?transport=tcp',
    'turns:turn.s2cam.com.br:5349?transport=tcp',
]}
code = Path(__file__).with_suffix('.cjs').read_text()
result = subprocess.run(['docker', 'exec', '-i', 'drac-operational-browser', 'node', '-e', code],
                        input=json.dumps(config), text=True, timeout=50)
raise SystemExit(result.returncode)
