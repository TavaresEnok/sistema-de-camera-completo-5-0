"""At most one bounded native motion crop; whole-image coverage is mandatory."""
from __future__ import annotations

from dataclasses import dataclass
import copy
import math


@dataclass(frozen=True)
class NativeRoiConfig:
    enabled: bool = True
    every_model_frames: int = 3
    input_size: int = 512
    max_size: int = 512
    min_size: int = 224
    confidence_floor: float = 0.40


def choose_native_roi(frame_shape, motion_boxes, config: NativeRoiConfig):
    h, w = frame_shape[:2]
    if min(h, w) <= 0:
        return None
    candidates = []
    for box in motion_boxes or []:
        try:
            values = [float(v) for v in box]
        except (TypeError, ValueError, OverflowError):
            continue
        if len(values) != 4 or not all(math.isfinite(v) for v in values):
            continue
        x1, y1, x2, y2 = values
        x1, y1, x2, y2 = max(0, x1), max(0, y1), min(w, x2), min(h, y2)
        bw, bh = x2 - x1, y2 - y1
        if min(bw, bh) <= 0 or max(bw, bh) > config.max_size / 1.4:
            continue
        size = min(config.max_size, max(config.min_size, int(math.ceil(max(bw, bh) * 1.8))))
        rw, rh = min(w, size), min(h, size)
        if rw * rh >= w * h * 0.65:
            continue
        xa = max(0, min(w - rw, int(round((x1 + x2 - rw) / 2))))
        ya = max(0, min(h - rh, int(round((y1 + y2 - rh) / 2))))
        candidates.append((bw * bh, (xa, ya, xa + rw, ya + rh)))
    return min(candidates, key=lambda p: p[0])[1] if candidates else None


def project_native_crop(detections, region, native_shape, target_shape, *, confidence_floor=0.40):
    x1, y1, x2, y2 = region
    nh, nw = native_shape[:2]
    th, tw = target_shape[:2]
    output = []
    for item in detections:
        bx1, by1, bx2, by2 = item.bbox
        if item.confidence < confidence_floor:
            continue
        # Crop-only edges are not real object edges. Keep the whole-frame path.
        if bx1 <= 2 or by1 <= 2 or bx2 >= x2 - x1 - 2 or by2 >= y2 - y1 - 2:
            continue
        d = copy.deepcopy(item)
        d.bbox = [int(round((bx1 + x1) * tw / nw)), int(round((by1 + y1) * th / nh)),
                  int(round((bx2 + x1) * tw / nw)), int(round((by2 + y1) * th / nh))]
        if d.bbox[2] <= d.bbox[0] or d.bbox[3] <= d.bbox[1]:
            continue
        d.extra = {**(d.extra or {}), "nativeRegion": list(region)}
        output.append(d)
    return output


def merge_native_crop(full, extra):
    """Suppress crop duplicates only; never merge two whole-frame people."""
    result = list(full)
    for candidate in sorted(extra, key=lambda d: d.confidence, reverse=True):
        duplicate = False
        for i, item in enumerate(result):
            if (item.extra or {}).get("classId") != (candidate.extra or {}).get("classId"):
                continue
            ax1, ay1, ax2, ay2 = item.bbox
            bx1, by1, bx2, by2 = candidate.bbox
            aa, ab = (ax2 - ax1) * (ay2 - ay1), (bx2 - bx1) * (by2 - by1)
            inter = max(0, min(ax2, bx2) - max(ax1, bx1)) * max(0, min(ay2, by2) - max(ay1, by1))
            iou = inter / max(1, aa + ab - inter)
            center = math.hypot((ax1 + ax2 - bx1 - bx2) / 2, (ay1 + ay2 - by1 - by2) / 2) / max(1, math.sqrt(min(aa, ab)))
            if iou >= 0.70 or (inter / max(1, min(aa, ab)) >= 0.85 and center <= 0.25):
                if candidate.confidence > item.confidence:
                    result[i] = candidate
                duplicate = True
                break
        if not duplicate:
            result.append(candidate)
    return result
