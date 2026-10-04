"""ByteTrack with explicit new-ID threshold and wall-clock recovery.

Visual estimates live in a separate bridge and never enter this observation
API. Imports remain lazy for installations without the ML stack.
"""
from __future__ import annotations

import numpy as np
import math
import time

from .base import TrackedBox, TrackerBackend


class ByteTrackBackend(TrackerBackend):
    name = "bytetrack"

    def __init__(self, class_id: int, activation_threshold: float,
                 lost_track_buffer: int, frame_rate: int, **kwargs):
        super().__init__(class_id, activation_threshold, lost_track_buffer, frame_rate, **kwargs)
        import supervision as sv  # lazy: ver docstring
        self._sv = sv
        self._legacy_thresholds = bool(kwargs.get("legacy_thresholds", False))
        self._tracker = sv.ByteTrack(
            # Supervision partitions scores using strict >, not >=.
            track_activation_threshold=(self.activation_threshold if self._legacy_thresholds else
                                        float(np.nextafter(np.float32(self.activation_threshold), np.float32(0)))),
            lost_track_buffer=self.lost_track_buffer,
            frame_rate=self.frame_rate,
            minimum_consecutive_frames=1,
        )
        self.recovery_seconds = max(0.25, min(10.0, float(kwargs.get("recovery_grace_ms", 2000)) / 1000))
        if not self._legacy_thresholds:
            self._tracker.det_thresh = self.activation_threshold
            self._tracker.max_time_lost = max(1, int(math.ceil(self.frame_rate * self.recovery_seconds)))
        self._last_at = None
        self._interval = 1.0 / self.frame_rate
        self._seen = {}
        self._expired = 0

    def update(self, xyxy: np.ndarray, confidences: np.ndarray, frame=None, timestamp=None) -> list[TrackedBox]:
        now = time.monotonic() if timestamp is None else float(timestamp)
        if not math.isfinite(now):
            raise ValueError("tracking timestamp must be finite")
        if not self._legacy_thresholds:
            if self._last_at is not None:
                delta = now - self._last_at
                if delta <= 0 or delta > self.recovery_seconds:
                    # Preserve counters: IDs must not be recycled after a gap.
                    self._tracker.tracked_tracks.clear()
                    self._tracker.lost_tracks.clear()
                    self._seen.clear()
                elif delta >= 0.03:
                    self._interval = 0.75 * self._interval + 0.25 * delta
            self._tracker.max_time_lost = max(1, int(math.ceil(self.recovery_seconds / max(1 / 30, self._interval))))
            for attr in ("tracked_tracks", "lost_tracks"):
                kept = []
                for track in getattr(self._tracker, attr):
                    last = self._seen.get(int(track.external_track_id), now)
                    if now - last > self.recovery_seconds:
                        # Supervision 0.27 STrack has no mark_removed() method.
                        from supervision.tracker.byte_tracker.single_object_track import TrackState
                        track.state = TrackState.Removed
                        self._expired += 1
                    else:
                        kept.append(track)
                setattr(self._tracker, attr, kept)
            self._seen = {k: t for k, t in self._seen.items() if now - t <= self.recovery_seconds * 2}
        self._last_at = now
        sv = self._sv
        if xyxy is not None and len(xyxy):
            semantic_scores = np.asarray(confidences, dtype=np.float32)
            # SV's hardcoded unconfirmed match cost is 0.7, with score fusion.
            # Even an identical box at score .25 otherwise cannot be confirmed.
            # This association-only floor does NOT change the published/model
            # score or promote a candidate below the class/new-ID threshold.
            association_scores = semantic_scores if self._legacy_thresholds else np.where(
                semantic_scores >= self.activation_threshold, np.maximum(semantic_scores, 0.31), semantic_scores)
            values = sv.Detections(
                xyxy=np.asarray(xyxy, dtype=np.float32),
                confidence=association_scores,
                class_id=np.asarray([self.class_id] * len(xyxy), dtype=int),
                data={"semanticConfidence": semantic_scores},
            )
        else:
            values = sv.Detections.empty()
        tracked = self._tracker.update_with_detections(values)
        # SV keeps historical removed STracks; IDs have independent counters.
        if len(self._tracker.removed_tracks) > 256:
            self._tracker.removed_tracks = self._tracker.removed_tracks[-256:]

        tracker_ids = tracked.tracker_id if tracked.tracker_id is not None else []
        scores = tracked.data.get("semanticConfidence", tracked.confidence if tracked.confidence is not None else [])
        classes = tracked.class_id if tracked.class_id is not None else []
        output: list[TrackedBox] = []
        for bbox, score, track_id, cls in zip(tracked.xyxy, scores, tracker_ids, classes):
            self._seen[int(track_id)] = now
            output.append(
                TrackedBox(
                    bbox=np.asarray(bbox, dtype=np.float32),
                    confidence=float(score),
                    class_id=int(cls) if cls is not None else self.class_id,
                    track_id=int(track_id),
                )
            )
        return output

    def status(self) -> dict:
        return {**super().status(), "activation_threshold": self.activation_threshold,
                "new_track_threshold": float(self._tracker.det_thresh),
                "recovery_seconds": self.recovery_seconds,
                "max_lost_frames": int(self._tracker.max_time_lost),
                "effective_update_fps": round(1 / self._interval, 3),
                "expired_by_time": self._expired, "legacy_thresholds": self._legacy_thresholds}

    def rescale_coordinates(self, scale_x, scale_y):
        """QoS/stream resolution changes must preserve IDs and pixel units."""
        transform = np.diag([scale_x, scale_y, scale_x / scale_y, scale_y,
                             scale_x, scale_y, scale_x / scale_y, scale_y])
        for track in self._tracker.tracked_tracks + self._tracker.lost_tracks:
            if track.mean is not None:
                track.mean = transform @ track.mean
                track.covariance = transform @ track.covariance @ transform.T
            if hasattr(track, '_tlwh'):
                track._tlwh = np.asarray(track._tlwh) * [scale_x, scale_y, scale_x, scale_y]
