#!/usr/bin/env python3
"""Read-only local production sample. Outputs metrics only, never URLs/tokens/images."""
import argparse
import json
import subprocess
import time


def cpu():
    with open('/proc/stat', encoding='ascii') as handle:
        values = [int(x) for x in handle.readline().split()[1:9]]
    return sum(values), values[3] + values[4]


def health():
    code = 'import requests,json;h=requests.get("http://localhost:8000/health",timeout=5).json();print(json.dumps({"status":h.get("status"),"processors":{k:{"processed":v.get("performance",{}).get("processed_frames",0),"target":v.get("process_fps"),"running":v.get("running"),"stages":v.get("performance",{}).get("stage_timings"),"stream":{f:v.get("stream",{}).get(f) for f in ["width","height","fps","frame_age_last_ms","decoder_threads"]}} for k,v in h.get("processors",{}).items()}}))'
    return json.loads(subprocess.check_output(['docker', 'exec', 'vms-ai-service', 'python', '-c', code], timeout=15))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--label', required=True)
    parser.add_argument('--seconds', type=int, default=60)
    args = parser.parse_args()
    before = health()
    initial_cpu = last_cpu = cpu()
    started = time.monotonic()
    while time.monotonic() - started < args.seconds:
        time.sleep(min(10, max(0, args.seconds - (time.monotonic() - started))))
        current_cpu = cpu()
        busy = 100 * (1 - (current_cpu[1] - last_cpu[1]) / max(1, current_cpu[0] - last_cpu[0]))
        print(json.dumps({'label': args.label, 'elapsed': round(time.monotonic() - started, 1), 'host_cpu_percent': round(busy, 2)}), flush=True)
        last_cpu = current_cpu
    after = health()
    elapsed = time.monotonic() - started
    print(json.dumps({'label': args.label, 'elapsed': round(elapsed, 2),
                      'host_cpu_percent': round(100 * (1 - (last_cpu[1] - initial_cpu[1]) / max(1, last_cpu[0] - initial_cpu[0])), 2),
                      'status': after['status'],
                      'cameras': {key: {**value,
                                       'counter_reset': value['processed'] < before['processors'][key]['processed'],
                                       'measured_fps': (round((value['processed'] - before['processors'][key]['processed']) / elapsed, 3)
                                                        if value['processed'] >= before['processors'][key]['processed'] else None)}
                                  for key, value in after['processors'].items() if key in before['processors']}}), flush=True)


if __name__ == '__main__':
    main()
