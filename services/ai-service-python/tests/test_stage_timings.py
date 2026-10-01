import unittest
from stage_timings import StageTimings


class StageTimingsTest(unittest.TestCase):
    def test_unmeasured_is_not_zero_and_samples_are_bounded(self):
        timings = StageTimings(window=2)
        self.assertIsNone(timings.snapshot()["motion"]["avg_ms"])
        for seconds in (1, .002, .004):
            timings.observe("motion", seconds)
        result = timings.snapshot()["motion"]
        self.assertEqual(result["count"], 3)
        self.assertEqual(result["window_samples"], 2)
        self.assertEqual(result["avg_ms"], 3)

    def test_stage_names_cannot_grow_memory(self):
        with self.assertRaises(ValueError):
            StageTimings().observe("arbitrary-camera-id", 1)
