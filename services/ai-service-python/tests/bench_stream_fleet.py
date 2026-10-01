#!/usr/bin/env python3
"""Measure the real two-thread motion pipeline; never emit events or run objects.

Use BENCH_CAMERAS_JSON=[{id, publicId, detectionZones}], BENCH_MEDIA_USER/PASS.
Run in an isolated container on the existing MediaMTX network.
"""

import argparse
import json
import logging
import os
import resource
import statistics
import time
from urllib.parse import quote

import cv2

from stream_processor import StreamProcessor


def host_cpu():
    with open("/proc/stat", encoding="ascii") as handle:
        counters = [int(value) for value in handle.readline().split()[1:9]]
    return sum(counters), counters[3] + counters[4]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--label", default="fleet")
    parser.add_argument("--rates", default="3,5,7,10")
    parser.add_argument("--seconds", type=float, default=20)
    parser.add_argument("--startup-seconds", type=float, default=180)
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--cv-threads", type=int, default=1)
    parser.add_argument("--skip-motion", action="store_true", help="Isolate capture throughput without running the detector")
    args = parser.parse_args()
    logging.basicConfig(level=logging.WARNING)
    cv2.setNumThreads(args.cv_threads)
    cameras = json.loads(os.environ["BENCH_CAMERAS_JSON"])
    if args.limit:
        cameras = cameras[:args.limit]
    rates = [float(value) for value in args.rates.split(",")]
    user = quote(os.environ["BENCH_MEDIA_USER"], safe="")
    password = quote(os.environ["BENCH_MEDIA_PASS"], safe="")
    processors = []
    for camera in cameras:
        path = "cam_" + camera["id"].replace("-", "") + "_grid"
        processor = StreamProcessor(
            camera["id"], f"rtsp://{user}:{password}@mediamtx:8554/{path}",
            "http://api:3000", "unused-benchmark-token", "motion",
            {"simulationOnly": True, "detectionZones": camera.get("detectionZones") or []},
        )
        processor.semantic_enabled = False
        if args.skip_motion:
            processor.motion_detector.infer = lambda frame, **kwargs: []
        processor.touch_live_view_session("fleet-benchmark", 120, "grid")
        processors.append((camera, processor))

    def maintain_leases():
        for _, processor in processors:
            processor.touch_live_view_session("fleet-benchmark", 120, "grid")

    def wait_until(deadline):
        while time.monotonic() < deadline:
            maintain_leases()
            time.sleep(min(1.0, max(0.0, deadline - time.monotonic())))

    def counters(processor):
        return processor.capture_frames_enqueued, getattr(processor, "motion_infer_runs", processor.processed_frames), processor.capture_frames_dropped

    try:
        for _, processor in processors:
            processor.start()
        startup_start = time.monotonic()
        while time.monotonic() - startup_start < args.startup_seconds:
            maintain_leases()
            if all(processor.processed_frames >= 35 for _, processor in processors):
                break
            time.sleep(1)
        print(json.dumps({"label": args.label, "startup_seconds": round(time.monotonic() - startup_start, 2), "requested": len(processors), "capturing": sum(p.capture_frames_enqueued > 0 for _, p in processors), "cv_threads": cv2.getNumThreads(), "motion_enabled": not args.skip_motion}), flush=True)
        if any(processor.capture_frames_enqueued == 0 for _, processor in processors):
            raise RuntimeError("A fleet source did not deliver frames; comparison is incomplete")
        for rate in rates:
            for _, processor in processors:
                with processor._live_view_lock:
                    processor.base_process_fps = rate
                    processor._apply_qos_mode("grid")
            wait_until(time.monotonic() + 3)
            before = {camera["id"]: counters(processor) for camera, processor in processors}
            cpu_start = time.process_time()
            host_start = host_cpu()
            started = time.monotonic()
            wait_until(started + args.seconds)
            elapsed = time.monotonic() - started
            host_end = host_cpu()
            host_busy = 1 - (host_end[1] - host_start[1]) / max(1, host_end[0] - host_start[0])
            rows = []
            for camera, processor in processors:
                captured, analyzed, dropped = counters(processor)
                old_capture, old_analyzed, old_dropped = before[camera["id"]]
                stream = processor.capture_stream_state()
                rows.append({
                    "camera": camera.get("publicId", camera["id"]),
                    "capture_fps": round((captured - old_capture) / elapsed, 3),
                    "motion_fps": round((analyzed - old_analyzed) / elapsed, 3),
                    "dropped": dropped - old_dropped,
                    "decoder_threads": stream.get("decoder_threads"),
                    "frame_age_ms": stream.get("frame_age_last_ms"),
                    "input_fps": stream.get("capture_rate_guard", {}).get("observed_fps"),
                    "motion_avg_ms": processor.performance_state().get("motion_infer_avg_ms"),
                    "last_error": processor.last_error,
                })
            values = [row["motion_fps"] for row in rows]
            print(json.dumps({
                "label": args.label, "target_fps": rate, "seconds": round(elapsed, 3), "cameras": len(rows),
                "motion_mean_fps": round(statistics.mean(values), 3),
                "motion_min_fps": min(values), "motion_max_fps": max(values),
                "cameras_at_90_percent": sum(value >= 0.9 * rate for value in values),
                "process_cpu_cores": round((time.process_time() - cpu_start) / elapsed, 3),
                "host_cpu_percent": round(host_busy * 100, 2),
                "rss_mib": round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024, 1),
                "per_camera": rows,
            }), flush=True)
            if host_busy > 0.8:
                raise RuntimeError("Host load exceeded 80%; stopping the diagnostic")
    finally:
        for _, processor in processors:
            processor.stop()


if __name__ == "__main__":
    main()
