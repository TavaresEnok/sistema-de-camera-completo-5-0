export type RecorderProfile = {
  token: string; name?: string | null; sourceToken?: string | null;
  width?: number | null; height?: number | null; rtspPath?: string | null;
};
export type RecorderChannel = { channel: number; name: string; rtspPath: string; mainToken?: string; sourceToken?: string; profiles: number };

/** Only group by the actual ONVIF video source, never by resolution or list position. */
export function groupRecorderProfiles(profiles: RecorderProfile[]): RecorderChannel[] {
  const groups = new Map<string, RecorderProfile[]>();
  for (const profile of profiles) {
    if (!profile.sourceToken || !profile.rtspPath) continue;
    const list = groups.get(profile.sourceToken) ?? [];
    list.push(profile); groups.set(profile.sourceToken, list);
  }
  const rows: RecorderChannel[] = [];
  const used = new Set<number>();
  for (const [sourceToken, list] of groups) {
    const main = [...list].sort((a, b) => (b.width ?? 0) * (b.height ?? 0) - (a.width ?? 0) * (a.height ?? 0))[0];
    const path = main.rtspPath!;
    // Unrecognised schemes keep an explicit source mapping; no guessed RTSP channel substitution.
    const raw = /[?&]channel=(\d+)/i.exec(path)?.[1] ?? /\/Streaming\/Channels\/(\d+)\d{2}(?:\b|\/)/i.exec(path)?.[1];
    let channel = raw ? Number(raw) : rows.length + 1;
    if (used.has(channel)) continue;
    used.add(channel);
    rows.push({ channel, name: `Canal ${channel}`, rtspPath: path, mainToken: main.token, sourceToken, profiles: list.length });
  }
  return rows.sort((a, b) => a.channel - b.channel);
}

export function recorderPath(manufacturer: string, channel: number, custom?: string) {
  if (custom?.trim()) {
    const value = custom.trim();
    if (!value.startsWith('/') || value.startsWith('//') || /[\r\n#]/.test(value) || value.length > 1024 || /(?:rtsp|https?):\/\//i.test(value)) throw new Error('Informe apenas o caminho do canal, começando com /.');
    return value;
  }
  if (['intelbras', 'dahua'].includes(manufacturer)) return `/cam/realmonitor?channel=${channel}&subtype=0`;
  if (manufacturer === 'hikvision') return `/Streaming/Channels/${channel}01`;
  throw new Error('Informe o caminho RTSP deste canal ou use a descoberta ONVIF.');
}
