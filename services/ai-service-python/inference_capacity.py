"""Explicit inference concurrency, independent of the OpenVINO thread budget."""
MAX_GLOBAL_REQUESTS = 32


def global_request_limit(value=2):
    try:
        requested = int(value)
    except (TypeError, ValueError, OverflowError):
        requested = 2
    return max(1, min(MAX_GLOBAL_REQUESTS, requested))
