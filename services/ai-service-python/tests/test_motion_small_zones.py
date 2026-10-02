"""Small distant movement: respect high zones without weakening other zones."""
import unittest
from unittest.mock import patch

import cv2
import numpy as np

from detectors.motion import MotionDetector
from runtime_profiles import MOTION_PROFILE


def zone(level="alta", left=0, right=1, kind="include"):
    return {"kind": kind, "sensitivity": level,
            "points": [[left, 0], [right, 0], [right, 1], [left, 1]]}


class MaskModel:
    def __init__(self, mask):
        self.mask = mask

    def apply(self, frame, learningRate):
        return self.mask.copy()


class TestSmallZones(unittest.TestCase):
    def detector(self, zones, mask):
        with patch.dict(MOTION_PROFILE, {"motion_noise_floor": False,
                                         "motion_chronic_suppression": False,
                                         "motion_periodic_suppression": False}):
            detector = MotionDetector(zones=zones)
        detector.fgbg = MaskModel(mask)
        detector._warmup_frames = detector._warmup_total
        return detector

    def mask(self, width=3, height=16, x=80):
        mask = np.zeros((180, 320), dtype=np.uint8)
        mask[75:75+height, x:x+width] = 255
        return mask

    def test_thin_small_motion_survives_only_in_high_zone(self):
        frame = np.full((180, 320, 3), 100, np.uint8)
        for level, expected in [("alta", True), ("media", False), ("baixa", False)]:
            with self.subTest(level=level):
                detector = self.detector([zone(level)], self.mask())
                hits = [detector.infer(frame) for _ in range(3)]
                self.assertFalse(hits[0], "small motion still requires confirmation")
                self.assertEqual(bool(hits[-1]), expected)

    def test_early_gate_accepts_36_pixels_before_local_high_threshold(self):
        detector = self.detector([zone()], self.mask(6, 6))
        frame = np.full((180, 320, 3), 100, np.uint8)
        self.assertEqual(detector._minimum_zone_component_pixels, 34)
        self.assertTrue(any(detector.infer(frame) for _ in range(3)))

    def test_mixed_zones_keep_default_cleanup_outside_high(self):
        detector = MotionDetector(zones=[zone("alta", 0, 0.45)])
        mask = self.mask(x=80) | self.mask(x=240)
        # Include zone would exclude the right half. Use a full-frame include
        # plus a high overlay so both sides really are monitored.
        detector.set_zones([zone("media"), zone("alta", 0, 0.45)])
        cleaned = detector._clean_motion_mask(mask)
        self.assertEqual(np.count_nonzero(cleaned[:, :140]), 48)
        self.assertEqual(np.count_nonzero(cleaned[:, 200:]), 0)

    def test_excluded_high_pixels_do_not_lower_gate(self):
        detector = MotionDetector(zones=[zone("media"), zone("alta", 0, 0.4),
                                         zone("media", 0, 0.45, "exclude")])
        self.assertEqual(detector._minimum_zone_component_pixels, 69)
        self.assertIsNone(detector._high_sensitivity_mask)

    def test_cleanup_cannot_leak_into_excluded_zone(self):
        detector = MotionDetector(zones=[zone(), zone("media", 0.5, 1, "exclude")])
        mask = np.full((180, 320), 255, np.uint8)
        cleaned = detector._clean_motion_mask(mask)
        self.assertFalse(np.any(cleaned[detector._zone_mask == 0]))

    def test_zone_update_rebuilds_cached_gate_and_cleanup(self):
        detector = MotionDetector(zones=[zone()])
        self.assertTrue(detector._all_monitored_high)
        detector.set_zones([zone("media")])
        self.assertEqual(detector._minimum_zone_component_pixels, 69)
        self.assertIsNone(detector._high_sensitivity_mask)
        detector.set_zones([zone("baixa")])
        self.assertEqual(detector._minimum_zone_component_pixels, 207)

    def test_default_cleanup_remains_bit_identical_without_zones(self):
        rng = np.random.default_rng(9)
        mask = (rng.random((180, 320)) > 0.6).astype(np.uint8) * 255
        mask |= self.mask(25, 25)
        kernel = np.ones((5, 5), np.uint8)
        old = cv2.morphologyEx(mask, cv2.MORPH_OPEN, kernel)
        old = cv2.morphologyEx(old, cv2.MORPH_CLOSE, kernel)
        np.testing.assert_array_equal(MotionDetector()._clean_motion_mask(mask), old)

    def test_isolated_speckles_do_not_pass_high_cleanup(self):
        mask = np.zeros((180, 320), np.uint8)
        mask[::4, ::4] = 255
        detector = MotionDetector(zones=[zone()])
        self.assertFalse(np.any(detector._clean_motion_mask(mask)))

    def test_high_sensitivity_preserves_adaptive_noise_guard(self):
        detector = self.detector([zone()], self.mask(6, 6))
        detector._noise_floor_enabled = True
        detector._noise_window.extend([100] * detector._noise_window.maxlen)
        self.assertFalse(detector.infer(np.full((180, 320, 3), 100, np.uint8)))
        self.assertEqual(detector.diagnostics()["last_suppression_reason"], "adaptive_noise_floor")

    def test_real_mog2_detects_thin_movement_after_warmup(self):
        background = np.full((180, 320, 3), 100, np.uint8)
        detector = MotionDetector(zones=[zone()])
        for _ in range(100):
            self.assertFalse(detector.infer(background))
        hits = []
        for step in range(10):
            frame = background.copy()
            frame[70:86, 80+step*6:83+step*6] = 220
            hits.extend(detector.infer(frame))
        self.assertTrue(hits)

    def test_high_zone_static_sensor_noise_does_not_emit(self):
        rng = np.random.default_rng(20261002)
        background = np.repeat(rng.integers(65, 100, (180, 320, 1), dtype=np.uint8), 3, axis=2).astype(np.float32)
        detector = MotionDetector(zones=[zone()])
        for _ in range(160):
            frame = np.clip(background + rng.normal(0, 10, background.shape), 0, 255).astype(np.uint8)
            self.assertFalse(detector.infer(frame))

    def test_flat_noisy_background_stays_quiet_after_learning(self):
        # Both old/new models can emit while initially learning a featureless,
        # noisy surface (contrast stretching magnifies noise). This checks the
        # settled model rather than pretending those existing startup events
        # were eliminated by the zone change.
        rng = np.random.default_rng(20261002)
        detector = MotionDetector(zones=[zone()])
        for i in range(220):
            frame = np.clip(100 + rng.normal(0, 10, (180, 320, 3)), 0, 255).astype(np.uint8)
            detections = detector.infer(frame)
            if i >= 100:
                self.assertFalse(detections)

    def test_high_zone_uniform_light_change_does_not_emit(self):
        detector = MotionDetector(zones=[zone()])
        background = np.full((180, 320, 3), 100, np.uint8)
        for _ in range(100):
            detector.infer(background)
        self.assertFalse(detector.infer(np.full_like(background, 150)))


if __name__ == "__main__":
    unittest.main()
