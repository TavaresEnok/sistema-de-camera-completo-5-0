import os
import unittest
from unittest.mock import Mock, patch
from fastapi import HTTPException
from pydantic import ValidationError
import main


class DetectionBatchTest(unittest.TestCase):
    def test_token_required_before_reading_processors(self):
        with patch.dict(os.environ, {"INTERNAL_SERVICE_TOKEN": "test-token-with-at-least-24-chars"}):
            with self.assertRaises(HTTPException) as error:
                main.latest_detections_batch(main.DetectionBatchRequest(camera_ids=["a"]), None)
            self.assertEqual(error.exception.status_code, 401)

    def test_partial_failure_and_deduplication(self):
        good = Mock()
        good.get_live_delivery.return_value = {"detections": [], "recentDetections": [{"recent": True}]}
        broken = Mock()
        broken.get_live_delivery.side_effect = RuntimeError("test")
        with patch.dict(main.processors, {"good": good, "broken": broken}, clear=True), \
             patch.object(main, "validate_internal_token"), patch.object(main.logger, "exception"):
            result = main.latest_detections_batch(main.DetectionBatchRequest(camera_ids=["good", "good", "broken", "absent"]))
        good.get_live_delivery.assert_called_once_with(5000, 12)
        self.assertEqual(result["cameras"]["good"]["status"], "ok")
        self.assertEqual(result["cameras"]["broken"]["status"], "unavailable")
        self.assertEqual(result["cameras"]["absent"]["status"], "not_running")

    def test_request_is_bounded(self):
        for args in ({"camera_ids": ["a"] * 101}, {"limit": 51}, {"max_age_ms": 199}):
            with self.assertRaises(ValidationError):
                main.DetectionBatchRequest(**args)
