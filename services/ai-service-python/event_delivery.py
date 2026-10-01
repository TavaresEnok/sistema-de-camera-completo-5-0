"""Single-attempt event delivery off the analysis thread.

One waiting event per camera, FIFO and backpressure (never silent overflow).
No automatic HTTP retries: the existing API is not idempotent. This is not a
durable outbox; process/host crashes retain the existing delivery limitation.
"""
import logging
import threading
import time
from queue import Empty, Queue

logger = logging.getLogger("ai-service.events")


class EventDelivery:
    def __init__(self, send):
        self._send = send
        self._queue = Queue(maxsize=1)
        self._closed = threading.Event()
        self._lock = threading.Lock()
        self._submit_lock = threading.Lock()
        self._counts = {"sent": 0, "failed": 0, "backpressure": 0, "queue_wait_last_ms": None}
        self._thread = threading.Thread(target=self._run, daemon=True, name="event-delivery")
        self._thread.start()

    def submit(self, payload):
        with self._submit_lock:
            if self._closed.is_set():
                raise RuntimeError("event delivery is closed")
            if self._queue.full():
                with self._lock:
                    self._counts["backpressure"] += 1
            # On saturation, retain the old blocking behavior instead of dropping
            # a recording trigger. Normal delivery does not block frame analysis.
            self._queue.put((time.monotonic(), payload))

    def _run(self):
        while not self._closed.is_set() or not self._queue.empty():
            try:
                enqueued, payload = self._queue.get(timeout=.1)
            except Empty:
                continue
            with self._lock:
                self._counts["queue_wait_last_ms"] = round((time.monotonic() - enqueued) * 1000, 3)
            try:
                success = self._send(payload)
            except Exception:
                success = False
                logger.error("Falha no envio de evento; sem repetição automática")
            with self._lock:
                self._counts["sent" if success else "failed"] += 1
            self._queue.task_done()

    def close(self, timeout=7):
        with self._submit_lock:
            self._closed.set()
        self._thread.join(timeout=timeout)
        if self._thread.is_alive():
            logger.error("Envio de evento ainda pendente durante encerramento")
        return not self._thread.is_alive()

    def snapshot(self):
        with self._lock:
            return {**self._counts, "queued": self._queue.qsize(), "alive": self._thread.is_alive()}
