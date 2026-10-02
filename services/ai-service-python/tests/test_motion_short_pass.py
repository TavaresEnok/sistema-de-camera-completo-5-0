"""Strong one-frame motion, without weakening small/noisy-motion guards."""
import unittest
from unittest.mock import patch

import numpy as np

from detectors.motion import MotionDetector
from runtime_profiles import MOTION_PROFILE


class TestShortPass(unittest.TestCase):
    def setUp(self):
        self.rng = np.random.default_rng(20261001)
        self.background = np.repeat(self.rng.integers(65, 100, (180, 320, 1), dtype=np.uint8), 3, axis=2)

    def detector(self, **profile):
        with patch.dict(MOTION_PROFILE, profile):
            detector = MotionDetector()
        for _ in range(100):
            self.assertFalse(detector.infer(self.background))
        return detector

    def changed(self, size=30):
        frame = self.background.copy()
        frame[75:75+size, 80:80+size] = 210
        return frame

    def test_strong_pass_is_reported_even_when_only_one_frame_is_available(self):
        detector = self.detector()
        self.assertTrue(detector.infer(self.changed()))
        self.assertEqual(detector.diagnostics()['counters']['strong_single_frame_confirmations'], 1)

    def test_small_changes_still_require_temporal_confirmation(self):
        detector = self.detector()
        self.assertFalse(detector.infer(self.changed(size=12)))
        self.assertEqual(detector.diagnostics()['last_suppression_reason'], 'temporal_confirmation')

    def test_kill_switch_restores_old_confirmation(self):
        detector = self.detector(motion_single_frame_strong=False)
        self.assertFalse(detector.infer(self.changed()))
        self.assertTrue(detector.infer(self.changed()))

    def test_noisy_night_scene_does_not_confirm_on_one_frame(self):
        detector = MotionDetector()
        for _ in range(200):
            noisy = np.clip(self.background.astype(np.float32) + self.rng.normal(0, 10, self.background.shape), 0, 255).astype(np.uint8)
            self.assertFalse(detector.infer(noisy))

    def test_uniform_light_change_is_not_a_strong_pass(self):
        detector = self.detector()
        bright = np.clip(self.background.astype(np.int16) + 50, 0, 255).astype(np.uint8)
        self.assertFalse(detector.infer(bright))

    def test_excluded_region_remains_excluded(self):
        detector = MotionDetector(zones=[{'kind': 'include', 'points': [[0.6, 0], [1, 0], [1, 1], [0.6, 1]]}])
        for _ in range(100):
            detector.infer(self.background)
        self.assertFalse(detector.infer(self.changed()))

    def test_low_sensitivity_requires_a_larger_region_for_one_frame(self):
        detector = MotionDetector(zones=[{'kind': 'include', 'sensitivity': 'baixa',
            'points': [[0, 0], [1, 0], [1, 1], [0, 1]]}])
        for _ in range(100):
            detector.infer(self.background)
        self.assertFalse(detector.infer(self.changed()))
        self.assertTrue(detector.infer(self.changed()))
