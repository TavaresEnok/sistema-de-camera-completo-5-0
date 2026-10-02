#!/usr/bin/env python3
"""Real-model smoke test on public COCO128 images, without camera access.

Run in the patched AI image, models mounted read-only, PYTHONPATH=/app, and
AI_INFERENCE_THREADS_OVERRIDE=1. Downloaded images/labels stay in memory;
no archives are extracted and no production settings or model files change.
This verifies the permission fix, not accuracy on customers' camera scenes.
"""
import io
import json
import urllib.request
import zipfile
from pathlib import PurePosixPath
from unittest.mock import patch

import cv2
import numpy as np

from detectors.object_detector import ObjectDetector
from runtime_profiles import GENERAL_PROFILE


def main():
    cv2.setNumThreads(1)
    url = "https://github.com/ultralytics/assets/releases/download/v0.0.0/coco128.zip"
    with urllib.request.urlopen(url, timeout=25) as response:
        payload = response.read(12_000_001)
    if len(payload) > 12_000_000:
        raise RuntimeError("Dataset exceeds smoke-test memory limit")
    archive = zipfile.ZipFile(io.BytesIO(payload))
    images = {PurePosixPath(name).stem: name for name in archive.namelist()
              if "/images/" in name and name.lower().endswith((".jpg", ".jpeg", ".png"))}
    candidates = {2: [], 3: []}
    for name in archive.namelist():
        if "/labels/" not in name or not name.endswith(".txt"):
            continue
        image = images.get(PurePosixPath(name).stem)
        if not image:
            continue
        for line in archive.read(name).decode().splitlines():
            fields = line.split()
            class_id = int(fields[0])
            area = float(fields[3]) * float(fields[4])
            if class_id in candidates:
                candidates[class_id].append((area, image))
    detector = ObjectDetector()
    detector.load()
    detected = set()
    for class_id, items in candidates.items():
        seen = set()
        for area, name in sorted(items, reverse=True):
            if name in seen:
                continue
            seen.add(name)
            frame = cv2.imdecode(np.frombuffer(archive.read(name), np.uint8), cv2.IMREAD_COLOR)
            if frame is None:
                raise RuntimeError("Cannot decode public test image")
            with patch.dict(GENERAL_PROFILE, {"detect_vehicles": False, "persistent_track_id": False}):
                previous = detector.infer(frame)
                current = detector.infer(frame, allowed_classes={"person", "bicycle", "car", "motorcycle"})
            assert not any(item.label in ("carro", "moto") for item in previous)
            assert all(item.label in ("pessoa", "bicicleta", "carro", "moto") for item in current)
            detected.update(item.label for item in current)
            print(json.dumps({"image": PurePosixPath(name).name, "ground_truth_class_id": class_id,
                              "ground_truth_area_fraction": round(area, 3),
                              "legacy_vehicle_detections": [],
                              "permitted_detections": [{"label": item.label, "confidence": round(item.confidence, 3)}
                                                        for item in current]}, ensure_ascii=False), flush=True)
            if len(seen) >= 3:
                break
    assert {"carro", "moto"}.issubset(detected), "Model did not demonstrate both vehicle classes"
    print(json.dumps({"vehicle_policy_smoke_test": "passed", "model": detector.model_name,
                      "precision": detector.loaded_precision, "input_size": detector.input_size}))


if __name__ == "__main__":
    main()
