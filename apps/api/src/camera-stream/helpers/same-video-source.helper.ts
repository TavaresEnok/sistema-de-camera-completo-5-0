/** Exact physical source, including credentials, channel and query. */
export function sameVideoSource(requested: string | null | undefined, published: string | null | undefined): boolean {
  if (!requested || !published) return false;
  try {
    const left = new URL(requested);
    const right = new URL(published);
    if (!['rtsp:', 'rtsps:'].includes(left.protocol) || left.protocol !== right.protocol) return false;
    left.hash = '';
    right.hash = '';
    return left.toString() === right.toString();
  } catch {
    return false;
  }
}
