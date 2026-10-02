#!/usr/bin/env python3
"""Bounded read-only production observation; counters only, no video or secrets."""
import argparse
import json
import os
import subprocess
import sys
import time

def run(command):
    return subprocess.check_output(command, text=True, timeout=20)

def cpu():
    with open('/proc/stat') as f:
        v = list(map(int, f.readline().split()[1:9]))
    return sum(v), v[3] + v[4]

def snapshot():
    code = '''import requests,json
h=requests.get('http://localhost:8000/health',timeout=5).json()
print(json.dumps({'status':h.get('status'),'processors':{k:{'processed':v.get('performance',{}).get('processed_frames',0),'running':v.get('running'),'target':v.get('process_fps'),'frame_age_ms':v.get('stream',{}).get('frame_age_last_ms')} for k,v in h.get('processors',{}).items()}}))'''
    ai = json.loads(run(['docker','exec','vms-ai-service','python','-c',code]))
    sampled_at = time.monotonic()
    containers = json.loads(run(['docker','inspect','vms-ai-service','vms-api','vms-mediamtx','vms-web']))
    state = {c['Name'].lstrip('/'): {'restarts':c['RestartCount'], 'started':c['State']['StartedAt'],
             'healthy':c['State'].get('Health',{}).get('Status'), 'oom':c['State']['OOMKilled']} for c in containers}
    stats = [json.loads(s) for s in run(['docker','stats','--no-stream','--format','{{json .}}',
             'vms-ai-service','vms-api','vms-mediamtx','vms-web']).splitlines()]
    mem = {}
    with open('/proc/meminfo') as f:
        for line in f:
            key, value = line.split(':',1)
            if key in ('MemAvailable','SwapFree'): mem[key+'_kib'] = int(value.split()[0])
    return {'sampled_at':sampled_at,'ai':ai,'containers':state,'stats':[{k:s.get(k) for k in ('Name','CPUPerc','MemUsage','PIDs')} for s in stats],**mem}

def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--seconds',type=int,default=900)
    p.add_argument('--interval',type=int,default=30)
    p.add_argument('--output',help='Exclusive counters-only NDJSON output, permissions 0600')
    a=p.parse_args()
    if not 30<=a.seconds<=14400 or not 10<=a.interval<=60: p.error('Bounded seconds/interval required')
    output=open(a.output,'x',buffering=1) if a.output else sys.stdout
    if a.output:os.chmod(a.output,0o600)
    def emit(value):print(json.dumps(value),file=output,flush=True)
    began=time.monotonic(); previous_time=began; previous=snapshot(); previous_cpu=cpu()
    initial=previous
    emit({'elapsed':0,**previous})
    failures=0; frames_reset=0; samples=0; issues=0; fps_history={};cpu_history=[]
    while time.monotonic()-began<a.seconds:
        time.sleep(min(a.interval,max(0,a.seconds-(time.monotonic()-began))))
        try:
            current=snapshot(); now=time.monotonic(); current_cpu=cpu(); fps={}
            for k,v in current['ai']['processors'].items():
                old=previous['ai']['processors'].get(k)
                reset=not old or v['processed']<old['processed'];frames_reset+=int(bool(old) and reset)
                fps[k]=None if reset else round((v['processed']-old['processed'])/(current['sampled_at']-previous['sampled_at']),3)
                if fps[k] is not None:fps_history.setdefault(k,[]).append(fps[k])
            samples+=1
            busy=round(100*(1-(current_cpu[1]-previous_cpu[1])/max(1,current_cpu[0]-previous_cpu[0])),2)
            cpu_history.append(busy)
            abnormal=(current['ai']['status']!='online' or any(v['healthy']!='healthy' or v['oom'] or
                      v['started']!=initial['containers'][k]['started'] or v['restarts']!=initial['containers'][k]['restarts']
                      for k,v in current['containers'].items()) or
                      any(k not in current['ai']['processors'] for k in initial['ai']['processors']) or
                      any(fps.get(k) is not None and fps[k]<.9*v['target'] for k,v in initial['ai']['processors'].items() if v['target']))
            issues+=int(abnormal)
            emit({'elapsed':round(now-began,1),'host_cpu_percent':busy,'abnormal_sample':abnormal,'fps':fps,**current})
            previous=current;previous_time=now;previous_cpu=current_cpu
        except (subprocess.SubprocessError,ValueError,OSError):
            failures+=1;emit({'elapsed':round(time.monotonic()-began,1),'sample_error':True})
    emit({'summary':True,'elapsed':round(time.monotonic()-began,1),'samples':samples,'sample_errors':failures,
          'counter_resets':frames_reset,'abnormal_samples':issues,'cpu_mean_sample_percent':round(sum(cpu_history)/max(1,len(cpu_history)),2),
          'cpu_max_sample_percent':max(cpu_history,default=None),
          'fps':{k:{'min':min(v),'max':max(v),'mean':round(sum(v)/len(v),3)} for k,v in fps_history.items()}})
    if a.output:output.close()
    return int(failures>0 or frames_reset>0 or issues>0)

if __name__=='__main__': raise SystemExit(main())
