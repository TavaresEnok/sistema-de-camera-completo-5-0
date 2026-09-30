#!/usr/bin/env python3
"""Event-free motion benchmark using existing MediaMTX grid streams."""

import argparse
import json
import os
import threading
import time
from urllib.parse import quote

import cv2

from detectors.motion import MotionDetector


def run_camera(camera_id, shared, results, lock):
    user = quote(os.environ["BENCH_MEDIA_USER"], safe="")
    password = quote(os.environ["BENCH_MEDIA_PASS"], safe="")
    path = "cam_" + camera_id.replace("-", "") + "_grid"
    url = f"rtsp://{user}:{password}@mediamtx:8554/{path}"
    cap = cv2.VideoCapture(url, cv2.CAP_FFMPEG)
    opened = cap.isOpened()
    source_fps = round(float(cap.get(cv2.CAP_PROP_FPS) or 0), 2) if opened else 0
    detector = MotionDetector() if opened else None
    with lock:
        results[camera_id] = {"opened": opened, "source_fps": source_fps, "frames": [0] * len(shared["rates"]), "grabs": [0] * len(shared["rates"]), "errors": 0}
    try:
        if not opened:
            return
        # Keep the RTSP reader draining while the rest of the fleet opens.
        while not shared["start"].is_set() and not shared["stop"].is_set():
            if not cap.grab():
                time.sleep(0.05)
        last_frame = 0.0
        errors = 0
        while not shared["stop"].is_set() and errors < 40:
            now = time.monotonic()
            phase = int((now - shared["start_time"]) // shared["seconds"])
            if phase < 0:
                continue
            if phase >= len(shared["rates"]):
                break
            interval = 1.0 / shared["rates"][phase]
            if shared["capture_mode"] == "grab-only":
                if cap.grab():
                    results[camera_id]["grabs"][phase] += 1
                    errors = 0
                else:
                    errors += 1
                    time.sleep(0.05)
                continue
            if shared["capture_mode"] == "retrieve":
                if not cap.grab():
                    errors += 1
                    time.sleep(0.05)
                    continue
                results[camera_id]["grabs"][phase] += 1
                if time.monotonic() - last_frame < interval:
                    continue
                ok, frame = cap.retrieve()
                if not ok:
                    errors += 1
                    time.sleep(0.05)
                    continue
                last_frame = time.monotonic()
                detector.infer(frame)
                results[camera_id]["frames"][phase] += 1
                errors = 0
                continue
            if now - last_frame < interval:
                if not cap.grab():
                    errors += 1
                    time.sleep(0.05)
                continue
            ok, frame = cap.read()
            if not ok:
                errors += 1
                time.sleep(0.05)
                continue
            last_frame = time.monotonic()
            detector.infer(frame)
            results[camera_id]["frames"][phase] += 1
            errors = 0
        results[camera_id]["errors"] = errors
    finally:
        cap.release()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--cameras", required=True)
    parser.add_argument("--rates", default="3,5,7,10")
    parser.add_argument("--seconds", type=float, default=12)
    parser.add_argument("--startup-seconds", type=float, default=180)
    parser.add_argument("--capture-mode", choices=["read", "retrieve", "grab-only"], default="read")
    args = parser.parse_args()
    ids = [part.strip() for part in args.cameras.split(",") if part.strip()]
    rates = [float(part) for part in args.rates.split(",")]
    cv2.setNumThreads(1)
    os.environ.setdefault("OPENCV_FFMPEG_CAPTURE_OPTIONS", "rtsp_transport;tcp|fflags;nobuffer|flags;low_delay|stimeout;5000000")
    shared = {"rates": rates, "seconds": args.seconds, "capture_mode": args.capture_mode, "start": threading.Event(), "stop": threading.Event(), "start_time": 0.0}
    results = {}
    lock = threading.Lock()
    threads = [threading.Thread(target=run_camera, args=(cid, shared, results, lock), daemon=True) for cid in ids]
    for thread in threads:
        thread.start()
    deadline = time.monotonic() + args.startup_seconds
    while time.monotonic() < deadline:
        with lock:
            ready = len(results)
        if ready == len(ids):
            break
        time.sleep(0.25)
    with lock:
        print(json.dumps({"startup_complete": len(results), "requested": len(ids), "opened": sum(v["opened"] for v in results.values())}), flush=True)
    shared["start_time"] = time.monotonic() + 0.2
    shared["start"].set()
    for index, rate in enumerate(rates):
        cpu_start = time.process_time()
        phase_end = shared["start_time"] + (index + 1) * args.seconds
        while time.monotonic() < phase_end:
            time.sleep(min(0.1, phase_end - time.monotonic()))
        with lock:
            snapshot = {cid: dict(value) for cid, value in results.items()}
        opened = [value for value in snapshot.values() if value["opened"]]
        frames = sum(value["frames"][index] for value in opened)
        grabs = sum(value["grabs"][index] for value in opened)
        print(json.dumps({
            "capture_mode": args.capture_mode,
            "target_fps": rate,
            "opened_cameras": len(opened),
            "cpu_cores": round((time.process_time() - cpu_start) / args.seconds, 2),
            "total_real_fps": round(frames / args.seconds, 2),
            "source_grabs_per_camera": round(grabs / (args.seconds * len(opened)), 2) if opened else 0,
            "real_fps_per_open_camera": round(frames / (args.seconds * len(opened)), 2) if opened else 0,
            "per_camera_fps": {cid: round(v["frames"][index] / args.seconds, 2) for cid, v in snapshot.items() if v["opened"]},
        }), flush=True)
    shared["stop"].set()
    for thread in threads:
        thread.join(timeout=5)
    print(json.dumps({"requested_cameras": len(ids), "opened_cameras": sum(v["opened"] for v in results.values()), "sources": {cid: {"opened": v["opened"], "source_fps": v["source_fps"], "errors": v["errors"]} for cid, v in results.items()}, "threads_still_alive": sum(thread.is_alive() for thread in threads)}), flush=True)


if __name__ == "__main__":
    main()
