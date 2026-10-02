#!/usr/bin/env python3
"""Offline old/new detector comparison; no cameras, credentials or network.

Run in the exact previous AI image, mounting the patched source read-only.
Measures detector CPU time only (not video decode or the whole installation).
"""
import importlib.util
import json
import statistics
import time

import cv2
import numpy as np

from detectors.motion import MotionDetector as Previous


def main():
    cv2.setNumThreads(1)
    spec = importlib.util.spec_from_file_location("detectors.motion_patched", "/workspace/detectors/motion.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    rng = np.random.default_rng(20261002)
    base = np.repeat(rng.integers(65, 100, (180, 320, 1), dtype=np.uint8), 3, axis=2)
    frames = []
    for step in range(120):
        frame = base.copy()
        x = 40 + (step * 6) % 220
        frame[70:86, x:x+3] = 220
        frames.append(frame)
    full = [[0, 0], [1, 0], [1, 1], [0, 1]]
    cases = {
        "default": [],
        "all_high": [{"kind": "include", "sensitivity": "alta", "points": full}],
        "mixed": [{"kind": "include", "sensitivity": "media", "points": full},
                  {"kind": "include", "sensitivity": "alta",
                   "points": [[0, 0], [0.5, 0], [0.5, 1], [0, 1]]}],
    }
    for name, zones in cases.items():
        samples = {"old": [], "new": []}
        events = {}
        for repeat in range(5):
            # Alternate order to reduce bias from host load and CPU warmup.
            versions = [("old", Previous), ("new", module.MotionDetector)]
            if repeat % 2:
                versions.reverse()
            for version, cls in versions:
                detector = cls(zones=zones)
                for _ in range(100):
                    detector.infer(base)
                started = time.process_time()
                emitted = sum(bool(detector.infer(frame)) for frame in frames)
                samples[version].append((time.process_time() - started) * 1000 / len(frames))
                events[version] = emitted
        old, new = (statistics.median(samples[v]) for v in ("old", "new"))
        print(json.dumps({"case": name, "frames": len(frames), "repeats": 5,
                          "old_cpu_ms_per_frame": round(old, 4),
                          "new_cpu_ms_per_frame": round(new, 4),
                          "change_percent": round((new / old - 1) * 100, 2),
                          "old_new_emitted_frames": events}), flush=True)


if __name__ == "__main__":
    main()
