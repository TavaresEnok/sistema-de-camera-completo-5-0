"""Synthetic-only use of the real production StreamProcessor."""
import json
import logging
import time
import cv2
from stream_processor import StreamProcessor
logging.basicConfig(level=logging.ERROR)
cv2.setNumThreads(1)
p=StreamProcessor('synthetic-recovery','rtsp://drac-validation-sink:8554/live/validation',
                  'http://127.0.0.1:1','unused','motion',{'simulationOnly':True})
p.semantic_enabled=False
p.adaptive_enabled=False
p.base_process_fps=5
p.start()
try:
    for _ in range(240):
        p.touch_live_view_session('synthetic',120,'grid')
        print(json.dumps({'captured':p.capture_frames_enqueued,'processed':p.processed_frames,
                          'fresh_age_ms':round((time.time()-p.last_seen)*1000) if p.last_seen else None,
                          'failures':p.consecutive_capture_failures,'capture_alive':p.capture_thread.is_alive(),
                          'process_alive':p.thread.is_alive(),'queue':p.frame_queue.qsize()}),flush=True)
        time.sleep(1)
finally:p.stop()
