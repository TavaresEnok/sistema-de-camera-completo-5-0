#!/usr/bin/env python3
"""Offline synthetic frames, cached model, stage timings; never publishes events."""
import json
import statistics
import time
import cv2
import numpy as np
from detectors.object_detector import ObjectDetector

cv2.setNumThreads(1)
detector = ObjectDetector()
started = time.perf_counter()
detector.load()
load_ms = (time.perf_counter()-started)*1000
runtime = detector._runtime_for_hint(None)
samples = {name:[] for name in ['preprocess','inference','detect_total','tracking','frame_total']}

def timed(name, function):
    def call(*args,**kwargs):
        began = time.perf_counter()
        try:
            return function(*args,**kwargs)
        finally:
            samples[name].append((time.perf_counter()-began)*1000)
    return call

detector._preprocess = timed('preprocess',detector._preprocess)
detector._detect_raw = timed('detect_total',detector._detect_raw)
detector._track_people = timed('tracking',detector._track_people)
requests = []
while not runtime['pool'].empty():
    requests.append(runtime['pool'].get_nowait())

class TimedRequest:
    def __init__(self,request):
        self.request = request
    def infer(self,*args,**kwargs):
        return timed('inference',self.request.infer)(*args,**kwargs)
    def get_output_tensor(self,*args,**kwargs):
        return self.request.get_output_tensor(*args,**kwargs)

for request in requests:
    runtime['pool'].put(TimedRequest(request))
frame = np.zeros((1080,1920,3),np.uint8)
cv2.rectangle(frame,(700,400),(820,720),(170,180,190),-1)
for index in range(25):
    began = time.perf_counter()
    detector.infer(frame,context_key='offline-synthetic')
    samples['frame_total'].append((time.perf_counter()-began)*1000)
    if index==4:
        for values in samples.values():
            values.clear()

print(json.dumps({'synthetic':True,'load_ms':round(load_ms,2),'input_size':runtime['input_size'],
                  'inference_threads':detector.inference_threads,
                  'stages':{name:{'samples':len(values),'avg_ms':round(statistics.mean(values),3) if values else None,
                                  'p95_ms':round(sorted(values)[int((len(values)-1)*.95)],3) if values else None}
                            for name,values in samples.items()}}))
