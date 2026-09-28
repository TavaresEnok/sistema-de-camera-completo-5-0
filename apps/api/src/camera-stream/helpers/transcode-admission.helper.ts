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
  // MediaMTX expands $variables BEFORE invoking sh, including local shell
  // variables. Emit literal slot names; no shell-local expansion can be lost.
  const slots = Array.from({ length: limit }, (_, slot) =>
    `{ exec 9>"/tmp/s2cam-live-slot-${slot}.lock"; flock -n 9; }`).join(' || ');
  return `command -v flock >/dev/null 2>&1 || exit 75; `
    + `if ${slots}; then exec ${command}; fi; `
    + `echo 'Live conversion capacity reached' >&2; exit 75`;
}
