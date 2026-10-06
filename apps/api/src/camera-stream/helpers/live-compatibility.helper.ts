import { createHash } from 'node:crypto';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';

export type LiveCompatibility = {
  normalizeVideo: boolean;
  audio: 'healthy' | 'invalid' | 'unknown';
  reason?: string;
};

/** Only fingerprints and decisions are persisted; URLs and credentials never are. */
export class LiveCompatibilityMemory {
  private entries = new Map<string, { value: LiveCompatibility; expires: number }>();
  constructor(private file = process.env.LIVE_COMPATIBILITY_STATE_FILE ?? '/storage/.live-compatibility.json') {
    try {
      const rows = JSON.parse(readFileSync(file, 'utf8'));
      if (Array.isArray(rows)) for (const row of rows.slice(-512)) {
        if (/^[a-f0-9]{64}$/.test(row?.key) && row.expires > Date.now()
          && typeof row.value?.normalizeVideo === 'boolean'
          && ['healthy', 'invalid', 'unknown'].includes(row.value?.audio)) this.entries.set(row.key, row);
      }
    } catch { /* An absent/unwritable state file must not interrupt video. */ }
  }
  static key(source: string, transport: string) {
    return createHash('sha256').update(JSON.stringify([source, transport])).digest('hex');
  }
  get(key: string): LiveCompatibility | undefined {
    const entry = this.entries.get(key);
    if (!entry || entry.expires <= Date.now()) { this.entries.delete(key); return undefined; }
    return entry.value;
  }
  set(key: string, value: LiveCompatibility, ttlMs = 300_000) {
    for (const [key, entry] of this.entries) if (entry.expires <= Date.now()) this.entries.delete(key);
    if (this.entries.size >= 512) this.entries.delete(this.entries.keys().next().value!);
    this.entries.set(key, { value, expires: Date.now() + ttlMs });
    try {
      const temporary = this.file + '.pending';
      writeFileSync(temporary, JSON.stringify([...this.entries].map(([key, entry]) => ({ key, ...entry }))), { mode: 0o600 });
      renameSync(temporary, this.file);
    } catch { /* Read-only test/runtime environments retain the in-memory cache. */ }
  }
}

export function unsafeVideoTimestamps(packets: any[]): boolean {
  const times = packets.filter(p => p.codec_type === 'video')
    .map(p => Number(p.dts_time)).filter(Number.isFinite);
  return times.some((time, i) => i > 0 && (time < times[i - 1] - 0.25 || time - times[i - 1] > 30));
}

export function audioDecodeErrors(text: string): number {
  return (text.match(/Error submitting packet to decoder|Error decoding AAC|channel element .* not allocated|Prediction is not allowed|Invalid data found when processing input/g) ?? []).length;
}

export function compatibilityVideoArgs(input: {
  fps: number | null; original: boolean; width: number; height: number; bitrate: number;
}): string {
  const fps = Math.max(1, Math.min(30, input.fps || 15));
  const scale = input.original ? '' : `,scale=w='min(iw,${input.width})':h='min(ih,${input.height})':force_original_aspect_ratio=decrease:force_divisible_by=2`;
  // Repair before fps: applying fps to broken timestamps generates duplicated
  // frames/backlog and can consume cores without delivering a live image.
  return '-threads 2 -c:v libx264 -preset veryfast -tune zerolatency -profile:v main ' +
    `-crf 23 -maxrate ${input.bitrate}k -bufsize ${input.bitrate}k -pix_fmt yuv420p ` +
    `-g ${Math.ceil(fps * 2)} -keyint_min ${Math.ceil(fps)} -sc_threshold 0 -bf 0 -refs 2 ` +
    `-vf "setpts=N/(${fps}*TB)${scale},fps=${fps}"`;
}
