"""Read-only recorded-video replay. Agreement with baseline is NOT ground truth.

No camera configuration, HTTP event, image file, model download or production
connection is made. Videos and model folders must be mounted read-only.
"""
import argparse
from collections import Counter
import json
import resource
import statistics
import time
from unittest.mock import patch

import cv2
import numpy as np
from detectors.object_detector import ObjectDetector, GENERAL_PROFILE
from detectors.motion import MotionDetector
from detectors.confirmacao_de_objeto import ConfirmadorDeObjeto

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--video', action='append', required=True)
parser.add_argument('--seconds', type=float, default=12)
parser.add_argument('--start', type=float, default=30)
parser.add_argument('--sizes', nargs='+', type=int, default=[640, 512])
parser.add_argument('--fps', type=float, default=7)
args = parser.parse_args()
cv2.setNumThreads(1)
owner = ObjectDetector()
owner.load()
results = []

def percentiles(values):
    return {'mean_ms': round(statistics.mean(values), 3),
            'p95_ms': round(float(np.percentile(values, 95)), 3)} if values else {}

def overlap(a, b):
    x = max(0, min(a[2], b[2]) - max(a[0], b[0]))
    y = max(0, min(a[3], b[3]) - max(a[1], b[1]))
    union = (a[2]-a[0])*(a[3]-a[1]) + (b[2]-b[0])*(b[3]-b[1]) - x*y
    return x*y/max(1, union)

for video in args.video:
    for size in args.sizes:
        runs = []
        for enabled in (False, True):
            with patch.dict(GENERAL_PROFILE, {'visual_tracking': enabled}):
                detector = ObjectDetector()
            detector.model = owner.model
            detector._runtimes = owner._runtimes
            detector.loaded_precision = owner.loaded_precision
            detector.loaded_model_path = owner.loaded_model_path
            # Compile both variants outside measured work for fair runs.
            detector._ensure_runtime(size)
            detector._ensure_runtime(512)
            motion, confirmer = MotionDetector(), ConfirmadorDeObjeto()
            cap = cv2.VideoCapture(video, cv2.CAP_FFMPEG)
            if not cap.isOpened():
                raise RuntimeError('Recorded video could not be opened')
            source_fps = float(cap.get(cv2.CAP_PROP_FPS))
            if source_fps <= 0 or source_fps > 120:
                raise RuntimeError('Invalid recording FPS')
            cap.set(cv2.CAP_PROP_POS_MSEC, args.start*1000)
            sample_index = 0
            timings = {key: [] for key in ('decode', 'motion', 'resize', 'objects', 'publish', 'total')}
            frames, kinds, alerts = [], Counter(), []
            cpu_start, wall_start = time.process_time(), time.perf_counter()
            while sample_index < int(args.seconds * args.fps):
                began = time.perf_counter()
                ok, native = cap.read()
                timings['decode'].append((time.perf_counter()-began)*1000)
                if not ok:
                    break
                pts = float(cap.get(cv2.CAP_PROP_POS_MSEC))/1000
                if not np.isfinite(pts) or (sample_index == 0 and pts < args.start-.5):
                    raise RuntimeError('Recording presentation timestamps unavailable; do not invent them from nominal FPS')
                if pts + 1e-6 < args.start + sample_index/args.fps:
                    continue
                began_motion = time.perf_counter()
                found = motion.infer(native)
                boxes = [d.bbox for d in found]
                timings['motion'].append((time.perf_counter()-began_motion)*1000)
                began_resize = time.perf_counter()
                h, w = native.shape[:2]
                scale = min(960/w, 540/h, 1.0)
                frame = cv2.resize(native, (round(w*scale), round(h*scale))) if scale < 1 else native
                small_boxes = [[round(v*scale) for v in b] for b in boxes]
                timings['resize'].append((time.perf_counter()-began_resize)*1000)
                began_objects = time.perf_counter()
                out = detector.infer(frame, context_key='recorded', timestamp=pts,
                    input_size_hint=size, allowed_classes={'person','car','motorcycle','bicycle'},
                    motion_boxes=small_boxes, native_frame=native, native_motion_boxes=boxes,
                    confirmed_track_ids=confirmer.confirmed_track_ids())
                timings['objects'].append((time.perf_counter()-began_objects)*1000)
                kinds[out.execution_kind] += 1
                new_alerts = confirmer.avaliar(out)
                alerts.extend({'pts': pts, 'class': d.extra.get('classId'), 'id': d.extra.get('trackId')} for d in new_alerts)
                payload = [{'class': d.extra.get('classId'), 'id': d.extra.get('trackId'),
                            'confidence': round(d.confidence, 4), 'bbox': d.bbox,
                            'estimated': bool(d.extra.get('estimated'))} for d in out]
                began_publish = time.perf_counter()
                json.dumps(payload)
                timings['publish'].append((time.perf_counter()-began_publish)*1000)
                timings['total'].append((time.perf_counter()-began)*1000)
                frames.append({'pts': pts, 'boxes': payload})
                sample_index += 1
            cpu, wall = time.process_time()-cpu_start, time.perf_counter()-wall_start
            cap.release()
            row = {'video': video, 'input_size': size, 'visual_tracking': enabled,
                   'frames': len(frames), 'source_fps': source_fps, 'cpu_seconds': cpu,
                   'wall_seconds': wall, 'processing_capacity_fps': len(frames)/max(.001, wall),
                   'peak_process_rss_mib': resource.getrusage(resource.RUSAGE_SELF).ru_maxrss/1024,
                   'model_calls': detector._real_infer_runs, 'roi_calls': detector._native_roi_runs,
                   'execution_kinds': dict(kinds), 'stages': {k: percentiles(v) for k,v in timings.items()},
                   'alerts': alerts, 'observations': frames, 'bridge_status':detector.temporal_status()['per_camera']['recorded']}
            runs.append(row)
        baseline, hybrid = runs
        agreement = Counter()
        for a,b in zip(baseline['observations'], hybrid['observations']):
            if a['pts'] != b['pts']:
                raise RuntimeError('Replay samples do not align')
            used = set()
            for box in a['boxes']:
                candidates = [(overlap(box['bbox'],other['bbox']), i) for i,other in enumerate(b['boxes'])
                              if i not in used and box['class']==other['class']]
                best = max(candidates, default=(0,-1))
                if best[0] >= .5:
                    used.add(best[1]); agreement['matched_baseline_boxes'] += 1
                else:
                    agreement['baseline_boxes_not_matched'] += 1
            agreement['hybrid_boxes_not_matched'] += len(b['boxes'])-len(used)
        results.append({'video':video, 'input_size':size, 'agreement_not_accuracy':dict(agreement), 'runs':runs})
        # Preserve a bounded set of raw observations for review, not thousands
        # of private-frame boxes in the final diagnostic artifact.
        for row in runs:
            row['observations'] = row['observations'][::14]
        print(json.dumps({'progress': video.split('/')[-1], 'size':size, 'frames': baseline['frames'],
                          'baseline_cpu':round(baseline['cpu_seconds'],2), 'hybrid_cpu':round(hybrid['cpu_seconds'],2)}), flush=True)
print(json.dumps({'protocol':{'real_recordings':True,'live_test':False,'fps':args.fps,
    'start_seconds':args.start,'duration_seconds':args.seconds,'ground_truth_annotated':False,
    'identical_frames_classes_thresholds_roi_policy':True,'real_presentation_timestamps':True,'alert_confirmation_enabled':True,
    'network_browser_and_recording_io_not_included':True,
    'rss_is_process_peak_not_per_camera_increment':True}, 'results':results}), flush=True)
