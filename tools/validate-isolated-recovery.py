#!/usr/bin/env python3
"""Bounded disruption of synthetic lab only. Removes only its named containers.

Native MediaMTX recording writes disposable synthetic video to tmpfs. Production
containers, cameras, credentials, and recording modes are never changed.
"""
import json
from pathlib import Path
import subprocess
import threading
import time
import uuid

ROOT=Path(__file__).resolve().parents[1]
NAMES=['drac-validation-source','drac-validation-forward','drac-validation-sink','drac-validation-ai']
latest={}; process=None
def run(*args):return subprocess.check_output(args,text=True,timeout=30)
def docker(*args):return run('docker',*args)
def wait_fresh(deadline=45):
    before=latest.get('captured',0);started=time.monotonic()
    while time.monotonic()-started<deadline:
        if latest.get('captured',0)>before and latest.get('fresh_age_ms',999999)<1500:
            return round(time.monotonic()-started,3)
        time.sleep(.25)
    raise RuntimeError('Synthetic analysis did not recover within deadline')
def recording():
    # Sink ships no Python; its ffmpeg image does ship /bin/sh/stat/find.
    lines=docker('exec','drac-validation-sink','sh','-c',"find /recordings -name '*.mp4' -type f -exec stat -c %s '{}' ';'").splitlines()
    return {'segments':len(lines),'bytes':sum(int(x) for x in lines)}
def main():
    global process
    existing=set(docker('ps','-a','--format','{{.Names}}').splitlines())
    if existing.intersection(NAMES):raise RuntimeError('Named validation container already exists; refusing overwrite')
    created=[];owner=str(uuid.uuid4())
    try:
        common=['run','-d','--pull','never','--network','drac-srs-pilot-net','--memory','512m','--cpus','1',
                '--cap-drop','ALL','--security-opt','no-new-privileges:true','--label','org.ajustcam.validation='+owner]
        docker(*common,'--name',NAMES[2],'--read-only','--tmpfs','/recordings:rw,size=128m',
               '-v',str(ROOT/'infra/gateway/srs/validation-sink.yml')+':/mediamtx.yml:ro','bluenviron/mediamtx:1-ffmpeg');created.append(NAMES[2])
        docker(*common,'--name',NAMES[1],'-e','SRS_FORWARDER_PULSE_MS=50',
               '-v',str(ROOT/'infra/gateway/srs/validation-forward.conf')+':/usr/local/srs/conf/pilot.conf:ro',
               'drac-srs-forward:20261002','./objs/srs','-c','conf/pilot.conf');created.append(NAMES[1])
        docker(*common,'--name',NAMES[0],'--entrypoint','ffmpeg','bluenviron/mediamtx:1-ffmpeg',
               '-hide_banner','-loglevel','error','-re','-f','lavfi','-i','testsrc2=size=640x360:rate=20',
               '-c:v','libx264','-preset','ultrafast','-tune','zerolatency','-threads','1','-g','20','-f','flv',
               'rtmp://drac-validation-forward/live/validation');created.append(NAMES[0])
        process=subprocess.Popen(['docker','run','--rm','--name',NAMES[3],'--network','drac-srs-pilot-net',
          '--label','org.ajustcam.validation='+owner,
          '--read-only','--memory','512m','--cpus','1','-e','PYTHONDONTWRITEBYTECODE=1','-e','PYTHONPATH=/app','-e','MOTION_DETECTION_FPS=5',
          '-v',str(ROOT/'services/ai-service-python')+':/app:ro','-v',str(ROOT/'tools')+':/tools:ro','-w','/app',
          '--entrypoint','python','drac-pipeline-ai:20261002-deadline','/tools/validate-recovery-worker.py'],
          stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True)
        created.append(NAMES[3])
        def reader():
            for line in process.stdout:
                try:latest.update(json.loads(line))
                except ValueError:pass
        threading.Thread(target=reader,daemon=True).start()
        print(json.dumps({'stage':'startup','analysis_ready_seconds':wait_fresh(),'state':dict(latest)}),flush=True)
        time.sleep(12)
        for stage,target,restart_source in [('source-loss',NAMES[0],False),('forwarder-loss',NAMES[1],True),('sink-loss',NAMES[2],True)]:
            before=recording();docker('stop','--time','3',target);time.sleep(8)
            interrupted=dict(latest);docker('start',target)
            if restart_source:docker('restart','--time','3',NAMES[0])
            recovery=wait_fresh();time.sleep(10);after=recording()
            print(json.dumps({'stage':stage,'outage_hold_seconds':8,'analysis_recovery_seconds_after_restore':recovery,
                              'interrupted':interrupted,'recovered':dict(latest),'recording_before':before,'recording_after':after}),flush=True)
            if after['bytes']<=0 or (stage!='sink-loss' and after['bytes']<=before['bytes']):
                raise RuntimeError('Synthetic recording did not progress after restore')
        print(json.dumps({'summary':'passed','scope':'isolated synthetic SRS -> MediaMTX recording + real motion processor'}),flush=True)
    finally:
        for name in reversed(created):
            label=subprocess.run(['docker','inspect','--format','{{index .Config.Labels "org.ajustcam.validation"}}',name],
                                 stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True,timeout=10)
            if label.returncode==0 and label.stdout.strip()==owner:
                subprocess.run(['docker','rm','-f',name],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=30)
        if process:process.wait(timeout=30)

if __name__=='__main__':main()
