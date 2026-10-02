"""Offline static scene control, comparing only per-instance contrast setting."""
import json
from unittest.mock import patch
import cv2
import numpy as np
from detectors.motion import MotionDetector
cv2.setNumThreads(1)
rng=np.random.default_rng(20261001)
frame=np.repeat(rng.integers(65,100,(180,320,1),dtype=np.uint8),3,axis=2)
for contrast in (True,False):
    detector=MotionDetector();detector._improve_contrast=contrast;clock=[1000.0];hits=[]
    with patch('detectors.motion.time.time',side_effect=lambda:clock[0]),patch('detectors.motion.time.monotonic',side_effect=lambda:clock[0]):
        for n in range(1,161):
            result=detector.infer(frame)
            if result:hits.append({'frame':n,'scene_change':any(d.extra.get('sceneChange') for d in result)})
            clock[0]+=.2
    print(json.dumps({'static_control':True,'contrast':contrast,'frames':160,'declared_warmup_frames':detector._warmup_total,
                      'detections':hits,'diagnostics':detector.diagnostics()}),flush=True)
