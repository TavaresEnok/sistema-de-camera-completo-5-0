#!/usr/bin/env python3
"""Synthetic lab only: measure decoded frame inter-arrival, no camera credentials."""
import json
import os
import statistics
import time

os.environ['OPENCV_FFMPEG_CAPTURE_OPTIONS'] = 'rtsp_transport;tcp'
import cv2

cv2.setNumThreads(1)
capture = cv2.VideoCapture('rtsp://drac-srs-pilot-sink:8554/live/pilot', cv2.CAP_FFMPEG)
if not capture.isOpened():
    raise SystemExit('Synthetic source unavailable')
arrivals = []
started = time.monotonic()
try:
    while time.monotonic() - started < 25:
        if not capture.grab():
            raise SystemExit('Synthetic source stopped')
        if time.monotonic() - started >= 5:
            arrivals.append(time.monotonic())
finally:
    capture.release()
gaps = sorted((b-a)*1000 for a,b in zip(arrivals, arrivals[1:]))
if not gaps:
    raise SystemExit('No measured frames')
print(json.dumps({'frames':len(arrivals), 'fps':round((len(arrivals)-1)/(arrivals[-1]-arrivals[0]),3),
                  'gap_median_ms':round(statistics.median(gaps),3),
                  'gap_p95_ms':round(gaps[int((len(gaps)-1)*.95)],3),
                  'gap_max_ms':round(max(gaps),3),
                  'gaps_over_400ms':sum(x>400 for x in gaps)}))
