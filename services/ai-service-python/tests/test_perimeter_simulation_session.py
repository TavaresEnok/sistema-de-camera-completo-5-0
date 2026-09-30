import unittest

from stream_processor import StreamProcessor


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

        processor.stop_live_view_session("perimeter-test-session-123")
        self.assertFalse(processor._is_awake())

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


if __name__ == "__main__":
    unittest.main()
