"""Isolated RTSP replay: receive/decode, latest-frame queue, motion, YOLO,
tracking and JSON overlay serialization. No event/recording writes. Browser
rendering, mobile networks and production capacity are NOT measured here.
"""
import argparse
from collections import Counter
import json
import os
import queue
import resource
import threading
import time
import cv2
from detectors.motion import MotionDetector
from detectors.object_detector import ObjectDetector
from detectors.confirmacao_de_objeto import ConfirmadorDeObjeto

p=argparse.ArgumentParser(description=__doc__)
p.add_argument('--url', required=True)
p.add_argument('--counts', nargs='+', type=int, default=[1,3,5,10])
p.add_argument('--seconds', type=float, default=10)
p.add_argument('--size', type=int, default=512)
a=p.parse_args()
cv2.setNumThreads(1)
os.environ['OPENCV_FFMPEG_CAPTURE_OPTIONS']='threads;1|rtsp_transport;tcp'
model=ObjectDetector(); model.load(); model._ensure_runtime(a.size); model._ensure_runtime(512)
results=[]
for count in a.counts:
    stop=threading.Event(); start=threading.Event(); states=[]; threads=[]
    def capture(state):
        cap=cv2.VideoCapture()
        options=[cv2.CAP_PROP_OPEN_TIMEOUT_MSEC,5000,cv2.CAP_PROP_READ_TIMEOUT_MSEC,3000]
        if hasattr(cv2,'CAP_PROP_N_THREADS'): options += [cv2.CAP_PROP_N_THREADS,1]
        cap.open(a.url, cv2.CAP_FFMPEG, options)
        state['opened']=cap.isOpened(); state['ready'].set(); start.wait()
        try:
            while state['opened'] and not stop.is_set():
                ok, frame=cap.read()
                if not ok: state['errors']+=1; break
                state['received']+=1
                item=(frame,time.time())
                try: state['queue'].put_nowait(item)
                except queue.Full:
                    try: state['queue'].get_nowait();state['superseded']+=1
                    except queue.Empty: pass
                    try: state['queue'].put_nowait(item)
                    except queue.Full: pass
        finally: cap.release()
    def analyze(state):
        motion=MotionDetector(); confirm=ConfirmadorDeObjeto(); start.wait(); due=time.monotonic()
        while not stop.is_set():
            if time.monotonic()<due: stop.wait(min(.02,due-time.monotonic()));continue
            try: native,arrived=state['queue'].get(timeout=.1)
            except queue.Empty: continue
            began=time.perf_counter(); found=motion.infer(native); boxes=[d.bbox for d in found]
            h,w=native.shape[:2]; scale=min(960/w,540/h,1)
            frame=cv2.resize(native,(round(w*scale),round(h*scale))) if scale<1 else native
            out=model.infer(frame,context_key=state['id'],timestamp=arrived,input_size_hint=a.size,
                allowed_classes={'person','car','motorcycle','bicycle'},native_frame=native,
                native_motion_boxes=boxes,motion_boxes=[[round(v*scale) for v in b] for b in boxes],
                confirmed_track_ids=confirm.confirmed_track_ids())
            confirm.avaliar(out);state['kind'][out.execution_kind]+=1;state['model_calls']+=out.model_calls
            json.dumps([{'bbox':d.bbox,'class':d.extra.get('classId'),'estimated':d.extra.get('estimated',False)} for d in out])
            state['analyzed']+=1;state['age_ms'].append((time.time()-arrived)*1000)
            state['work_ms'].append((time.perf_counter()-began)*1000)
            due=max(due+1/7,time.monotonic())
    for i in range(count):
        state={'id':f'isolated-{count}-{i}','queue':queue.Queue(maxsize=1),'ready':threading.Event(),
               'received':0,'superseded':0,'analyzed':0,'errors':0,'model_calls':0,'kind':Counter(),'age_ms':[],'work_ms':[]}
        states.append(state)
        threads.extend([threading.Thread(target=capture,args=(state,),daemon=True),threading.Thread(target=analyze,args=(state,),daemon=True)])
    for thread in threads: thread.start()
    for state in states: state['ready'].wait(8)
    cpu_start=time.process_time(); wall_start=time.perf_counter();start.set();stop.wait(a.seconds);stop.set()
    wall=time.perf_counter()-wall_start;cpu=time.process_time()-cpu_start
    for thread in threads:thread.join(6)
    if any(thread.is_alive() for thread in threads):raise RuntimeError('Isolated capture failed to terminate')
    rows=[]
    for state in states:
        model.release_context(state['id'])
        rows.append({key:state[key] for key in ('opened','received','superseded','analyzed','errors','model_calls')})
        rows[-1].update(kinds=dict(state['kind']), received_fps=state['received']/wall, analyzed_fps=state['analyzed']/wall,
            age_avg_ms=sum(state['age_ms'])/max(1,len(state['age_ms'])), work_avg_ms=sum(state['work_ms'])/max(1,len(state['work_ms'])))
    result={'count':count,'duration_s':wall,'process_cpu_percent':cpu/wall*100,
            'peak_process_rss_mib':resource.getrusage(resource.RUSAGE_SELF).ru_maxrss/1024,'cameras':rows}
    results.append(result);print(json.dumps({'progress_count':count,'cpu_percent':round(result['process_cpu_percent'],1),
        'total_analyzed':sum(x['analyzed'] for x in rows),'busy':sum(x['kinds'].get('busy',0) for x in rows)}),flush=True)
print(json.dumps({'isolated':True,'same_recording_repeated':True,'decoder_threads':1,'quota_cpus':os.getenv('BENCH_CPU_QUOTA'),
                  'input_size':a.size,'configured_fps':7,'not_a_production_fleet_capacity_claim':True,'results':results}),flush=True)
