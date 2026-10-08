/** Only application-owned delivery publishers, not camera ingest sessions. */
export function isManagedLivePublisher(path: any): boolean {
  return path?.ready === true
    && /^cam_[a-zA-Z0-9]+_(?:grid|grid_audio|orig|orig_audio)$/.test(String(path.name ?? ''))
    && ['rtspSession', 'publisher'].includes(String(path.source?.type ?? ''));
}

/** Also protect starts through cached URLs/direct media readers. This executes
 * in MediaMTX before any new worker, never terminates an existing stream.
 * Base64 shields awk $fields from MediaMTX's environment expansion.
 */
export function withHostPressureAdmission(command: string, _cores: number): string {
  // Measure busy CPU over a short interval. /proc/loadavg also counts disk
  // waits and retains past pressure: it blocked healthy starts below 70% CPU.
  // awk excludes guest time (already part of user/nice) and counts iowait idle.
  const readCpu = `awk '/^cpu / { total=0; for(i=2;i<=9;i++) total+=$i; print total, $5+$6; exit }' /proc/stat`;
  const check = `before=$(${readCpu}); sleep 0.3; `
    + `awk -v before="$before" '/^cpu / { split(before,b," "); total=0; for(i=2;i<=9;i++) total+=$i; elapsed=total-b[1]; idle=$5+$6-b[2]; if(elapsed<=0 || (elapsed-idle)*100/elapsed>=75) exit 75; exit }' /proc/stat && `
    + `awk '/^MemTotal:/ { total=$2 } /^MemAvailable:/ { available=$2 } END { if (available < 524288 || available < total*0.1) exit 75 }' /proc/meminfo`;
  const encoded = Buffer.from(check).toString('base64');
  return `printf %s ${encoded} | base64 -d | sh || { echo 'Live conversion host pressure reached' >&2; exit 75; }; ${command}`;
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

/** Relative admission points, not a CPU percentage prediction. Decode input
 * resolution matters even when the output is scaled down. Unknown costs more. */
export function liveConversionCost(input: {
  videoEncoded: boolean; codec?: string | null;
  width?: number | null; height?: number | null; fps?: number | null;
}): 1 | 2 | 4 {
  if (!input.videoEncoded) return 1;
  const { width, height, fps } = input;
  if (!width || !height || !fps) return 4;
  const pixelRate = width * height * fps;
  const codecFactor = /^(?:h265|hevc)$/i.test(input.codec ?? '') ? 2 : 1;
  return pixelRate * codecFactor <= 1280 * 720 * 30 ? 2 : 4;
}

/** Atomically reserves a contiguous bundle of points while keeping fd 9 free
 * for the independent process-count ceiling. No shell variables: MediaMTX
 * substitutes them before execution. Only the short allocation holds fd 8. */
export function withWeightedTranscodeAdmission(command: string, maximum: number, cost: 1 | 2 | 4): string {
  const limit = Math.max(1, Math.min(2000, Math.floor(maximum) || 1));
  const release = 'exec 3>&- 4>&- 5>&- 6>&-';
  const bundles = Array.from({ length: Math.floor(limit / cost) }, (_, group) => {
    const locks = Array.from({ length: cost }, (_, i) =>
      `exec ${3 + i}>"/tmp/s2cam-live-point-${group * cost + i}.lock" && flock -n ${3 + i}`).join(' && ');
    return `{ ${release}; ${locks}; }`;
  }).join(' || ');
  return 'command -v flock >/dev/null 2>&1 || exit 75; '
    + 'exec 8>"/tmp/s2cam-live-point-allocation.lock"; flock 8 || exit 75; '
    + `if ${bundles || 'false'}; then flock -u 8; exec 8>&-; exec ${command}; fi; `
    + `${release}; echo 'Live conversion resource budget reached' >&2; exit 75`;
}
