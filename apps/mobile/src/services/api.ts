const DEFAULT_TIMEOUT_MS = 15_000;

// Handler global de "sessão expirada". O App registra sua função de logout aqui;
// qualquer requisição AUTENTICADA que receba 401 dispara o logout gracioso, em
// vez de deixar o app preso mostrando telas vazias com um token morto.
let unauthorizedHandler: ((requestToken?: string) => void) | null = null;
let tokenRefreshHandler: ((expiredToken: string, apiUrl: string) => Promise<string | null>) | null = null;
const tokenRefreshInFlight = new Map<string, Promise<string | null>>();
const renewedCredentials = new Map<string, string>();
let sessionGeneration = 0;
const activeRequests = new Set<AbortController>();
export function invalidateAuthRequests() {
  sessionGeneration++;
  for (const controller of activeRequests) controller.abort();
  tokenRefreshInFlight.clear();
  renewedCredentials.clear();
}
export function setUnauthorizedHandler(handler: ((requestToken?: string) => void) | null) {
  unauthorizedHandler = handler;
}

export function setTokenRefreshHandler(handler: ((expiredToken: string, apiUrl: string) => Promise<string | null>) | null) {
  tokenRefreshHandler = handler;
  if (!handler) tokenRefreshInFlight.clear();
}

export async function request<T>(apiUrl: string, path: string, token?: string, init?: RequestInit): Promise<T> {
  return requestInternal<T>(apiUrl, path, token, init, true);
}

async function refreshOnce(generation: number, apiUrl: string, token: string, handler: NonNullable<typeof tokenRefreshHandler>) {
  const key = `${generation}:${apiUrl}:${token}`;
  const known = renewedCredentials.get(key);
  if (known) return known;
  let pending = tokenRefreshInFlight.get(key);
  if (!pending) {
    pending = handler(token, apiUrl).then(renewed => {
      if (renewed && generation === sessionGeneration) renewedCredentials.set(key, renewed);
      return renewed;
    }).finally(() => {
      if (tokenRefreshInFlight.get(key) === pending) tokenRefreshInFlight.delete(key);
    });
    tokenRefreshInFlight.set(key, pending);
  }
  return pending;
}

/** Transferências nativas compartilham renovação e invalidação da sessão HTTP. */
export async function authenticatedTransfer<T extends { status: number }>(
  apiUrl: string, token: string, transfer: (token: string, signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const generation = sessionGeneration;
  const handler = tokenRefreshHandler;
  const controller = new AbortController();
  activeRequests.add(controller);
  const timeout = setTimeout(() => controller.abort(), 120_000);
  const check = () => { if (controller.signal.aborted || generation !== sessionGeneration) throw new Error('Transferência cancelada. Tente novamente.'); };
  try {
    let result = await transfer(token, controller.signal);
    check();
    if (result.status === 401 && handler) {
      const renewed = await refreshOnce(generation, apiUrl, token, handler);
      check();
      if (renewed) result = await transfer(renewed, controller.signal);
      else unauthorizedHandler?.(token);
    }
    check();
    if (result.status < 200 || result.status >= 300) {
      throw Object.assign(new Error('Não foi possível baixar o arquivo.'), { status: result.status });
    }
    return result;
  } finally { clearTimeout(timeout); activeRequests.delete(controller); }
}

async function requestInternal<T>(apiUrl: string, path: string, token: string | undefined, init: RequestInit | undefined, allowRefresh: boolean): Promise<T> {
  const controller = new AbortController();
  const generation = sessionGeneration;
  const refreshHandler = tokenRefreshHandler;
  activeRequests.add(controller);
  const externalSignal = init?.signal;
  const abortFromExternal = () => controller.abort();
  if (externalSignal?.aborted) controller.abort();
  else externalSignal?.addEventListener('abort', abortFromExternal, { once: true });
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

  try {
    const response = await fetch(`${apiUrl}${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(init?.headers ?? {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    });
    const text = await response.text();
    let data: any = null;
    if (text) {
      try { data = JSON.parse(text); }
      catch { data = { message: text.slice(0, 300) }; }
    }
    if (!response.ok) {
      if (generation !== sessionGeneration || controller.signal.aborted) throw new Error('Operação cancelada.');
      if (response.status === 401 && token && allowRefresh && refreshHandler) {
        const refreshedToken = await refreshOnce(generation, apiUrl, token, refreshHandler);
        if (generation !== sessionGeneration || externalSignal?.aborted) throw new Error('Operação cancelada.');
        if (refreshedToken) {
          return requestInternal<T>(apiUrl, path, refreshedToken, init, false);
        }
      }
      // Só desconecta depois que a renovação automática falhou. Login sem token
      // continua sem disparar o handler.
      if (response.status === 401 && token) {
        unauthorizedHandler?.(token);
      }
      // Anexa o status HTTP ao erro para que quem chama possa tratar 401 (sessão
      // expirada) de forma robusta, sem depender do texto da mensagem.
      const error = new Error(data?.message ?? `HTTP ${response.status}`) as Error & { status?: number };
      error.status = response.status;
      throw error;
    }
    if (generation !== sessionGeneration || controller.signal.aborted) throw new Error('Operação cancelada.');
    return data as T;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('Tempo esgotado. Verifique a conexão.');
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    activeRequests.delete(controller);
    externalSignal?.removeEventListener('abort', abortFromExternal);
  }
}

export function normalizeServerUrl(value: string | null | undefined, apiUrl: string) {
  if (!value) return null;
  try {
    const api = new URL(apiUrl);
    const target = new URL(value, api);
    if (!['http:', 'https:'].includes(target.protocol)) return null;
    if (target.username || target.password) return null;
    if (['localhost', '127.0.0.1', '0.0.0.0'].includes(target.hostname.toLowerCase())) {
      // URLs internas emitidas pelo backend devem acompanhar host, porta e TLS
      // públicos da API; preservar "http" aqui quebrava o app HTTPS em release.
      target.protocol = api.protocol;
      target.hostname = api.hostname;
      target.port = api.port;
    }
    return target.toString();
  } catch {
    return null;
  }
}
