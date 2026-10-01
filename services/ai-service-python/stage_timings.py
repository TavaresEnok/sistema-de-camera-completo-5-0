"""Bounded, thread-safe timing samples. Values describe local work, not camera latency."""
from collections import deque
from threading import Lock


class StageTimings:
    STAGES = frozenset(("grab_wait_decode", "retrieve_bgr", "motion", "advanced_resize",
                        "advanced_infer_tracking", "overlay_publish", "event_http"))

    def __init__(self, window=256):
        self._lock = Lock()
        self._samples = {name: deque(maxlen=window) for name in self.STAGES}
        self._counts = {name: 0 for name in self.STAGES}

    def observe(self, name, seconds):
        if name not in self.STAGES:
            raise ValueError("unknown timing stage")
        with self._lock:
            self._samples[name].append(max(0.0, seconds * 1000.0))
            self._counts[name] += 1

    def snapshot(self):
        with self._lock:
            samples = {name: sorted(values) for name, values in self._samples.items()}
            counts = dict(self._counts)
        return {name: {
            "count": counts[name], "window_samples": len(values),
            "avg_ms": round(sum(values) / len(values), 3) if values else None,
            "p95_ms": round(values[int((len(values) - 1) * .95)], 3) if values else None,
        } for name, values in samples.items()}
