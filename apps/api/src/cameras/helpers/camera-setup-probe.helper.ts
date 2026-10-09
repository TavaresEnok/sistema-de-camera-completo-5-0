import { Socket } from 'node:net';
import { assertCameraTargetAllowed } from '../../common/network/safe-url.helper';

export type SetupFailure = 'unreachable' | 'not_rtsp' | 'auth_denied' | 'video_unavailable' | 'timeout';
export type SetupStream = { codec?: string | null; width?: number | null; height?: number | null; fps?: number | null; bitrateKbps?: number | null };
export type SetupProbe = { ok: boolean; port: number | null; path: string | null; error: string | null; metadata: SetupStream | null; authDenied: boolean };
export type SetupProfile = { rtspUri?: string | null; rtspPath?: string | null };

export function setupRtspPorts(port: number, mode?: 'manual' | 'automatic') {
  return mode === 'manual' ? [port] : [...new Set([port, 554, 5540, 8554, 10554, 5544, 8555, 51488, 51489, 51490])];
}

/** Never follow the host or credentials supplied by a camera's ONVIF response. */
export function setupProfileTarget(profile: SetupProfile) {
  try {
    const uri = new URL(profile.rtspUri ?? '');
    if (uri.protocol !== 'rtsp:') return null;
    const port = Number(uri.port || 554);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
    return { port, path: `${uri.pathname || '/'}${uri.search}` };
  } catch { return null; }
}

export async function boundedMap<T, R>(values: T[], concurrency: number, action: (value: T) => Promise<R>): Promise<R[]> {
  let next = 0;
  const results = new Array<R>(values.length);
  await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), values.length) }, async () => {
    while (next < values.length) {
      const index = next++;
      results[index] = await action(values[index]);
    }
  }));
  return results;
}

/** TCP being open does not prove RTSP. No password is sent in this preflight. */
export function checkSetupRtsp(host: string, port: number, timeoutMs = 1500): Promise<'closed' | 'rtsp' | 'other' | 'unknown'> {
  host = assertCameraTargetAllowed(host, port);
  return new Promise(resolve => {
    const socket = new Socket();
    let opened = false;
    let response = '';
    let settled = false;
    const finish = (result: 'closed' | 'rtsp' | 'other' | 'unknown') => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeAllListeners();
      socket.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => finish(opened ? 'unknown' : 'closed'), Math.max(1, timeoutMs));
    socket.once('connect', () => {
      opened = true;
      const authority = host.includes(':') ? `[${host}]` : host;
      socket.write(`OPTIONS rtsp://${authority}:${port}/ RTSP/1.0\r\nCSeq: 1\r\nUser-Agent: S2Cam\r\n\r\n`);
    });
    socket.on('data', chunk => {
      response += chunk.toString('ascii').slice(0, 2048 - response.length);
      if (/^RTSP\/1\.0 \d{3}/.test(response)) finish('rtsp');
      else if (response.includes('\n') || response.length >= 2048) finish('other');
    });
    socket.once('error', () => finish(opened ? 'unknown' : 'closed'));
    socket.once('end', () => finish(opened ? 'unknown' : 'closed'));
    socket.connect(port, host);
  });
}

export async function probeCameraSetup(input: {
  port: number; mode?: 'manual' | 'automatic'; customPath?: string;
  paths: string[]; deadline: number;
}, deps: {
  check: (port: number) => Promise<'closed' | 'rtsp' | 'other' | 'unknown'>;
  discover: (deadline: number) => Promise<SetupProfile[]>;
  probe: (port: number, paths: string[], deadline: number, concurrency: number) => Promise<SetupProbe>;
  now?: () => number;
}) {
  const now = deps.now ?? Date.now;
  const checked = new Map<number, Awaited<ReturnType<typeof deps.check>>>();
  const check = async (port: number) => {
    if (!checked.has(port)) checked.set(port, now() < input.deadline ? await deps.check(port) : 'closed');
    return checked.get(port)!;
  };
  const ports = setupRtspPorts(input.port, input.mode);
  await boundedMap(ports, 3, check);
  let attempts = 0;
  let last: SetupProbe | null = null;
  const tried = new Set<string>();
  const run = async (port: number, paths: string[], deadline = input.deadline) => {
    const fresh = paths.filter(path => !tried.has(`${port}:${path}`));
    if (!fresh.length || now() >= deadline) return null;
    for (const path of fresh) tried.add(`${port}:${path}`);
    attempts++;
    // One explicit/discovered path first: small cameras may allow only one session.
    last = await deps.probe(port, fresh, deadline, 1);
    return last.ok || last.authDenied ? last : null;
  };
  const selected = checked.get(input.port);
  if (input.customPath && (selected === 'rtsp' || selected === 'unknown')) {
    const result = await run(input.port, [input.customPath], Math.min(input.deadline, now() + 6000));
    if (result) return finish(result);
  }
  // Discovery is optional and bounded. No PTZ calls, main/sub probes or bitrate
  // estimates block the mobile form; normal post-create provisioning does those.
  const profiles = now() < input.deadline ? await deps.discover(Math.min(input.deadline, now() + 8000)) : [];
  const targets = profiles.map(setupProfileTarget).filter((target): target is NonNullable<typeof target> => target !== null);
  const discoveredPaths = [...new Set([...targets.map(target => target.path), ...profiles.map(profile => profile.rtspPath).filter((path): path is string => Boolean(path?.startsWith('/')))])];
  if (input.mode !== 'manual') {
    for (const target of targets.slice(0, 6)) {
      if (!ports.includes(target.port)) { ports.push(target.port); await check(target.port); }
    }
  }
  const candidates = ports.filter(port => checked.get(port) === 'rtsp');
  // Devices that ignore OPTIONS still get a video test, after real RTSP responders.
  candidates.push(...ports.filter(port => checked.get(port) === 'unknown'));
  for (let index = 0; index < candidates.length; index++) {
    const port = candidates[index];
    const deadline = Math.min(input.deadline, now() + Math.max(1, Math.floor((input.deadline - now()) / (candidates.length - index))));
    const preferred = [...new Set([...(input.customPath ? [input.customPath] : []), ...discoveredPaths])];
    for (const path of preferred) {
      const result = await run(port, [path], deadline);
      if (result) return finish(result);
    }
    const result = await run(port, input.paths, deadline);
    if (result) return finish(result);
  }
  return finish(last);

  function finish(probe: SetupProbe | null) {
    const reachablePorts = [...checked].filter(([, kind]) => kind !== 'closed').map(([port]) => port);
    const failure: SetupFailure | null = probe?.ok ? null
      : probe?.authDenied ? 'auth_denied'
      : now() >= input.deadline ? 'timeout'
      : !reachablePorts.length ? 'unreachable'
      : !attempts ? 'not_rtsp' : 'video_unavailable';
    return { probe, reachablePorts, failure, attempts };
  }
}
