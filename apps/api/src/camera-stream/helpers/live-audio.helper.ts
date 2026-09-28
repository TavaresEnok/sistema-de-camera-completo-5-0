/** Runtime track descriptions, not camera settings. null means unknown. */
export function audioCodecFromTracks(tracks: unknown, ready: boolean): string | null {
  if (!ready || !Array.isArray(tracks)) return null;
  const values = tracks.map(value => String(value).toLowerCase());
  if (values.some(value => value.includes('opus'))) return 'opus';
  if (values.some(value => /mpeg-4 audio|aac/.test(value))) return 'aac';
  if (values.some(value => /g711|g722|pcm|audio/.test(value))) return 'other';
  // Only assert no audio when every reported track is understood.
  if (values.length && values.every(value => /^(h264|h265|vp8|vp9|av1)$/.test(value))) return 'none';
  return null;
}
