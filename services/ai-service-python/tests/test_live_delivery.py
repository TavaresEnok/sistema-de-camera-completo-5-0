import unittest
from unittest.mock import patch

from detectors.base import Detection
from stream_processor import StreamProcessor


class LiveDeliveryTest(unittest.TestCase):
    def setUp(self):
        self.clock = patch('stream_processor.time.time', return_value=100.0)
        self.now = self.clock.start()
        self.addCleanup(self.clock.stop)
        self.processor = StreamProcessor('cam', 'rtsp://localhost/test', 'http://api', 'test',
                                         'motion', {'simulationOnly': True})
        self.processor.touch_live_view_session('perimeter-test-one', 20, 'selected', 'motion')
        self.detection = Detection(label='motion', confidence=1, bbox=[1, 2, 10, 20],
                                   event_type='MOTION_DETECTED')

    def store(self, when, detections):
        self.now.return_value = when
        self.processor._store_live_detections(detections, when)

    def test_short_hit_between_polls_is_recent_not_current(self):
        self.store(100.010, [self.detection])
        self.store(100.153, [])
        self.store(100.296, [])
        self.now.return_value = 100.5
        result = self.processor.get_live_delivery(700, 10)
        self.assertEqual(result['detections'], [])
        self.assertEqual(len(result['recentDetections']), 1)
        self.assertTrue(result['recentDetections'][0]['recent'])
        self.assertEqual(result['recentDetections'][0]['ageMs'], 490)
        self.assertEqual(result['sequence'], 3)
        self.assertFalse(self.processor.emit_events)

    def test_expiry_does_not_refresh_on_poll(self):
        self.store(100.010, [self.detection])
        self.store(100.153, [])
        self.store(100.296, [])
        for _ in range(3):
            self.now.return_value = 100.5
            self.assertTrue(self.processor.get_live_delivery()['recentDetections'])
        self.now.return_value = 101.211
        self.assertEqual(self.processor.get_live_delivery()['recentDetections'], [])

    def test_no_trail_when_current_and_no_history_outside_simulation(self):
        self.store(100.010, [self.detection])
        result = self.processor.get_live_delivery()
        self.assertEqual(len(result['detections']), 1)
        self.assertEqual(result['recentDetections'], [])
        self.processor.stop_live_view_session('perimeter-test-one')
        self.store(100.2, [])
        self.store(100.4, [])
        self.assertEqual(self.processor.get_live_delivery()['recentDetections'], [])
        self.assertEqual(len(self.processor._recent_motion), 0)

    def test_history_is_bounded(self):
        for i in range(100):
            self.store(100 + i / 1000, [self.detection])
        self.assertEqual(len(self.processor._recent_motion), 64)


if __name__ == '__main__':
    unittest.main()
