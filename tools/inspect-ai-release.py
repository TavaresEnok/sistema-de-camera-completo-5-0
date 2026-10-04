"""Read-only release evidence, excluding credentials and camera URLs."""
import hashlib
import json
from pathlib import Path
import urllib.request
import cv2
import supervision
from onnxruntime_session import inference_threading_status

data=json.load(urllib.request.urlopen('http://127.0.0.1:8000/health',timeout=15))
processors=data.get('processors',{})
result={'ready':data.get('ready'),'opencv':cv2.__version__,
    'supervision':supervision.__version__,'threads':inference_threading_status(),
    'source_hashes':{},'model_hashes':{},'cameras':{}}
for name in ('trackers/bytetrack_backend.py','trackers/visual_bridge.py','detectors/object_detector.py','stream_processor.py'):
    result['source_hashes'][name]=hashlib.sha256(Path('/app',name).read_bytes()).hexdigest()
for size in (416,512,640):
    for ext in ('xml','bin'):
        name=f'yolo26n_int8_{size}_openvino_model/yolo26n.{ext}'
        path=Path('/app/models',name)
        result['model_hashes'][name]=hashlib.sha256(path.read_bytes()).hexdigest() if path.is_file() else None
for key,processor in processors.items():
    stream=processor.get('stream',{}); perf=processor.get('performance',{})
    result['cameras'][key]={'ready':processor.get('readiness',{}).get('ready'),
       'received_fps':stream.get('capture_fps'),'motion_fps':stream.get('motion_fps'),
       'model_fps':perf.get('object_model_frame_fps'),'tracking_fps':perf.get('visual_track_fps'),
       'completion_age_ms':stream.get('analysis_completion_age_ms'),
       'model_applicable':processor.get('inference',{}).get('applicable')}
print(json.dumps(result))
