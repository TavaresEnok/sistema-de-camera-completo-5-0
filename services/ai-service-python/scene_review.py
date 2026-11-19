"""Contraprova de caixas de pessoa suspeitas, com estado isolado por câmera."""
import math
import queue
import threading
import time

import cv2
import numpy as np
import requests

from object_policy import normalizar_classe


def normalized_box(box, width, height):
    if not isinstance(box, (list, tuple)) or len(box) != 4 or min(width, height) <= 0:
        return None
    if not all(isinstance(v, (int, float)) and math.isfinite(v) for v in box):
        return None
    x, y, r, b = box
    if not (0 <= x < r <= width and 0 <= y < b <= height):
        return None
    return (x / width, y / height, r / width, b / height)


def matches(a, b):
    return max(abs(x-y) for x, y in zip(a, b)) <= .025


def near_full(box):
    x, y, r, b = box
    return r-x >= .88 and b-y >= .78 and (x <= .035 or r >= .965)


def corroborated(box, observations, width, height):
    for obj in observations:
        if normalizar_classe(obj.label) != 'person':
            continue
        other = normalized_box(obj.bbox, width, height)
        if other is None:
            continue
        x, y, r, b = other
        x, r = 1-r, 1-x
        intersection = max(0, min(box[2], r)-max(box[0], x)) * max(0, min(box[3], b)-max(box[1], y))
        area = (r-x)*(b-y)
        target = (box[2]-box[0])*(box[3]-box[1])
        if intersection >= .35*min(area, target):
            return True
    return False


class CalibrationCache:
    """Uma consulta por instalação; expira configurações antigas se a API cair."""
    def __init__(self):
        self.lock = threading.Lock()
        self.started = False
        self.snapshot = (0, {})
        self.reports = queue.Queue(maxsize=64)

    def for_camera(self, camera, url, token):
        if not self.started:
            with self.lock:
                if not self.started:
                    threading.Thread(target=self.refresh, args=(url, token), daemon=True).start()
                    threading.Thread(target=self.deliver, args=(url, token), daemon=True).start()
                    self.started = True
        observed, config = self.snapshot
        return config.get(camera, ()) if time.monotonic() - observed < 55 else ()

    def deliver(self, url, token):
        while True:
            report = self.reports.get()
            try:
                requests.post(url.rstrip('/') + '/review/internal/person-example',
                              headers={'X-Service-Token': token}, json=report, timeout=3, allow_redirects=False)
            except requests.RequestException:
                pass

    def refresh(self, url, token):
        while True:
            try:
                response = requests.get(url.rstrip('/') + '/review/internal/person-patterns',
                                        headers={'X-Service-Token': token}, timeout=4, allow_redirects=False)
                response.raise_for_status()
                config = response.json()
                if isinstance(config, dict):
                    self.snapshot = (time.monotonic(), {
                        camera: [box for box in boxes if normalized_box(box, 1, 1)]
                        for camera, boxes in config.items() if isinstance(boxes, list)
                    })
            except (ValueError, requests.RequestException):
                pass
            time.sleep(20)


calibrations = CalibrationCache()
_budget = threading.Lock()
_next_check = 0.0


def reserve_check(now):
    global _next_check
    with _budget:
        if now < _next_check:
            return False
        _next_check = now + .4
        return True


class PersonBoxReview:
    def __init__(self):
        self.last = None
        self.pending = None
        self.attempt_after = self.next_report = 0
        self.checks = self.filtered = self.unavailable = self.suspect = self.invalid = 0

    def apply(self, items, frame, detector, hint, camera, api_url, token, execution):
        if not items:
            return items
        height, width = frame.shape[:2]
        now = time.monotonic()
        patterns = calibrations.for_camera(camera, api_url, token)
        result = []
        for obj in items:
            if normalizar_classe(obj.label) != 'person':
                result.append(obj)
                continue
            raw = obj.bbox
            if (not isinstance(raw, (list, tuple)) or len(raw) != 4 or
                    not all(isinstance(v, (int, float)) and math.isfinite(v) for v in raw)):
                self.invalid += 1
                continue
            clipped = [max(0, min(limit, int(v))) for v, limit in zip(raw, (width, height, width, height))]
            box = normalized_box(clipped, width, height)
            if box is None:
                self.invalid += 1
                continue
            obj.bbox = clipped
            score = float(obj.confidence)
            if score > .65:
                self.last = self.pending = None
            if not (0 < score <= .65):
                result.append(obj)
                continue
            calibrated = any(matches(box, p) for p in patterns)
            if not calibrated and not near_full(box):
                result.append(obj)
                continue
            # A mudança da cena ou do ID invalida uma contraprova anterior.
            x, y, r, b = map(int, obj.bbox)
            if x >= r or y >= b:
                result.append(obj)
                continue
            patch = cv2.resize(frame[y:b, x:r], (16, 16), interpolation=cv2.INTER_AREA).astype(np.int16)
            track = (obj.extra or {}).get('trackId')
            last = self.last
            same = (last and now-last[0] <= 3 and track == last[1] and matches(box, last[2])
                    and np.abs(patch-last[3]).mean() < 4)
            if same:
                if last[4]:
                    obj.extra = {**(obj.extra or {}), 'sceneReview': 'unconfirmed'}
                    self.suspect += 1
                    if calibrated:
                        self.filtered += 1
                        continue
            elif execution == 'model' and now >= self.attempt_after and reserve_check(now):
                self.attempt_after = now + .75
                try:
                    observations, ran = detector._detect_raw(cv2.flip(frame, 1), detector._runtime_for_hint(hint),
                                                             allowed_class_ids={0})
                except Exception:
                    observations, ran = [], False
                if ran:
                    self.checks += 1
                    miss = not corroborated(box, observations, width, height)
                    pending = self.pending
                    rejected = bool(miss and pending and .5 <= now-pending[0] <= 10
                                    and track == pending[1] and matches(box, pending[2])
                                    and np.abs(patch-pending[3]).mean() < 4)
                    self.pending = (now, track, box, patch) if miss else None
                    self.last = (now, track, box, patch, rejected) if rejected or not miss else None
                    if rejected:
                        obj.extra = {**(obj.extra or {}), 'sceneReview': 'unconfirmed'}
                        self.suspect += 1
                        if now >= self.next_report:
                            self.next_report = now + 300
                            try:
                                calibrations.reports.put_nowait(dict(camera=camera, bbox=clipped,
                                    frameWidth=width, frameHeight=height, confidence=score))
                            except queue.Full:
                                pass
                        if calibrated:
                            self.filtered += 1
                            continue
                else:
                    self.unavailable += 1
            result.append(obj)
        return result
