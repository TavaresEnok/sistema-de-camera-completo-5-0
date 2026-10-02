"""Regression for contrast-induced motion on an entirely static input."""
import unittest
import numpy as np

from detectors.motion import MotionDetector


class TestMotionStartup(unittest.TestCase):
    def scene(self, lo=65, hi=100):
        rng = np.random.default_rng(20261001)
        return np.repeat(rng.integers(lo, hi, (180, 320, 1), dtype=np.uint8), 3, axis=2)

    def test_static_low_contrast_has_no_post_warmup_events(self):
        for lo, hi in ((65, 100), (8, 30), (110, 125), (10, 245)):
            with self.subTest(range=(lo, hi)):
                detector = MotionDetector()
                frame = self.scene(lo, hi)
                self.assertFalse(any(detector.infer(frame) for _ in range(160)))
                self.assertEqual(detector.diagnostics()['counters'].get('global_scene_changes', 0), 0)

    def test_uniform_start_does_not_reseed_when_an_object_appears(self):
        detector = MotionDetector()
        for _ in range(35):
            detector.infer(np.full((180, 320, 3), 80, dtype=np.uint8))
        self.assertTrue(detector._contrast_initialized)
        np.testing.assert_array_equal(detector._contrast_history[49], [0, 255])
        detector.infer(self.scene())
        np.testing.assert_array_equal(detector._contrast_history[49], [0, 255])
        self.assertFalse(np.array_equal(detector._contrast_history[0], detector._contrast_history[49]))

    def test_low_light_moving_region_survives_startup_fix(self):
        detector = MotionDetector()
        frame = self.scene(8, 30)
        for _ in range(160):
            detector.infer(frame)
        results = []
        for step in range(6):
            moving = frame.copy()
            moving[70:105, 80+step*12:115+step*12] = 100
            results.extend(detector.infer(moving))
        self.assertTrue(results)
        self.assertFalse(any(d.extra.get('sceneChange') for d in results))

    def test_contrast_still_smooths_changes_after_initialization(self):
        detector = MotionDetector()
        detector.infer(self.scene())
        initial = detector._contrast_history.copy()
        detector.infer(self.scene(70, 115))
        np.testing.assert_array_equal(detector._contrast_history[2:], initial[2:])
        self.assertFalse(np.array_equal(detector._contrast_history[1], initial[1]))
