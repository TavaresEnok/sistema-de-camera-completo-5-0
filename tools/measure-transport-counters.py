#!/usr/bin/env python3
"""Read TCP counters in the video container's network namespace, no URLs/keys."""
import argparse
import json
import subprocess
import time

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--container', required=True)
parser.add_argument('--seconds', type=int, default=30)
args = parser.parse_args()

def read():
    lines = subprocess.check_output(['docker','exec',args.container,'cat','/proc/net/snmp'],text=True,timeout=10).splitlines()
    for index,line in enumerate(lines):
        if line.startswith('Tcp:'):
            return dict(zip(line.split()[1:],map(int,lines[index+1].split()[1:])))
    raise SystemExit('No TCP counters available')

before = read()
started = time.monotonic()
time.sleep(args.seconds)
after = read()
delta = {key:after[key]-before[key] for key in ('InSegs','OutSegs','RetransSegs','InErrs','OutRsts')}
print(json.dumps({'container':args.container,'seconds':round(time.monotonic()-started,2),
                  'tcp':delta,'retransmitted_segment_ratio_percent':round(100*delta['RetransSegs']/max(1,delta['OutSegs']),4),
                  'current_established':after['CurrEstab']}))
