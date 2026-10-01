"""Batching must preserve every median and the final illumination decision."""

import unittest

import numpy as np

from detectors.illumination_guard import GlobalIlluminationGuard


def original_offsets(guard, delta, mask):
    height, width = delta.shape
    offsets = []
    for gy in range(guard._grid_y):
        for gx in range(guard._grid_x):
            y1, y2 = gy * height // guard._grid_y, (gy + 1) * height // guard._grid_y
            x1, x2 = gx * width // guard._grid_x, (gx + 1) * width // guard._grid_x
            block = delta[y1:y2, x1:x2]
            values = block.reshape(-1) if mask is None else block[mask[y1:y2, x1:x2] > 0]
            if values.size >= 16:
                offsets.append(float(np.median(values)))
    return offsets


class TestIlluminationBlockBatch(unittest.TestCase):
    def test_exact_medians_for_masks_strides_and_uneven_geometry(self):
        rng = np.random.default_rng(9481)
        for shape in ((180, 320), (179, 319), (24, 32), (6, 8)):
            for dtype in (np.float32, np.float64):
                delta = rng.normal(3, 24, (shape[0], shape[1] * 2)).astype(dtype)[:, ::2]
                guard = GlobalIlluminationGuard(shape)
                masks = [None, np.zeros(shape, np.uint8), np.full(shape, 255, np.uint8)]
                masks.extend((rng.random(shape) < p).astype(np.uint8) * 255 for p in (0.01, 0.5, 0.95))
                for mask in masks:
                    with self.subTest(shape=shape, dtype=dtype, masked=mask is not None):
                        self.assertEqual(guard._block_offsets(delta, mask), original_offsets(guard, delta, mask))

    def test_compensated_pixels_and_decisions_match_original_sequence(self):
        rng = np.random.default_rng(412)
        base = rng.integers(30, 190, (180, 320, 3), dtype=np.uint8)
        mask = np.zeros((180, 320), np.uint8)
        mask[20:150, 70:270] = 255
        for selected_mask in (None, mask):
            candidate = GlobalIlluminationGuard(base.shape[:2])
            original = GlobalIlluminationGuard(base.shape[:2])
            original._block_offsets = lambda delta, mask: original_offsets(original, delta, mask)
            for shift in (0, 0, 15, 35, -10, 5, 30, 0):
                frame = np.clip(base.astype(np.int16) + shift, 0, 255).astype(np.uint8)
                frame[60:90, 120:160] = rng.integers(0, 255, (30, 40, 3), dtype=np.uint8)
                actual, actual_decision = candidate.compensate(frame, mask=selected_mask)
                expected, expected_decision = original.compensate(frame, mask=selected_mask)
                self.assertEqual(actual_decision, expected_decision)
                np.testing.assert_array_equal(actual, expected)


if __name__ == "__main__":
    unittest.main()
