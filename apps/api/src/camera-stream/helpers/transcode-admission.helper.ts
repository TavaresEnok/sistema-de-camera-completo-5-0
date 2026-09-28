/** Only application-owned delivery publishers, not camera ingest sessions. */
export function isManagedLivePublisher(path: any): boolean {
  return path?.ready === true
    && /^cam_[a-zA-Z0-9]+_(?:grid|grid_audio|orig_audio)$/.test(String(path.name ?? ''))
    && ['rtspSession', 'publisher'].includes(String(path.source?.type ?? ''));
}

/** Kernel locks survive exec and are released even on SIGKILL. No stale PID locks.
 * Runs in the MediaMTX container, so admission also covers old configured paths
 * starting later and requests from multiple API instances. Fail closed without flock.
 */
export function withTranscodeAdmission(command: string, maximum: number): string {
  const limit = Math.max(1, Math.min(2000, Math.floor(maximum) || 1));
  return `command -v flock >/dev/null 2>&1 || exit 75; `
    + `slot=0; while [ "$slot" -lt ${limit} ]; do `
    + `exec 9>"/tmp/s2cam-live-slot-$slot.lock"; `
    + `if flock -n 9; then exec ${command}; fi; slot=$((slot + 1)); done; `
    + `echo 'Live conversion capacity reached' >&2; exit 75`;
}
