import threading
import unittest
from event_delivery import EventDelivery


class EventDeliveryTest(unittest.TestCase):
    def test_full_queue_applies_backpressure_without_dropping(self):
        started, release = threading.Event(), threading.Event()
        sent = []
        def send(payload):
            started.set()
            release.wait(2)
            sent.append(payload)
            return True
        delivery = EventDelivery(send)
        delivery.submit(1)
        self.assertTrue(started.wait(1))
        delivery.submit(2)
        producer = threading.Thread(target=lambda: delivery.submit(3))
        producer.start()
        try:
            producer.join(.05)
            self.assertTrue(producer.is_alive())
        finally:
            release.set()
            producer.join(2)
            delivery.close()
        self.assertEqual(sent, [1, 2, 3])
        self.assertEqual(delivery.snapshot()["backpressure"], 1)

    def test_slow_http_does_not_block_first_submission_and_drains_fifo(self):
        started, release = threading.Event(), threading.Event()
        sent = []
        def send(payload):
            started.set()
            release.wait(2)
            sent.append(payload)
            return True
        delivery = EventDelivery(send)
        try:
            delivery.submit({"occurredAt": "original-time", "id": 1})
            self.assertTrue(started.wait(1))
            delivery.submit({"id": 2})
            self.assertEqual(delivery.snapshot()["queued"], 1)
        finally:
            release.set()
            self.assertTrue(delivery.close())
        self.assertEqual(sent, [{"occurredAt": "original-time", "id": 1}, {"id": 2}])
        self.assertEqual(delivery.snapshot()["sent"], 2)

    def test_failed_attempt_is_counted_without_duplicate_retry(self):
        attempts = []
        def fail(payload):
            attempts.append(payload)
            return False
        delivery = EventDelivery(fail)
        delivery.submit({"id": 1})
        self.assertTrue(delivery.close())
        self.assertEqual(attempts, [{"id": 1}])
        self.assertEqual(delivery.snapshot()["failed"], 1)
        with self.assertRaises(RuntimeError):
            delivery.submit({"id": 2})
