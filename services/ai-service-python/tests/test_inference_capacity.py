import os
import unittest
from unittest.mock import patch
from inference_capacity import configure_cpu_channels, global_request_limit


class CapacityTests(unittest.TestCase):
    def test_cpu_auto_capacity(self):
        for cpus, expected in ((1, 1), (9, 4), (10, 5), (20, 10), (128, 64)):
            with patch.dict(os.environ, {}, clear=True), patch(
                "inference_capacity._available_cpu_threads", return_value={"available_threads": cpus}
            ):
                configure_cpu_channels()
                for key in ("AI_INFERENCE_WORKER_COUNT", "AI_INFERENCE_THREADS_OVERRIDE",
                            "GENERAL_GLOBAL_INFER_REQUESTS", "GENERAL_OPENVINO_STREAMS"):
                    self.assertEqual(os.environ[key], str(expected))
                self.assertEqual(global_request_limit(os.environ[key], cpus // 2), expected)

    def test_cpu_manual_overrides(self):
        with patch.dict(os.environ, {"AI_INFERENCE_WORKER_COUNT": "7", "GENERAL_OPENVINO_STREAMS": "3"}, clear=True):
            configure_cpu_channels()
            self.assertEqual(os.environ["GENERAL_OPENVINO_STREAMS"], "3")
            self.assertEqual(os.environ["GENERAL_GLOBAL_INFER_REQUESTS"], "7")

    def test_gpu_keeps_its_profile(self):
        with patch.dict(os.environ, {"GENERAL_OPENVINO_DEVICE": "GPU"}, clear=True):
            configure_cpu_channels()
            self.assertNotIn("AI_INFERENCE_WORKER_COUNT", os.environ)

    def test_default(self):
        self.assertEqual(global_request_limit(), 2)

    def test_previous_choices_unchanged(self):
        for value in (1, 3, 5, 7, 8):
            self.assertEqual(global_request_limit(value), value)

    def test_twelve_requests_not_silently_clipped(self):
        self.assertEqual(global_request_limit(12), 12)
        self.assertEqual(global_request_limit('12'), 12)

    def test_bounded(self):
        self.assertEqual(global_request_limit(0), 1)
        self.assertEqual(global_request_limit(-10), 1)
        self.assertEqual(global_request_limit(1000), 32)

    def test_invalid_uses_safe_default(self):
        for value in (None, 'bad', float('nan'), float('inf')):
            self.assertEqual(global_request_limit(value), 2)


if __name__ == '__main__':
    unittest.main()
