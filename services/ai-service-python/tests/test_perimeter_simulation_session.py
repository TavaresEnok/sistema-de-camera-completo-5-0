import unittest
from unittest.mock import patch

from stream_processor import MOTION_PROFILE, StreamProcessor, runtime_profile


class PerimeterSimulationSessionTest(unittest.TestCase):
    def processor(self, *, classes=None, simulation_only=True):
        return StreamProcessor(
            "cam-manual",
            "rtsp://camera.local/stream",
            "http://api:3000",
            "token",
            "motion",
            {
                "simulationOnly": simulation_only,
                "objectDetection": {
                    "ativo": bool(classes),
                    "classes": classes or [],
                },
            },
        )

    def test_simulation_only_never_emits_events_and_only_wakes_with_lease(self):
        processor = self.processor(classes=["person"])

        self.assertFalse(processor.emit_events)
        self.assertFalse(processor._is_awake())

        lease = processor.touch_live_view_session(
            "perimeter-test-session-123",
            20,
            "selected",
            "object",
        )

        self.assertEqual(lease["simulation_mode"], "object")
        self.assertEqual(processor._perimeter_simulation_mode(), "object")
        self.assertTrue(processor._is_awake())
        self.assertTrue(processor.live_view_state()["perimeter_test_active"])

        processor.stop_live_view_session("perimeter-test-session-123")
        self.assertFalse(processor._is_awake())
        self.assertFalse(processor.live_view_state()["perimeter_test_active"])

    def test_regular_live_session_cannot_request_simulation_mode(self):
        processor = self.processor(classes=["person"], simulation_only=False)

        lease = processor.touch_live_view_session(
            "ordinary-live-session",
            20,
            "selected",
            "object",
        )

        self.assertIsNone(lease["simulation_mode"])
        self.assertIsNone(processor._perimeter_simulation_mode())
        self.assertFalse(processor.live_view_state()["perimeter_test_active"])
        self.assertEqual(processor.process_fps, MOTION_PROFILE["detection_fps"])

    def test_motion_simulation_and_normal_detection_use_same_configuration(self):
        for fps in (3.0, 5.0, 7.0, 10.0):
            profile = {**runtime_profile("motion"), "detection_fps": fps}
            with self.subTest(fps=fps), patch.dict(MOTION_PROFILE, {"detection_fps": fps}), patch("stream_processor.runtime_profile", return_value=profile):
                processor = self.processor(simulation_only=False)
                self.assertEqual(processor.process_fps, fps)
                processor.touch_live_view_session("perimeter-test-motion", 20, "selected", "motion")
                self.assertEqual(processor.process_fps, fps)
                processor.stop_live_view_session("perimeter-test-motion")
                self.assertEqual(processor.process_fps, fps)


if __name__ == "__main__":
    unittest.main()
