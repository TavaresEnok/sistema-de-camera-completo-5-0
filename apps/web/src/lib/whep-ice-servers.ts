export type WhepIceServer = {
  urls: string;
  username?: string;
  credential?: string;
};

const ICE_SERVER_SCHEME = /^(?:stun|stuns|turn|turns):/i;

/**
 * Separa valores RFC 8288 sem quebrar vírgulas que estejam entre aspas ou
 * dentro de `<...>`. `Headers.get('Link')` combina múltiplos cabeçalhos numa
 * única string, então um simples `split(',')` não é seguro.
 */
function splitLinkValues(header: string) {
  const values: string[] = [];
  let start = 0;
  let quoted = false;
  let escaped = false;
  let angleDepth = 0;

  for (let index = 0; index < header.length; index += 1) {
    const char = header[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quoted && char === '\\') {
      escaped = true;
      continue;
    }
    if (char === '"') {
      quoted = !quoted;
      continue;
    }
    if (!quoted && char === '<') angleDepth += 1;
    else if (!quoted && char === '>' && angleDepth > 0) angleDepth -= 1;
    else if (!quoted && angleDepth === 0 && char === ',') {
      values.push(header.slice(start, index).trim());
      start = index + 1;
    }
  }
  values.push(header.slice(start).trim());
  return values.filter(Boolean);
}

function unquote(value: string) {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/\\([\\"])/g, '$1');
  }
  return trimmed;
}

/** Lê `Link: <turn:...>; rel="ice-server"; username=...; credential=...`. */
export function parseWhepIceServers(linkHeader?: string | null): WhepIceServer[] {
  if (!linkHeader) return [];
  const servers: WhepIceServer[] = [];

  for (const value of splitLinkValues(linkHeader)) {
    const target = /^\s*<([^>]+)>/.exec(value)?.[1]?.trim();
    if (!target || !ICE_SERVER_SCHEME.test(target)) continue;

    const params = new Map<string, string>();
    const tail = value.slice(value.indexOf('>') + 1);
    const parameter = /;\s*([^=;\s]+)(?:\s*=\s*("(?:\\.|[^"])*"|[^;]*))?/g;
    let match: RegExpExecArray | null;
    while ((match = parameter.exec(tail)) !== null) {
      params.set(match[1].toLowerCase(), unquote(match[2] ?? ''));
    }

    const relations = (params.get('rel') ?? '').toLowerCase().split(/\s+/);
    if (!relations.includes('ice-server')) continue;

    const server: WhepIceServer = { urls: target };
    const username = params.get('username');
    const credential = params.get('credential');
    if (username) server.username = username;
    if (credential) server.credential = credential;
    servers.push(server);
  }

  return servers.filter((server, index, all) => all.findIndex((candidate) => (
    candidate.urls === server.urls
    && candidate.username === server.username
    && candidate.credential === server.credential
  )) === index);
}

/**
 * O WHEP anuncia STUN/TURN por OPTIONS. Falhar essa descoberta não impede o
 * WebRTC direto das instalações antigas: nesse caso devolvemos `[]` e o ICE
 * usa apenas candidatos host/srflx. Em instalações atrás da Gateway, o Link
 * traz uma credencial TURN temporária e passa a tornar o candidato privado do
 * MediaMTX alcançável pelo navegador externo.
 */
export async function discoverWhepIceServers(
  whepUrl: string,
  authorization: string | null,
  signal?: AbortSignal,
): Promise<WhepIceServer[]> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) controller.abort();
  const deadline = setTimeout(abort, 3000);
  try {
    const response = await fetch(whepUrl, {
      method: 'OPTIONS',
      mode: 'cors',
      redirect: 'error',
      headers: authorization ? { Authorization: authorization } : undefined,
      signal: controller.signal,
    });
    if (!response.ok) return [];
    return parseWhepIceServers(response.headers.get('link'));
  } catch {
    return [];
  } finally {
    clearTimeout(deadline);
    signal?.removeEventListener('abort', abort);
  }
}
