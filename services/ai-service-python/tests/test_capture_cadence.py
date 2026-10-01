"""Verify actual selected frames with paced source and nonzero conversion cost."""

import unittest
from queue import Empty, Queue
from unittest.mock import patch

import cv2
import numpy as np

from stream_processor import StreamProcessor


class PacedCapture:
    def __init__(self, processor, clock, source_fps, frames, conversion_seconds):
        self.processor = processor
        self.clock = clock
        self.period = 1 / source_fps
        self.frames = frames
        self.conversion_seconds = conversion_seconds
        self.grabs = 0
        self.retrievals = 0
        self.released = False

    def grab(self):
        self.grabs += 1
        self.clock[0] += self.period
        if self.grabs >= self.frames:
            self.processor.running = False
        return True

    def retrieve(self):
        self.retrievals += 1
        self.clock[0] += self.conversion_seconds
        return True, np.full((2, 2, 3), self.grabs, np.uint8)

    def release(self):
        self.released = True


class TestCaptureCadence(unittest.TestCase):
    def capture(self, target_fps, source_fps=20, frames=100, conversion_seconds=0.02, queue_class=Queue):
        proc = StreamProcessor("test", "rtsp://camera/stream", "http://api", "token", "motion")
        proc.process_fps = target_fps
        proc.running = True
        proc.frame_queue = queue_class(maxsize=1)
        clock = [1000.0]
        cap = PacedCapture(proc, clock, source_fps, frames, conversion_seconds)
        observed = []
        proc._open_capture = lambda: cap
        proc._refresh_qos_mode = lambda: None
        proc._is_awake = lambda: True
        proc._update_capture_stream_info = lambda *args: None
        proc._note_capture_rate = lambda: observed.append(clock[0]) or 0
        with patch("stream_processor.time.monotonic", side_effect=lambda: clock[0]), patch("stream_processor.time.time", side_effect=lambda: clock[0]):
            proc._capture_frames()
        return proc, cap, clock[0] - 1000, observed

    def test_motion_keeps_latest_frame_independent_of_analysis_rate(self):
        for fps in (3, 5, 7, 10):
            proc, cap, elapsed, observed = self.capture(fps)
            with self.subTest(fps=fps):
                self.assertEqual(cap.retrievals, cap.grabs)
                self.assertEqual(proc.capture_frames_enqueued, cap.retrievals)
                self.assertEqual(len(observed), cap.grabs)
                self.assertTrue(cap.released)
                self.assertLessEqual(proc.frame_queue.qsize(), 1)
                self.assertEqual(proc.capture_frames_superseded, cap.retrievals - 1)
                self.assertEqual(proc.capture_frames_dropped, 0)

    def test_analysis_cadence_is_independent_of_processing_time(self):
        for fps in (3, 5, 7, 10):
            proc = StreamProcessor("test", "rtsp://camera/stream", "http://api", "token", "motion")
            proc.process_fps = fps
            now = 1000.0
            selected = []
            for _ in range(60):
                now += proc._motion_frame_wait_seconds(now)
                selected.append(now)
                proc._note_motion_frame_selected(now)
                now += 0.02
            self.assertAlmostEqual((len(selected) - 1) / (selected[-1] - selected[0]), fps)

    def test_slow_source_and_rate_change_do_not_create_catchup_bursts(self):
        proc = StreamProcessor("test", "rtsp://camera/stream", "http://api", "token", "motion")
        proc.process_fps = 7
        self.assertEqual(proc._motion_frame_wait_seconds(1000), 0)
        proc._note_motion_frame_selected(1000)
        proc._note_motion_frame_selected(1010)
        self.assertAlmostEqual(proc._motion_frame_wait_seconds(1010), 1 / 7)
        proc.process_fps = 3
        self.assertEqual(proc._motion_frame_wait_seconds(1010), 0)

    def test_real_process_loop_selects_unique_frames_at_analysis_rate(self):
        for fps in (3, 5, 7, 10):
            proc = StreamProcessor("test", "rtsp://camera/stream", "http://api", "token", "motion")
            proc.process_fps = fps
            proc.running = True
            proc.semantic_enabled = False
            clock = [1000.0]
            last_source = [-1]
            selected = []

            def refresh():
                index = int(round((clock[0] - 1000) * 20, 5))
                if index > last_source[0]:
                    if not proc.frame_queue.empty():
                        proc.frame_queue.get_nowait()
                    proc.frame_queue.put((np.full((2, 2, 3), index, np.uint8), clock[0]))
                    last_source[0] = index

            def sleep(seconds):
                clock[0] += seconds
                if clock[0] >= 1002:
                    proc.running = False

            def infer(frame, **kwargs):
                selected.append(int(frame[0, 0, 0]))
                clock[0] += 0.02
                return []

            proc._refresh_qos_mode = refresh
            proc._is_awake = lambda: True
            proc.motion_detector.infer = infer
            proc._store_live_detections = lambda *args: None
            with patch("stream_processor.time.monotonic", side_effect=lambda: clock[0]), patch("stream_processor.time.time", side_effect=lambda: clock[0]), patch("stream_processor.time.sleep", side_effect=sleep):
                proc._process()
            with self.subTest(fps=fps):
                self.assertAlmostEqual(len(selected) / 2, fps, delta=0.5)
                self.assertEqual(len(selected), len(set(selected)))
                self.assertEqual(proc.motion_infer_runs, len(selected))

    def test_slow_source_is_not_duplicated_to_meet_target(self):
        proc, cap, _, observed = self.capture(10, source_fps=5, frames=30, conversion_seconds=0)
        self.assertEqual(cap.retrievals, 30)
        self.assertEqual(len(observed), 30)
        self.assertEqual(proc.capture_frames_superseded, 29)

    def test_consumer_race_never_discards_the_new_frame(self):
        class ConcurrentConsumerQueue(Queue):
            def get_nowait(self):
                super().get_nowait()
                raise Empty  # o consumidor acabou de retirar o quadro antigo

        proc, cap, _, _ = self.capture(7, frames=2, queue_class=ConcurrentConsumerQueue)
        self.assertEqual(proc.capture_frames_enqueued, 2)
        self.assertEqual(proc.capture_frames_superseded, 0)
        self.assertEqual(int(proc.frame_queue.get()[0][0, 0, 0]), 2)

    def test_decoder_threads_and_timeouts_are_applied_when_opening(self):
        proc = StreamProcessor("test", "rtsp://camera/stream", "http://api", "token")
        with patch("stream_processor.cv2.VideoCapture") as open_capture, patch.dict("os.environ", {"AI_CAPTURE_DECODER_THREADS": "1"}):
            proc._open_capture()
        args = open_capture.call_args.args
        params = dict(zip(args[2][::2], args[2][1::2]))
        self.assertEqual(params[cv2.CAP_PROP_N_THREADS], 1)
        self.assertEqual(params[cv2.CAP_PROP_OPEN_TIMEOUT_MSEC], 15000)
        self.assertEqual(params[cv2.CAP_PROP_READ_TIMEOUT_MSEC], 15000)

    def test_motion_rate_does_not_keep_reporting_old_fps_after_a_stall(self):
        proc = StreamProcessor("test", "rtsp://camera/stream", "http://api", "token", "motion")
        proc._motion_inference_timestamps.extend((990, 990.2, 990.4))
        with patch("stream_processor.time.time", return_value=1000):
            self.assertEqual(proc.performance_state()["motion_fps_real"], 0)
            self.assertEqual(proc.capture_stream_state()["motion_fps"], 0)


if __name__ == "__main__":
    unittest.main()
