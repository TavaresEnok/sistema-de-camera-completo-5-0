export type TrackProgress = 'progressing' | 'missing' | 'stalled' | 'unknown';
export type TrackPacketHealth = { video: TrackProgress; audio: TrackProgress };

/** Packet timestamps distinguish an audio-only stream from progressing video.
 * An inconclusive probe is never evidence for restarting a healthy source. */
export function trackPacketHealth(text: string, tracks: string[]): TrackPacketHealth {
  const unknown: TrackPacketHealth = { video: 'unknown', audio: 'unknown' };
  let packets: any[];
  try { packets = JSON.parse(text).packets; } catch { return unknown; }
  if (!Array.isArray(packets)) return unknown;
  const times = (kind: string) => packets.filter(x => x.codec_type === kind)
    .map(x => x.pts_time === undefined || x.pts_time === null || x.pts_time === 'N/A' ? x.dts_time : x.pts_time)
    .filter(x => x !== undefined && x !== null && x !== 'N/A' && x !== '')
    .map(Number).filter(Number.isFinite);
  const video = times('video');
  const audio = times('audio');
  const progresses = (values: number[]) => values.length >= 2 && values.some(x => x !== values[0]);
  const status = (values: number[], other: number[], expected: boolean): TrackProgress => {
    if (!expected) return 'unknown';
    if (progresses(values)) return 'progressing';
    if (values.length >= 2) return 'stalled';
    if (!values.length && progresses(other)) return 'missing';
    return 'unknown';
  };
  return {
    video: status(video, audio, tracks.some(x => /h26[45]|hevc|vp[89]|av1|mjpeg/i.test(x))),
    audio: status(audio, video, tracks.some(x => /audio|opus|aac|g7|pcm|mp[23]/i.test(x))),
  };
}
