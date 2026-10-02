#!/usr/bin/env python3
"""Generation-to-display latency in isolated lab, NOT production end-to-end delay."""
import json
from pathlib import Path
import subprocess
import threading
import time
import uuid

ROOT=Path(__file__).resolve().parents[1]
NAMES=['drac-validation-sink','drac-validation-forward','drac-validation-clock-source']
def docker(*args):return subprocess.check_output(['docker',*args],text=True,timeout=30)
def main():
    if set(docker('ps','-a','--format','{{.Names}}').splitlines()).intersection(NAMES):
        raise RuntimeError('Validation names in use; refusing overwrite')
    created=[];source=None;stop=threading.Event();attached=False;owner=str(uuid.uuid4())
    try:
        common=['run','-d','--pull','never','--network','drac-srs-pilot-net','--memory','512m','--cpus','1','--label','org.ajustcam.validation='+owner]
        docker(*common,'--name',NAMES[0],'--read-only','--tmpfs','/recordings:rw,size=128m',
               '-v',str(ROOT/'infra/gateway/srs/validation-sink.yml')+':/mediamtx.yml:ro','bluenviron/mediamtx:1-ffmpeg');created.append(NAMES[0])
        docker(*common,'--name',NAMES[1],'-e','SRS_FORWARDER_PULSE_MS=50',
               '-v',str(ROOT/'infra/gateway/srs/validation-forward.conf')+':/usr/local/srs/conf/pilot.conf:ro',
               'drac-srs-forward:20261002','./objs/srs','-c','conf/pilot.conf');created.append(NAMES[1])
        time.sleep(2)
        source=subprocess.Popen(['docker','run','--rm','-i','--name',NAMES[2],'--network','drac-srs-pilot-net',
           '--label','org.ajustcam.validation='+owner,
           '--read-only','--memory','256m','--cpus','1','--entrypoint','ffmpeg','bluenviron/mediamtx:1-ffmpeg',
           '-hide_banner','-loglevel','error','-f','rawvideo','-pixel_format','rgb24','-video_size','640x360','-framerate','20','-i','pipe:0',
           '-c:v','libx264','-preset','ultrafast','-tune','zerolatency','-threads','1','-pix_fmt','yuv420p','-g','20','-f','flv',
           'rtmp://drac-validation-forward/live/validation'],stdin=subprocess.PIPE,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        created.append(NAMES[2])
        def feed():
            frame=bytearray([70])*640*360*3;tick=time.monotonic()
            try:
                while not stop.is_set():
                    stamp=int(time.time()*1000)
                    for i in range(48):
                        row=bytes([235 if (stamp>>(47-i))&1 else 15])*12*3
                        for y in range(10,26):
                            offset=(y*640+10+i*12)*3;frame[offset:offset+36]=row
                    source.stdin.write(frame);source.stdin.flush();tick+=.05;stop.wait(max(0,tick-time.monotonic()))
            except (BrokenPipeError,OSError):pass
        feeder=threading.Thread(target=feed,daemon=True);feeder.start();time.sleep(5)
        # Existing diagnostic browser has Chromium; its base image alone does not.
        # Attach only this test helper to the internal lab, restoring topology below.
        networks=json.loads(docker('inspect','drac-operational-browser'))[0]['NetworkSettings']['Networks']
        if 'drac-srs-pilot-net' in networks:raise RuntimeError('Browser already attached to lab; refusing topology overwrite')
        docker('network','connect','drac-srs-pilot-net','drac-operational-browser');attached=True
        result=subprocess.run(['docker','exec','drac-operational-browser','node','-e',ROOT.joinpath('tools/validate-synthetic-latency.cjs').read_text()],timeout=80)
        return result.returncode
    finally:
        stop.set()
        if attached:docker('network','disconnect','drac-srs-pilot-net','drac-operational-browser')
        for name in reversed(created):
            label=subprocess.run(['docker','inspect','--format','{{index .Config.Labels "org.ajustcam.validation"}}',name],
                                 stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True,timeout=10)
            if label.returncode==0 and label.stdout.strip()==owner:
                subprocess.run(['docker','rm','-f',name],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=30)
        if source:source.wait(timeout=30)

if __name__=='__main__':raise SystemExit(main())
