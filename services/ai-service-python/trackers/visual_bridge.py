"""Bounded pixel tracking between real object detections, never new evidence.

ByteTrack associates observations; sparse optical flow is the separate visual
bridge. No predicted box may create a track, raise confidence, confirm an
event, survive a failed image check, or replace periodic full-frame inference.
"""
from __future__ import annotations

from dataclasses import dataclass
import copy
import math

import cv2
import numpy as np


@dataclass(frozen=True)
class VisualBridgeConfig:
    enabled: bool = True
    refresh_seconds: float = 0.75
    max_frame_gap_seconds: float = 0.50
    max_skips: int = 2
    min_model_hits: int = 3
    max_tracks: int = 12
    max_width: int = 480
    max_height: int = 270
    max_points: int = 12
    min_points: int = 4
    max_fb_error: float = 0.75


class VisualTrackBridge:
    def __init__(self, config: VisualBridgeConfig):
        self.config = config
        self.clear()
        self.stats = {"model_frames": 0, "visual_frames": 0, "fallbacks": {}, "visual_ms": 0.0}

    def clear(self):
        self.gray = None
        self.shape = None
        self.items = []
        self.points = []
        self.hits = {}
        self.model_at = None
        self.frame_at = None
        self.skips = 0
        self.ready = False

    def _gray(self, frame):
        h, w = frame.shape[:2]
        scale = min(1.0, self.config.max_width / w, self.config.max_height / h)
        small = cv2.resize(frame, (max(1, round(w * scale)), max(1, round(h * scale)))) if scale < 1 else frame
        return cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)

    def seed(self, frame, detections, now, *, complete=True):
        """Only an actually executed full-image pass resets validation age."""
        previous_hits = self.hits if self.shape == frame.shape[:2] else {}
        self.clear()
        self.stats["model_frames"] += 1
        self.shape = frame.shape[:2]
        self.model_at = self.frame_at = float(now)
        valid = [d for d in detections if (d.extra or {}).get("trackId") is not None
                 and (d.extra or {}).get("observedByModel", True)
                 and not (d.extra or {}).get("associationOnly", False)]
        self.hits = {d.extra["trackId"]: previous_hits.get(d.extra["trackId"], 0) + 1 for d in valid}
        # A full-frame shortcut cannot drop weak/association-only or untracked
        # objects merely because the remaining strong object is easy to follow.
        # Keep real inference until every currently shown detection is covered.
        if not self.config.enabled or not complete or len(valid) != len(detections) or not valid or len(valid) > self.config.max_tracks:
            return
        self.gray = self._gray(frame)
        gh, gw = self.gray.shape
        h, w = self.shape
        self.items = copy.deepcopy(valid)
        for d in self.items:
            x1, y1, x2, y2 = np.asarray(d.bbox, dtype=float) * [gw / w, gh / h, gw / w, gh / h]
            # Select texture inside the body, not a background ring around it.
            mx, my = (x2 - x1) * 0.12, (y2 - y1) * 0.12
            xa, ya = max(0, int(math.ceil(x1 + mx))), max(0, int(math.ceil(y1 + my)))
            xb, yb = min(gw, int(x2 - mx)), min(gh, int(y2 - my))
            if xb <= xa or yb <= ya:
                self.points.append(None)
                continue
            pts = cv2.goodFeaturesToTrack(self.gray[ya:yb, xa:xb], maxCorners=self.config.max_points,
                                         qualityLevel=0.04, minDistance=2, blockSize=3)
            if pts is not None:
                pts += np.array([xa, ya], dtype=np.float32)
            self.points.append(pts)
        self.ready = all(self.hits[d.extra["trackId"]] >= self.config.min_model_hits for d in self.items)

    def _fallback(self, reason):
        bucket = self.stats["fallbacks"]
        bucket[reason] = bucket.get(reason, 0) + 1
        return None

    @staticmethod
    def _covered(motion, boxes):
        x1, y1, x2, y2 = motion
        area = (x2 - x1) * (y2 - y1)
        if area <= 0:
            return False
        # Conservative: a motion region must fit mostly within one known box.
        for b in boxes:
            bx1, by1, bx2, by2 = b
            mx, my = max(4, (bx2 - bx1) * 0.12), max(4, (by2 - by1) * 0.12)
            inter = max(0, min(x2, bx2 + mx) - max(x1, bx1 - mx)) * max(0, min(y2, by2 + my) - max(y1, by1 - my))
            if inter / area >= 0.90:
                return True
        return False

    def advance(self, frame, motion_boxes, now):
        """None means run YOLO now; [] is deliberately never an idle shortcut."""
        cfg = self.config
        if not cfg.enabled or not self.ready or self.gray is None or not self.items:
            return self._fallback("not_ready")
        if self.shape != frame.shape[:2]:
            return self._fallback("resolution_changed")
        if now <= self.frame_at or now - self.frame_at > cfg.max_frame_gap_seconds:
            return self._fallback("frame_gap")
        if now - self.model_at >= cfg.refresh_seconds or self.skips >= cfg.max_skips:
            return self._fallback("refresh_due")
        if motion_boxes is None:
            return self._fallback("motion_unavailable")
        if any(p is None or len(p) < cfg.min_points for p in self.points):
            return self._fallback("few_points")
        current = self._gray(frame)
        # Abrupt illumination/cut invalidates all estimates, including static ones.
        if abs(float(np.mean(current)) - float(np.mean(self.gray))) > 25:
            return self._fallback("scene_change")
        # The main motion detector intentionally rejects noise and very small
        # components. Its empty output is not proof that no new object appeared.
        # A cheap pixel guard outside all known boxes forces a full pass instead
        # of silently coasting one parked car while cyclists enter the image.
        previous_smooth = cv2.GaussianBlur(self.gray, (3, 3), 0)
        current_smooth = cv2.GaussianBlur(current, (3, 3), 0)
        changed = cv2.absdiff(previous_smooth, current_smooth) > 16
        gh, gw = current.shape
        h, w = self.shape
        for item in self.items:
            x1,y1,x2,y2 = np.asarray(item.bbox, dtype=float) * [gw/w,gh/h,gw/w,gh/h]
            mx,my=max(2,(x2-x1)*.12),max(2,(y2-y1)*.12)
            changed[max(0,int(y1-my)):min(gh,int(math.ceil(y2+my))), max(0,int(x1-mx)):min(gw,int(math.ceil(x2+mx)))] = False
        if int(np.count_nonzero(changed)) >= 24:
            return self._fallback("uncovered_pixel_change")
        all_old = np.concatenate(self.points).astype(np.float32)
        params = dict(winSize=(15, 15), maxLevel=2,
                      criteria=(cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 20, 0.01))
        new, st1, err = cv2.calcOpticalFlowPyrLK(self.gray, current, all_old, None, **params)
        if new is None or st1 is None or err is None or not np.all(np.isfinite(new)):
            return self._fallback("flow_failed")
        back, st2, _ = cv2.calcOpticalFlowPyrLK(current, self.gray, new, None, **params)
        if back is None or st2 is None or not np.all(np.isfinite(back)):
            return self._fallback("backward_failed")
        fb = np.max(np.abs(back - all_old), axis=2).ravel()
        good = (st1.ravel() > 0) & (st2.ravel() > 0) & (fb <= cfg.max_fb_error) & (err.ravel() < 25)
        results, points = [], []
        gh, gw = current.shape
        h, w = self.shape
        offset = 0
        for old_pts, item in zip(self.points, self.items):
            end = offset + len(old_pts)
            ok = good[offset:end]
            if int(np.sum(ok)) < max(cfg.min_points, math.ceil(len(old_pts) * 0.60)):
                return self._fallback("points_lost")
            delta = (new[offset:end][ok] - all_old[offset:end][ok]).reshape(-1, 2)
            shift = np.median(delta, axis=0)
            if np.max(np.median(np.abs(delta - shift), axis=0)) > 1.5:
                return self._fallback("incoherent_motion")
            dx, dy = shift * [w / gw, h / gh]
            b = np.asarray(item.bbox, dtype=float)
            if abs(dx) > max(6, (b[2] - b[0]) * 0.5) or abs(dy) > max(6, (b[3] - b[1]) * 0.5):
                return self._fallback("fast_motion")
            b += [dx, dy, dx, dy]
            if b[0] < 0 or b[1] < 0 or b[2] > w or b[3] > h:
                return self._fallback("frame_edge")
            d = copy.deepcopy(item)
            d.bbox = [int(round(v)) for v in b]
            d.extra = {**d.extra, "observedByModel": False, "trackingSource": "optical_flow",
                       "estimated": True, "modelAgeMs": round((now - self.model_at) * 1000)}
            results.append(d)
            points.append(new[offset:end][ok].copy())
            offset = end
        if any(not self._covered(m, [d.bbox for d in results]) for m in motion_boxes):
            return self._fallback("new_motion")
        # Crossing/overlapping objects require real detections, not flow identity guesses.
        for i, a in enumerate(results):
            for b in results[i + 1:]:
                ax1, ay1, ax2, ay2 = a.bbox
                bx1, by1, bx2, by2 = b.bbox
                inter = max(0, min(ax2, bx2) - max(ax1, bx1)) * max(0, min(ay2, by2) - max(ay1, by1))
                if inter / max(1, min((ax2 - ax1) * (ay2 - ay1), (bx2 - bx1) * (by2 - by1))) > 0.20:
                    return self._fallback("overlapping_tracks")
        self.items, self.points, self.gray = results, points, current
        self.frame_at = float(now)
        self.skips += 1
        self.stats["visual_frames"] += 1
        return results

    def status(self):
        return {**copy.deepcopy(self.stats), "enabled": self.config.enabled,
                "refresh_seconds": self.config.refresh_seconds, "max_skips": self.config.max_skips,
                "tracks": len(self.items), "ready": self.ready}
