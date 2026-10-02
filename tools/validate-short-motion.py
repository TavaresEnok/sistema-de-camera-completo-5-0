"""Offline sampling/confirmation experiment; NOT vehicle speed or field accuracy."""
import json
import math
from unittest.mock import patch
import cv2
import numpy as np
from detectors.motion import MotionDetector

cv2.setNumThreads(1)
# Textured static background avoids a uniform lighting-change experiment.
rng=np.random.default_rng(20261001)
background=np.repeat(rng.integers(65,100,(180,320,1),dtype=np.uint8),3,axis=2)
for fps in (3,5,7,10):
    for duration in (.05,.1,.2,.4,.8):
        visible=0;confirmed=0;phases=8
        for phase in range(phases):
            detector=MotionDetector();clock=[1000.0]
            with patch('detectors.motion.time.time',side_effect=lambda:clock[0]),patch('detectors.motion.time.monotonic',side_effect=lambda:clock[0]):
                # Contrast smoothing has a 50-frame history; settle the detector
                # independently of its shorter MOG2 boot warmup.
                for _ in range(max(200,detector._warmup_total+10)):
                    detector.infer(background);clock[0]+=1/fps
                for _ in range(20):
                    if detector.infer(background):raise RuntimeError('Static baseline not quiet; experiment invalid')
                    clock[0]+=1/fps
                started=phase/phases/fps;captured=False;detected=False
                for tick in range(math.ceil((duration+1)*fps)):
                    moment=tick/fps;frame=background.copy()
                    if started<=moment<started+duration:
                        captured=True;x=80+int(100*(moment-started)/duration)
                        frame[75:100,x:x+30]=210
                    clock[0]+=1/fps
                    if detector.infer(frame):detected=True
                visible+=captured;confirmed+=detected
        print(json.dumps({'analysis_fps':fps,'presence_ms':round(duration*1000),'phase_trials':phases,
                          'object_sampled_trials':visible,'motion_confirmed_trials':confirmed}),flush=True)
