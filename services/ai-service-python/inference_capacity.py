"""Explicit inference concurrency, independent of the OpenVINO thread budget."""
import os

from onnxruntime_session import _available_cpu_threads

MAX_GLOBAL_REQUESTS = 32


def global_request_limit(value=2, automatic_channels=1):
    try:
        requested = int(value)
    except (TypeError, ValueError, OverflowError):
        requested = 2
    return max(1, min(max(MAX_GLOBAL_REQUESTS, automatic_channels), requested))


def configure_cpu_channels():
    """Default CPU concurrency at startup; explicit installation settings take precedence."""
    if (os.getenv("GENERAL_OPENVINO_DEVICE") or "CPU").strip().upper() != "CPU":
        return
    available = _available_cpu_threads()["available_threads"]
    automatic = max(1, available // 2)
    workers = os.getenv("AI_INFERENCE_WORKER_COUNT", "").strip()
    channels = global_request_limit(workers, automatic) if workers else automatic
    for name in ("AI_INFERENCE_WORKER_COUNT", "AI_INFERENCE_THREADS_OVERRIDE",
                 "GENERAL_GLOBAL_INFER_REQUESTS", "GENERAL_OPENVINO_STREAMS"):
        if not os.getenv(name, "").strip():
            os.environ[name] = str(channels)
